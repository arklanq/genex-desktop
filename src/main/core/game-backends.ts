/**
 * Game backends: the server process a game declares in studio.json (`backend`), run by the studio.
 *
 * A game's page runs in a partition that may reach nothing but the studio's own server (SECUI-3),
 * so a game with a server of its own could not be played or judged. This service starts the
 * declared command in the game folder, inside the same sandbox as every other agent-originated
 * process, waits for its health check, and only then lets game pages reach its one loopback port
 * (`openBackendPort`). The port is taken back the moment the process stops, fails or exits.
 *
 * Docker (for testcontainers) is a separate grant: the Docker socket reaches a daemon that can
 * mount any folder of this Mac, so a backend gets it only when the person started the studio with
 * `STUDIO_ALLOW_GAME_BACKEND_DOCKER=1` — a switch no agent can flip from inside a game.
 */
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type GameBackendSpec, GameBackendState, type GameBackendStatus } from "../../shared/game-backend.ts";
import { type BackendDeclaration, readBackendDeclaration } from "../../substrate/game-backend-spec.ts";
import { serial } from "./serial.ts";

/** How many output lines a backend keeps for `backend.logs`. */
const LOG_LINES = 500;
/** How often a starting backend's health check is asked. */
const HEALTH_POLL_MS = 250;
/** How long one stop waits for the process to leave after SIGTERM, before SIGKILL. */
const STOP_GRACE_MS = 5 * SECOND_MS;
/** How long a stop waits for the process to be gone after SIGKILL. */
const KILL_WAIT_MS = 2 * SECOND_MS;
/** How many of the last output lines a failure message carries. */
const FAILURE_TAIL_LINES = 12;
/** How long one health request or port check may take. */
const PROBE_TIMEOUT_MS = 2 * SECOND_MS;

