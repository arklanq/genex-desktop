/**
 * Reading a game's `backend` declaration from its studio.json. The file sits in the folder agents
 * write, so every field is checked here and a declaration that is not plain is refused with a
 * reason instead of being half-used.
 */
import path from "node:path";
import {
  DEFAULT_BACKEND_BOOT_MS,
  DEFAULT_BACKEND_HEALTH,
  type GameBackendSpec,
  MAX_BACKEND_BOOT_MS,
  MIN_BACKEND_BOOT_MS,
} from "../shared/game-backend.ts";
import { readJsonIfExists } from "./fsx.ts";

/** The longest command line a declaration may carry. */
const MAX_COMMAND_LENGTH = 1000;
/** A health path: absolute (one leading slash), URL-safe characters only, no query or fragment. */
const HEALTH_PATH = /^\/(?!\/)[A-Za-z0-9._~/-]*$/;

/** Why a declaration was refused, in the words a tool result shows. */
const MESSAGE = {
  NotObject: "studio.json backend must be an object",
  Command: "studio.json backend.command must be a non-empty command line",
  Health: "studio.json backend.health must be a path such as /health",
  Docker: "studio.json backend.docker must be true or false",
  BootMs: "studio.json backend.bootMs must be a number of milliseconds",
} as const;

/** A declaration read from studio.json: none, a usable spec, or a refusal with its reason. */
export type BackendDeclaration =
  | { declared: false }
  | { declared: true; spec: GameBackendSpec }
  | { declared: true; problem: string };

/** studio.json's `backend` as written: every field unchecked until it is used. */
interface RawBackend {
  command?: unknown;
  health?: unknown;
  docker?: unknown;
  bootMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCommand(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_COMMAND_LENGTH;
}

/** The boot wait, clamped to the allowed range; null when the value is not a number at all. */
function bootMsOf(value: unknown): number | null {
  if (value === undefined) return DEFAULT_BACKEND_BOOT_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_BACKEND_BOOT_MS, Math.max(MIN_BACKEND_BOOT_MS, Math.round(value)));
}

/** The first field of a declaration that is not usable, or null when all of them are. */
function backendProblem(raw: RawBackend): string | null {
  if (!validCommand(raw.command)) return MESSAGE.Command;
  const health = raw.health === undefined ? DEFAULT_BACKEND_HEALTH : raw.health;
  if (typeof health !== "string" || !HEALTH_PATH.test(health)) return MESSAGE.Health;
  if (raw.docker !== undefined && typeof raw.docker !== "boolean") return MESSAGE.Docker;
  if (bootMsOf(raw.bootMs) === null) return MESSAGE.BootMs;
  return null;
}

/** Check studio.json's `backend` value. Absent (or null) means the game declares no backend. */
export function parseBackendDeclaration(raw: unknown): BackendDeclaration {
  if (raw === undefined || raw === null) return { declared: false };
  if (!isRecord(raw)) return { declared: true, problem: MESSAGE.NotObject };
  const problem = backendProblem(raw);
  if (problem) return { declared: true, problem };
  return {
    declared: true,
    spec: {
      command: (raw.command as string).trim(),
      health: typeof raw.health === "string" ? raw.health : DEFAULT_BACKEND_HEALTH,
      docker: raw.docker === true,
      bootMs: bootMsOf(raw.bootMs) ?? DEFAULT_BACKEND_BOOT_MS,
    },
  };
}

/** The backend a game folder declares in its studio.json; a missing or unreadable file declares none. */
export async function readBackendDeclaration(dir: string): Promise<BackendDeclaration> {
  const meta = await readJsonIfExists<{ backend?: unknown }>(path.join(dir, "studio.json")).catch(() => null);
  return parseBackendDeclaration(meta?.backend);
}
