# Game backends

A game may bring its own server. The studio runs one instance of it per copy of the game — the
game folder Live shows, each worker's worktree, each optimizer candidate — in the sandbox, tells
each copy's page where its instance is, and lets that page reach only that instance.

## Declaring one

The game's `studio.json` names the server under `backend`:

```json
{
  "backend": {
    "command": "bun run server",
    "health": "/health",
    "docker": false,
    "bootMs": 60000
  }
}
```

| Field | Meaning |
| --- | --- |
| `command` | Shell command run in the copy's folder, inside `ProcessSandbox`. Required. |
| `health` | Path that answers 2xx once the server is ready. Default `/health`. |
| `docker` | The server starts containers (testcontainers) and needs the Docker socket. Default `false`. |
| `bootMs` | How long to wait for the health check: 1 s to 5 min, default 1 min. |

[`src/substrate/game-backend-spec.ts`](../src/substrate/game-backend-spec.ts) checks every field and
refuses a declaration that is not plain with the field's name. There is no port: the studio gives
each instance its own and the server reads it from the environment.

| Variable | Value |
| --- | --- |
| `PORT` | The port to listen on, from 20000–39999 (below the preview's own loopback ports). |
| `GENEX_BACKEND` | `1`. |
| `GENEX_BACKEND_INSTANCE` | The instance id: the project's name and a hash of the copy's path. |
| `GENEX_BACKEND_DATA` | A folder of its own for the instance's state, outside the copy's git tree. |

## The page

Before game code runs, the page shim defines `window.__studioBackend = { http, ws }` with the
instance's `http://localhost:<port>` and `ws://localhost:<port>`. The game reads it and falls back
to its own address outside the studio. A fixed port cannot work: Chromium does not let the
session redirect a WebSocket, and every copy has a different port. The server answers CORS for the
page's origin (`game://<project>` or the game's loopback origin), as it would for a separate dev
server.

## Instances

[`GameBackends`](../src/main/core/game-backends.ts) (`core.backends`) keys an instance by the
copy's real path, as `GameBuilds` and the delegations do.

- **Start.** The first time any window loads a copy (`ensureFor` in every load path of
  [`src/main/core/previews.ts`](../src/main/core/previews.ts): Live, the stand-in, builder,
  playtest and `look` windows, profiling), or when an agent asks. At most as many instances run as
  there are preview windows.
- **Health.** The health path is asked every 250 ms until it answers 2xx, the process exits or
  `bootMs` runs out. A server that never answers is stopped; its last output lines go into the
  status and onto the page's console.
- **Running.** Both output streams are kept, the last 500 lines. An exit records the code and the
  last lines, and what the sandbox wrapper left behind is killed.
- **Stop.** SIGTERM to the process group, SIGKILL after 5 s; a stop waits until the whole group is
  gone, so the port is free when it returns. A restart reuses the port while it is free, so a page
  that kept the old origin still reaches it.
- **Idle.** An instance no window shows, no session works in and no page has talked to for
  10 minutes stops; the next load or tool call starts it again. One someone stopped stays stopped,
  and a failed one waits for a restart after the fix.
- **Gone.** `snapshot.removeWorktree`, a worktree re-made in place and `optimization.close` discard
  the instance and its data folder. A landing restarts the game folder's instance when it runs.
  `StudioCore.stop` stops every instance.
- **Crash.** Running processes are recorded in `scratch/backends/instances.json`; the next start
  kills those that are still the same process (same id and start time, read with `ps`).

## Network

Each preview window has its own session, and `GamePreview` asks `GameBackends.portFor` with the
copy it shows (`backendRoot`, set per load) on every request. `gameRequestAllowed` and `routeHttp`
in [`src/main/page-serve.ts`](../src/main/page-serve.ts) then allow that one port over plain http
and `ws:` on `localhost` or `127.0.0.1`, and nothing else on loopback; navigation to it is never
allowed. The `http` protocol handler passes those requests to the server with `net.fetch`;
WebSockets are decided by the request filter alone. A worker's page cannot reach another copy's
instance, and loses its own the moment it stops.

## Agents

- **Delegated sessions** (workers, the chat's contractor, a build's lead) get the host tool
  `game_backend` ([`backend-tool.ts`](../src/main/core/backend-tool.ts); `mcp__studio__game_backend`
  for Claude) when their copy declares a backend. Its actions — `status`, `start`, `stop`,
  `restart`, `logs` — act only on the instance of the folder the session works in (a lead's, the
  build it leads).
- **The harness** calls `game.backendStatus`, `game.backendStart`, `game.backendStop`,
  `game.backendRestart` and `game.backendLogs` with a library game's name and an optional `root`
  (a worktree under scratch, checked by real path); the seed's
  [`backend-tools.ts`](../src/harness-seed/tools/backend-tools.ts) wraps them.

Agents edit server code like any other file and restart their instance themselves: a preview
reload does not restart it.

## Docker

A backend that declares `docker` starts only when the app was launched with
`STUDIO_ALLOW_GAME_BACKEND_DOCKER=1`; otherwise its status says so. With the switch on, each
instance may connect to Docker Desktop's socket (`~/.docker/run/docker.sock` and
`/var/run/docker.sock`), so testcontainers starts containers of its own for it, and its Ryuk
container removes them when the instance's process ends.

sandbox-runtime reads Unix socket grants only from its process-wide config, never from a run's
overlay, and bakes them into a command's Seatbelt profile when it wraps the command. So
`ProcessSandbox` wraps commands one at a time (`#wrapInTurn`), sets the grant process-wide only for
the wrap of the run that asked, and puts the config back after. Grants are path-based on macOS
only.

### Residual risk

The Docker daemon can mount any folder of this Mac into a container, and the backend runs
agent-written code. The switch is therefore the person's, outside every game, and off by default;
no other sandboxed process gets the socket.

## Limits

- No Live control for the instance yet: the first load and the agents start it.
- Windows is untested; Linux has no path-based Unix socket grant, so `docker` backends are macOS only.
