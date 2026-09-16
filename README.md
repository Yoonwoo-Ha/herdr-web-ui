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

herdr exposes a newline-delimited JSON API over a unix socket. Two traits of that
protocol shape this app:

1. **The server closes the connection after every response**, so each RPC opens its own
   short-lived connection (`server/herdr/client.ts`). A pooled client would hang waiting
   for a second reply.
2. **`events.subscribe` is the exception** — it holds the connection open and streams
   frames. That carries agent-status changes.

The terminal itself is not built on that JSON API. herdr ships a real attach client, and
herdr-br runs it: `herdr terminal attach <terminal_id>` on a PTY, with the raw bytes
forwarded to xterm.js over the WebSocket and the user's keystrokes forwarded back. Reading
the pane with `pane.read` on a timer was the obvious alternative and is worse — it caps at
1000 lines per read and can only ever repaint the current viewport, so history and
selection are gone.

Three consequences worth knowing:

- **No `--takeover`.** herdr 0.9.0 lets attaches coexist, verified by attaching twice to
  one terminal, so herdr-br never displaces whoever is already watching that terminal —
  including your own desktop TUI.
- **Scrollback is herdr's, not xterm's.** The attach stream enters the alternate screen
  (`CSI ?1049h`), where xterm.js disables its own scrollback by design. herdr also enables
  mouse reporting, so a wheel gesture in the browser is forwarded to herdr and scrolls the
  real pane — which is what makes scrollback work for full-screen agent TUIs too.
- **The PTY lives in a Node sidecar** (`server/pty/pty-host.mjs`). Bun 1.4 has no PTY API
  (`Bun.spawn` ignores `pty`, `Bun.PTY` is undefined) and loading node-pty inside Bun panics
  the runtime (oven-sh/bun#18546), so the Bun server spawns a small Node process that owns
  the pty and speaks newline-JSON control frames on stdin.

Terminal geometry propagates: resizing the browser refits xterm, which resizes the pty,
which the shell in the pane sees as its own window size.

## Types are generated, not hand-written

herdr's wire types live in `shared/herdr-api.generated.ts`, generated from herdr's own
published schema:

```bash
bun run generate:types            # regenerate from scripts/herdr-schema.json
bun run generate:types --check    # fail if the committed output is stale
bun run generate:types --refresh  # re-read the schema from `herdr api schema --json`
```

`bun test` runs `--check`, so a herdr upgrade surfaces as a failing test instead of types
that quietly disagree with the server. String enums are widened with `(string & {})` so a
value from a newer herdr still decodes instead of breaking the parse.

This caught a real bug on day one: the hand-written `ReadSource` carried the CLI's
`recent-unwrapped` spelling, but the JSON API only accepts `recent_unwrapped` and rejects
the hyphenated form with `invalid_request`.

## Layout

| Path | Role |
| --- | --- |
| `shared/protocol.ts` | Types shared by server and client; the HTTP/WS contract |
| `shared/herdr-api.generated.ts` | herdr wire types, generated from its API schema |
| `scripts/generate-protocol-types.ts` | the generator and its `--check` freshness gate |
| `server/herdr/client.ts` | herdr unix-socket client: RPC + event subscriptions |
| `server/pty/` | PTY attach: Node sidecar host + the Bun-side session |
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
WS   /ws   client: attach | detach | input | keys | resize
           server: snapshot | pty-data | pty-exit | pane-status | error
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
