# Game backends

A game may bring its own server. The studio starts it in the sandbox, lets the game's page reach
its one loopback port, and gives agents tools to start, stop, restart it and read its output.

## Declaring one

The game's `studio.json` names the server under `backend`:

```json
{
  "backend": {
    "command": "bun run server",
    "port": 3001,
    "health": "/health",
    "docker": false,
    "bootMs": 60000
  }
}
```

| Field | Meaning |
| --- | --- |
| `command` | Shell command run in the live game folder, inside `ProcessSandbox`. Required. |
| `port` | Loopback port the server listens on, 1024–39999; the server also gets it as `PORT`. Required. |
| `health` | Path that answers 2xx once the server is ready. Default `/health`. |
| `docker` | The server starts containers (testcontainers) and needs the Docker socket. Default `false`. |
| `bootMs` | How long to wait for the health check: 1 s to 5 min, default 1 min. |

[`src/substrate/game-backend-spec.ts`](../src/substrate/game-backend-spec.ts) checks every field and
refuses a declaration that is not plain with the field's name. Ports from 40000 up are refused
because the preview serves bundled games' files there (`loopbackPortFor`). The server also gets
`GENEX_BACKEND=1`.

The page calls `http://localhost:<port>` or opens `ws://localhost:<port>`. Its origin is
`game://<project>` or the game's own loopback origin, so the server answers CORS for it, as it
would for a separate dev server outside the studio.

## Lifecycle

[`GameBackends`](../src/main/core/game-backends.ts) (`core.backends`) owns the processes:

1. **Start.** A port that anything already answers on, or that another game's backend holds, is
   refused before a process starts. The command starts through `ProcessSandbox.spawnLongLived`.
2. **Health.** The service asks the health path every 250 ms until it answers 2xx, the process
   exits or `bootMs` runs out. Only then is the port opened to game pages (`openBackendPort` in
   [`src/main/preview.ts`](../src/main/preview.ts)). A server that never answers is stopped.
3. **Running.** Both output streams are kept, the last 500 lines. An exit closes the port at once
   and records the code and the last lines.
4. **Stop.** The port closes first, then the process group gets SIGTERM and, after 5 s, SIGKILL.

The first preview load of a game in an app session starts its backend (`ensureStarted`); a failure
becomes one console line on the page, so the harness reads why the game's requests fail. After
that nothing restarts it on its own: a backend someone stopped stays stopped, and a failed one waits
for a restart after the fix. `StudioCore.stop` stops every backend.

## Network

`gameRequestAllowed` and `routeHttp` in [`src/main/page-serve.ts`](../src/main/page-serve.ts) take
the set of running backend ports. A game page may reach those ports over plain http and `ws:` on
`localhost` or `127.0.0.1`, and nothing else on loopback; navigation to a backend is never
allowed. The preview's `http` protocol handler passes a backend port's requests to the server with
`net.fetch`; WebSockets are not intercepted, so the request filter alone decides them.

## Agents

The host methods `game.backendStatus`, `game.backendStart`, `game.backendStop`,
`game.backendRestart` and `game.backendLogs` take a library game's name and always act on its live
folder, never a worktree. The seed's [`backend-tools.ts`](../src/harness-seed/tools/backend-tools.ts)
wraps them as `backend_status`, `start_backend`, `stop_backend`, `restart_backend` and
`backend_logs`; a chat pinned to a game can touch only that game's backend. Agents edit server code
like any other file and restart the backend themselves: a preview reload does not restart it.

## Docker

A backend that declares `docker` starts only when the app was launched with
`STUDIO_ALLOW_GAME_BACKEND_DOCKER=1`; otherwise its status says so. With the switch on it may connect
to Docker Desktop's socket (`~/.docker/run/docker.sock` and `/var/run/docker.sock`), so
testcontainers can start a database and its Ryuk container removes it when the backend exits.

sandbox-runtime reads Unix socket grants only from its process-wide config, never from a run's
overlay, and bakes them into a command's Seatbelt profile when it wraps the command. So
`ProcessSandbox` wraps commands one at a time (`#wrapInTurn`), sets the grant process-wide only for
the wrap of the run that asked, and puts the config back after. Other commands, wrapped before or
after, never get the socket. Grants are path-based on macOS only.

### Residual risk

The Docker daemon can mount any folder of this Mac into a container, and the backend runs
agent-written code. The switch is therefore the person's, outside every game, and off by default;
no other sandboxed process gets the socket.

## Limits

- One backend per game, run from the live folder; a facet worktree's server changes reach it only
  after landing.
- No Live UI control yet: agents and the first load start it.
- Windows is untested; Linux has no path-based Unix socket grant, so `docker` backends are macOS only.
