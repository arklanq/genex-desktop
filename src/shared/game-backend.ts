/**
 * A game's own backend: a server process the game declares in studio.json (`backend`). The studio
 * runs one instance per copy of the game — the game folder Live shows, and each worker's worktree
 * — each on a port of its own, and tells that copy's page where its instance is. Browser-safe; the
 * substrate parses the declaration and `main/core/game-backends.ts` runs the instances.
 */
import { MINUTE_MS, SECOND_MS } from "./duration.ts";

/** Where one backend instance is. Wire values: never rename one. */
export const GameBackendState = {
  /** Not running: never started, stopped on request, or stopped after it sat unused. */
  Stopped: "stopped",
  /** Started, waiting for its health check to answer. */
  Starting: "starting",
  /** Its health check answered: pages showing its copy of the game may reach its port. */
  Running: "running",
  /** It exited on its own, or never became healthy. */
  Failed: "failed",
} as const;
export type GameBackendState = (typeof GameBackendState)[keyof typeof GameBackendState];

/** Why a stopped instance is stopped. Wire values: never rename one. */
export const GameBackendStop = {
  /** Someone asked: a preview load does not start it again; only a start or restart does. */
  Request: "request",
  /** Nothing used it for {@link BACKEND_IDLE_STOP_MS}: the next load or tool call starts it again. */
  Idle: "idle",
} as const;
export type GameBackendStop = (typeof GameBackendStop)[keyof typeof GameBackendStop];

/**
 * The ports instances are given: above the system's reserved ports, and below the ones the preview
 * serves bundled games' files on (`loopbackPortFor`, 40000 up), so an instance never shadows one.
 */
export const BACKEND_PORT_MIN = 20_000;
export const BACKEND_PORT_MAX = 39_999;
/** The path the studio asks when studio.json names no health check. */
export const DEFAULT_BACKEND_HEALTH = "/health";
/** How long the studio waits for a backend to answer its health check when studio.json names no time. */
export const DEFAULT_BACKEND_BOOT_MS = MINUTE_MS;
/** The shortest boot wait studio.json may ask for. */
export const MIN_BACKEND_BOOT_MS = SECOND_MS;
/** The longest boot wait studio.json may ask for: a first Docker image pull is slow, but not endless. */
export const MAX_BACKEND_BOOT_MS = 5 * MINUTE_MS;
/** An instance no window shows and no session works in is stopped after this long. */
export const BACKEND_IDLE_STOP_MS = 10 * MINUTE_MS;

/** studio.json's `backend`, checked: how to start the server and how to tell it is up. */
export interface GameBackendSpec {
  /** Shell command run in the game's copy, inside the studio's sandbox; it listens on `PORT`. */
  command: string;
  /** Path that answers 2xx once the server is ready. */
  health: string;
  /** The server starts containers (testcontainers): it needs the Docker socket. */
  docker: boolean;
  /** How long to wait for the health check, in milliseconds. */
  bootMs: number;
}

/** Where a page reaches its instance: what the studio puts on the page as `window.__studioBackend`. */
export interface GameBackendOrigin {
  /** `http://localhost:<port>` */
  http: string;
  /** `ws://localhost:<port>` */
  ws: string;
}

/** The origin a page uses for an instance on `port`. */
export function backendOrigin(port: number): GameBackendOrigin {
  return { http: `http://localhost:${port}`, ws: `ws://localhost:${port}` };
}

/** What `game.backendStatus` and the backend tools report about one instance. */
export interface GameBackendStatus {
  project: string;
  /** The copy of the game this instance serves: the game folder, or a worktree (a real path). */
  root: string;
  /** studio.json in that copy declares a backend this studio can run. */
  declared: boolean;
  state: GameBackendState;
  /** Why a stopped instance is stopped; null otherwise. */
  stoppedBy: GameBackendStop | null;
  /** The port this instance was given, once it has one. */
  port: number | null;
  /** Where its pages reach it while it runs. */
  origin: GameBackendOrigin | null;
  /** The process id while it runs. */
  pid: number | null;
  /** When the current (or last) process started, as an ISO time. */
  startedAt: string | null;
  /** The exit code of a process that has ended. */
  exitCode: number | null;
  /** Why it is not running: a refused declaration, a failed health check, an exit, a limit. */
  error: string | null;
}
