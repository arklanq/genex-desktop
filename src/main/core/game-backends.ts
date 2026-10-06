/**
 * Game backends: the server a game declares in studio.json (`backend`), one instance per copy of
 * the game.
 *
 * A copy is a folder the studio serves: the game folder Live shows, a worker's worktree, an
 * optimizer's candidate. Each copy gets its own instance — its own process, port, data folder and
 * containers — so two workers never share a database or see each other's half-written server.
 * An instance is keyed by the copy's real path, like the builds and the delegations.
 *
 * A page reaches only the instance of the copy it shows: the studio puts that instance's origin on
 * the page (`window.__studioBackend`, through the page shim) and the window's session lets that one
 * port through (`main/preview.ts`). The process runs in the same sandbox as every other
 * agent-originated process. Docker (for testcontainers) is a separate grant: the Docker socket
 * reaches a daemon that can mount any folder of this Mac, so an instance gets it only when the
 * person started the studio with `STUDIO_ALLOW_GAME_BACKEND_DOCKER=1`.
 *
 * Instances start when a window first loads their copy (`ensureFor`) or when an agent asks; they
 * stop when asked, when their worktree goes (`discard`), after sitting unused for
 * `BACKEND_IDLE_STOP_MS`, and with the studio. A record of running processes on disk lets the
 * next start end what a crash left behind (`sweepOrphans`).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  BACKEND_IDLE_STOP_MS,
  BACKEND_PORT_MAX,
  BACKEND_PORT_MIN,
  type GameBackendSpec,
  GameBackendState,
  type GameBackendStatus,
  GameBackendStop,
  backendOrigin,
} from "../../shared/game-backend.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { type BackendDeclaration, readBackendDeclaration } from "../../substrate/game-backend-spec.ts";
import { serial } from "./serial.ts";

const execFileAsync = promisify(execFile);

/** How many output lines an instance keeps for `backend.logs`. */
const LOG_LINES = 500;
/** How often a starting instance's health check is asked. */
const HEALTH_POLL_MS = 250;
/** How long one stop waits for the process to leave after SIGTERM, before SIGKILL. */
const STOP_GRACE_MS = 5 * SECOND_MS;
/** How long a stop waits for the process to be gone after SIGKILL. */
const KILL_WAIT_MS = 2 * SECOND_MS;
/** How often a stop looks whether the process group is gone. */
const GROUP_POLL_MS = 50;
/** How many of the last output lines a failure message carries. */
const FAILURE_TAIL_LINES = 12;
/** How long one health request or port check may take. */
const PROBE_TIMEOUT_MS = 2 * SECOND_MS;
/** How often unused instances are looked for. */
const IDLE_SWEEP_MS = MINUTE_MS;
/** How many ports a free-port search tries before it gives up. */
const PORT_ATTEMPTS = 64;
/** How far apart a recorded start and a process's real start may be and still be the same process. */
const START_TOLERANCE_MS = 5 * SECOND_MS;
/** The file in the data root that records running processes for the next start's sweep. */
const REGISTRY_FILE = "instances.json";