/** What the backend tools read when a backend does not run. */
const MESSAGE = {
  NotDeclared: "this game declares no backend in studio.json",
  DockerNotAllowed:
    "this backend declares docker, and the studio was not started with STUDIO_ALLOW_GAME_BACKEND_DOCKER=1; ask the person to restart Genex with it",
  PortHeld: (port: number, other: string) => `port ${port} is held by the backend of ${other}`,
  PortBusy: (port: number) => `port ${port} is already in use by another program`,
  Exited: (code: number | null, signal: string | null) =>
    `the backend exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
  NeverHealthy: (path: string, ms: number) =>
    `the backend did not answer ${path} with 2xx within ${Math.round(ms / SECOND_MS)}s`,
  SpawnFailed: (reason: string) => `the backend could not start: ${reason}`,
  WithTail: (message: string, tail: string[]) => (tail.length ? `${message}\n${tail.join("\n")}` : message),
} as const;

/** The child a backend runs as, as far as this service uses it. */
export interface BackendChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/** How a backend is started: the sandbox's long-lived spawn, with the overlay it needs. */
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
  /** Let game pages reach a port, and take it back (`main/preview.ts`). */
  openPort(port: number): void;
  closePort(port: number): void;
  /** The person allowed backends the Docker socket. */
  dockerAllowed: boolean;
  /** The Docker socket paths a `docker` backend may connect to. */
  dockerSockets: readonly string[];
  /** Test seams: the clock and the pause between health checks. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** One game's backend process and what is known about it. */
interface Backend {
  project: string;
  spec: GameBackendSpec;
  child: BackendChild | null;
  state: GameBackendState;
  startedAt: string | null;
  exitCode: number | null;
  error: string | null;
  logs: string[];
  stopping: boolean;
  /** Settles when the process has exited (at once when none was started). */
  exited: Promise<void>;
}

/**
 * Where Docker Desktop's socket is: its own path under the home folder, and the system path it
 * links there. A grant names both, since a client may dial either.
 */
export function dockerSocketPaths(home: string = os.homedir()): string[] {
  return [path.join(home, ".docker", "run", "docker.sock"), "/var/run/docker.sock"];
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

/** Whether a backend is up or on its way up. */
function isLive(backend: Backend): boolean {
  return backend.state === GameBackendState.Running || backend.state === GameBackendState.Starting;
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

export class GameBackends {
  readonly #deps: GameBackendDeps;
  readonly #backends = new Map<string, Backend>();
  readonly #operations = new Map<string, Promise<unknown>>();

  constructor(deps: GameBackendDeps) {
    this.#deps = deps;
  }

  /** Where a game's backend is, read against what its studio.json declares now. */
  async status(project: string, dir: string): Promise<GameBackendStatus> {
    const declaration = await readBackendDeclaration(dir);
    return this.#report(project, declaration);
  }

  /** Start a game's backend and wait for its health check; a running one is left as it is. */
  start(project: string, dir: string): Promise<GameBackendStatus> {
    return serial(this.#operations, project, () => this.#start(project, dir));
  }

  /** Stop a game's backend and everything it started. */
  stop(project: string, dir: string): Promise<GameBackendStatus> {
    return serial(this.#operations, project, async () => {
      await this.#stop(project);
      return this.#report(project, await readBackendDeclaration(dir));
    });
  }

  /** Stop the backend and start it again from the current studio.json and sources. */
  restart(project: string, dir: string): Promise<GameBackendStatus> {
    return serial(this.#operations, project, async () => {
      await this.#stop(project);
      return this.#start(project, dir);
    });
  }

  /** The last `lines` lines the backend printed (both streams, in arrival order). */
  logs(project: string, lines = LOG_LINES): string[] {
    const logs = this.#backends.get(project)?.logs ?? [];
    return logs.slice(-Math.max(1, Math.min(LOG_LINES, Math.floor(lines))));
  }

  /**
   * Before a game is shown: the first time in this app session, start the backend it declares.
   * Only the first time — a backend someone stopped stays stopped, and one that failed is
   * restarted by `game.backendRestart` after a fix, not by every preview load waiting out its
   * boot. Never throws; returns why the backend does not run (a refused declaration included), or
   * null when it runs or none is declared.
   */
  async ensureStarted(project: string, dir: string): Promise<string | null> {
    const known = this.#backends.get(project);
    if (known) return isLive(known) ? null : known.error;
    const declaration = await readBackendDeclaration(dir).catch(() => ({ declared: false }) as const);
    if ("problem" in declaration) return declaration.problem;
    if (!("spec" in declaration)) return null;
    try {
      const status = await this.start(project, dir);
      return status.state === GameBackendState.Running ? null : status.error;
    } catch (error) {
      this.#deps.log?.(`[backend] ${project}: ${errorMessage(error)}`);
      return errorMessage(error);
    }
  }

  /** Stop every backend: the studio is going away, and none of them may outlive it. */
  async stopAll(): Promise<void> {
    const projects = [...this.#backends.keys()];
    await Promise.all(projects.map((project) => serial(this.#operations, project, () => this.#stop(project))));
  }

  async #start(project: string, dir: string): Promise<GameBackendStatus> {
    const declaration = await readBackendDeclaration(dir);
    if (!("spec" in declaration)) return this.#report(project, declaration);
    const { spec } = declaration;
    const current = this.#backends.get(project);
    const live = current !== undefined && isLive(current);
    if (live && current.spec.port === spec.port) return this.#report(project, declaration);
    if (live) await this.#stop(project);
    const refusal = await this.#refusal(project, spec);
    if (refusal) return this.#failWithout(project, spec, refusal, declaration);
    const backend = await this.#launch(project, dir, spec);
    if (backend.state === GameBackendState.Starting) await this.#awaitHealthy(backend);
    return this.#report(project, declaration);
  }

  /** Why a declared backend may not start now, or null when it may. */
  async #refusal(project: string, spec: GameBackendSpec): Promise<string | null> {
    if (spec.docker && !this.#deps.dockerAllowed) return MESSAGE.DockerNotAllowed;
    for (const other of this.#backends.values()) {
      const holds = other.project !== project && isLive(other) && other.spec.port === spec.port;
      if (holds) return MESSAGE.PortHeld(spec.port, other.project);
    }
    if (!(await this.#deps.portFree(spec.port))) return MESSAGE.PortBusy(spec.port);
    return null;
  }

  /** Record a backend that was refused before any process started. */
  #failWithout(
    project: string,
    spec: GameBackendSpec,
    error: string,
    declaration: BackendDeclaration,
  ): GameBackendStatus {
    this.#backends.set(project, this.#record(project, spec, GameBackendState.Failed, error));
    return this.#report(project, declaration);
  }

  #record(project: string, spec: GameBackendSpec, state: GameBackendState, error: string | null = null): Backend {
    return {
      project,
      spec,
      child: null,
      state,
      startedAt: null,
      exitCode: null,
      error,
      logs: [],
      stopping: false,
      exited: Promise.resolve(),
    };
  }

  /** Start the process; its exit, whenever it comes, takes the port back and records why. */
  async #launch(project: string, dir: string, spec: GameBackendSpec): Promise<Backend> {
    const backend = this.#record(project, spec, GameBackendState.Starting);
    this.#backends.set(project, backend);
    const launch: BackendLaunch = {
      command: spec.command,
      cwd: dir,
      env: { PORT: String(spec.port), GENEX_BACKEND: "1" },
      label: `backend:${project}`,
      policy: spec.docker ? { allowUnixSockets: [...this.#deps.dockerSockets] } : {},
    };
    try {
      backend.child = await this.#deps.spawn(launch);
    } catch (error) {
      backend.state = GameBackendState.Failed;
      backend.error = MESSAGE.SpawnFailed(errorMessage(error));
      return backend;
    }
    backend.startedAt = new Date(this.#now()).toISOString();
    collectLines(backend.child.stdout, backend.logs);
    collectLines(backend.child.stderr, backend.logs);
    backend.exited = this.#watchExit(backend, backend.child);
    return backend;
  }

  #watchExit(backend: Backend, child: BackendChild): Promise<void> {
    return new Promise((resolve) => {
      const settle = (code: number | null, signal: string | null, failure?: string) => {
        this.#deps.closePort(backend.spec.port);
        backend.exitCode = code;
        if (backend.stopping) backend.state = GameBackendState.Stopped;
        else {
          backend.state = GameBackendState.Failed;
          const tail = backend.logs.slice(-FAILURE_TAIL_LINES);
          backend.error = MESSAGE.WithTail(failure ?? MESSAGE.Exited(code, signal), tail);
        }
        resolve();
      };
      child.once("exit", (code, signal) => settle(code, signal));
      child.once("error", (error) => settle(null, null, MESSAGE.SpawnFailed(error.message)));
    });
  }

  /** Ask the health check until it answers, the process exits, or the boot time runs out. */
  async #awaitHealthy(backend: Backend): Promise<void> {
    const deadline = this.#now() + backend.spec.bootMs;
    while (backend.state === GameBackendState.Starting) {
      if (await this.#deps.probe(backend.spec.port, backend.spec.health).catch(() => false)) {
        if (backend.state !== GameBackendState.Starting) return;
        backend.state = GameBackendState.Running;
        this.#deps.openPort(backend.spec.port);
        return;
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(HEALTH_POLL_MS);
    }
    if (backend.state !== GameBackendState.Starting) return;
    const tail = backend.logs.slice(-FAILURE_TAIL_LINES);
    await this.#end(backend);
    backend.state = GameBackendState.Failed;
    backend.error = MESSAGE.WithTail(MESSAGE.NeverHealthy(backend.spec.health, backend.spec.bootMs), tail);
  }

  async #stop(project: string): Promise<void> {
    const backend = this.#backends.get(project);
    if (!backend) return;
    await this.#end(backend);
    backend.state = GameBackendState.Stopped;
    backend.error = null;
  }

  /** End the process: SIGTERM, a grace period, then SIGKILL. The port is closed first. */
  async #end(backend: Backend): Promise<void> {
    this.#deps.closePort(backend.spec.port);
    const pid = backend.child?.pid;
    const running = backend.state === GameBackendState.Running || backend.state === GameBackendState.Starting;
    if (!pid || !running) return;
    backend.stopping = true;
    await this.#deps.killTree(pid, "SIGTERM");
    if (await this.#exitsWithin(backend, STOP_GRACE_MS)) return;
    await this.#deps.killTree(pid, "SIGKILL");
    await this.#exitsWithin(backend, KILL_WAIT_MS);
  }

  async #exitsWithin(backend: Backend, ms: number): Promise<boolean> {
    let exited = false;
    await Promise.race([backend.exited.then(() => (exited = true)), this.#sleep(ms)]);
    return exited;
  }

  #report(project: string, declaration: BackendDeclaration): GameBackendStatus {
    const backend = this.#backends.get(project);
    const spec = "spec" in declaration ? declaration.spec : null;
    const problem = "problem" in declaration ? declaration.problem : null;
    const declared = spec !== null;
    const live = backend !== undefined && isLive(backend);
    return {
      project,
      declared,
      state: backend?.state ?? GameBackendState.Stopped,
      port: live ? backend.spec.port : (spec?.port ?? null),
      pid: live ? (backend.child?.pid ?? null) : null,
      startedAt: backend?.startedAt ?? null,
      exitCode: backend?.exitCode ?? null,
      error: problem ?? backend?.error ?? (declared ? null : MESSAGE.NotDeclared),
    };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #sleep(ms: number): Promise<void> {
    return this.#deps.sleep ? this.#deps.sleep(ms) : delay(ms, undefined, { ref: false });
  }
}
