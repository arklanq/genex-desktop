/**
 * Game backends: the server a game declares in studio.json, run by the studio. The process, the
 * port checks and the clock are fakes here; the sandbox suite owns the real Seatbelt boundary, and
 * the last test runs one real server through the real sandbox.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { GameBackendState } from "../../src/shared/game-backend.ts";
import {
  type BackendChild,
  type BackendLaunch,
  type GameBackendDeps,
  GameBackends,
  loopbackPortFree,
  probeHealth,
} from "../../src/main/core/game-backends.ts";
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

/** The service's world: launches, open ports, signals, a clock that moves only when it sleeps. */
function world(overrides: Partial<GameBackendDeps> & { healthy?: () => boolean; ignoreTerm?: boolean } = {}) {
  const launches: BackendLaunch[] = [];
  const children: FakeChild[] = [];
  const open = new Set<number>();
  const signals: Array<[number, NodeJS.Signals]> = [];
  let clock = 0;
  const deps: GameBackendDeps = {
    spawn: async (launch) => {
      launches.push(launch);
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    probe: async () => (overrides.healthy ?? (() => true))(),
    portFree: async () => true,
    killTree: async (pid, signal) => {
      signals.push([pid, signal]);
      const child = children.find((candidate) => candidate.pid === pid);
      if (signal === "SIGKILL" || !overrides.ignoreTerm) child?.exit(null, signal);
    },
    openPort: (port) => open.add(port),
    closePort: (port) => open.delete(port),
    dockerAllowed: false,
    dockerSockets: DOCKER_SOCKETS,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await nextTurn();
    },
    ...overrides,
  };
  return { backends: new GameBackends(deps), launches, children, open, signals };
}

/** A game folder whose studio.json declares `backend` (or nothing). */
async function game(backend?: unknown): Promise<string> {
  const dir = await tmpDir("studio-backend-game-");
  await writeFile(path.join(dir, "studio.json"), JSON.stringify(backend === undefined ? {} : { backend }));
  return dir;
}

