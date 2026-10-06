/**
 * A game's own backend: a server process the game declares in studio.json (`backend`), which the
 * studio starts in its sandbox and lets the game's page reach on one loopback port. Browser-safe;
 * the substrate parses the declaration and `main/core/game-backends.ts` runs the process.
 */
import { MINUTE_MS, SECOND_MS } from "./duration.ts";

/** Where a game's backend is. Wire values: never rename one. */
export const GameBackendState = {
  /** Not running: never started, or stopped on request. */
  Stopped: "stopped",
  /** Started, waiting for its health check to answer. */
  Starting: "starting",
  /** Its health check answered: the game's page may reach its port. */
  Running: "running",
  /** It exited on its own, or never became healthy. */
  Failed: "failed",
} as const;
export type GameBackendState = (typeof GameBackendState)[keyof typeof GameBackendState];

/**
 * The lowest port a backend may declare: the ports below need root, and none of them is a game's.
 */
export const BACKEND_PORT_MIN = 1024;
/**
 * The highest port a backend may declare. The preview serves a bundled game's files on a loopback
 * port of its own from 40000 up (`loopbackPortFor`); a backend there could shadow one.
 */
export const BACKEND_PORT_MAX = 39_999;
/** The path the studio asks when studio.json names no health check. */
export const DEFAULT_BACKEND_HEALTH = "/health";
/** How long the studio waits for a backend to answer its health check when studio.json names no time. */
export const DEFAULT_BACKEND_BOOT_MS = MINUTE_MS;
/** The shortest boot wait studio.json may ask for. */
export const MIN_BACKEND_BOOT_MS = SECOND_MS;
/** The longest boot wait studio.json may ask for: a first Docker image pull is slow, but not endless. */
export const MAX_BACKEND_BOOT_MS = 5 * MINUTE_MS;

/** studio.json's `backend`, checked: how to start the server and how to tell it is up. */
export interface GameBackendSpec {
  /** Shell command run in the game folder, inside the studio's sandbox. */
  command: string;
  /** The loopback port the server listens on; it also gets it as `PORT`. */
  port: number;
  /** Path on that port that answers 2xx once the server is ready. */
  health: string;
  /** The server starts containers (testcontainers): it needs the Docker socket. */
  docker: boolean;
  /** How long to wait for the health check, in milliseconds. */
  bootMs: number;
}

/** What `backend.status` and the backend tools report about one game's backend. */
export interface GameBackendStatus {
  project: string;
  /** studio.json declares a backend this studio can run. */
  declared: boolean;
  state: GameBackendState;
  /** The declared port, when there is a declaration. */
  port: number | null;
  /** The process id while it runs. */
  pid: number | null;
  /** When the current (or last) process started, as an ISO time. */
  startedAt: string | null;
  /** The exit code of a process that has ended. */
  exitCode: number | null;
  /** Why it is not running: a refused declaration, a busy port, a failed health check, an exit. */
  error: string | null;
}