/** What the backend tools read when an instance does not run. */
const MESSAGE = {
  NotDeclared: "this copy of the game declares no backend in studio.json",
  DockerNotAllowed:
    "this backend declares docker, and the studio was not started with STUDIO_ALLOW_GAME_BACKEND_DOCKER=1; ask the person to restart Genex with it",
  NoPort: "no free port was found for the backend",
  TooMany: (count: number) =>
    `${count} backends already run, the most this studio runs at once; stop one (or let one sit unused) first`,
  Exited: (code: number | null, signal: string | null) =>
    `the backend exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
  NeverHealthy: (healthPath: string, ms: number) =>
    `the backend did not answer ${healthPath} with 2xx within ${Math.round(ms / SECOND_MS)}s`,
  SpawnFailed: (reason: string) => `the backend could not start: ${reason}`,
  StoppedOnRequest: "the backend was stopped on request; start or restart it with the backend tool",
  WithTail: (message: string, tail: string[]) => (tail.length ? `${message}\n${tail.join("\n")}` : message),
} as const;

/** The child an instance runs as, as far as this service uses it. */
export interface BackendChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** How an instance is started: the sandbox's long-lived spawn, with the overlay it needs. */
export interface BackendLaunch {
  command: string;
  cwd: string;
  env: Record<string, string>;
  label: string;
  policy: { allowUnixSockets?: string[] };
}

/** What the service needs from the rest of the studio; every one of them is a test seam. */
export interface GameBackendDeps {
  spawn(launch: BackendLaunch): Promise<BackendChild>;
  /** Whether `path` on the loopback `port` answers 2xx. */
  probe(port: number, path: string): Promise<boolean>;
  /** Whether nothing accepts connections on the loopback `port`. */
  portFree(port: number): Promise<boolean>;
  /** End a process and everything it started. */
  killTree(pid: number, signal: NodeJS.Signals): Promise<void>;
  /** When a running process started (ms since the epoch), or null when no such process runs. */
  processStart(pid: number): Promise<number | null>;
  /**
   * Whether anything of the process group `pid` leads still runs. The sandbox wrapper can exit
   * before the server it started, so a stop waits for the whole group, not the first process.
   */
  groupAlive(pid: number): boolean;
  /** Whether a window shows this copy, or a session works in it: such an instance is never idle. */
  inUse(root: string): boolean;
  /** The most instances that may run at once. */
  maxInstances(): number;
  /** Instances' data folders, and the record of their processes. */
  dataRoot: string;
  /** The person allowed backends the Docker socket. */
  dockerAllowed: boolean;
  /** The Docker socket paths a `docker` backend may connect to. */
  dockerSockets: readonly string[];
  /** Test seams: the clock, the pause between health checks, a port to try. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  randomPort?: () => number;
  log?: (line: string) => void;
}

/** One instance and what is known about it. */
interface Instance {
  project: string;
  /** The copy's real path: the key. */
  root: string;
  /** Short and stable: names its data folder and its sandbox label. */
  id: string;
  spec: GameBackendSpec | null;
  port: number | null;
  child: BackendChild | null;
  state: GameBackendState;
  stoppedBy: GameBackendStop | null;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  stopping: boolean;
  lastUsed: number;
  /** Settles when the process has exited (at once when none was started). */
  exited: Promise<void>;
}

/** One running process in the record the next start sweeps. */
interface RecordedProcess {
  id: string;
  pid: number;
  startedAt: number;
}

/** Whether an instance is up or on its way up. */
function isLive(instance: Instance): boolean {
  return instance.state === GameBackendState.Running || instance.state === GameBackendState.Starting;
}

/** Keep the last `LOG_LINES` lines of a stream in `logs`. */
function collectLines(stream: Readable | null, logs: string[]): void {
  if (!stream) return;
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = `${partial}${chunk}`.split(/\r?\n/);
    partial = lines.pop() ?? "";
    logs.push(...lines);
    if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES);
  });
}

/** An instance's id: the project's name and a hash of its copy's path, safe as a folder name. */
function instanceId(project: string, root: string): string {
  const name = project.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  return `${name}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

/** A well-formed entry of the process record; anything else in the file is ignored. */
function isRecordedProcess(value: unknown): value is RecordedProcess {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && Number.isInteger(entry.pid) && typeof entry.startedAt === "number";
}

/**
 * Where Docker Desktop's socket is: its own path under the home folder, and the system path it
 * links there. A grant names both, since a client may dial either.
 */
export function dockerSocketPaths(home: string = os.homedir()): string[] {
  return [path.join(home, ".docker", "run", "docker.sock"), "/var/run/docker.sock"];
}

/** When process `pid` started, by `ps` (ms since the epoch), or null when no such process runs. */
export async function processStartTime(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: PROBE_TIMEOUT_MS,
    });
    const started = Date.parse(stdout.trim());
    return Number.isFinite(started) ? started : null;
  } catch {
    return null;
  }
}