describe("a game's backend", () => {
  it("starts the declared command in the game folder with PORT, and opens the port once healthy", async () => {
    const dir = await game({ command: "bun run server", port: 3001 });
    let asks = 0;
    const { backends, launches, open } = world({ healthy: () => ++asks >= 3 });
    const status = await backends.start("pond", dir);
    assert.equal(status.state, GameBackendState.Running);
    assert.equal(status.port, 3001);
    assert.equal(status.pid, 1000);
    assert.equal(status.error, null);
    assert.deepEqual(launches, [
      {
        command: "bun run server",
        cwd: dir,
        env: { PORT: "3001", GENEX_BACKEND: "1" },
        label: "backend:pond",
        policy: {},
      },
    ]);
    assert.deepEqual([...open], [3001]);
  });

  it("leaves a running backend as it is when asked to start again", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const { backends, launches } = world();
    await backends.start("pond", dir);
    await backends.start("pond", dir);
    assert.equal(launches.length, 1);
  });

  it("says when a game declares no backend, or one it cannot use, and starts nothing", async () => {
    const { backends, launches } = world();
    const none = await backends.start("pond", await game());
    assert.equal(none.declared, false);
    assert.equal(none.state, GameBackendState.Stopped);
    assert.match(none.error ?? "", /declares no backend/);
    const bad = await backends.start("pond", await game({ command: "x", port: 80 }));
    assert.equal(bad.declared, false);
    assert.match(bad.error ?? "", /backend\.port/);
    assert.equal(launches.length, 0);
  });

  it("refuses a port another program already uses, without starting anything", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const { backends, launches, open } = world({ portFree: async () => false });
    const status = await backends.start("pond", dir);
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /port 3001 is already in use/);
    assert.equal(launches.length, 0);
    assert.equal(open.size, 0);
  });

  it("refuses a port another game's backend holds", async () => {
    const { backends, launches } = world();
    await backends.start("pond", await game({ command: "x", port: 3001 }));
    const status = await backends.start("lake", await game({ command: "y", port: 3001 }));
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /held by the backend of pond/);
    assert.equal(launches.length, 1);
  });

  it("gives the Docker socket only to a docker backend, and only when the person allowed it", async () => {
    const dir = await game({ command: "bun run server", port: 3001, docker: true });
    const refused = world();
    const status = await refused.backends.start("pond", dir);
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /STUDIO_ALLOW_GAME_BACKEND_DOCKER=1/);
    assert.equal(refused.launches.length, 0);

    const allowed = world({ dockerAllowed: true });
    assert.equal((await allowed.backends.start("pond", dir)).state, GameBackendState.Running);
    assert.deepEqual(allowed.launches[0]?.policy, { allowUnixSockets: DOCKER_SOCKETS });
    const plain = world({ dockerAllowed: true });
    await plain.backends.start("pond", await game({ command: "x", port: 3001 }));
    assert.deepEqual(plain.launches[0]?.policy, {}, "a backend that does not declare docker gets no socket");
  });

  it("kills a backend that never answers its health check, and says why with its last output", async () => {
    const dir = await game({ command: "x", port: 3001, bootMs: 2000 });
    let printed = false;
    const fake = world({
      healthy: () => {
        if (!printed) fake.children[0]?.print("listening on 3002 by mistake");
        printed = true;
        return false;
      },
    });
    const { backends, open, signals } = fake;
    const status = await backends.start("pond", dir);
    assert.equal(status.state, GameBackendState.Failed);
    assert.match(status.error ?? "", /did not answer \/health with 2xx within 2s/);
    assert.match(status.error ?? "", /listening on 3002 by mistake/);
    assert.deepEqual(signals, [[1000, "SIGTERM"]]);
    assert.equal(open.size, 0);
  });

  it("takes the port back and records the exit when a running backend dies on its own", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const { backends, children, open } = world();
    await backends.start("pond", dir);
    children[0]?.print("TypeError: db is undefined", "stderr");
    await nextTurn();
    children[0]?.exit(1);
    const status = await backends.status("pond", dir);
    assert.equal(status.state, GameBackendState.Failed);
    assert.equal(status.exitCode, 1);
    assert.equal(status.pid, null);
    assert.match(status.error ?? "", /exited with code 1/);
    assert.match(status.error ?? "", /TypeError: db is undefined/);
    assert.equal(open.size, 0);
    assert.deepEqual(backends.logs("pond"), ["TypeError: db is undefined"]);
  });

  it("stops with SIGTERM, and with SIGKILL when the process ignores it", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const polite = world();
    await polite.backends.start("pond", dir);
    const stopped = await polite.backends.stop("pond", dir);
    assert.equal(stopped.state, GameBackendState.Stopped);
    assert.equal(stopped.error, null);
    assert.deepEqual(polite.signals, [[1000, "SIGTERM"]]);
    assert.equal(polite.open.size, 0);

    const stubborn = world({ ignoreTerm: true });
    await stubborn.backends.start("pond", dir);
    await stubborn.backends.stop("pond", dir);
    assert.deepEqual(stubborn.signals, [
      [1000, "SIGTERM"],
      [1000, "SIGKILL"],
    ]);
  });

  it("restarts from the current studio.json", async () => {
    const dir = await game({ command: "bun run v1", port: 3001 });
    const { backends, launches, open } = world();
    await backends.start("pond", dir);
    await writeFile(path.join(dir, "studio.json"), JSON.stringify({ backend: { command: "bun run v2", port: 3005 } }));
    const status = await backends.restart("pond", dir);
    assert.equal(status.state, GameBackendState.Running);
    assert.deepEqual(
      launches.map((launch) => launch.command),
      ["bun run v1", "bun run v2"],
    );
    assert.deepEqual([...open], [3005]);
  });

  it("starts a shown game's backend the first time only, and leaves one someone stopped alone", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const { backends, launches } = world();
    assert.equal(await backends.ensureStarted("pond", dir), null);
    assert.equal(launches.length, 1);
    await backends.stop("pond", dir);
    assert.equal(await backends.ensureStarted("pond", dir), null);
    assert.equal(launches.length, 1, "a stopped backend stays stopped");
    assert.equal(await backends.ensureStarted("lake", await game()), null, "no declaration, nothing to start");
    assert.match(
      (await backends.ensureStarted("brook", await game({ command: "x", port: 80 }))) ?? "",
      /backend\.port/,
      "a refused declaration says why on the page",
    );
  });

  it("reports why a shown game's backend failed, without retrying it on every load", async () => {
    const dir = await game({ command: "x", port: 3001 });
    const { backends, launches } = world({ portFree: async () => false });
    assert.match((await backends.ensureStarted("pond", dir)) ?? "", /already in use/);
    assert.match((await backends.ensureStarted("pond", dir)) ?? "", /already in use/);
    assert.equal(launches.length, 0);
  });

  it("stops every backend when the studio stops", async () => {
    const { backends, open, signals } = world();
    await backends.start("pond", await game({ command: "x", port: 3001 }));
    await backends.start("lake", await game({ command: "y", port: 3002 }));
    await backends.stopAll();
    assert.equal(open.size, 0);
    assert.deepEqual(signals.map(([, signal]) => signal).sort(), ["SIGTERM", "SIGTERM"]);
  });
});

describe("a game's backend in the real sandbox", () => {
  let sandbox: ProcessSandbox | null = null;
  after(async () => {
    await sandbox?.dispose();
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
  });

  it("serves its health check on the declared port, and leaves nothing behind when stopped", async () => {
    const root = await tmpDir("studio-backend-real-");
    const dir = path.join(root, "pond");
    await mkdir(dir, { recursive: true });
    const server = [
      "require('node:http')",
      ".createServer((q, s) => s.end(q.url))",
      ".listen(Number(process.env.PORT), () => console.log('up on', process.env.PORT))",
    ].join("");
    await writeFile(path.join(dir, "server.cjs"), server);
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const command = `${JSON.stringify(process.execPath)} server.cjs`;
    await writeFile(path.join(dir, "studio.json"), JSON.stringify({ backend: { command, port, bootMs: 15_000 } }));
    sandbox = await ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      readableRoots: [path.dirname(process.execPath)],
    });
    const active = sandbox;
    const open = new Set<number>();
    const backends = new GameBackends({
      spawn: async (launch) => (await active.spawnLongLived(launch)).child,
      probe: probeHealth,
      portFree: loopbackPortFree,
      killTree: (pid, signal) => killProcessTree(pid, { signal }),
      openPort: (opened) => open.add(opened),
      closePort: (closed) => open.delete(closed),
      dockerAllowed: false,
      dockerSockets: [],
    });
    const status = await backends.start("pond", dir);
    assert.equal(status.state, GameBackendState.Running, status.error ?? "");
    assert.deepEqual([...open], [port]);
    assert.deepEqual(backends.logs("pond"), [`up on ${port}`]);
    const pid = status.pid ?? 0;
    await backends.stop("pond", dir);
    assert.equal(open.size, 0);
    assert.equal(await loopbackPortFree(port), true, "the port is free again");
    assert.equal(running(pid), false, "the process tree is gone");
  });
});
