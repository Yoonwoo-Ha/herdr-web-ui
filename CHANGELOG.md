# Changelog

herdr web ui is versioned with [semantic versioning](https://semver.org/). Each release is a
`vX.Y.Z` Git tag with a GitHub release. Installs update only to releases; commits on `main`
between releases do not reach them. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

### Fixed
- Alerts could be turned on but not off: once on, the bell was disabled. It is now a switch for
  this device. Off drops the device's push subscription (the server forgets it) and silences the
  page's own alerts; on subscribes again. The choice is kept per device.

## [0.3.27] - 2026-09-27

### Fixed
- An omo pane's chat keeps its transcript while a background task runs. omo holds the task's log
  (`.omo/senpi-task/logs/*.jsonl` in the working directory) open, and that file was taken for the
  pane's session, so the chat fell back to terminal text until omo restarted. Only files in omo's
  session store count now.

## [0.3.26] - 2026-09-27

### Changed
- Releases are published only from a `main` commit that passed the full CI run, and pull requests
  must pass the same checks before they merge.

### Fixed
- Foldable and tablet-width screens (481-768px, e.g. a Galaxy Z Fold8 inner screen): the header no
  longer breaks the Korean "채팅"/"터미널" labels one syllable per line, and no longer shows the
  sidebar collapse toggle (a no-op in drawer mode) or sign out beside the drawer button. Up to
  560px the chat/terminal switch shows icons only, so the pane title keeps room.
- The chat's terminal-text fallback, used when an agent's transcript cannot be found, reflows lines
  the terminal soft-wrapped instead of breaking them where the pty's columns ended. A PC whose
  herdr predates unwrapped reads falls back to the old read.
- Korean UI: the new session dialog's Browse, the prompt card's Submit and Send, and the held-input
  and queued-message banners' Send, Discard and Send now are translated.
- Phone-width screens (up to 480px) hide the command palette's keyboard shortcut hints, and the
  key bar puts its direct-typing toggle first, so a narrow cover screen no longer cuts it off.

## [0.3.25] - 2026-09-27

### Added
- Chat Markdown renders inline `\(...\)` and display `\[...\]` equations with KaTeX.
  Code stays literal, and invalid or incomplete formulas preserve the surrounding Markdown.

### Changed
- The installer keeps herdr's plugin install preview (every command of the manifest) to itself and
  prints only herdr's `Installed ...` line; when the install fails, it prints all of herdr's output.
- README: a sample of the installer's output, from a PC that had herdr but no Bun or Node.

### Fixed
- Ctrl+V in the terminal pastes clipboard text instead of sending a control character that
  triggers an agent's image-paste shortcut and reports "No image in clipboard". Korean text,
  multiline paste, Ctrl+Shift+V and other terminal control keys retain their expected behavior.
- Revoking a paired device closes its active terminal connections and roster stream immediately.
  A corrupt or unreadable device registry stays gated and intact, with recovery guidance.
- Token and paired-device sessions show **Sign out** in the header and command palette.
  Closed or obsolete pane selections recover to a live pane without discarding newly created
  panes or selections on disconnected PCs.
- The plugin also reads its settings from `.env` in herdr's plugin config dir, the name herdr's
  plugin docs use; it read only `env`, so a `.env` (say, `HOST=0.0.0.0` for a reverse proxy) was
  silently ignored. `env` is still read; where both set a key to different values, `.env` wins and
  `start` and `status` name the keys (never their values). `status` prints the files it read. The
  plugin checkout runs this, and in-app updates do not replace it: reinstall the plugin to get it.

## [0.3.24] - 2026-09-27

### Changed
- The installer's addresses are links a terminal can open with a click (OSC 8), plain text when
  the output goes to a file or log. It also names this PC's Tailscale IP next to the phone address,
  which stays the MagicDNS name: the HTTPS certificate is for the name, not the IP.

## [0.3.23] - 2026-09-27

### Fixed
- The one-line installer, run where the app is already installed, prints the phone address and its
  QR code from the version that runs. herdr's plugin directory keeps the version first installed
  (in-app updates run from `~/.config/herdr-web-ui/updates`), so it used to find no `phone` step
  there and only said to update. A running version from before 0.3.22 gets the address it already
  knows, as a QR code.

## [0.3.22] - 2026-09-27

### Added
- A one-line installer: `curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh`
  installs what is missing (herdr, Bun, Node 22, for the user only and without sudo), installs the
  herdr plugin and starts it when herdr runs. When Tailscale runs on the PC, it serves the app to
  the tailnet on the first free HTTPS port, says how to undo that, and prints the address a phone
  opens as a QR code. Running it again keeps what is there and prints the address again.
- `bun scripts/plugin.ts phone`, the installer's last step, for a plugin installed without it.

### Changed
- Through a proxy on a PC whose Tailscale login is known, as with `tailscale serve`, a request
  with no login (a tagged device) needs pairing, even before the first device is paired.
- The plugin starts the server with `~/.bun/bin`, `~/.local/bin` and the installer's Node appended
  to herdr's PATH, so a herdr started from a shell without them still runs terminals.

## [0.3.21] - 2026-09-27

### Added
- Codex and Claude skill activity stays visible above folded chat work blocks: the skill name,
  invocation/read status, and expandable evidence or document path. Recorded activity is distinct
  from completing the skill's workflow; English and Korean labels work on desktop and mobile.
- Native Codex image attachments, including image-only prompts, appear in the chat through
  bounded, pane-scoped image reads.

### Fixed
- Native context clears discard old turns, pending calls, loaded pages and stale cursors.
  Late page and tool-output responses cannot restore cleared history or populate another pane.
- omp, omo and gjc transcripts honor hidden messages and normalize string messages, tool field
  aliases and embedded results consistently across rendering, paging and full-output reads.
- omo transcript selection uses process/session evidence and rejects ambiguous same-directory
  candidates. Claude paste wrappers unwrap only when their identifiers match.

### Changed
- Growing Codex tasks parse incrementally while preserving transcript rewrite invalidation,
  reducing repeated parsing of long tool-heavy turns.

## [0.3.20] - 2026-09-27

### Added
- **Report a problem**: a small bug icon at the end of the chat's status line gathers what a chat
  or prompt-card bug is made of (the versions, browser and agent; the latest turns and the prompt
  card as parsed; the terminal screen if chosen) into a report to read and edit. It is then
  copied, saved as a file, or opened as a prefilled GitHub issue; nothing is sent on its own.

### Changed
- The ⚡ button beside the message box is gone: quick replies show above the box only when turned on
  in **Settings → Quick replies** (off by default), so the box looks as it did before them.
- The context left is a small ring beside the model, filled by what is used and red when little is
  left, as Codex's app shows it; hovering or tapping it says "Context 27% left" with the token
  counts. A session whose window the transcript does not name shows no ring.
- The `/ commands  @ files` hint above the message box is gone.
- In the sidebar, the computer the app runs on is marked **Host**, not "This PC", which on a phone
  read as the phone.
- Settings open from the sidebar's Settings button (and ⌘⇧, or the palette): the ⚙ in the header,
  one more way to the same place, is gone. On a phone that is ☰, then Settings.

### Fixed
- Numbered lists in the chat keep their numbers now: items with blank lines between them (as agents
  often write them) each read "1.", a list broken by a code block started over at 1, and one that
  began at 3 read 1. An item's indented lines now read as its own text, and a code block indented
  inside a list reads as code.

## [0.3.19] - 2026-09-27

### Added
- Quick replies: one-tap messages above the chat's message box (`continue`, `yes`, `no`,
  `commit and push`, `retry` to start with). Each is sent as if typed: queued while the agent works,
  taken as the answer when a question is open, and a draft in the box stays. **Settings → Quick
  replies** edits the list on each device; the row is hidden until the ⚡ button beside the paperclip
  shows it.