/** Whether anything of the process group `pid` leads still runs (signal 0 probes without sending). */
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `path` on the loopback `port` answers 2xx. `localhost` tries IPv4 and IPv6 both. */
export async function probeHealth(port: number, healthPath: string): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}${healthPath}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether nothing accepts a connection on the loopback `port`: a refused or timed-out dial is free. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "localhost", timeout: PROBE_TIMEOUT_MS });
    const settle = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.once("connect", () => settle(false));
    socket.once("timeout", () => settle(true));
    socket.once("error", () => settle(true));
  });
}

export class GameBackends {
  readonly #deps: GameBackendDeps;
  readonly #instances = new Map<string, Instance>();
  readonly #operations = new Map<string, Promise<unknown>>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(deps: GameBackendDeps) {
    this.#deps = deps;
  }

  /** Where the instance of a copy is, read against what its studio.json declares now. */
  async status(project: string, root: string): Promise<GameBackendStatus> {
    const real = await realpath(root);
    return this.#report(project, real, await readBackendDeclaration(real));
  }

  /** Start the instance of a copy and wait for its health check; a running one is left as it is. */
  async start(project: string, root: string): Promise<GameBackendStatus> {
    const real = await realpath(root);
    return serial(this.#operations, real, () => this.#start(project, real));
  }

  /** Stop the instance of a copy and everything it started; it stays stopped until asked again. */
  async stop(project: string, root: string): Promise<GameBackendStatus> {
    const real = await realpath(root);
    return serial(this.#operations, real, async () => {
      await this.#stop(real, GameBackendStop.Request);
      return this.#report(project, real, await readBackendDeclaration(real));
    });
  }

  /** Stop the instance and start it again from the copy's current studio.json and sources. */
  async restart(project: string, root: string): Promise<GameBackendStatus> {
    const real = await realpath(root);
    return serial(this.#operations, real, async () => {
      await this.#stop(real, GameBackendStop.Request);
      return this.#start(project, real);
    });
  }

  /** The last `lines` lines the instance printed (both streams, in arrival order). */
  async logs(root: string, lines = LOG_LINES): Promise<string[]> {
    const instance = this.#instances.get(await realpath(root));
    if (instance) instance.lastUsed = this.#now();
    const logs = instance?.logs ?? [];
    return logs.slice(-Math.max(1, Math.min(LOG_LINES, Math.floor(lines))));
  }

  /**
   * Before a window shows a copy: start its instance when it declares one that has not run yet or
   * stopped unused. One someone stopped stays stopped, and one that failed waits for a restart after
   * the fix, rather than every load waiting out its boot. Never throws: answers the instance's
   * status (`root` is the copy's real path, the key a window then names), or null when the copy
   * declares no backend.
   */
  async ensureFor(project: string, root: string): Promise<GameBackendStatus | null> {
    try {
      const real = await realpath(root);
      const known = this.#instances.get(real);
      if (known) known.lastUsed = this.#now();
      const declaration = await readBackendDeclaration(real);
      if (!declaration.declared) return null;
      const waiting = !known || known.stoppedBy === GameBackendStop.Idle;
      if ("spec" in declaration && waiting) return await this.start(project, real);
      return this.#report(project, real, declaration);
    } catch (error) {
      this.#deps.log?.(`[backend] ${project}: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * The port a page showing `root` (a real path) may reach right now, or null. Asked on every
   * request a page makes to the loopback, so it also marks the instance used.
   */
  portFor(root: string): number | null {
    const instance = this.#instances.get(root);
    if (instance?.state !== GameBackendState.Running) return null;
    instance.lastUsed = this.#now();
    return instance.port;
  }

  /** A worktree or candidate is going away: stop its instance and remove its data. */
  async discard(root: string): Promise<void> {
    const real = await realpath(root).catch(() => path.resolve(root));
    await serial(this.#operations, real, async () => {
      const instance = this.#instances.get(real);
      if (!instance) return;
      await this.#end(instance);
      this.#instances.delete(real);
      await this.#writeRecord();
      await rm(path.dirname(this.#dataDir(instance)), { recursive: true, force: true });
    });
  }

  /** New sources landed in a copy: an instance that runs restarts on them; one that does not stays put. */
  async restartIfRunning(project: string, root: string): Promise<void> {
    const real = await realpath(root).catch(() => null);
    const instance = real ? this.#instances.get(real) : undefined;
    if (!real || !instance || !isLive(instance)) return;
    await this.restart(project, real).catch((error) =>
      this.#deps.log?.(`[backend] ${project}: restart after landing failed: ${errorMessage(error)}`),
    );
  }

  /** Look for unused instances every minute, until `stopAll`. */
  startIdleSweeps(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => void this.sweepIdle(), IDLE_SWEEP_MS);
    this.#sweeper.unref();
  }

  /** Stop every instance no window shows, no session works in and nothing used for the idle time. */
  async sweepIdle(): Promise<void> {
    const cutoff = this.#now() - BACKEND_IDLE_STOP_MS;
    const idle = [...this.#instances.values()].filter(
      (instance) => instance.state === GameBackendState.Running && instance.lastUsed <= cutoff,
    );
    for (const instance of idle) {
      if (this.#deps.inUse(instance.root)) {
        instance.lastUsed = this.#now();
        continue;
      }
      await serial(this.#operations, instance.root, () => this.#stop(instance.root, GameBackendStop.Idle));
    }
  }

  /**
   * End what a crash left running: every process in the record that is still the process the
   * record names (same id, same start time), so a reused process id is never hit.
   */
  async sweepOrphans(): Promise<void> {
    for (const entry of await this.#readRecord()) {
      const started = await this.#deps.processStart(entry.pid).catch(() => null);
      const same = started !== null && Math.abs(started - entry.startedAt) <= START_TOLERANCE_MS;
      if (!same) continue;
      await this.#deps.killTree(entry.pid, "SIGKILL");
      this.#deps.log?.(`[backend] ended ${entry.id} (pid ${entry.pid}), left running by an earlier session`);
    }
    await this.#writeRecord();
  }

  /** Stop every instance: the studio is going away, and none of them may outlive it. */
  async stopAll(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
    const roots = [...this.#instances.keys()];
    await Promise.all(
      roots.map((root) => serial(this.#operations, root, () => this.#stop(root, GameBackendStop.Request))),
    );
  }

  async #start(project: string, root: string): Promise<GameBackendStatus> {
    const declaration = await readBackendDeclaration(root);
    if (!("spec" in declaration)) return this.#report(project, root, declaration);
    const instance = this.#instance(project, root);
    instance.lastUsed = this.#now();
    if (isLive(instance)) return this.#report(project, root, declaration);
    const refusal = this.#refusal(declaration.spec);
    if (refusal) return this.#fail(instance, declaration, refusal);
    const port = await this.#portFor(instance);
    if (port === null) return this.#fail(instance, declaration, MESSAGE.NoPort);
    await this.#launch(instance, declaration.spec, port);
    if (instance.state === GameBackendState.Starting) await this.#awaitHealthy(instance);
    return this.#report(project, root, declaration);
  }

  /** The instance of a copy, made the first time it is asked for. */
  #instance(project: string, root: string): Instance {
    const known = this.#instances.get(root);
    if (known) return known;
    const instance: Instance = {
      project,
      root,
      id: instanceId(project, root),
      spec: null,
      port: null,
      child: null,
      state: GameBackendState.Stopped,
      stoppedBy: null,
      startedAt: null,
      exitCode: null,
      error: null,
      logs: [],
      stopping: false,
      lastUsed: this.#now(),
      exited: Promise.resolve(),
    };
    this.#instances.set(root, instance);
    return instance;
  }

  /** Why a declared instance may not start now, or null when it may. */
  #refusal(spec: GameBackendSpec): string | null {
    if (spec.docker && !this.#deps.dockerAllowed) return MESSAGE.DockerNotAllowed;
    const live = [...this.#instances.values()].filter(isLive).length;
    if (live >= this.#deps.maxInstances()) return MESSAGE.TooMany(live);
    return null;
  }

  #fail(instance: Instance, declaration: BackendDeclaration, error: string): GameBackendStatus {
    instance.state = GameBackendState.Failed;
    instance.stoppedBy = null;
    instance.error = error;
    return this.#report(instance.project, instance.root, declaration);
  }

  /**
   * The instance's port: the one it had, while nothing else took it (a page that kept the old
   * origin still reaches it after a restart), else a free one in the backend range.
   */
  async #portFor(instance: Instance): Promise<number | null> {
    if (instance.port !== null && (await this.#deps.portFree(instance.port))) return instance.port;
    const taken = new Set([...this.#instances.values()].map((other) => other.port));
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
      const port = this.#randomPort();
      if (taken.has(port) || !(await this.#deps.portFree(port))) continue;
      instance.port = port;
      return port;
    }
    return null;
  }

  /** Start the process; its exit, whenever it comes, records why. */
  async #launch(instance: Instance, spec: GameBackendSpec, port: number): Promise<void> {
    Object.assign(instance, {
      spec,
      state: GameBackendState.Starting,
      stoppedBy: null,
      error: null,
      exitCode: null,
      logs: [],
      stopping: false,
    });
    const data = this.#dataDir(instance);
    await mkdir(data, { recursive: true });
    const launch: BackendLaunch = {
      command: spec.command,
      cwd: instance.root,
      env: { PORT: String(port), GENEX_BACKEND: "1", GENEX_BACKEND_INSTANCE: instance.id, GENEX_BACKEND_DATA: data },
      label: `backend:${instance.id}`,
      policy: spec.docker ? { allowUnixSockets: [...this.#deps.dockerSockets] } : {},
    };
    try {
      instance.child = await this.#deps.spawn(launch);
    } catch (error) {
      instance.state = GameBackendState.Failed;
      instance.error = MESSAGE.SpawnFailed(errorMessage(error));
      return;
    }
    instance.startedAt = new Date(this.#now()).toISOString();
    collectLines(instance.child.stdout, instance.logs);
    collectLines(instance.child.stderr, instance.logs);
    instance.exited = this.#watchExit(instance, instance.child);
    await this.#writeRecord();
  }

  #watchExit(instance: Instance, child: BackendChild): Promise<void> {
    return new Promise((resolve) => {
      const settle = (code: number | null, signal: string | null, failure?: string) => {
        instance.exitCode = code;
        instance.child = null;
        if (!instance.stopping) {
          instance.state = GameBackendState.Failed;
          const tail = instance.logs.slice(-FAILURE_TAIL_LINES);
          instance.error = MESSAGE.WithTail(failure ?? MESSAGE.Exited(code, signal), tail);
          // What the wrapper left behind (the server it started) must not hold the port on its own.
          if (child.pid && this.#deps.groupAlive(child.pid)) void this.#deps.killTree(child.pid, "SIGKILL");
        }
        void this.#writeRecord();
        resolve();
      };
      child.once("exit", (code, signal) => settle(code, signal));
      child.once("error", (error) => settle(null, null, MESSAGE.SpawnFailed(error.message)));
    });
  }

  /** Ask the health check until it answers, the process exits, or the boot time runs out. */
  async #awaitHealthy(instance: Instance): Promise<void> {
    const { spec, port } = instance;
    if (!spec || port === null) return;
    const deadline = this.#now() + spec.bootMs;
    while (instance.state === GameBackendState.Starting) {
      if (await this.#deps.probe(port, spec.health).catch(() => false)) {
        if (instance.state === GameBackendState.Starting) instance.state = GameBackendState.Running;
        return;
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(HEALTH_POLL_MS);
    }
    if (instance.state !== GameBackendState.Starting) return;
    const tail = instance.logs.slice(-FAILURE_TAIL_LINES);
    await this.#end(instance);
    instance.state = GameBackendState.Failed;
    instance.error = MESSAGE.WithTail(MESSAGE.NeverHealthy(spec.health, spec.bootMs), tail);
  }

  async #stop(root: string, why: GameBackendStop): Promise<void> {
    const instance = this.#instances.get(root);
    if (!instance) return;
    await this.#end(instance);
    instance.state = GameBackendState.Stopped;
    instance.stoppedBy = why;
    instance.error = null;
  }

  /** End the process: SIGTERM, a grace period, then SIGKILL. Pages lose the port at once. */
  async #end(instance: Instance): Promise<void> {
    const pid = instance.child?.pid;
    const live = isLive(instance);
    if (live) instance.state = GameBackendState.Stopped;
    if (!pid || !live) return;
    instance.stopping = true;
    await this.#deps.killTree(pid, "SIGTERM");
    if (await this.#goneWithin(instance, pid, STOP_GRACE_MS)) return;
    await this.#deps.killTree(pid, "SIGKILL");
    await this.#goneWithin(instance, pid, KILL_WAIT_MS);
  }

  /** Whether the process and every member of its group are gone within `ms`. */
  async #goneWithin(instance: Instance, pid: number, ms: number): Promise<boolean> {
    let exited = false;
    await Promise.race([instance.exited.then(() => (exited = true)), this.#sleep(ms)]);
    if (!exited) return false;
    const deadline = this.#now() + ms;
    while (this.#deps.groupAlive(pid)) {
      if (this.#now() >= deadline) return false;
      await this.#sleep(GROUP_POLL_MS);
    }
    return true;
  }

  #report(project: string, root: string, declaration: BackendDeclaration): GameBackendStatus {
    const instance = this.#instances.get(root);
    const problem = "problem" in declaration ? declaration.problem : null;
    const declared = "spec" in declaration;
    const port = instance?.port ?? null;
    const running = instance?.state === GameBackendState.Running && port !== null;
    const stoppedOnRequest = instance?.stoppedBy === GameBackendStop.Request;
    const fallback = declared ? null : MESSAGE.NotDeclared;
    return {
      project,
      root,
      declared,
      state: instance?.state ?? GameBackendState.Stopped,
      stoppedBy: instance?.stoppedBy ?? null,
      port,
      origin: running ? backendOrigin(port) : null,
      pid: instance?.child?.pid ?? null,
      startedAt: instance?.startedAt ?? null,
      exitCode: instance?.exitCode ?? null,
      error: problem ?? instance?.error ?? (stoppedOnRequest ? MESSAGE.StoppedOnRequest : fallback),
    };
  }

  #dataDir(instance: Instance): string {
    return path.join(this.#deps.dataRoot, instance.id, "data");
  }

  async #readRecord(): Promise<RecordedProcess[]> {
    const text = await readFile(path.join(this.#deps.dataRoot, REGISTRY_FILE), "utf8").catch(() => "[]");
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter(isRecordedProcess) : [];
    } catch {
      return [];
    }
  }

  /** Record the processes that run now, for the next start's sweep. */
  async #writeRecord(): Promise<void> {
    const running = [...this.#instances.values()].flatMap((instance) => {
      const pid = instance.child?.pid;
      return pid && instance.startedAt ? [{ id: instance.id, pid, startedAt: Date.parse(instance.startedAt) }] : [];
    });
    try {
      await mkdir(this.#deps.dataRoot, { recursive: true });
      await atomicWriteJson(path.join(this.#deps.dataRoot, REGISTRY_FILE), running);
    } catch (error) {
      this.#deps.log?.(`[backend] could not record running backends: ${errorMessage(error)}`);
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #sleep(ms: number): Promise<void> {
    return this.#deps.sleep ? this.#deps.sleep(ms) : delay(ms, undefined, { ref: false });
  }

  #randomPort(): number {
    if (this.#deps.randomPort) return this.#deps.randomPort();
    return BACKEND_PORT_MIN + Math.floor(Math.random() * (BACKEND_PORT_MAX - BACKEND_PORT_MIN + 1));
  }
}
