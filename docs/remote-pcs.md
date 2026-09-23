# Remote PCs over SSH

Use **Add PC** in the sidebar to connect a Linux or macOS computer. Enter an SSH alias or `user@hostname`; the name defaults to that address. Advanced settings accept a port, a key path on the **web server**, and a named herdr session. Each registration selects one herdr socket. The sidebar groups PC → workspace → pane, and the header and new-session dialog show the destination PC.

The connection server uses its own operating-system account’s OpenSSH configuration and ssh-agent. The browser never opens SSH itself. Existing keys are tried first; unknown host fingerprints and password/key-passphrase prompts appear in the setup dialog. Secret entry requires HTTPS or localhost. Verify a new fingerprint against the target PC. A changed host key fails closed; correcting trust is a deliberate administrator action, not an automatic reset.

After inspection, **Install and connect** lists the proposed changes. The installer uses a private runtime bundle containing Bun, Node and native node-pty, plus a pinned herdr fallback. It uses an existing herdr where available, starts a daemon only when its socket is absent, and never stops/replaces a running herdr daemon. Agent CLI installation and login remain the remote account’s responsibility. Cancelling a setup closes its SSH processes; already-created remote work is preserved.

Password or encrypted-key authentication also offers registration of an app-specific ed25519 key for unattended reconnection. The private key stays on the connection server under `<stateDir>/ssh/<machine-id>`, mode `0600`; only its public key is appended to the remote account’s `authorized_keys`. The original SSH keys/configuration are preserved. One-time secrets pass through a private askpass Unix socket in memory; they are not stored in jobs or configuration files.

## Runtime and endpoints

```
Browser → connection server → OpenSSH local forward → remote loopback bridge → herdr Unix socket
```

