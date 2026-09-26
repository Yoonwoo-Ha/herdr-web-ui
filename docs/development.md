# Development

## Run it

Run the server and Vite side by side:

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

`bun run server` and `bun run dev` never update themselves; only `bun run start` and the plugin run the update supervisor.

## Checks

```bash
bun run typecheck
bun run build
bun test                        # needs herdr installed; creates and removes its own workspaces
bun run test:ui                 # browser regression against isolated test servers
bun scripts/chat-browser-qa.ts  # chat lens end to end
bun scripts/output-browser-qa.ts # terminal output flow control end to end
bun run test:ssh                # remote-PC integration over SSH
```

Tests run against a herdr session of their own, `herdr-web-ui-test`. The first run starts a headless `herdr --session herdr-web-ui-test server` and later runs reuse it, so test workspaces never show in the herdr you work in (`scripts/test-herdr.ts`). Stop it with `herdr --session herdr-web-ui-test server stop`. `HERDR_TEST_SESSION` picks another name, and `HERDR_TEST_LIVE=1` runs against `HERDR_SOCKET` or your default session instead.

Browser checks look for Chrome at `/opt/google/chrome/chrome`; set `CHROME_PATH` otherwise. After a herdr upgrade, refresh the generated wire types with `bun run generate:types --refresh` (and `--check` to verify).

## README media

`bun run build && bun scripts/readme-media/capture.ts` regenerates the stills and demos in `docs/screenshots/` from a staged, fictional session in its own herdr session (`herdr-web-ui-demo`). Pass `shots` or `video` to redo only one of them. It needs ffmpeg.

- `stage.ts` builds the session: five workspaces under `/tmp/herdr-demo`, curated chats served in place of transcripts, and the hostname rewritten.
- `record.ts` records a walkthrough at 2x (Chrome's screencast, with `--force-device-scale-factor=2`), logging pointer moves, clicks, taps and camera cues as it drives the page.
- `compose.ts` draws every output frame on a canvas: a backdrop, a browser window or a phone, the frame under an eased camera, and a vector cursor with click ripples or touch rings. It writes `demo-*.mp4` (1920×1200 and 1080×1920, 30 fps) and a GIF of each. Stills get the same window or phone on a transparent background.

The MP4s are not committed: GitHub plays a README video only from an upload (`github.com/user-attachments/…`), so drop them into an issue or PR comment and use the link it gives.
The website takes the same two uploads from the README, so a new recording needs only the README links changed.

## Website

<https://devswha.github.io/herdr-web-ui/> is `site/index.html`, a static page. `bun run build:site`
assembles it into `_site/` with the icons, social preview and screenshots it references, the two demo
videos (the local `docs/screenshots/*.mp4` when present, otherwise the README's uploads) and, with
ffmpeg, a poster frame for each video and smaller stills; without ffmpeg the page has no posters.
`.github/workflows/pages.yml` installs ffmpeg, runs the same build and deploys it to GitHub Pages on
every push to `main` that touches the site or its sources.

## Releasing

1. Bump `version` in `package.json` and `herdr-plugin.toml`.
2. Move the `Unreleased` notes in [CHANGELOG.md](../CHANGELOG.md) under the new version.
3. Commit, then push `main` together with a `vX.Y.Z` tag: `git push origin main vX.Y.Z`.

The release workflow checks that the three versions agree, builds, tests and publishes the GitHub release. Installs pick it up within five minutes.

Remote-PC runtime bundles are released separately: raise `REMOTE_BUNDLE_VERSION` in `shared/machines.ts` and push a `remote-vN` tag. See [remote PCs](remote-pcs.md).

## Layout

| Path | Contents |
| --- | --- |
| [`src/`](../src/) | React UI: chat, terminal, composer, sidebar, settings |
| [`server/`](../server/) | API, WebSockets, transcript readers, push, PTY bridge, remote PCs and updater |
| [`shared/`](../shared/) | HTTP/WebSocket contract and generated herdr types |
| [`scripts/`](../scripts/) | Plugin lifecycle, type generation, remote bundles, README media and browser checks |
| [`public/`](../public/) | PWA manifest, service worker and icons |
| [`docs/`](.) | Remote PCs, updates, flow control, chat audit and brand assets |
| [`site/`](../site/) | The website, built by `scripts/build-site.ts` and deployed by GitHub Pages |
| [`DESIGN.md`](../DESIGN.md) | Design tokens and UI conventions |
