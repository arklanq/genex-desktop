/**
 * The game's own server — a `backend` the game declares in its studio.json:
 *
 *   "backend": { "command": "bun run server", "health": "/health", "docker": false }
 *
 * Every copy of the game — the game folder, each worker's worktree — gets its own instance: its
 * own process, port, data folder (`GENEX_BACKEND_DATA`) and containers. The studio starts it in
 * the copy's folder, inside its sandbox, with `PORT` set, and the first time a preview loads that
 * copy. The page reads where its instance is from `window.__studioBackend` ({ http, ws }) — never
 * a fixed port — and falls back to its own address outside the studio; the server answers CORS for
 * the page's origin. After editing server code, restart it here: a preview reload does not.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";

/** How many log lines backend_logs reads back when the call names none. */
const DEFAULT_LOG_LINES = 80;

const str = (description: string) => ({ type: "string", description });
const copyProperties = {
  project: str("game folder name; defaults to this chat's game"),
  root: str("the worktree whose instance to act on; omit for the game folder"),
};
const copyParameters = { type: "object", properties: copyProperties };

/** The copy a call names: its worktree, when it names one. */
function copyOf(args: AnyRecord): { root?: string } {
  return typeof args.root === "string" && args.root ? { root: args.root } : {};
}

/** The game a backend tool acts on: the chat's own, or the one named when the chat has none. */
function backendProject(args: AnyRecord, ctx: ToolCtx): { project?: string; error?: string } {
  if (ctx.project && args.project && args.project !== ctx.project)
    return { error: `This chat is pinned to "${ctx.project}". Do not touch the backend of "${args.project}".` };
  const project = ctx.project || args.project;
  return project ? { project: String(project) } : { error: "Name the game (project)." };
}

/** One status line an agent can act on. */
function describe(status: AnyRecord): string {
  const where = status.origin ? ` at ${status.origin.http}` : "";
  const pid = status.pid ? ` (pid ${status.pid})` : "";
  const error = status.error ? `\n${status.error}` : "";
  return `Backend ${status.state}${where}${pid}.${error}`;
}

/** The backend host methods that answer a status. */
type StatusMethod =
  | typeof HostMethod.GameBackendStatus
  | typeof HostMethod.GameBackendStart
  | typeof HostMethod.GameBackendStop
  | typeof HostMethod.GameBackendRestart;

/** A tool that runs one backend host method and reports the status it answers. */
function statusTool(name: string, description: string, method: StatusMethod): HarnessTool {
  return {
    name,
    description,
    parameters: copyParameters,
    async execute(args, ctx) {
      const { project, error } = backendProject(args, ctx);
      if (!project) return { ok: false, content: error };
      const status = await ctx.call(method, { project, ...copyOf(args) });
      return { ok: !status.error, content: describe(status), details: { ...status } };
    },
  };
}

export const tools: HarnessTool[] = [
  statusTool(
    "backend_status",
    "Is the game's own server (studio.json `backend`) running? Says its port, or why it is not running.",
    HostMethod.GameBackendStatus,
  ),
  statusTool(
    "start_backend",
    "Start the game's own server from studio.json `backend` and wait for its health check. Leaves a running server as it is.",
    HostMethod.GameBackendStart,
  ),
  statusTool("stop_backend", "Stop the game's own server and everything it started.", HostMethod.GameBackendStop),
  statusTool(
    "restart_backend",
    "Restart the game's own server after editing its code or studio.json `backend`, then reload the preview.",
    HostMethod.GameBackendRestart,
  ),
  {
    name: "backend_logs",
    description: "Read the last lines the game's own server printed (stdout and stderr), to see why it failed.",
    parameters: {
      type: "object",
      properties: {
        ...copyProperties,
        lines: { type: "number", description: `how many lines, default ${DEFAULT_LOG_LINES}` },
      },
    },
    async execute(args, ctx) {
      const { project, error } = backendProject(args, ctx);
      if (!project) return { ok: false, content: error };
      const lines = await ctx.call(HostMethod.GameBackendLogs, {
        project,
        ...copyOf(args),
        lines: args.lines ?? DEFAULT_LOG_LINES,
      });
      return lines.length ? lines.join("\n") : "The backend has printed nothing.";
    },
  },
];
