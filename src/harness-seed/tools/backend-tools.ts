/**
 * The game's own server — a `backend` the game declares in its studio.json:
 *
 *   "backend": { "command": "bun run server", "port": 3001, "health": "/health", "docker": false }
 *
 * The studio starts the command in the game folder, inside its sandbox, with `PORT` set, waits for
 * the health path to answer 2xx and only then lets the game's page reach that one port (http and
 * ws). The game's page calls `http://localhost:<port>` and the server answers CORS for the page's
 * origin. After editing server code, restart it here: nothing restarts it on its own, and a
 * preview reload does not either.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";

/** How many log lines backend_logs reads back when the call names none. */
const DEFAULT_LOG_LINES = 80;

const str = (description: string) => ({ type: "string", description });
const projectParameters = {
  type: "object",
  properties: { project: str("game folder name; defaults to this chat's game") },
};

/** The game a backend tool acts on: the chat's own, or the one named when the chat has none. */
function backendProject(args: AnyRecord, ctx: ToolCtx): { project?: string; error?: string } {
  if (ctx.project && args.project && args.project !== ctx.project)
    return { error: `This chat is pinned to "${ctx.project}". Do not touch the backend of "${args.project}".` };
  const project = ctx.project || args.project;
  return project ? { project: String(project) } : { error: "Name the game (project)." };
}

/** One status line an agent can act on. */
function describe(status: AnyRecord): string {
  const where = status.port ? ` on port ${status.port}` : "";
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
    parameters: projectParameters,
    async execute(args, ctx) {
      const { project, error } = backendProject(args, ctx);
      if (!project) return { ok: false, content: error };
      const status = await ctx.call(method, { project });
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
        project: str("game folder name; defaults to this chat's game"),
        lines: { type: "number", description: `how many lines, default ${DEFAULT_LOG_LINES}` },
      },
    },
    async execute(args, ctx) {
      const { project, error } = backendProject(args, ctx);
      if (!project) return { ok: false, content: error };
      const lines = await ctx.call(HostMethod.GameBackendLogs, { project, lines: args.lines ?? DEFAULT_LOG_LINES });
      return lines.length ? lines.join("\n") : "The backend has printed nothing.";
    },
  },
];
