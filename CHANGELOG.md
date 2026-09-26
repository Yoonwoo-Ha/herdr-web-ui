# Changelog

herdr web ui is versioned with [semantic versioning](https://semver.org/). Each release is a
`vX.Y.Z` Git tag with a GitHub release. Installs update only to releases; commits on `main`
between releases do not reach them. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

## [0.3.12] - 2026-09-26

### Added
- The website has a demo, <https://devswha.github.io/herdr-web-ui/demo/>: the app itself on a
  fictional session, no server. Its five panes, chats and Codex approval are the README media's;
  answering the approval, sending a message and typing into the shell pane all get demo answers.

### Fixed
- Installing no longer compiles a native module. The terminal addon comes prebuilt for Linux x64
  and arm64 and for macOS (`@lydell/node-pty`, node-pty 1.1.0 repackaged), so a PC without Python
  and a C++ toolchain installs, where `herdr plugin install` used to end in a page of node-gyp
  errors and "Plugin was not installed". The first build step now says in one line what is
  missing (`bun`, `node`, or a version too old) instead of failing some steps later.

## [0.3.11] - 2026-09-26

### Added
- **Settings → Phone**: how to get the app onto a phone from this PC. When the page is already on
  an HTTPS address, or Tailscale on the PC already serves the app, it shows that address as a QR
  code. Otherwise it shows the one `tailscale serve` command still to run, on the first free of the
  usual HTTPS ports, with a Copy button and the address it will give, or says that Tailscale is
  not connected or not installed. The server reads `tailscale status` and `tailscale serve status`
  only (`GET /api/access`); it never changes the tailnet.
- **Star on GitHub** in Settings → About, next to a link to the website.
- A website, <https://devswha.github.io/herdr-web-ui/>: the demos, the install command, the phone
  setup and how it compares with other herdr phone clients. GitHub Pages builds it from `site/`
  on every push to `main`; `bun run build:site` builds it locally.

### Fixed
- A link styled as a button (**Reconnect** after a PC drops, **Star on GitHub**) is no longer
  underlined.

## [0.3.10] - 2026-09-26

### Fixed
- A file named without its folders in a chat answer (`demo.mp4` for `docs/screenshots/demo.mp4`)
  opens: the viewer finds it under the pane's folder, ignored files included, and lists the
  files to choose from when several have that name. It used to say "No readable file".

## [0.3.9] - 2026-09-26

### Added
- Open the files your agents write, from any device. A file path in a chat answer
  (`docs/demo.mp4`, `~/out/shot.png`) opens in a viewer: images, video and audio that play and
  seek at once, PDFs, and the start of a text file, each with Open in new tab and Download.
  **Browse files** (in the header, or the command palette on a phone) lists the pane's folder
  and any other. Files stream from disk with ranges, so a large video costs the server no memory;
  HTML and SVG open sandboxed and text as plain text, never as script on the app's origin.

### Changed
- The README's screenshots and demos are sharper and framed: recorded at 2x, in a browser window
  or a phone, with a moving camera and cursor on desktop. The phone demo no longer shows only the
  top left of the screen.

## [0.3.8] - 2026-09-26

### Added
- The chat pins the agent's todo list to its bottom: done count and the item in progress on one
  line, the whole list by phase when opened. It follows Claude Code's `TodoWrite`, Codex's
  `update_plan`, and omp, omo and gjc todo operations, and in the work block a todo call reads as
  one line ("done · Build") that opens to the list as it stood after it.

### Fixed
- A pane's terminal (and the chat over it) no longer shows "terminal ended" when it reconnects
  just after Codex finished an answer, for example on a phone coming back from the background.
  herdr refuses an attach while a read of the same terminal is in progress, and asks for a
  retry. On an idle Codex pane, the transcript match's 400-line read makes herdr scroll the
  history back, which takes about a second or more. The attach is now retried for as long as
  such a read can last, and a refused attach no longer prints herdr's message into the terminal.
  (#45, by @Yoonwoo-Ha)
- An omo or gjc pane that finishes while you are not looking at it reads **DONE** (and alerts),
  not READY, and reads RUN while it works. herdr recognises these agents from their screen and
  processes; omo's label turns from `pi` to `claude` mid-turn, so herdr reported the whole turn
  as `unknown` and its end as plain `idle`. The server now keeps whether each pane worked and
  reports what herdr does for agents it does not lose: done until the pane is focused in herdr.

## [0.3.7] - 2026-09-25

### Added
- Answer an agent's waiting prompt from the chat's message box: type an option's number or your
  own answer. A pick for an approval, a plan or a menu waits in the prompt card for **Confirm**,
  and the options are numbered to match. (#6, by @Yoonwoo-Ha)
- Codex's queued questions (the collapsed "? N questions" block) show as a card and are answered
  from the chat; the queue closes again afterwards, so messages still reach Codex. Prompts of
  Claude Code 2.1 and Codex 0.156 are recognised. (#6)
- **Browse** beside the directory field of a new session: pick the folder from a list instead of
  typing its path. It lists one folder at a time on the PC the session starts on, hidden folders
  on request. A remote PC offers it once its bridge is updated; until then, type the path.

### Fixed
- The header no longer says "reconnecting" after you switch to another pane on the same PC. The
  switch reset the connection badge, and the terminal, still connected, never reported again.

## [0.3.6] - 2026-09-25

### Added
- gjc and omo have their own marks in the sidebar and the chat. An omo pane is named `omo` even
  though herdr labels it `pi` or `claude` as omo works, so its mark no longer changes under you.
- gjc panes open in the chat view with their conversation, model and effort, like omp and omo.
  The chat follows the session the pane's gjc has open.

### Fixed
- A request that failed (an authentication error, an overloaded provider) shows its error in the
  chat of an omp, omo or gjc pane. The prompt used to stand there with no answer at all.

## [0.3.5] - 2026-09-25

### Added
- Web addresses in chat messages are links: a bare `https://…` URL or one in `<…>` opens in a
  new tab, as a `[text](url)` link already did. Punctuation that ends the sentence stays out of
  the link, and so does text written straight after it (e.g. Korean without a space).
- The chat composer attaches any file, not only PNG, JPEG, GIF and WebP images. An icon, a PDF or
  a log is stored beside the pane under its own name and mentioned by path, as images are; SVGs
  get a thumbnail too. Other files used to be dropped without a word.

### Fixed
- Resizing the window no longer lags on a long session. Every frame of the drag resized the pane,
  and each resize made herdr reflow it and the program in it (Claude Code) repaint its whole
  conversation; the terminal now resizes once the drag rests.
- The app does much less work while it sits open. The terminal under the chat view no longer
  draws every output frame, an unchanged chat is no longer re-rendered on every status update,
  and a hidden tab or a phone app in the background stops polling until it is back.
- A chat open on a long session no longer stalls the server every poll while the agent works. The
  server re-read and re-parsed up to 16 MB of the transcript every 2 s; it now reads only what was
  appended and re-parses only the last turn.
- Live status, pane-ended and session-changed updates resume after herdr restarts. One failed
  reconnect used to stop them until the web server itself restarted.
- Long code blocks in a chat answer no longer look cut off. A block was capped at about six lines
  with the rest behind an inner scroll that a phone does not show, so a long answer seemed to stop
  halfway. Blocks now show whole; one longer than 30 lines opens at its first 20 with a
  **Show all N lines** row below it.

## [0.3.4] - 2026-09-25

### Changed
- On a phone or tablet, an agent pane opens in the chat the first time you select it; shells, and
  every pane on a desktop, still open their terminal. The lens you pick is still remembered per
  pane.

### Fixed
- Scrolling the terminal on a phone scrolls herdr's history again when another tab (for example a
  desktop browser) already had that pane open. The phone joined a busy pane without its mouse
  mode, so a drag turned into arrow keys and paged through the agent's prompt history instead.
- Picking a session in the chat view and typing straight away now types into the chat box. The
  keys went to the hidden terminal instead, straight into the agent's own prompt, and a phone
  showed the typed text in the middle of the screen.

## [0.3.3] - 2026-09-25

### Added
- Remote PC bridges update in the background. When an app update needs a newer bridge, PCs that
  connect with their saved key are updated automatically (**Settings → Remote PCs**, on by
  default); with it off, **Update bridge** starts the same update in one tap. A PC that needs a
  password asks through **Sign in and update…**.
- The sidebar and the header show a bridge update's step, bytes and time left, with **Cancel
  update**. Closing the dialog after approval no longer cancels an install.
- The web server keeps downloaded bridge bundles by checksum and downloads each once, so a second
  PC or a retry only sends it to the PC.

### Fixed
- Dragging the terminal on a phone scrolls herdr's history again. The gesture was lost after its
  first move, since the redraw replaced the row it started on, and the browser then scrolled the
  page or the composer instead. The text now also follows the finger (drag down for older lines),
  and each scroll lands at the finger's position.
- Android notifications show the herdr mark instead of Chrome's bell as their small icon.

### Development
- Tests and the browser QA scripts run in a herdr session of their own, `herdr-web-ui-test`, so
  their workspaces and agents never show in the herdr you work in. `HERDR_TEST_LIVE=1` restores
  the old behaviour.

## [0.3.2] - 2026-09-25

### Changed
- A pane opens its terminal the first time you select it, agent panes included, instead of the chat.
  Switch to Chat once and that pane keeps opening in chat.
- `bun run start` now listens on `127.0.0.1` by default, like the plugin, instead of every
  interface. To reach it from your LAN again, set `HOST=0.0.0.0` together with `HERDR_WEB_TOKEN`;
  for a phone, `tailscale serve` or an SSH tunnel to `127.0.0.1` needs no change.
- The README and INSTALL.md say when a token is needed: not on this computer, over an SSH tunnel,
  or through `tailscale serve` on a tailnet of your own devices; needed on a LAN, a shared tailnet
  or a public address.

### Fixed
- A composer message that waited more than 45s behind earlier input is not typed any more; the
  composer keeps it and says nothing was typed. Before, it could reach the pane after the composer
  had given up on it, so sending it again typed it twice.
- Text typed after a message that is still sending keeps its leading spaces, and an edit inside
  the part being sent stays in the box with a note that it was not sent.
- A numbered menu row under Codex's collapsed question queue is no longer mistaken for its main
  prompt.

## [0.3.1] - 2026-09-25

### Changed
- Remote PCs use the `remote-v2` runtime, which carries 0.3.0's server changes (chat pages, the
  Codex conversation fixes, server-side message sending and `304` answers) to the remote side.
  A PC connected with the `remote-v1` bridge needs **Update bridge…** once; its herdr sessions are
  kept.
- A PC that only an update or an approval can reconnect says so: it stops retrying, shows the next
  step under its name with the button that does it (**Update bridge…** or **Set up…**), and a line
  under the header says the same, so it shows on a phone with the drawer closed.

## [0.3.0] - 2026-09-25

### Added
- Chat history pages: a transcript is read one page at a time (at most 16MB and 50 prompts), and
  scrolling up loads earlier turns while keeping your place. A long Codex rollout no longer re-reads
  the whole file on every poll, and a Codex conversation that was backtracked shows the history
  from the rollouts before it.
- **Settings → Chat → Chat font size**, from 11 to 24px. Messages, code and prompt cards scale
  together; the rest of the UI and the composer keep their size.
- The composer is resizable: drag its top edge or use ↑/↓, double-tap or press Home to go back to
  the automatic height. The height is remembered per device and capped at half the visible screen.
- The status line shows the reasoning effort Claude Code records, for example `Reasoning xhigh`.

### Changed
- **New session** is back at the top of the sidebar, opening on the selected PC (the same as
  Mod+Shift+N), with **Add PC** beside it.
- **Install app** shows in the sidebar unless the app is installed. Where the browser offers no
  install prompt (iOS, plain HTTP), it explains the platform's own steps, such as Share → Add to
  Home Screen on iOS. Settings → Install shows the same steps.
- A composer message is now sent on the server: agent panes use herdr's `agent.prompt`, which pastes
  the text and presses Enter separately, and refuses while the agent waits for an answer. Other
  panes get the text, a short gap, then Enter. This fixes messages left unsent in the agent's input
  box on phones, where the text and its Enter used to arrive as one chunk. The composer keeps the
  text until the pane confirms it, and says why when it can't be sent.
- The empty composer is taller (42px on desktop, 48px on touch) and its status line is a size up.
- Unchanged conversations answer `304` with no body, and the chat stops polling while the page is
  hidden, which saves data and battery on phones.
- Each window reopens its own pane on reload; a new window still starts on the last pane used.

### Fixed
- A Codex pane kept its conversation only while an answer was on screen; a long run of tool output
  flipped the chat to "Conversation unavailable". The pane now keeps the rollout it matched, or the
  thread named by `codex resume`, until a newer interactive thread begins in that directory.
- Conversation cursors are tied to the Codex rollout chain, so a changed chain reloads the chat
  instead of showing turns twice or out of order, and a chain whose earlier rollout was archived is
  looked up again instead of falling back to terminal output.
- On an iPhone, a second tap on the token field no longer closes the keyboard, and the empty band
  under the composer is gone.
- On Windows, the terminal measures its cells with a monospace font, so ASCII text is no longer
  spaced apart.

## [0.2.1] - 2026-09-23

### Fixed
- Updates now replace the update supervisor too. `server/managed.ts` became a small launcher that
  runs the active release's supervisor; after an install passes its health check the supervisor
  hands over to the new one (one more brief reconnect), and a new supervisor that cannot start is
  replaced by the previous one, with the failure shown in Settings → Updates.
- Release CI skips the one updater test that needs a live herdr.

## [0.2.0] - 2026-09-23

### Added
- Remote PCs over SSH: **Add PC** walks through the host fingerprint, password or key passphrase and
  an approved install, then groups workspaces by PC. Chat, files, images, terminal input and alerts
  follow the selected PC.
- Remote runtime bundles for linux-x64, linux-arm64, darwin-x64 and darwin-arm64, published as the
  `remote-v1` release and verified by SHA-256.
- Managed app updates: `bun run start` and the herdr plugin run a supervisor that builds each update
  in a private checkout, restarts after a health check, and rolls back a failed start.
- Updates follow release tags, and **Settings → Updates** and the header notice show versions
  (`v0.2.0`) instead of commit ids. The sidebar footer shows the running version.
- herdr plugin installs, which herdr leaves as a shallow detached checkout, can now update in place.
- [INSTALL.md](INSTALL.md), a step-by-step install guide written for coding agents.

### Changed
- Warm terminal redesign: amber on graphite (dark) and ledger paper (light), with agent states in
  their own colors. Sidebar titles use the full width, PC headers fit on one line, user chat turns
  are neutral cards, and the composer placeholder is short.
- The header drops the version pill and the theme toggle. The version is in the connection chip's
  tooltip and the sidebar footer, and theme lives in Settings and the command palette.
- README rewritten around setup, remote PCs, mobile use and updates.

### Fixed
- Codex transcripts resolve on macOS, where `/proc` does not exist.
- Underscores inside identifiers (`MAC_QA_CHAT_OK`) stay literal in rendered Markdown.
- The settings shortcut table no longer splits its row rules.

## [0.1.0] - 2026-09-22

First public version.

- Chat and Terminal lenses on one live herdr pane, with Codex, Claude Code and omp/omo transcripts.
- Composer with `/` commands, `@` file mentions, image paste, per-pane drafts and a queued message.
- Answers to approval, question and plan menus from chat.
- Session management, command palette and keyboard shortcuts.
- Installable PWA, a mobile key bar, web push alerts and optional token auth.
- Distribution as a herdr plugin.

[Unreleased]: https://github.com/devswha/herdr-web-ui/compare/v0.3.12...HEAD
[0.3.12]: https://github.com/devswha/herdr-web-ui/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/devswha/herdr-web-ui/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/devswha/herdr-web-ui/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/devswha/herdr-web-ui/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/devswha/herdr-web-ui/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/devswha/herdr-web-ui/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/devswha/herdr-web-ui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/devswha/herdr-web-ui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/devswha/herdr-web-ui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/devswha/herdr-web-ui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/devswha/herdr-web-ui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/devswha/herdr-web-ui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devswha/herdr-web-ui/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/devswha/herdr-web-ui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devswha/herdr-web-ui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devswha/herdr-web-ui/releases/tag/v0.1.0
