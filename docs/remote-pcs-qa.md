# Remote PC verification — 2026-09-22

Verified on Linux x64 with Bun 1.4.2, Node 26.9.0, system OpenSSH, Chrome, local herdr 0.9.0 and bundled herdr 0.9.1. All terminal writes targeted test-owned workspaces; remote homes, SSH trust files, keys and state were isolated.

| Check | Result |
|---|---|
| `bun run typecheck` / `bun run build` | Passed; Vite retains its existing large-chunk advisory |
| `bun test` | 245 passed, 0 failed across 32 files |
| Final machine/API/push contracts | 68 passed, 0 failed; includes authenticated API, origin checks, target validation and PC-separated encrypted push payloads |
| Packaged Linux x64 runtime | Native node-pty smoke test, archive checksum, private daemon/socket and authenticated bridge handshake passed |
| Real OpenSSH key flow | Fingerprint approval, encrypted-key passphrase, dedicated-key registration and automatic reconnection passed |
| Real password flow | Disposable Debian Docker PC, actual password login, first install without Bun/Node/build tools, bundled herdr startup, dedicated key and key-only reconnection passed |
| Two target sessions | Independent herdr daemons both used `w1:p1`; input, state and browser drafts stayed with their machine |
| Remote APIs | Terminal input/resize, observe-mode rejection, image storage, conversation, file search, prompt reads and session management passed |
| Backpressure | End-to-end ACK relay retained the 1 MiB budget; stalled observer closed with 4008 and operator connection survived |
| Recovery | Local herdr unavailable while remote worked; disabling one PC left the other available; disconnect and server restart preserved remote panes |
| Setup failure paths | Cancel before approval, incompatible installation manifest and changed SSH host key failed without replacing existing work |
| Explicit remote update | Verified new runtime before stopping the owned bridge; both daemon sessions survived |
| Chrome PC UI | Same-ID drafts, late real image upload response, held queue across reload/PC switch, target-labelled creation, dark/light desktop and mobile passed; no browser errors or horizontal overflow |
| Existing UI regression | Composer queue review, per-pane drafts/uploads, session creation and mobile/storage-unavailable behavior passed |
| Existing app updater UI | Check/install/restart, reload notice, unsent draft preservation, rollback and mobile controls passed |

Screenshots are in `evidence/machines/` (gitignored): desktop dark/light, mobile dark/light and the Add PC dialog. They contain only isolated QA sessions. Reproduce with the commands in [remote-pcs.md](remote-pcs.md).

The four-platform workflow was added but has **not** been executed on GitHub in this session. Intel macOS and Linux arm64 native runtime validation remain release checks; the Apple Silicon follow-up below passed on a real MacBook Pro. No `remote-v1` release was published. The connection server now automatically discovers locally built manifests for the target platform; explicit `HERDR_WEB_BUNDLE_MANIFEST` still takes priority. Real mobile push-service delivery was not repeated; the encrypted payload/signature tests cover PC identity and tags, and notification navigation preserves legacy local links.

The missing-release follow-up assembled both Apple Silicon and Intel macOS bundles from checksum-pinned official Bun/Node/herdr binaries and node-pty's packaged N-API prebuilds. Mach-O CPU types and executable helper permissions were checked. This Linux run did **not** execute macOS binaries: the installer now runs a PTY smoke test on the destination before activating a runtime, and native CI remains required for release validation. Regression tests cover automatic local discovery for both Mac architectures, explicit overrides, missing-platform release fallback, corrupt bytes, incompatible versions, traversal and cancellation.

Follow-up verification: typecheck passed; the bundle/machine/API suites passed **60 tests**. The rebuilt Linux runtime passed packaged startup/authentication and the disposable Debian SSH test with **no manifest environment variable**: password login, local bundle discovery, installation with the new PTY preflight, app key registration and key-only reconnect all passed. That preflight exposed an extra `libatomic.so.1` dependency in the builder's Node 26 binary; all bundles now pin verified Node 22.23.2 instead. Both Mac manifests were also resolved and their complete archives checksum-verified while launching from a different working directory.

## Real MacBook Pro follow-up

Connected over system OpenSSH to an Apple Silicon MacBook Pro running macOS 26.6.2, with existing herdr 0.9.0 and Codex 0.154.0. All writes used a separate, test-owned named herdr session and temporary directory. Existing SSH keys authenticated successfully; this Mac run did **not** exercise password authentication or dedicated-key registration.

| Check | Result |
|---|---|
| First installation | Locally discovered `darwin-arm64` archive, checksum verification, native Bun/herdr execution, node-pty smoke and authenticated bridge startup passed |
| Existing herdr | Reused the installed compatible herdr; the user's default session socket remained present and the QA session was separate |
| Remote terminal | Output and ACKs, input, resize, observe-mode input rejection and key-only reconnection passed; reconnect retained the owned pane |
| Remote data | File search, image upload into the remote cwd with mode `0600`, shell fallback, pane rename and real Codex native transcript retrieval passed |
| Codex startup prompt | Reproduced the directory-trust menu while herdr reported `idle`; chat now polls visible prompts for connected agent panes regardless of the status badge |
| Exact response rendering | Fixed intraword underscores being parsed as emphasis; `MAC_QA_CHAT_OK` now matches the native transcript exactly, including inside bold text |
| Browser | PC-labelled header, one sidebar entry per single-pane session, isolated shell/Codex drafts, desktop/mobile and dark/light checks passed without page errors or horizontal overflow |
| Network and cleanup | `lsof` confirmed the bridge listened only on `127.0.0.1`; neither owned terminal retained an attach process after browser closure |
| Regression checks | Markdown/prompt/Codex suites: 25 passed; real-PTY browser suite passed, including an idle startup prompt and unavailable mobile storage; typecheck and build passed |

The QA Codex conversation was archived, its temporary directory trust entry removed, and the owned workspaces, named daemon, bridge and temporary files removed. The installed remote runtime remains available for subsequent connections. Existing workspaces were not written to or closed. Evidence is in `evidence/mac-qa/` (gitignored), including `codex-trust-menu.png`, `codex-native-transcript.png`, desktop and mobile captures. No further Codex request was needed to verify the Markdown fix: the browser reread the saved response.
