/**
 * `game_backend`: the host tool a delegated builder (a worker's Claude or Codex session, the chat's
 * contractor, a build's lead) uses on the game's own server. It always acts on the instance of the
 * copy the session works in — its worktree, or the game folder — so a worker can start, stop,
 * restart and read only its own instance, never another worker's.
 */
import { GameBackendState, type GameBackendStatus } from "../../shared/game-backend.ts";
import type { DelegateRequest, LiveToolResult } from "../../substrate/engines/types.ts";
import type { GameBackends } from "./game-backends.ts";

/** The tool's name, as the session sees it (`mcp__studio__game_backend` for Claude). */
export const BACKEND_TOOL_NAME = "game_backend";
/** How many log lines `logs` reads back when the call names none. */
const DEFAULT_LOG_LINES = 80;

/** What the tool can do. Wire values: never rename one. */
export const BackendAction = {
  Status: "status",
  Start: "start",
  Stop: "stop",
  Restart: "restart",
  Logs: "logs",
} as const;
export type BackendAction = (typeof BackendAction)[keyof typeof BackendAction];

const ACTIONS: readonly string[] = Object.values(BackendAction);

/** The tool as the session is handed it. */
export const BACKEND_TOOL: NonNullable<DelegateRequest["liveTools"]>[number] = {
  name: BACKEND_TOOL_NAME,
  description: [
    "The game's own server (studio.json `backend`), for the copy of the game you work in: your worktree has an instance of its own, with its own port, data folder and containers.",
    "It starts the first time your copy is previewed. The page finds it at `window.__studioBackend` ({ http, ws }); never hard-code a port.",
    "After editing server code or studio.json `backend`, call restart, then reload or re-capture the game. Use logs to see why it failed.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "status | start | stop | restart | logs" },
      lines: { type: "number", description: `logs: how many lines, default ${DEFAULT_LOG_LINES}` },
    },
    required: ["action"],
  },
};

/** One status line a model can act on. */
export function describeBackend(status: GameBackendStatus): string {
  const where = status.origin ? ` at ${status.origin.http}` : "";
  const pid = status.pid ? ` (pid ${status.pid})` : "";
  const error = status.error ? `\n${status.error}` : "";
  return `Backend ${status.state}${where}${pid}.${error}`;
}

/** Run one call of the tool against the instance of `root`, the session's own copy. */
export async function runBackendTool(
  backends: GameBackends,
  project: string,
  root: string,
  args: Record<string, unknown>,
): Promise<LiveToolResult> {
  const action = String(args.action ?? "");
  if (!ACTIONS.includes(action)) return { text: `action must be one of: ${ACTIONS.join(", ")}`, isError: true };
  if (action === BackendAction.Logs) {
    const lines = await backends.logs(root, typeof args.lines === "number" ? args.lines : DEFAULT_LOG_LINES);
    return lines.length ? lines.join("\n") : "The backend has printed nothing.";
  }
  const status = await statusAfter(backends, project, root, action as BackendAction);
  const failed = status.state === GameBackendState.Failed || (status.error !== null && !status.declared);
  return { text: describeBackend(status), ...(failed ? { isError: true } : {}) };
}

function statusAfter(
  backends: GameBackends,
  project: string,
  root: string,
  action: BackendAction,
): Promise<GameBackendStatus> {
  if (action === BackendAction.Start) return backends.start(project, root);
  if (action === BackendAction.Stop) return backends.stop(project, root);
  if (action === BackendAction.Restart) return backends.restart(project, root);
  return backends.status(project, root);
}
