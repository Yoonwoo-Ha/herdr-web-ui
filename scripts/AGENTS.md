# scripts/

Build, code generation, CI orchestration and the browser QA harness. Only `build-xterm.ts` is typechecked (through `vite.config.ts`) and only the `*.test.ts` files are discovered by a test runner, so the rules that decide whether a check actually runs live in this directory.

## SUITES AND DISCOVERY
- `ci-tests.ts` globs `{src,shared,server,scripts,telemetry}/**/*.test.ts` and splits the result into exactly two suites with one predicate: a file needs herdr when it ends in `.contract.test.ts`, or it is `server/updater.test.ts`, or it sits under `server/herdr/` or `server/pty/`. Those last three run in the integration suite despite their plain names. A new test that needs a live herdr must take the `.contract.test.ts` name or be added to that predicate; otherwise it lands in the unit suite, where the socket does not exist.
- A `*-regression.ts`, `*-demo-regression.ts` or `*-browser-qa.ts` script is not a test file and nothing discovers it: it runs only from `ci-browser.sh`, from `ui-regression.ts`, or by name. A new one that is not added to one of those never runs in CI.
- Each integration worker gets the herdr session `<session>-<n>`, also when there is only one worker: the plain `<session>` belongs to the browser scripts that run beside the suite in CI.
- The queue is ordered largest file (in bytes) first, so a long file is unlikely to start last and run on alone. Per-file test timeout is raised above Bun's 5 s default because live process and pane probes poll for up to 10 s, and a run that never printed its counts is treated as a failure rather than as an empty pass.

## ISOLATION
- The lock that keeps two lane runs apart is a listening loopback port (`LOCK_PORT` in `check.ts`) whose holder answers a connection with its pid. Taking it is a single step and it is free again the moment the run is gone however it ended, so there is never a lock left behind to break.
- A run still shares the checkout with the PC: `fast` rewrites the generated types file while it checks it, and `fast` and the browser lane build into `dist/`; `check run` runs only its command, so build first when that command serves `dist/`. One run per checkout.
- `bunfig.toml` preloads `test-herdr.ts`, so a test that imports nothing is already pointed at the test session, and `HERDR_TEST_LIVE=1` is the only way back to the user's own herdr.
- macOS keeps its temp dir behind a symlink (`/var` -> `/private/var`) and herdr reports a pane's cwd resolved, so a fixture built under the unresolved path never matches the pane it was made for.

## BROWSER LANE
- The lane builds the demo client once into `HERDR_DEMO_BUILD` and every script copies it (`demo-build.ts`). Run with a directory, `demo-build.ts` always builds into it whatever `HERDR_DEMO_BUILD` says, which is what makes that directory the one the others copy; a script run on its own builds its own.
- `CHROME_PATH` is the lockfile's `playwright-core` Chromium. Only under `CI` are its system libraries installed (`install-deps`, as root through `ci-bounded-retry.sh`, which bounds each apt attempt and tries three times), because a PC is never asked for sudo.
- `ui-regression.ts` runs its checks in one process behind one outer try/finally: the first failure skips every later check (cleanup still runs), and a check that waits without a deadline stops the rest of the suite instead of failing it.

## GENERATED TYPES AND RELEASE GATES
- `generate-protocol-types.ts` emits only the herdr types this repo consumes plus their transitive closure, and widens string enums with `(string & {})`: herdr gives no value-stability guarantee, so a value from a newer herdr has to flow through instead of failing to typecheck. `--check` fails on a stale committed file, `--refresh` re-reads `herdr api schema --json`, and `HERDR_WEB_HERDR_BIN` picks the binary.
- `build-xterm.ts` exists because xterm's source declares `const enum`s in `.d.ts` files, which TypeScript has to inline before Vite sees them. The patch in `patches/` therefore targets xterm's readable source, never its minified `dist`.
- `release-notes.ts` is the gate that runs before a tag is published: it refuses a release whose three version sources disagree, whose notes are empty, or whose `release-summaries.json` entry is missing one of the app's languages. What it prints is the GitHub release body: the English patch-note lists, then the changelog section in a `<details>` fold.
- A remote bundle for another platform fetches that platform's `@lydell/node-pty` package from the registry, because bun installs only the host's prebuild; the pinned tarball digests in `build-remote-bundle.ts` must be updated with the version bump. A win32 bundle is Bun alone and therefore mirrors panes.

## PLUGIN
- herdr's startup hooks are one-shot commands, not supervised daemons, so `plugin.ts` owns the process: `start` detaches the server and records its pid under `HERDR_PLUGIN_STATE_DIR`, and it is idempotent, since a server already answering on the port is left alone. That is what makes one command safe both as a startup hook and as a hand-run action.
- The port is settled before the server is spawned. With no `PORT`, a default that will not open gives way to a far-apart fallback (`plugin-port.ts`), because a port inside a range Windows reserves (Hyper-V, WSL2, Docker) fails although nothing is listening on it; the choice is remembered so the app's address survives a restart.
- A pane entrypoint must follow the active release rather than this checkout (`plugin-runtime.ts`): the plugin checkout outlives an update.

## MEDIA
- `film/` and `readme-media/` record the real client against the browser demo's fixtures at 2x. A take may change what the fixtures say, never how the app behaves.
- Shot times in `film/timeline.ts` are fixed by hand and have to be re-measured after a re-capture, and `film/hand.ts` is a near-copy of `readme-media/record.ts`, so a fix usually belongs in both.