- The chat's status line says how much context is left: `74% left` from the window Codex records,
  or for Claude once a request has run past 200k (the 1M window); `68k used` where the transcript
  names no window (omp, omo, gjc, and Claude below 200k). It turns red at 20% left. Hovering shows
  the token counts.
- A tool call that failed says so: its row reads "failed" in red, its output is headed Error, and
  the folded "Worked for…" header counts the failures. Claude and omp record the failure; for Codex
  it is read from the output (a command that exited non-zero, a script or patch that failed).
- A file a tool call names (an edit, a read, a patch's files) opens in the viewer on a tap.
- A Codex patch reads as a diff: each file as a header, then its lines in red and green, and the row
  is summed up by the files it touches, also when an `exec` script applies it.
- While reading further up the chat, a ↓ button takes you back to the end, new messages or not.
- Images you sent show above your message: ones pasted into Claude's prompt, fetched only when
  shown, and ones attached here (an `@…png` mention). A tap opens them.
- An edit reads as one diff: unchanged lines once, removed and added lines in place between them,
  instead of the whole old block and then the whole new one. Several edits to one file each get
  theirs.
- Where a compaction folded a Claude conversation, a divider says so, and opens to its summary.
- Headings down to `######` render as headings.
- A tool output cut for the chat (past 4,000 characters) has a "Show the whole output" button that
  fetches the rest, up to 2 MB, into a box of its own.
- The `/` menu lists Claude's skills (yours and the project's) and the skills and commands of the
  plugins turned on in its settings, as `/<plugin>:<name>`. In a Codex pane it lists your saved
  prompts as `/prompts:<name>`, and `$` opens Codex's skills.
