# Installing herdr web ui (guide for coding agents)

Follow these steps in order to install herdr web ui for a user. Run each command and check its output
before moving on. Every step says what success looks like. Stop and ask the user whenever a step says
**Ask**.

herdr web ui is a browser and phone client for [herdr](https://github.com/herdrdev/herdr). It adds a
web server on port `7317` and never replaces herdr, its sessions or the user's own terminal.

## Rules

- Bind to `127.0.0.1` (the default) unless the user asks for remote access. Anyone who can reach an
  ungated server can type into the user's terminals. Never bind to `0.0.0.0` or a LAN address, or
  put it behind a proxy other people can reach, without a token (`HERDR_WEB_TOKEN`). A `tailscale
  serve` address may go without one only when the user confirms every device in their tailnet is
  their own.
- Never print, log or commit the token. Write it only to the config file named below and tell the
  user where it is.
- Do not install herdr, Bun or Node yourself unless the user agrees. Say which one is missing and how
  to install it.
- Do not stop or restart the user's herdr server (`herdr server stop`). Restarting herdr web ui is fine.

## 1. Check prerequisites

```bash
bun --version        # need 1.4 or newer
node --version       # need v18 or newer (it runs the terminal-attach sidecar)
herdr --version      # need 0.9.0 or newer
herdr status server  # the herdr server must be running
git --version
```

- A missing tool: **Ask** the user before installing it. Bun: `curl -fsSL https://bun.sh/install | bash`.
  herdr: <https://herdr.dev>. Node: the user's usual manager (nvm, Homebrew, distro packages).
- herdr not running: ask the user to start `herdr` in a terminal, then check again.
- Supported platforms: Linux and macOS.

## 2. Choose the install method

| Method | When | Updates |
| --- | --- | --- |
| **A. herdr plugin** (default) | The user wants it to start with herdr | In-app: Settings → Updates |
| **B. Source checkout** | The user wants to develop it, or asks for a clone | In-app, while the checkout stays on a clean `main` |

Use A unless the user says otherwise.

## 3A. Install as a herdr plugin

```bash
herdr plugin install devswha/herdr-web-ui --yes
```

herdr clones the repository, runs `bun install` and `bun run build`, then registers the plugin. This
takes about a minute.

- Success: the command exits 0 and `herdr plugin list` shows `devswha.herdr-web-ui`.
- `bun: command not found` during the build: herdr runs build commands with **its own** environment.
  Make sure `bun` is on the `PATH` of the shell that started herdr (usually `~/.bun/bin`), ask the
  user to restart herdr from that shell, then retry.
- "installing over a locally linked plugin is refused": run `herdr plugin unlink devswha.herdr-web-ui`
  first.

Start it now. Otherwise it starts the next time herdr starts:

```bash
herdr plugin action invoke devswha.herdr-web-ui.start
```

Success prints `herdr web ui listening at http://127.0.0.1:7317`. It may also print
`no token set: ...`; that is expected for a local-only install.

Plugin settings do **not** come from the user's shell. They go in an `env` file:

```bash
CONFIG_DIR="$(herdr plugin config-dir devswha.herdr-web-ui)"
echo "$CONFIG_DIR/env"
```

The file holds `KEY=value` lines. After editing it, restart the plugin:

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin action invoke devswha.herdr-web-ui.start
```

## 3B. Install from source

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install
bun run start
```

`bun run start` runs in the foreground. Start it in a separate herdr pane, or under the user's
service manager, so it keeps running. Settings are environment variables on that command.
`bun run server` and `bun run dev` are development commands and do not update themselves.

## 4. Verify

```bash
curl -s http://127.0.0.1:7317/api/health
```

Success is JSON with `"ok":true` and a `herdr` object, for example
`{"ok":true,"herdr":{"version":"0.9.0","protocol":...},"auth":{"required":false,...},...}`.

- Connection refused: the server is not running. For the plugin, run the `status` action. Command
  logs are listed by `herdr plugin log list`; the server's own log is `server.log` in the plugin's
  state directory. Port `7317` in use: set `PORT` (see [Configuration](#configuration)) and restart.
- An error mentioning the herdr socket: herdr is not running, or it uses a named session. For a
  named session, set `HERDR_SOCKET=~/.config/herdr/sessions/<name>/herdr.sock`. The plugin follows
  herdr's session automatically.

Tell the user to open <http://127.0.0.1:7317>.

## 5. Optional: phone or remote access

**Ask** the user first. This exposes their terminals over the network. Also ask who else can reach
the address: with Tailscale, whether every device in their tailnet is their own. If yes, skip step 1
(no token) and go to step 2. Otherwise, and for any LAN or public address, create the token.

1. Create a token and store it without printing it. For the plugin:

   ```bash
   CONFIG_ENV="$(herdr plugin config-dir devswha.herdr-web-ui)/env"
   touch "$CONFIG_ENV" && chmod 600 "$CONFIG_ENV"
   printf 'HERDR_WEB_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$CONFIG_ENV"
   ```

   For a source install, write the same line to a file only the user can read (for example
   `~/.config/herdr-web-ui/token.env`, mode `600`) and start with
   `env $(cat ~/.config/herdr-web-ui/token.env) bun run start`.
   Restart herdr web ui either way.
2. Serve it over HTTPS. Without HTTPS, a phone can view the app but cannot install it or receive
   alerts. With Tailscale:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:7317
   ```

3. With a token, verify that `curl -s http://127.0.0.1:7317/api/health` now reports
   `"auth":{"required":true,...}`.
4. Tell the user the HTTPS address, and where the token is stored if there is one. They enter the
   token once per browser address; keep to one address (the HTTPS one), since each address keeps
   its own sign-in.

Other PCs over SSH are added from the web UI (**Add PC**), not by an install step here.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7317` | HTTP and WebSocket port |
| `HERDR_WEB_TOKEN` | unset | Token that gates access; required for anything but loopback |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket (source installs; the plugin follows herdr) |
| `HERDR_WEB_AUTO_UPDATE` | `0` | `1` installs new versions automatically |
| `HERDR_WEB_STATE_DIR` | `~/.config/herdr-web-ui` | Push keys, device subscriptions, PC registrations, update builds. Keep it across reinstalls. |

The [README](README.md#configuration) lists the rest.

## Update

- Settings → **Updates** → **Update and restart** when a new release (`vX.Y.Z`) is out. It works for
  both install methods. The new
  version is built separately and the app restarts only if the build and health check pass.
- Plugin alternative: `herdr plugin install devswha/herdr-web-ui --yes` again. It replaces the
  checkout; restart the plugin afterwards.
- Source alternative: `git pull` on `main`, then restart `bun run start`. The in-app updater only
  offers published releases (`vX.Y.Z` tags); `main` can be ahead of the latest release.

## Uninstall

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin uninstall devswha.herdr-web-ui
```

Uninstall removes herdr's managed checkout. It does not touch `~/.config/herdr-web-ui` (push
subscriptions, saved PCs, update builds). Check whether the plugin config directory (it holds the
token) is still there. Delete either one only if the user asks.
