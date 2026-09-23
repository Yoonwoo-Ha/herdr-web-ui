# App update implementation and verification

The previous app had network-first PWA navigation and immutable frontend assets, but no server update discovery or installation. The new managed entrypoint adds both. See [README usage](../README.md#updates).

## Reference and choices

Inspected `devswha/chatmux` at commit `3b1f3b49216157399e3fb9666a49c942908c3e32` in `/home/devswha/workspace/chatmux`. Its [version check hook](https://github.com/devswha/chatmux/blob/3b1f3b49216157399e3fb9666a49c942908c3e32/src/hooks/useVersionCheck.ts) periodically checks for updates; its [self-update service](https://github.com/devswha/chatmux/blob/3b1f3b49216157399e3fb9666a49c942908c3e32/server/self-update.ts) handles source/release installation. Chatmux is AGPL-3.0; herdr-web-ui is MIT. This implementation adopts behavior and contains no copied chatmux code.

| Priority | Adopted behavior | Implementation |
| --- | --- | --- |
| 1 | Automatic discovery, explicit install | Supervisor checks after 10 seconds/every 5 minutes; Settings provides check/install controls |
| 2 | Protect locally modified or diverged source | Clean `main` checkout required; exact target SHA and ancestry verified; source worktree never rewritten |
| 3 | Verify deployment and recover | Build isolated checkout, restart bridge, match a fresh boot ID through health, restore prior build on failure |
| 4 | Optional unattended installation | `HERDR_WEB_AUTO_UPDATE=1`; persist failed SHA to prevent repeating a bad automatic deployment |

Chatmux's systemd-specific launcher and release archive pipeline were not adopted: this repository distributes Git source through Bun and herdr plugins, including macOS. The supervisor uses [Bun's supported IPC](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc). No runtime dependencies were added.

## Boundaries

- `server/managed.ts` owns the bridge process and health-checked rollback. `server/updater.ts` owns bounded Git/build commands, source guards, release selection and persistence. Only the managed entrypoint runs discovery timers.
- `server/update-api.ts` relays requests/status over IPC. `/api/updates*` uses the existing token gate; POSTs require a custom header and reject cross-site browser requests. The browser cannot choose an executable, directory, remote or revision.
- `shared/update.ts` defines the status contract. `src/lib/updates.ts` polls it after authentication. `UpdateControls.tsx` displays Settings controls and the header notice. The compiled frontend revision identifies when a reload is needed; reloading remains explicit to preserve drafts.
- `bun run start` and plugin `start` use the supervisor; `bun run server` remains unmanaged. Restart an older running server once to adopt this entrypoint. The supervisor itself remains loaded for its process lifetime; its code comes from the source checkout. Update that checkout and restart when changing supervisor behavior.
- Update data is separate from push keys/subscriptions. State and socket paths are resolved before launching a candidate, so changing the candidate working directory cannot redirect either. The source checkout and the two most recent successful isolated builds remain available.
- Discovery/build failures keep the serving bridge alive. A failed candidate boot restores the previous build. If both candidate and previous build cannot start (for example herdr is unavailable), the failure remains in supervisor logs and needs normal service recovery.

## Verification

- `bun test`: full suite passed. The update suite also passed after adding the failed-revision retry regression (8 tests).
- `bun test server/updater.test.ts`: real temporary Git remotes, pinned builds, unchanged source, local-change/branch/divergence guards, build failure cleanup, IPC installation with the real bridge and live herdr, failed-boot rollback, saved-release restart, automatic install, duplicate requests, bounded subprocess cancellation, and persistent failed-revision retry suppression.
- `server/api.contract.test.ts`: update status cache policy, token protection, cross-site/form rejection and unmanaged installation rejection.
- `bun run typecheck` and `bun run build` passed.
- `bun scripts/update-browser-qa.ts`: actual source copy, private Git remote, candidate dependency installation/typecheck/build, desktop check/install, new frontend reload, retained unsent draft and owned herdr pane, deliberately failed server boot/rollback, mobile update-section bounds, and no browser JavaScript errors. The temporary server, browser and workspace are cleaned up.
- Screenshots and the supervisor log are generated under gitignored `evidence/updates/`. They are QA artifacts, not README/demo screenshots.