- On a phone, the terminal lens has an input line above the key bar. A phone keyboard rewrites
  what it typed (dictation revising a phrase, a Korean syllable being composed, autocorrect), and
  the terminal could not take back keys it had sent, so every revision arrived as more text. The
  line is written with the keyboard's own editing and goes to the pane whole, then Enter (typed
  like the keyboard, into an agent's open menu too); an empty line's button presses Enter alone.
  Tapping the terminal no longer raises the keyboard; the ⌨ key on the key bar switches to typing
  straight into it, remembered per device. Desktops are unchanged.

### Changed
- Remote PCs use the `remote-v5` runtime, which carries this release's server side to them: the
  context left and failed calls in their chats, images and whole tool outputs, skills in the menu,
  questions read in a narrow pane, and the terminal's input line. A connected PC's bridge updates
  itself as for `remote-v3`.
- Alerts wait before they go out, and a change of the pane meanwhile calls them off: a question
  answered at the PC within 10 seconds, or a finish followed by the next prompt within a minute,
  never buzzes the phone. A finish is told only after a turn that worked a minute or more, since a
  quick answer is read where it was asked.
- **Settings → Alerts** chooses, per device, whether a waiting agent alerts, and whether a finish
  does never, after a long turn (the default) or every time (then after 10 seconds). An ended
  terminal follows the finish choice.

### Fixed
- An agent's chat said "No conversation yet" until its first answer arrived, seconds on a remote PC.
  It now says it is loading.
- A Claude question never showed as a card in the chat when its pane was narrow (a phone, a split):
  the hint under the menu wraps (`… Esc to` / `cancel`), and it was looked for on one line. Hints
  are now read across the wrap, in every agent's menus, and so is the check that a menu is still
  open before an answer is typed into it. A single question's card is titled by its header chip.

## [0.3.18] - 2026-09-26

### Changed
- Remote PCs use the `remote-v4` runtime, which carries the fix below to the remote side: an omo
  or gjc pane that finished keeps reading DONE after the bridge restarts. A connected PC's bridge
  updates itself as for `remote-v3`.

### Fixed
- An omo or gjc pane that had finished read READY again after this server restarted (an update
  does): what this server adds to herdr's own `done` lived in memory. It is now kept in
  `completions.json` in the state directory, for the herdr it was seen in; a herdr started anew
  starts it over.

## [0.3.17] - 2026-09-26

### Changed
- Remote PCs use the `remote-v3` runtime, which carries 0.3.16's server fixes to the remote side: a
  finish in the pane herdr has in front reads DONE, and a Codex answer ending with a file link is
  found on screen. With **Update PC bridges automatically** on (the default), a connected PC's
  bridge updates itself once the app has; otherwise it asks for **Update bridge…**. herdr sessions
  are kept either way.

## [0.3.16] - 2026-09-26

