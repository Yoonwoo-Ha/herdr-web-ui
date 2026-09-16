# herdr-br

A self-hosted **browser version of the [herdr](https://herdr.dev) terminal**: your live herdr
workspaces, tabs and panes in a web UI, with real terminal output rendered by xterm.js and
keystrokes routed back into the live pane.

Inspired architecturally by [chatmux](https://github.com/devswha/chatmux), with one decisive
difference: chatmux spawns its own ptys via `node-pty`, whereas **herdr already owns the pty**.
herdr-br therefore spawns nothing — it is a pure bridge over herdr's unix-socket API.

## Requirements

- [Bun](https://bun.sh) 1.4+
- A running herdr 0.9.0 server (socket at `~/.config/herdr/herdr.sock`)

## Run

```bash
bun install
bun run start          # builds the client, then serves on http://localhost:7317
```

Development, with hot reload on the client:

```bash
bun run server         # API + WebSocket on :7317
bun run dev            # Vite on :5173, proxying /api and /ws to :7317
```

Override the port with `PORT=8080 bun run server`, and the socket with `HERDR_SOCKET=/path/to.sock`.

## How it works

herdr exposes a newline-delimited JSON API over a unix socket. Two traits of that protocol shape
this app:

1. **The server closes the connection after every response**, so each RPC opens its own short-lived
   connection (`server/herdr/client.ts`). A pooled client would hang waiting for a second reply.
2. **`events.subscribe` is the exception** — it holds the connection open and streams frames. That
   is the live channel.

So the bridge (`server/index.ts`) keeps one herdr subscription per watched pane, fans its events out
to every browser client watching that pane, and re-reads the pane with `format: "ansi"` on each
revision bump. Reads are coalesced drop-to-latest — one in-flight read per pane — because a busy
agent pane emits far more events than are worth re-reading. The browser repaints the xterm viewport
with the full screen each time, which is also what makes alternate-screen agent TUIs render correctly.

Typing in the browser goes the other way: `term.onData` -> WebSocket -> `pane.send_text`.

## Layout

| Path | Role |
| --- | --- |
| `shared/protocol.ts` | Types shared by server and client; the HTTP/WS contract |
| `server/herdr/client.ts` | herdr unix-socket client: RPC + event subscriptions |
| `server/index.ts` | Bun.serve HTTP API, WebSocket fan-out, static client |
| `src/components/PaneTerminal.tsx` | xterm.js view and input routing |
| `src/components/Sidebar.tsx` | Workspace/tab/pane tree with agent-status badges |

## API

```
GET  /api/health                    -> { ok, herdr: { version, protocol } }
GET  /api/session                   -> { snapshot }
GET  /api/pane/read?pane_id=&source=&format=&lines=
POST /api/pane/input  { pane_id, text }
POST /api/pane/keys   { pane_id, keys }
WS   /ws                            -> snapshot | pane-output | pane-status | error
```

## Tests

```bash
bun test          # runs against the live herdr server, read-only
bun run typecheck
bun run build
```

The suite talks to the real herdr socket rather than a mock, because the protocol behaviours that
matter here (one-shot connections, streaming subscriptions, coded errors) only exist on the real
server. Tests never write into a pane they did not create.

## Licence

MIT
