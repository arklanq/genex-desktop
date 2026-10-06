/**
 * Game backends: one instance of a game's declared server per copy of the game (the game folder,
 * each worker's worktree). The processes, port checks and clock are fakes here; the last test runs
 * real servers for two copies at once through the real sandbox.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { BACKEND_IDLE_STOP_MS, GameBackendState, GameBackendStop } from "../../src/shared/game-backend.ts";
import {
  type BackendChild,
  type BackendLaunch,
  type GameBackendDeps,
  GameBackends,
  loopbackPortFree,
  probeHealth,
  processGroupAlive,
  processStartTime,
} from "../../src/main/core/game-backends.ts";
import { runBackendTool } from "../../src/main/core/backend-tool.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { killProcessTree } from "../../src/substrate/process-tree.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const DOCKER_SOCKETS = ["/home/me/.docker/run/docker.sock", "/var/run/docker.sock"];

/** A backend process that does what the test tells it to. */
class FakeChild extends EventEmitter implements BackendChild {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  print(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    this[stream].write(`${line}\n`);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

interface WorldOptions extends Partial<GameBackendDeps> {
  healthy?: () => boolean;
  ignoreTerm?: boolean;
  busy?: Set<number>;
  used?: Set<string>;
}

/** The service's world: launches, signals, a clock that moves only when it sleeps, ports handed out in order. */
async function world(options: WorldOptions = {}) {
  const launches: BackendLaunch[] = [];
  const children: FakeChild[] = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  const busy = options.busy ?? new Set<number>();
  const used = options.used ?? new Set<string>();
  const dataRoot = options.dataRoot ?? path.join(await tmpDir("studio-backend-data-"), "backends");
  let clock = 1_000_000;
  let nextPort = 20_100;
  const deps: GameBackendDeps = {
    spawn: async (launch) => {
      launches.push(launch);
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    probe: async () => (options.healthy ?? (() => true))(),
    portFree: async (port) => !busy.has(port),
    killTree: async (pid, signal) => {
      signals.push([pid, signal]);
      const child = children.find((candidate) => candidate.pid === pid);
      if (signal === "SIGKILL" || !options.ignoreTerm) child?.exit(null, signal);
    },
    processStart: async () => null,
    groupAlive: () => false,
    inUse: (root) => used.has(root),
    maxInstances: () => 10,
    dataRoot,
    dockerAllowed: false,
    dockerSockets: DOCKER_SOCKETS,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await nextTurn();
    },
    randomPort: () => nextPort++,
    ...options,
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { backends: new GameBackends(deps), launches, children, signals, dataRoot, advance };
}

/** A copy of a game whose studio.json declares `backend` (or nothing): its real path. */
async function copy(backend?: unknown): Promise<string> {
  const dir = await realpath(await tmpDir("studio-backend-copy-"));
  await writeFile(path.join(dir, "studio.json"), JSON.stringify(backend === undefined ? {} : { backend }));
  return dir;
}

/** A tool answer's text, whatever its shape. */
function textOf(answer: string | { text: string }): string {
  return typeof answer === "string" ? answer : answer.text;
}

describe("a game's backend instance", () => {
  it("starts the declared command in its copy with a port, an id and a data folder of its own", async () => {
    const root = await copy({ command: "bun run server" });
    let asks = 0;
    const { backends, launches, dataRoot } = await world({ healthy: () => ++asks >= 3 });
    const status = await backends.start("pond", root);
    assert.equal(status.state, GameBackendState.Running);
    assert.equal(status.root, root);
    assert.equal(status.port, 20_100);
    assert.deepEqual(status.origin, { http: "http://localhost:20100", ws: "ws://localhost:20100" });
    assert.equal(status.error, null);
    const [launch] = launches;
    const id = launch?.env.GENEX_BACKEND_INSTANCE ?? "";
    assert.equal(launch?.command, "bun run server");
    assert.equal(launch?.cwd, root);
    assert.equal(launch?.env.PORT, "20100");
    assert.equal(launch?.env.GENEX_BACKEND, "1");
    assert.match(id, /^pond-[0-9a-f]{12}$/);
    assert.equal(launch?.env.GENEX_BACKEND_DATA, path.join(dataRoot, id, "data"));
    assert.ok((await stat(launch?.env.GENEX_BACKEND_DATA ?? "")).isDirectory());
    assert.deepEqual(launch?.policy, {});
    assert.equal(backends.portFor(root), 20_100);
  });

  it("gives every copy its own instance, port and data, and a page only its own copy's port", async () => {
    const live = await copy({ command: "bun run server" });
    const worker = await copy({ command: "bun run server" });
    const { backends, launches } = await world();
    const a = await backends.start("pond", live);
    const b = await backends.start("pond", worker);
    assert.notEqual(a.port, b.port);
    assert.notEqual(launches[0]?.env.GENEX_BACKEND_DATA, launches[1]?.env.GENEX_BACKEND_DATA);
    assert.equal(backends.portFor(live), a.port);
    assert.equal(backends.portFor(worker), b.port);
    assert.equal(backends.portFor(await copy()), null, "a copy with no instance reaches nothing");
  });

  it("leaves a running instance as it is when asked to start again", async () => {
    const root = await copy({ command: "x" });
    const { backends, launches } = await world();
    await backends.start("pond", root);
    await backends.start("pond", root);
    assert.equal(launches.length, 1);
  });

  it("skips a port another program uses", async () => {
    const root = await copy({ command: "x" });
    const { backends } = await world({ busy: new Set([20_100, 20_101]) });
    assert.equal((await backends.start("pond", root)).port, 20_102);
  });

  it("says when a copy declares no backend, or one it cannot use, and starts nothing", async () => {
    const { backends, launches } = await world();
    const none = await backends.start("pond", await copy());
    assert.equal(none.declared, false);
    assert.equal(none.state, GameBackendState.Stopped);
    assert.match(none.error ?? "", /declares no backend/);
    const bad = await backends.start("pond", await copy({ command: " " }));
    assert.equal(bad.declared, false);
    assert.match(bad.error ?? "", /backend\.command/);
    assert.equal(launches.length, 0);
  });

  it("refuses more instances than the studio runs at once", async () => {
    const { backends, launches } = await world({ maxInstances: () => 1 });
    await backends.start("pond", await copy({ command: "x" }));
    const second = await backends.start("pond", await copy({ command: "x" }));
    assert.equal(second.state, GameBackendState.Failed);
    assert.match(second.error ?? "", /the most this studio runs at once/);
    assert.equal(launches.length, 1);
  });

  it("gives the Docker socket only to a docker backend, and only when the person allowed it", async () => {
    const root = await copy({ command: "bun run server", docker: true });
    const refused = await world();
    const status = await refused.backends.start("pond", root);
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /STUDIO_ALLOW_GAME_BACKEND_DOCKER=1/);
    assert.equal(refused.launches.length, 0);

    const allowed = await world({ dockerAllowed: true });
    assert.equal((await allowed.backends.start("pond", root)).state, GameBackendState.Running);
    assert.deepEqual(allowed.launches[0]?.policy, { allowUnixSockets: DOCKER_SOCKETS });
    const plain = await world({ dockerAllowed: true });
    await plain.backends.start("pond", await copy({ command: "x" }));
    assert.deepEqual(plain.launches[0]?.policy, {}, "a backend that does not declare docker gets no socket");
  });

  it("kills an instance that never answers its health check, and says why with its last output", async () => {
    const root = await copy({ command: "x", bootMs: 2000 });
    let printed = false;
    const fake = await world({
      healthy: () => {
        if (!printed) fake.children[0]?.print("listening on 3002 by mistake");
        printed = true;
        return false;
      },
    });
    const status = await fake.backends.start("pond", root);
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /did not answer \/health with 2xx within 2s/);
    assert.match(status.error ?? "", /listening on 3002 by mistake/);
    assert.deepEqual(fake.signals, [[1000, "SIGTERM"]]);
    assert.equal(fake.backends.portFor(root), null);
  });

  it("records the exit, with the last output, when a running instance dies on its own", async () => {
    const root = await copy({ command: "x" });
    const { backends, children } = await world();
    await backends.start("pond", root);
    children[0]?.print("TypeError: db is undefined", "stderr");
    await nextTurn();
    children[0]?.exit(1);
    const status = await backends.status("pond", root);
    assert.equal(status.state, GameBackendState.Failed);
    assert.equal(status.exitCode, 1);
    assert.equal(status.pid, null);
    assert.match(status.error ?? "", /exited with code 1/);
    assert.match(status.error ?? "", /TypeError: db is undefined/);
    assert.equal(backends.portFor(root), null);
    assert.deepEqual(await backends.logs(root), ["TypeError: db is undefined"]);
  });

  it("stops with SIGTERM, and with SIGKILL when the process ignores it", async () => {
    const root = await copy({ command: "x" });
    const polite = await world();
    await polite.backends.start("pond", root);
    const stopped = await polite.backends.stop("pond", root);
    assert.equal(stopped.state, GameBackendState.Stopped);
    assert.equal(stopped.stoppedBy, GameBackendStop.Request);
    assert.deepEqual(polite.signals, [[1000, "SIGTERM"]]);
    assert.equal(polite.backends.portFor(root), null);

    const stubborn = await world({ ignoreTerm: true });
    await stubborn.backends.start("pond", root);
    await stubborn.backends.stop("pond", root);
    assert.deepEqual(stubborn.signals, [
      [1000, "SIGTERM"],
      [1000, "SIGKILL"],
    ]);
  });

  it("restarts from the copy's current studio.json, on the port it had", async () => {
    const root = await copy({ command: "bun run v1" });
    const { backends, launches } = await world();
    const first = await backends.start("pond", root);
    await writeFile(path.join(root, "studio.json"), JSON.stringify({ backend: { command: "bun run v2" } }));
    const status = await backends.restart("pond", root);
    assert.equal(status.state, GameBackendState.Running);
    assert.equal(status.port, first.port, "a page that kept the old origin still reaches it");
    assert.deepEqual(
      launches.map((launch) => launch.command),
      ["bun run v1", "bun run v2"],
    );
  });

  it("starts a shown copy's instance when it never ran, and leaves one someone stopped alone", async () => {
    const root = await copy({ command: "x" });
    const { backends, launches } = await world();
    assert.equal((await backends.ensureFor("pond", root))?.state, GameBackendState.Running);
    assert.equal(launches.length, 1);
    await backends.stop("pond", root);
    const stopped = await backends.ensureFor("pond", root);
    assert.equal(stopped?.state, GameBackendState.Stopped);
    assert.match(stopped?.error ?? "", /stopped on request/);
    assert.equal(launches.length, 1, "a stopped instance stays stopped");
    assert.equal(await backends.ensureFor("pond", await copy()), null, "no declaration, nothing to start");
    const refused = await backends.ensureFor("pond", await copy({ command: "" }));
    assert.match(refused?.error ?? "", /backend\.command/, "a refused declaration says why on the page");
  });

  it("does not retry a failed instance on every load", async () => {
    const root = await copy({ command: "x", bootMs: 1000 });
    const { backends, launches } = await world({ healthy: () => false });
    assert.equal((await backends.ensureFor("pond", root))?.state, GameBackendState.Failed);
    assert.equal((await backends.ensureFor("pond", root))?.state, GameBackendState.Failed);
    assert.equal(launches.length, 1);
  });

  it("stops an instance nothing used for the idle time, and starts it again on the next load", async () => {
    const root = await copy({ command: "x" });
    const { backends, launches, advance } = await world();
    await backends.ensureFor("pond", root);
    advance(BACKEND_IDLE_STOP_MS - 1);
    await backends.sweepIdle();
    assert.equal((await backends.status("pond", root)).state, GameBackendState.Running, "not idle long enough");
    advance(2);
    await backends.sweepIdle();
    const idle = await backends.status("pond", root);
    assert.equal(idle.state, GameBackendState.Stopped);
    assert.equal(idle.stoppedBy, GameBackendStop.Idle);
    assert.equal((await backends.ensureFor("pond", root))?.state, GameBackendState.Running);
    assert.equal(launches.length, 2);
  });

  it("never stops for idleness an instance a window shows, a session works in, or a page talks to", async () => {
    const shown = await copy({ command: "x" });
    const talking = await copy({ command: "x" });
    const { backends, advance } = await world({ used: new Set([shown]) });
    await backends.start("pond", shown);
    await backends.start("pond", talking);
    advance(BACKEND_IDLE_STOP_MS - 1);
    backends.portFor(talking);
    advance(2);
    await backends.sweepIdle();
    assert.equal((await backends.status("pond", shown)).state, GameBackendState.Running);
    assert.equal((await backends.status("pond", talking)).state, GameBackendState.Running);
  });

  it("discards a worktree's instance: process stopped, data removed, nothing left to reach", async () => {
    const root = await copy({ command: "x" });
    const { backends, launches, signals } = await world();
    await backends.start("pond", root);
    const data = launches[0]?.env.GENEX_BACKEND_DATA ?? "";
    await backends.discard(root);
    assert.deepEqual(signals, [[1000, "SIGTERM"]]);
    await assert.rejects(() => stat(path.dirname(data)), /ENOENT/);
    assert.equal(backends.portFor(root), null);
    assert.equal((await backends.status("pond", root)).state, GameBackendState.Stopped);
  });

  it("restarts the game folder's instance after a landing only when it runs", async () => {
    const root = await copy({ command: "x" });
    const { backends, launches } = await world();
    await backends.restartIfRunning("pond", root);
    assert.equal(launches.length, 0);
    await backends.start("pond", root);
    await backends.restartIfRunning("pond", root);
    assert.equal(launches.length, 2);
  });

  it("records running processes, and the next session ends only the ones that are still them", async () => {
    const root = await copy({ command: "x" });
    const first = await world();
    await first.backends.start("pond", root);
    const recordFile = path.join(first.dataRoot, "instances.json");
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    assert.deepEqual(
      record.map((entry: { pid: number }) => entry.pid),
      [1000],
    );
    const startedAt = record[0].startedAt as number;
    const killed: number[] = [];
    const kill = async (pid: number) => {
      killed.push(pid);
    };
    // The same pid, but a process that started an hour later: a reused id, left alone.
    const reused = await world({
      dataRoot: first.dataRoot,
      processStart: async () => startedAt + 3_600_000,
      killTree: kill,
    });
    await reused.backends.sweepOrphans();
    assert.deepEqual(killed, []);
    await writeFile(recordFile, JSON.stringify(record));
    const orphan = await world({ dataRoot: first.dataRoot, processStart: async () => startedAt, killTree: kill });
    await orphan.backends.sweepOrphans();
    assert.deepEqual(killed, [1000]);
    assert.deepEqual(JSON.parse(await readFile(recordFile, "utf8")), []);
  });

  it("stops every instance when the studio stops", async () => {
    const { backends, signals } = await world();
    await backends.start("pond", await copy({ command: "x" }));
    await backends.start("pond", await copy({ command: "y" }));
    await backends.stopAll();
    assert.deepEqual(signals.map(([, signal]) => signal).sort(), ["SIGTERM", "SIGTERM"]);
  });
});

describe("the game_backend tool of a delegated session", () => {
  it("acts on the session's own copy and says where its instance is", async () => {
    const root = await copy({ command: "x" });
    const { backends } = await world();
    assert.match(
      textOf(await runBackendTool(backends, "pond", root, { action: "start" })),
      /Backend running at http:\/\/localhost:20100/,
    );
    assert.match(textOf(await runBackendTool(backends, "pond", root, { action: "stop" })), /Backend stopped/);
    const wrong = await runBackendTool(backends, "pond", root, { action: "explode" });
    assert.ok(typeof wrong !== "string" && wrong.isError);
    const none = await runBackendTool(backends, "pond", await copy(), { action: "status" });
    assert.ok(typeof none !== "string" && none.isError, "no declaration is an error the model sees");
  });
});

describe("game backend instances in the real sandbox", () => {
  let sandbox: ProcessSandbox | null = null;
  after(async () => {
    await sandbox?.dispose();
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
  });

  it("serves two copies at once on ports of their own, and leaves nothing behind when stopped", async () => {
    const base = await realpath(await tmpDir("studio-backend-real-"));
    const server = [
      "require('node:http')",
      ".createServer((q, s) => s.end(process.env.GENEX_BACKEND_INSTANCE))",
      ".listen(Number(process.env.PORT), () => console.log('up'))",
    ].join("");
    const roots: string[] = [];
    for (const name of ["live", "worker"]) {
      const dir = path.join(base, name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "server.cjs"), server);
      const command = `${JSON.stringify(process.execPath)} server.cjs`;
      await writeFile(path.join(dir, "studio.json"), JSON.stringify({ backend: { command, bootMs: 15_000 } }));
      roots.push(dir);
    }
    sandbox = await ProcessSandbox.create({
      writableRoots: [base],
      scratchDir: path.join(base, "scratch"),
      secretPaths: [],
      readableRoots: [path.dirname(process.execPath)],
    });
    const active = sandbox;
    const backends = new GameBackends({
      spawn: async (launch) => (await active.spawnLongLived(launch)).child,
      probe: probeHealth,
      portFree: loopbackPortFree,
      killTree: (pid, signal) => killProcessTree(pid, { signal }),
      processStart: processStartTime,
      groupAlive: processGroupAlive,
      inUse: () => false,
      maxInstances: () => 10,
      dataRoot: path.join(base, "backends"),
      dockerAllowed: false,
      dockerSockets: [],
    });
    const statuses = await Promise.all(roots.map((root) => backends.start("pond", root)));
    for (const status of statuses) assert.equal(status.state, GameBackendState.Running, status.error ?? "");
    const [live, worker] = statuses;
    assert.notEqual(live?.port, worker?.port);
    const answers = await Promise.all(statuses.map(async (status) => (await fetch(status.origin?.http ?? "")).text()));
    assert.notEqual(answers[0], answers[1], "each copy answers from its own instance");
    const pids = statuses.map((status) => status.pid ?? 0);
    const started = await processStartTime(pids[0] ?? 0);
    assert.ok(started !== null && Math.abs(started - Date.parse(live?.startedAt ?? "")) < 5000, "ps reads its start");
    await backends.stopAll();
    for (const status of statuses) assert.equal(await loopbackPortFree(status.port ?? 0), true);
    for (const pid of pids) assert.equal(running(pid), false, "the process tree is gone");
  });
});