The bridge reuses this backend, so conversations, file searches, directory validation and pasted images run on the selected PC. Only a loopback bridge port is opened on that PC. OpenSSH forwards it over the authenticated connection; see [ssh(1)](https://man.openbsd.org/ssh.1) and [ssh_config(5)](https://man.openbsd.org/ssh_config.5).

The current server keeps one status-only WebSocket per remote PC without attaching to a terminal. SSE carries the combined roster and status events to the browser. Selected terminals use a separate WebSocket bound to one machine for its entire lifetime. Roles and output ACKs pass through unchanged: the browser acknowledges only after xterm parses output. The relay also enforces a 1 MiB transport budget and a 2-second stalled-consumer close (`4008`).

| Route | Contract |
|---|---|
| `GET /api/health?scope=bridge` | App/auth liveness independent of local herdr |
| `GET /api/bridge` | Authenticated protocol, runtime version, PID and socket identity |
| `GET /api/machines` | PC state plus cached snapshots |
| `GET /api/machines/events` | SSE roster and machine-scoped status events |
| `POST /api/machines/setup` | Create an interactive setup job |
| `GET/POST/DELETE /api/machines/setup/:id` | Inspect, answer/approve, cancel |
| `PATCH /api/machines/:id` | Rename or change `enabled` |
| `DELETE /api/machines/:id` | Forget the PC and remove its local private key |
| `/api/machines/:id/{session,agents,pane/*,workspace/*}` | Allowlisted target API routes |
| `/ws?machine_id=…` | Immutable terminal destination |

Legacy HTTP paths, `/ws` without a machine, and old stored preferences/notification links mean **local**. Machine mutations require `X-Herdr-Machine: 1`, the existing token gate and same-origin browser requests. The proxy passes a bridge credential read through SSH; browser cookies, bearer tokens, forwarded headers and remote cookies are not forwarded. Authentication, push devices, VAPID keys and app updates belong to the current connection server.

Remote credentials are registered in `~/.config/herdr-web-ui/bridges/` on that PC (mode `0600`). A compatible bridge for the same socket is reused, including a normally started server from this version. Independently managed bridges are never stopped by remote setup. Older unregistered bridges can still hold an exclusive terminal attach; release their browser attachment or restart them with registration support. No path uses `--takeover`.

## Disconnects and updates

PC registrations and last snapshots persist in `<stateDir>/machines.json`; `HERDR_WEB_STATE_DIR` chooses the state directory. A disconnected PC retains its last roster with controls disabled. Retries back off from 1 second to 60 seconds. Other PCs keep working. Reconnection never changes a non-empty selection or sends held input. Composer drafts, held messages, terminal drafts, lenses, recent panes and notification identities include both machine and pane. Held messages have an explicit **Send now** action.

**Disconnect** closes that PC’s observer, forwards and terminal attachments, preserving remote processes. **Remove PC** additionally forgets its local registration/key; the public key line on the remote account remains visible for manual removal (`herdr-web-ui:<machine-id>`). No unrelated authorized keys are removed.

**Update bridge…** is an explicit setup operation. A verified runtime is installed into a checksum-addressed directory before the selected managed bridge is restarted. Existing runtime directories remain available to other running bridges. The updater authenticates the old bridge and checks its PID before stopping it; herdr itself is left running. A separately managed server must use its own update controls. The connection server’s existing Settings-based app updater remains independent.

## Building and distributing runtimes

`bun run build:remote` builds for the host OS and CPU after `bun run build`. All bundles use checksum-pinned Node 22.23.2. Linux bundles copy the installed Bun and native node-pty, so they must be built on the target OS/CPU. macOS bundles use checksum-pinned Bun 1.4.2 plus the locked node-pty package's macOS N-API prebuilds; they can also be assembled on Linux:

```sh
bun run build:remote darwin-arm64  # Apple Silicon
bun run build:remote darwin-x64    # Intel Mac
```

The builder verifies herdr 0.9.1, all downloaded runtime checksums, macOS executable architectures and PTY helper permissions. Native builds run an actual PTY smoke test. Cross-platform assembly records `native_smoke_tested: false`; the destination runs bundled Bun/herdr and a Node PTY smoke test **before activating** the installed runtime. macOS runtime execution still needs native CI or a real Mac to verify it. No build tools are required on the remote PC.

The connection server first honors an explicit `HERDR_WEB_BUNDLE_MANIFEST`, then automatically uses `remote-bundles/manifest-<target OS>-<target CPU>.json` beside the server checkout, and otherwise downloads the versioned release. Local discovery follows the **remote** architecture, independently of the server OS and launch directory. Invalid local/configured manifests fail closed; they do not fall back to a different runtime.

`.github/workflows/remote-bundles.yml` builds and smoke-tests Linux/macOS × x64/arm64, plus a real SSH password-authentication job on Linux. Dispatching it produces artifacts; pushing `remote-v1` publishes all four archives and the combined `manifest.json` after the checks pass. This source change does **not** publish that release. Until it is published, build the target bundles locally as above, or configure `HERDR_WEB_BUNDLE_MANIFEST` with a local or HTTPS manifest hosted by your deployment.

The default manifest is `https://github.com/devswha/herdr-web-ui/releases/download/remote-v1/manifest.json`. Version and SHA-256 checks run on the connection server and SHA-256 is checked again on the remote PC before extraction. Each runtime contains its own version metadata. A malformed/incompatible manifest stops installation before a running bridge is stopped.

## Verification

- `bun test`, `bun run typecheck`, `bun run build`: contracts and existing behavior.
- `bun run build:remote && bun scripts/remote-bundle-smoke.ts`: packaged startup, private daemon/socket, authenticated handshake.
- `bun run test:ssh`: actual isolated sshd, fingerprint approval, encrypted-key askpass, app-key registration, first install, two independent herdr daemons with equal pane IDs, HTTP/WS routing, roles, ACK overload, reconnect/restart, cancellation, failed installation, explicit bridge update and host-key-change rejection. Tests write only to their own panes.
- `SSH_TEST_PASSWORD=1 bun run test:ssh`: the same flow with an ephemeral system account and real password login; requires noninteractive sudo, as configured in CI.
- `SSH_TEST_KEEP=1 bun run test:ssh`: keeps the fixture until SIGTERM and prints its JSON path. `bun scripts/machines-browser-qa.ts <fixture.json>` checks PC switching, late real upload responses, drafts/held input, destination labels, and desktop/mobile screenshots under `evidence/machines/`.
- `bun scripts/ssh-password-docker.ts`: real password login to a disposable Debian PC with no Bun/Node/build tools, followed by bundled herdr startup and app-key reconnection; requires Docker and changes no host accounts.
- `bun run test:ui`: existing composer/session/mobile browser regressions.

macOS Codex discovery uses `lsof` for open rollout files instead of `/proc`; canonical-store validation and the unambiguous transcript matching rules are unchanged. Platform jobs must run on their corresponding runners before all-platform release readiness can be claimed. The Docker password test can run locally without sudo; macOS/arm64 binaries still require their corresponding runners.
