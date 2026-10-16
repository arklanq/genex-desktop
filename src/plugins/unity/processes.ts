/**
 * Which Unity editor processes have a game's project open, read from the computer's own process
 * list: an editor is started with `-projectPath <folder>` (Unity Hub spells it `-projectpath`), so
 * its arguments name its project. Unity's lock file says nothing by itself: a killed or crashed
 * editor leaves it behind, and so does its Pipeline descriptor.
 *
 * Ending an editor is for one Genex is about to restore files under, or one whose main thread no
 * longer answers: a signal to that project's own editor processes, never to another project's.
 * Whether somebody is at the computer is read from how long ago its keyboard or pointer was last
 * touched: a stalled editor is ended without being asked only when nobody is.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";

/** One running process: its id, its program and its whole command line. */
export interface ProcessRow {
  pid: number;
  exec: string;
  args: string;
}

/** The computer's processes and how to signal one; tests stand in for both. */
export interface ProcessEnv {
  list(): Promise<ProcessRow[]>;
  /** Sends `signal` to `pid`; throws when the process is gone. */
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<unknown>;
}

/** A Mac's own program that lists processes, and how long it may take. */
const PS = "/bin/ps";
const PS_MS = 10 * SECOND_MS;
/** The most of the process list read. */
const PS_MAX_BYTES = 8 * 1024 * 1024;
/** The end of a Mac editor's program path; `Unity Hub` and its helpers end otherwise. */
const MAC_EDITOR = "/Unity.app/Contents/MacOS/Unity";
/** The editor's flag naming its project, in either spelling. */
const PROJECT_FLAG = /-projectpath /i;
/** How long an editor asked to end is given before it is killed, and how often Genex looks. */
const END_GRACE_MS = 10 * SECOND_MS;
const END_POLL_MS = SECOND_MS / 2;

const run = promisify(execFile);

/** One column of `ps` for every process, by pid. */
async function psColumn(column: string): Promise<Map<number, string>> {
  const { stdout } = await run(PS, ["-axww", "-o", `pid=,${column}=`], { timeout: PS_MS, maxBuffer: PS_MAX_BYTES });
  const rows = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) rows.set(Number(match[1]), match[2]);
  }
  return rows;
}

/** This Mac's processes, by `ps`: each one's program (`comm`) and its command line (`args`). */
async function macProcesses(): Promise<ProcessRow[]> {
  const [execs, args] = await Promise.all([psColumn("comm"), psColumn("args")]);
  return [...execs].flatMap(([pid, exec]) => {
    const line = args.get(pid);
    return line === undefined ? [] : [{ pid, exec, args: line }];
  });
}

/** This computer's processes: listed on a Mac, none elsewhere; signals by `process.kill`. */
export function systemProcesses(platform: NodeJS.Platform = process.platform): ProcessEnv {
  return {
    list: async () => (platform === "darwin" ? macProcesses().catch(() => []) : []),
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => sleep(ms),
  };
}

/** Whether a process is a Unity editor whose command line names the project at `root`. */
function hasProject(row: ProcessRow, root: string): boolean {
  if (!row.exec.endsWith(MAC_EDITOR)) return false;
  const flag = PROJECT_FLAG.exec(row.args);
  if (!flag) return false;
  const named = row.args.slice(flag.index + flag[0].length);
  // The path ends the line, or another flag follows it: a longer path that only starts alike is another project.
  return named === root || named.startsWith(`${root} -`);
}

/** The ids of the editor processes that have the project at `root` (its real path) open. */
export async function editorPids(env: ProcessEnv, root: string): Promise<number[]> {
  return (await env.list()).filter((row) => hasProject(row, root)).map((row) => row.pid);
}

/** Sends a signal to each process, passing over one that is already gone. */
function signalAll(env: ProcessEnv, pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      env.signal(pid, signal);
    } catch {
      // Gone between the listing and the signal: what was asked for.
    }
  }
}

/**
 * Ends the editors that have the project at `root` open: asked to end first, killed when still
 * there after a grace. Answers whether none is left.
 */
export async function endEditors(env: ProcessEnv, root: string): Promise<boolean> {
  const asked = await editorPids(env, root);
  if (asked.length === 0) return true;
  signalAll(env, asked, "SIGTERM");
  for (let waited = 0; waited < END_GRACE_MS; waited += END_POLL_MS) {
    await env.sleep(END_POLL_MS);
    if ((await editorPids(env, root)).length === 0) return true;
  }
  signalAll(env, await editorPids(env, root), "SIGKILL");
  await env.sleep(END_POLL_MS);
  return (await editorPids(env, root)).length === 0;
}

/** A Mac's own program that reads its hardware registry, where the time since the last input is kept. */
const IOREG = "/usr/sbin/ioreg";
/** The registry's line for how long nobody touched the keyboard or pointer, in nanoseconds. */
const IDLE_TIME = /"HIDIdleTime" = (\d+)/;
const NS_PER_MS = 1_000_000;

/**
 * How long since anyone touched this computer's keyboard or pointer, in milliseconds; undefined
 * where it can't be read (off a Mac), which callers take as "someone may be there".
 */
export async function systemIdleMs(platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
  if (platform !== "darwin") return undefined;
  const listed = await run(IOREG, ["-c", "IOHIDSystem"], { timeout: PS_MS, maxBuffer: PS_MAX_BYTES }).catch(
    () => undefined,
  );
  const idle = listed ? IDLE_TIME.exec(listed.stdout)?.[1] : undefined;
  return idle === undefined ? undefined : Math.floor(Number(idle) / NS_PER_MS);
}