### Added
- A pairing code from the PC's terminal, for a headless PC with no browser to open Settings →
  Devices in: `bun scripts/plugin.ts pair` (in the plugin checkout; a terminal command, since herdr
  keeps an action's output in its log) prints the code, the address a phone opens when Tailscale
  serves one, and that address as a QR code. Run by hand, it reads the PORT, HOST and token the
  plugin runs with from the config dir herdr names for it. Settings → Devices also shows the pairing
  link as text, to send to the other device however you like.

### Fixed
- Web addresses in the chat open. An address in backticks (`` `https://…` ``, as agents often write
  them) is a link that still looks like code; `[docs](www.example.com/x)`,
  `[guide](docs.example.com/guide)` and `[here](localhost:7317)` are links, not files; a bare
  `www.example.com/…` links like a full URL does, and `[here](127.0.0.1:8080)` over plain http. A
  file and its line (`[main.ts](main.ts:42)`) still opens the file, never a site of that name. In
  the terminal view, addresses in the output open in a new tab on click.
- A Codex chat whose last answer ends with a file link said "Conversation unavailable" while the
  terminal was open. Codex shows such a link as its label and a path relative to the repo, not
  the absolute path the session file keeps, so that answer was never found on screen. Answers are
  now looked for up to their last link target.
- An agent that finished in the pane herdr's terminal has in front read READY, and sent no alert,
  though nobody was looking: herdr reports a finish there as idle, and working from a browser or
  a phone never moves that focus. A finish now reads DONE and alerts in every pane, until the pane
  works again or focus moves onto it in herdr's terminal.
- A chat link to a local file (`[report](/repo/output/REPORT.md)`, as Codex writes them) showed
  only its label, so a sentence like "results and evidence" ended with nothing after it. The label
  now opens the file in the viewer, and where no viewer is available the path shows after it.

## [0.3.15] - 2026-09-26

### Added
- The app speaks Korean. It follows the browser's language, or **Settings → Appearance → Language**
  picks English or 한국어. Every label, button, hint and status in the client is translated; what
  agents write, terminal output and server messages are not. A test keeps the dictionary complete.

## [0.3.14] - 2026-09-26

### Added
- **Who gets in, without a token.** From anywhere but this PC, a request now gets in as the PC's
  own Tailscale login (which `tailscale serve` states in a header nobody else can set), as a
  paired device, or with the token. **Settings → Devices** pairs a device: a six-digit code that
  lives ten minutes, or the QR code that carries it, entered once on the other device, which then
  keeps its own credential; the list shows every device with its last visit, and **Revoke** ends
  one at its next request. Another Tailscale user's device is refused with a message. Until the
  first device is paired, and with no token set, a LAN or proxied address stays open as before.
  The sign-in screen asks for the code first and keeps the token as the other way.

## [0.3.13] - 2026-09-26

### Fixed
- With two or more Codex panes, one pane's chat could show another pane's conversation. Since
  Codex 0.157 every Codex TUI shares one app-server daemon, and that daemon reports each TUI's
  thread to herdr as the thread of the pane that started it. That report is now only a fallback:
  what the pane shows on screen decides, and a thread another pane shows, is bound to, or was
  resumed on is never taken for it.

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

[Unreleased]: https://github.com/devswha/herdr-web-ui/compare/v0.3.27...HEAD
[0.3.27]: https://github.com/devswha/herdr-web-ui/compare/v0.3.26...v0.3.27
[0.3.26]: https://github.com/devswha/herdr-web-ui/compare/v0.3.25...v0.3.26
[0.3.25]: https://github.com/devswha/herdr-web-ui/compare/v0.3.24...v0.3.25
[0.3.24]: https://github.com/devswha/herdr-web-ui/compare/v0.3.23...v0.3.24
[0.3.23]: https://github.com/devswha/herdr-web-ui/compare/v0.3.22...v0.3.23
[0.3.22]: https://github.com/devswha/herdr-web-ui/compare/v0.3.21...v0.3.22
[0.3.21]: https://github.com/devswha/herdr-web-ui/compare/v0.3.20...v0.3.21
[0.3.20]: https://github.com/devswha/herdr-web-ui/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/devswha/herdr-web-ui/compare/v0.3.18...v0.3.19
[0.3.18]: https://github.com/devswha/herdr-web-ui/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/devswha/herdr-web-ui/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/devswha/herdr-web-ui/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/devswha/herdr-web-ui/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/devswha/herdr-web-ui/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/devswha/herdr-web-ui/compare/v0.3.12...v0.3.13
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
