<p align="center">
  <img src="public/social-preview.png" width="960" alt="herdr web ui — Your agents. Any screen. A ram with a terminal prompt, browser window and pointer.">
</p>

<h1 align="center">herdr web ui</h1>

<p align="center">Chat with your coding agents. Open the live terminal. Pick up from your phone.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/Bun-1.4%2B-black" alt="Bun 1.4+">
  <img src="https://img.shields.io/badge/herdr-0.9.0%2B-6cb6ff" alt="herdr 0.9.0+">
  <img src="https://img.shields.io/badge/PWA-installable-4ec9a5" alt="Installable PWA">
</p>

A browser and mobile client for [herdr](https://github.com/herdrdev/herdr). Connect to a running herdr server to follow your agents, send prompts, answer supported approval menus and work in the same terminal from another screen.

The **Chat** and **Terminal** views share one live pane. herdr owns the sessions and terminal processes; this app adds a web interface through herdr's socket API and `herdr terminal attach`.

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#chat-and-terminal">Chat &amp; terminal</a> ·
  <a href="#use-it-on-your-phone">Mobile</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a>
</p>

## Chat and terminal

| | What you can do |
| --- | --- |
| **Read the conversation** | See prompts and Markdown answers, with commands, edits and progress grouped into an expandable work block. Copy answers as Markdown or plain text. |
| **See the active model** | View the model name and reasoning effort reported by the session beside the composer. Missing metadata stays unknown. Thinking summaries are optional. |
| **Keep the real terminal** | Switch to xterm.js for full-screen TUIs, raw output, keyboard input and herdr's scrollback. |
| **Answer prompts** | Respond to supported approval, question and plan menus in chat. The server checks that the prompt is still current before answering. |
| **Compose comfortably** | Complete `/` commands and `@` file mentions. Paste, pick or drop images. Keep drafts per pane and queue the next message while an agent works. |
| **Manage sessions** | Create a session with an agent and directory, rename workspaces and panes, reorder workspaces, and find panes through the command palette. |
| **Follow every agent** | See status updates across all panes. Enable alerts when an agent needs input, finishes or its terminal ends. |
| **Make it yours** | Choose light, dark or system theme, compact density, terminal font size, Enter behavior and thinking visibility. |

### Transcript support

| Agent | Chat source |
| --- | --- |
| **Codex** | Native rollout JSONL, with tool results and commentary/final phases. Internal context records and duplicate event/model messages are filtered. |
| **Claude Code** | Native conversation transcript resolved through herdr. |
| **omp / omo** | Native session JSONL; omo is identified through the pane's process tree. |
| **Other or unresolved sessions** | Terminal-text fallback; switch to Terminal for the full TUI. |

Structured chat depends on finding the correct local session file. Codex session resolution validates pane/session evidence instead of selecting an arbitrary recent session in the same directory. Model and reasoning labels come from recorded metadata; they are not inferred from answer text.

Interactive prompt support depends on the agent's visible menu format. For unsupported menus, use Terminal. See the [chat-mode audit](docs/chat-mode-audit.md) for implementation details and verification.

## Get started

You need **Bun 1.4+**, **Node 18+**, and a running **herdr 0.9.0+** server. The `herdr` CLI must be on `PATH`. herdr is a separate project and is not bundled here. Node runs the terminal-attach sidecar.

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install
HOST=127.0.0.1 bun run start
```

Open **http://localhost:7317**. The start command builds the client and launches the API/WebSocket server. It connects to `~/.config/herdr/herdr.sock` by default.

### Install as a herdr plugin

```bash
herdr plugin install devswha/herdr-web-ui
```

The plugin builds the app and starts it with herdr. You can also control it directly:

```bash
herdr plugin action invoke devswha.herdr-web-ui.start
herdr plugin action invoke devswha.herdr-web-ui.status
herdr plugin action invoke devswha.herdr-web-ui.stop
```

`start` leaves an already running server alone. The plugin defaults to `127.0.0.1`, keeps its PID and log under `HERDR_PLUGIN_STATE_DIR`, and follows the socket herdr supplies for the current session.

Plugin configuration lives in an `env` file in the directory printed by:

```bash
herdr plugin config-dir devswha.herdr-web-ui
```

Add `KEY=value` lines for the variables below. Protect that file if it contains a token. Plugin commands inherit herdr's environment, so use this file for persistent settings.

## Use it on your phone

Serve the app over **HTTPS** to install it and receive Web Push notifications. For example, with Tailscale configured on your devices:

```bash
HOST=127.0.0.1 HERDR_WEB_TOKEN='replace-with-a-long-random-token' bun run start
tailscale serve --bg --https=443 http://127.0.0.1:7317
```

Open the HTTPS address and enter your token. In Safari, choose **Share → Add to Home Screen**; in Chrome, choose **Install app**. A plain HTTP LAN address can display the app, but does not provide the secure context required for installation and push.

The phone layout includes a touch key bar with Esc, Tab, Ctrl, arrows and Ctrl+C. It follows the software keyboard and safe-area insets. Dragging the terminal scrolls the real herdr pane.

Tap the bell to enable notifications for that device. On iPhone, Web Push requires iOS 16.4+ and the installed home-screen app. The bridge must remain running to send alerts. Keep `HERDR_WEB_STATE_DIR` across restarts: it holds the VAPID key and device subscriptions.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` for direct runs; `127.0.0.1` for the plugin | Bind address |
| `PORT` | `7317` | HTTP and WebSocket port |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | Socket used by both API calls and terminal attach |
| `HERDR_WEB_TOKEN` | unset | Shared token protecting terminal access |
| `HERDR_WEB_STATE_DIR` | `~/.config/herdr-web-ui` | Persistent push keys and subscriptions |
| `HERDR_WEB_PUSH_SUBJECT` | This repository's URL | VAPID contact URL or `mailto:` address |

Set `HERDR_SOCKET` to `~/.config/herdr/sessions/<name>/herdr.sock` to select a named herdr session.

### Access and connection behavior

Anyone with access to an ungated server, or with its shared token, can operate the attached terminals. Use a token and HTTPS for remote access, or bind to loopback and use an SSH tunnel.

With a token configured, private API routes and WebSocket connections require authentication. Browser sign-in uses an HttpOnly, SameSite=Strict cookie; scripts can use `Authorization: Bearer <token>`. The shell, health endpoint and sign-in route remain public. A TLS proxy should send `x-forwarded-proto: https` so the cookie is marked Secure.

Input typed during a disconnect waits as a reviewable draft. Reconnecting does not silently send it. Queued messages wait through approval and question menus before sending when the agent is ready.

The app uses an interactive connection. The WebSocket protocol also supports server-enforced `observe` clients that cannot type or resize; there is no observe-mode toggle in the app. Attachments never use `--takeover`. A separate web server cannot attach a pane already held by another web server.

## Keyboard shortcuts

`Mod` means **⌘** on macOS and **Ctrl** elsewhere.

| Shortcut | Action |
| --- | --- |
| `Mod+Shift+K` | Command palette |
| `Mod+Shift+J` | Switch Chat / Terminal |
| `Mod+Shift+B` | Toggle sidebar |
| `Mod+Shift+N` | New session |
| `Mod+Shift+↑` / `↓` | Previous / next pane |
| `Mod+Shift+,` | Settings |

Choose Enter or Mod+Enter to send in Settings. Shift+Enter inserts a newline when Enter sends.

## How it works

The React client talks to a Bun HTTP/WebSocket bridge. The bridge reads workspace and agent state through herdr's Unix socket and forwards the real terminal-attach stream through a Node PTY sidecar. Chat reads local agent transcripts; sending still reaches the same live pane.

One attachment is shared by browsers viewing the same pane. Output has a bounded replay tail and backpressure; a stalled client is disconnected rather than accumulating unlimited output. herdr owns scrollback. See [terminal flow control](docs/terminal-flow-control.md) for the protocol and limits.

The service worker caches the app shell and static assets. It does not intercept `/api` or `/ws`; working with live terminals requires a connection. OSC 52 clipboard handling is wired, but herdr 0.9.x consumes those sequences before they reach the browser.

## Development

Run the backend and Vite in separate terminals:

```bash
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

```bash
bun run typecheck
bun run build
bun test
bun run test:ui
bun scripts/chat-browser-qa.ts
```

Integration tests require a live herdr server. They create and clean up their own test workspaces and use temporary push state. Browser checks use isolated test servers and panes; set `CHROME_PATH` if Chrome is not at `/opt/google/chrome/chrome`.

After a herdr upgrade, refresh the generated wire types:

```bash
bun run generate:types --refresh
bun run generate:types --check
```

| Path | Contents |
| --- | --- |
| [`src/`](src/) | React UI, chat, terminal, composer and settings |
| [`server/`](server/) | API, WebSockets, transcript readers, push and PTY bridge |
| [`shared/protocol.ts`](shared/protocol.ts) | Shared HTTP/WebSocket contract |
| [`scripts/`](scripts/) | Plugin lifecycle, type generation and browser checks |
| [`public/`](public/) | PWA manifest, service worker and app icons |
| [`docs/brand/`](docs/brand/) | Original artwork and icon/social-preview export instructions |
| [`DESIGN.md`](DESIGN.md) | UI tokens and design conventions |

## License

[MIT](LICENSE). Copyright © 2026 devswha.

[herdr](https://github.com/herdrdev/herdr) is a separate Apache-2.0 project. The browser bridge and chat experience take inspiration from [chatmux](https://github.com/devswha/chatmux).
