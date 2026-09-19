# herdr web ui Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented: this file
codifies what the UI already is, plus the consolidation applied while extracting it. The machine
copy of every token is the `:root` block in `src/styles.css`; the tables below must equal it
value for value. When a component needs a value that is not here, add it to both first.

## 1. Atmosphere & Identity

A quiet dark console where the terminal is the hero and the chrome stays out of the way. Surfaces
are near-black tonal steps separated by hairlines, text is cool grey, and the only saturated colors
are the brand blue and the four agent states, so a working or blocked agent is the loudest thing on
screen. The signature is the status rail: a 3px accent bar on the selected pane row and the same
blue on the terminal cursor, tying "what I am looking at" in the sidebar to "where I am typing".
Dark-only (`color-scheme: dark`): there is no light theme, and there will not be one.

## 2. Color

### Palette (dark-only; the Light column does not exist by design)

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Surface/base | `--bg` | `#070910` | `<body>`, area behind the shell |
| Surface/panel | `--bg-panel` | `#0b0e14` | Header, sidebar, terminal host |
| Surface/elevated | `--bg-elevated` | `#121724` | Selected row, chips, banners, pressed controls |
| Surface/hover | `--bg-hover` | `#1a2132` | Hover on rows and icon buttons |
| Border | `--border` | `#1e2637` | Hairlines, pill and control outlines |
| Text/primary | `--text` | `#c5cdd9` | Body, row titles |
| Text/dim | `--text-dim` | `#8390a8` | Metadata, ids, empty states, idle |
| Text/bright | `--text-strong` | `#e6edf7` | Brand, workspace labels, selected title |
| Accent | `--accent` | `#6cb6ff` | Selection rail, focus ring, agent chip text, cursor |
| Accent/tint | `--accent-tint` | `rgba(108, 182, 255, 0.12)` | Agent chip background; observe banner and observing pill, layered OVER `--bg-elevated` |
| Status/idle | `--status-idle` | `#8390a8` | Idle badge |
| Status/working | `--status-working` | `#e2a336` | Working badge, reconnecting dot and banner |
| Status/blocked | `--status-blocked` | `#f2545b` | Blocked badge, offline pill, error border |
| Status/done | `--status-done` | `#4ec9a5` | Done badge, live dot |
| Danger/tint | `--danger-tint` | `rgba(242, 84, 91, 0.12)` | Error state and offline pill background |
| Danger/text | `--danger-text` | `#ffd7d9` | Error message text, retry button |
| Overlay/scrim | `--scrim` | `rgba(0, 0, 0, 0.5)` | Behind the mobile drawer |
| Overlay/shadow | `--shadow-drawer` | `0 0 40px rgba(0, 0, 0, 0.6)` | The mobile drawer, nothing else |

### Terminal theme

xterm.js reads no CSS, so `PaneTerminal.tsx` carries these four values verbatim in its `theme`
object. They are tokens so the chrome can match them (the host background equals `--term-bg`).

| Role | Token | Value | xterm key |
|------|-------|-------|-----------|
| Terminal background | `--term-bg` | `#0b0e14` | `background` (= `--bg-panel`) |
| Terminal foreground | `--term-fg` | `#c5cdd9` | `foreground` (= `--text`) |
| Cursor | `--term-cursor` | `#6cb6ff` | `cursor` (= `--accent`) |
| Selection | `--term-selection` | `#2d3f5e` | `selectionBackground` |

### Rules
- Accent and the four status colors are the only saturated colors. Everything else is a grey step.
- Accent means "interactive or selected": rail, ring, cursor, agent chip. Never decorative.
- The unknown status has no color of its own: it uses `--text-dim` with a dashed border, because a
  darker grey fails 4.5:1 on `--bg-panel`.
- Tints are the one place `rgba()` appears, and only through `--accent-tint` / `--danger-tint`.
- Three colours live outside CSS and are synced by hand, because nothing there can read a custom
  property: `theme-color` in `index.html` and `theme_color` / `background_color` in
  `public/manifest.webmanifest` (= `--bg-panel` / `--bg`), and the brand tile in
  `public/icons/icon.svg` (gradient `#171d2e` → `#070910`, stroke `#2a3447`; its dots and chevron
  are the `--status-*` colours and `--accent`), and `public/favicon.svg` fills its tile with the flat
  `#0f1420`, that gradient's midpoint, because a 16px favicon has no room for a gradient.

## 3. Typography

### Scale

| Level | Token | Size | Weight | Line height | Tracking | Usage |
|-------|-------|------|--------|-------------|----------|-------|
| Brand | `--fs-lg` | 15px | `--fw-bold` 700 | `--lh-tight` 1.2 | `--tracking-tight` -0.01em | Wordmark |
| Label | `--fs-md` | 13px | `--fw-semibold` 600 | `--lh-base` 1.45 | 0 | Workspace label, terminal placeholder |
| Body | `--fs-sm` | 12px | `--fw-regular` 400 / `--fw-medium` 500 | `--lh-base` 1.45 | 0 | Pane title, header context, states, errors |
| Meta | `--fs-xs` | 11px | `--fw-regular` 400 | `--lh-base` 1.45 | 0 | Connection label, banners, "no panes" |
| Micro | `--fs-2xs` | 10px | `--fw-medium` 500 (badges, agent chip, tab overline) / `--fw-regular` 400 (pane ids, pills, workspace number) | `--lh-base` 1.45 (chips are flex-centred at `--chip-h`) | `--tracking-caps` 0.06em when uppercase | Badges, pills, ids, tab overline, chips |
| Input | `--fs-input` | 16px | inherits | inherits | 0 | Token gate input only: the one size iOS Safari does not zoom on focus |

### Font Stack
- UI: `--font-ui` = `Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif`
- Mono (ids, versions, codes): `--font-mono` = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
- Terminal (xterm only, hardcoded as `FONT_STACK` in `PaneTerminal.tsx`, 13px):
  `"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace`

### Rules
- Two families in the chrome (UI + mono); the terminal font is the pty's, not the chrome's.
- Body floor is 12px because this is a dense operational surface, not reading copy; 10px is only
  for uppercase chips and monospace ids that sit next to a larger primary line.
- Uppercase text always carries `--tracking-caps`; the wordmark always carries `--tracking-tight`.

## 4. Spacing & Layout

### Base Unit
All spacing derives from a base of **4px**.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon-to-label, chip padding, row inner gap |
| `--space-2` | 8px | Row padding, header gap, list item gaps |
| `--space-3` | 12px | Header inset, error padding, row left inset |
| `--space-4` | 16px | Between workspaces, empty-state padding |
| `--space-5` | 20px | Token gate copy → label |
| `--space-6` | 24px | Sidebar bottom breathing room, placeholder icon |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 6px | Rows, icon buttons, chips, retry button |
| `--radius-md` | 8px | Error state, empty state, the draft review banner and wrapped phone banners |
| `--radius-pill` | 999px | Badges, pills, banners, the connection dot |

### Sizes

| Token | Value | Usage |
|-------|-------|-------|
| `--header-h` | 46px | Header height (plus `env(safe-area-inset-top)`) |
| `--sidebar-w` | 300px | Sidebar column and drawer width |
| `--control-h` | 32px | Icon button, role toggle, retry button, gate input and button on fine pointers (`--touch-target` on coarse) |
| `--touch-target` | 40px | On `(pointer: coarse)`: pane row min-height, icon buttons, role toggle, retry button, gate input and button; key-bar keys always (min-width and height) |
| `--keybar-h` | 48px | Key bar height (plus `env(safe-area-inset-bottom)`); keys are `--touch-target` tall inside it |
| `--chip-h` | 18px | Badge, pill and chip height; banner minimum height (the draft review banner grows to its controls) |
| `--icon-size` | 18px | SVG inside an icon button |
| `--mark-size` | 22px | Brand mark |
| `--dot-size` | 7px | Connection dot |
| `--rail-w` | 3px | Selected-row accent rail |
| `--hairline` | 1px | Every border |

### Focus

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | `:focus-visible` outline on every interactive element |
| `--ring-offset` | 2px | Outline offset |

### Layers

| Token | Value | Usage |
|-------|-------|-------|
| `--z-banner` | 5 | Terminal banners and the empty-state placeholder over the xterm canvas |
| `--z-scrim` | 15 | Mobile scrim |
| `--z-drawer` | 20 | Mobile drawer above the scrim |

### Shell
- `.app` is a column: `.app-header` (fixed height) over `.app-body` (flex row, `min-height: 0`).
- `.app-body` is `.sidebar` (fixed `--sidebar-w`, owns its own vertical scroll) beside
  `.terminal-host` (`flex: 1`, `min-width: 0`, `overflow: hidden`; xterm owns scrolling inside).
- The app fills `var(--app-height, 100dvh)` with a `100%` fallback; header, drawer and terminal
  host add `env(safe-area-inset-*)` to their padding so notches and home bars never cover content.
  Where the key bar is rendered and visible (`.terminal-host:has(.key-bar)` under
  `(pointer: coarse), (max-width: 768px)`) the terminal host drops its bottom padding and the bar
  carries `env(safe-area-inset-bottom)` itself, so the inset is applied once; with no pane selected
  there is no bar and the host keeps the inset.
- `--app-height` is written on `<html>` by `src/lib/viewport.ts` from `window.visualViewport`
  (on `resize` and `scroll`, rounded, with the page pinned at `scrollTo(0, 0)`), so on iOS
  Safari the shell shrinks with the soft keyboard instead of sliding under it and the key bar
  stays above the keyboard. Chrome already resizes the layout viewport
  (`interactive-widget=resizes-content`); there the value is the same as `100dvh`.
- Breakpoints: `<= 768px` the sidebar becomes a left drawer over a scrim (a tablet in portrait
  cannot afford 300px next to an 80-column terminal); `<= 480px` the version pill is hidden so the
  header context keeps room. The ≤768px queries live in `src/styles.css`; the ≤480px rules
  span `src/styles.css` (`.pill-version`, `.conn-text`, `.brand-name`, `.context-workspace`) and
  `src/components/PaneTerminal.css` (banner wrapping) — component-scoped breakpoints stay with
  their component. At ≤480 the header keeps the role pill and the pane title by shedding the
  version pill, the conn label, the brand word (the 22px mark stays) and the workspace half of
  the context (the drawer names the workspace); 320px still fits.
- Browser mechanics stay raw: `calc()` with `env()`, `min-width: 0`, `inset: 0`, percentages.

## 5. Components

### Icon button (`.icon-button`)
- **Structure**: `<button class="icon-button" aria-label>` wrapping one inline SVG.
- **Variants**: `.drawer-toggle` (only rendered `<= 768px`); `.lock-button` (header, only when
  `health.auth.required`; calls `DELETE /api/auth` then refetches health so the gate returns);
  `.bell-button` (header, only when the Web Notification API exists — a secure context — and
  permission is not `denied`; click asks for permission, `.is-on` is the granted state:
  accent glyph and border, and `disabled` once granted — re-asking is impossible from JS, so
  the granted bell carries the shared disabled treatment: opacity 0.7, no hover, default cursor).
- **Spacing**: `--control-h` square (`--touch-target` square on `(pointer: coarse)`), `--icon-size` glyph, `--radius-sm`.
- **States**: default (transparent, `--border`), hover (`--bg-hover`), active and
  `[aria-expanded="true"]` (`--bg-elevated`, `--accent` border, `--text-strong`), disabled
  (`opacity: 0.7`, `cursor: default`, no hover — 0.7 keeps the accent glyph at 4.90:1 on
  `--bg-panel`), focus (`--ring`).
- **Accessibility**: `aria-label` (icon-only), `aria-expanded` + `aria-controls` on the toggle.
- **Motion**: background/border `--dur-fast`.
- **Layout**: cluster item in the header.

### Badge (`.badge`)
- **Structure**: `<span class="badge badge-{status}" data-status title="agent {status}">`.
- **Variants**: `badge-idle`, `badge-working`, `badge-blocked`, `badge-done`, `badge-unknown`
  (dim + dashed).
- **Spacing**: `--chip-h` tall, `0 --space-2` padding, `--radius-pill`, `--fs-2xs` uppercase.
- **States**: static; `badge-working` pulses (`--dur-pulse`) because working is a live state.
- **Accessibility**: `title` names the state; color is never the only signal (text + dash).
- **Layout**: last item of the workspace header and of the pane meta cluster.

### Pill (`.pill`)
- **Structure**: `<span class="pill">` mono text.
- **Variants**: `.pill-version` (`herdr 0.9.0`, hidden `<= 480px`), `.pill-offline` (danger).
- **Spacing**: `--chip-h`, `0 --space-2`, `--radius-pill`, `--font-mono` at `--fs-2xs`.
- **States**: static.
- **Layout**: header meta cluster, right edge.

### Brand (`.brand`)
- **Structure**: `<h1 class="brand"><img class="brand-mark" src="/icons/icon.svg" alt="" width="22" height="22">
  <span class="brand-name">herdr <span class="brand-sub">web ui</span></span></h1>`. Visible text is
  exactly `herdr web ui`.
- **Spacing**: `--mark-size` mark, `--space-2` gap, `--fs-lg` / `--fw-bold` / `--tracking-tight`.
- **States**: static; `brand-sub` is `--text-dim` at `--fw-medium`.

### Header context (`.context`)
- **Structure**: `<div class="context" title>` → `.context-workspace` › `.context-pane`.
- **Spacing**: `--space-1` gaps, `--fs-sm`; both segments ellipsize, the separator never shrinks.
- **States**: rendered only while a pane is selected.
- **Layout**: the single flexible header item (`flex: 1 1 auto; min-width: 0`).

### Connection indicator (`.conn`)
- **Structure**: `<span class="conn conn-live|conn-reconnecting" role="status"><span class="conn-dot"/>live|reconnecting</span>`.
- **Spacing**: `--dot-size` dot, `--space-1` gap, `--fs-xs`.
- **States**: live (`--status-done` dot, dim text), reconnecting (`--status-working` dot + text,
  dot pulses). Driven by `PaneTerminal`'s `onConnectionChange` prop. ≤480px the label text
  collapses to the visually-hidden `.conn-text` (the dot stays, the live region still announces).
- **Accessibility**: `role="status"` announces the change; the dot is `aria-hidden`.

### Sidebar tree (`.tree`, `.workspace`, `.pane-row`)
- **Structure**: `<nav class="tree">` → `<section class="workspace">` with
  `<header class="workspace-header">` (`.workspace-number` chip, `.workspace-label`, badge), an
  optional `.tab-label` overline (only when the workspace has more than one tab), and
  `<ul class="pane-list">` of `<button class="pane-row">` with `.pane-title` on line one and
  `.pane-meta` (`.pane-id` mono, `.agent-chip`, badge) on line two.
- **Spacing**: `--space-4` between workspaces, `--space-1` inside a workspace, rows padded
  `--space-2` with a `--space-3` left inset that the rail sits in.
- **States**: default, hover (`--bg-hover`), selected (`--bg-elevated` + inset `--rail-w` accent
  rail, title `--text-strong`, `aria-current="true"`), focus (`--ring`), loading (`.tree-state`
  "Loading workspaces…", `role="status"`), empty (`.tree-state-empty`, `role="status"`, "No workspaces yet — open one
  in herdr", dashed `--border` box), error (App-owned `.error-state`, `role="alert"`, with `.error-retry`).
- **Accessibility**: `<nav aria-label>`, real `<button>` rows with `title`, `aria-current` on the
  selected row, `min-height: --touch-target` on coarse pointers.
- **Motion**: row background `--dur-fast`.
- **Layout**: stack inside the sidebar, which owns the scroll.

### Terminal host (`.terminal-host`, `.pane-terminal`, `.terminal-placeholder`, `.terminal-banners`)
- **Structure**: `<main class="terminal-host">` (shell, `styles.css`) containing
  `PaneTerminal`: optional placeholder (icon + "Select a pane to open its terminal"), the
  `.terminal-banners` column, and the `.pane-terminal` xterm mount.
- **Spacing**: host padded `--space-2` (+ safe-area insets); the banner column anchored at
  `--space-2` / `--space-3` from the top-right, banners `--chip-h` (minimum) with
  `0 --space-2` padding, `--radius-pill` — the draft review banner and any banner that
  wraps on a phone take `--radius-md` and vertical padding instead.
- **States**: empty (placeholder, `--text-dim`, `--fs-md`, painted at `--z-banner` above the mount,
  which is `visibility: hidden` while no pane is selected so its cursor never shows through),
  connecting (App renders this host without `PaneTerminal`, and so without a WebSocket, while the
  auth state is unknown: "Connecting to herdr web ui…" instead of a blank page), ended
  (`.terminal-banner`, neutral; appends `— held input discarded` when a draft existed),
  reconnecting (`.terminal-banner-warning`, `--status-working`; while a draft is held it appends
  `input held: “…”` capped at 32ch so the user sees what did not send), reviewing
  (`.terminal-banner-draft`: after reconnect, the held input waits in the column's slot with the
  draft text in `--font-mono` ellipsized at 32ch, a dropped-special-keys count, and Send /
  Discard buttons at `--control-h`, `--radius-sm`; the one banner that accepts pointer events),
  observing (`.terminal-banner-observe`, `--accent` text and border on `--accent-tint` layered
  over `--bg-elevated`: "view only — the operator's screen size is untouched"; wraps to 36ch
  ≤480px). Banners carry `role="status"`.
- **Layout**: `position: relative` host; `.terminal-banners` is one absolute top-right column
  (flex, `--space-2` gap, `max-width: calc(100% - 2 * var(--space-3))`, `pointer-events: none`
  — the review banner re-enables them) so any state combination stacks without collisions
  while the pty keeps every row. ≤480px every banner wraps instead of overflowing.

### Role toggle (`.role-toggle`)
- **Structure**: `<button class="role-toggle">` whose visible label IS the state — `interactive`
  / `view only` — as the first item of the header's `.header-meta` cluster, next to the
  connection indicator (the role is a property of the CONNECTION, and the header keeps
  every control off the pty canvas). No `aria-pressed`: the label names the state
  (the play/pause pattern), and the observe banner announces the transition.
- **Semantics**: the connection's role (`interact` types and resizes, `observe` neither — enforced
  server-side). The server's `role-ack` applies the local consequences, so the pill only sends
  the request; returning to interact force-refits and re-asserts the local geometry, and xterm's
  stdin is gated with `disableStdin` while observing.
- **Spacing**: `--control-h` tall (`--touch-target` on `(pointer: coarse)`, same block as
  the icon buttons), `0 --space-3` padding, `--radius-pill`, `--fs-xs` at `--fw-medium`.
- **States**: default (`--bg-elevated`, `--text-dim`), hover (`--text`, `--accent` border),
  active (`--bg-hover`), observing (`.is-observing`: `--accent` text and border on
  `--accent-tint` layered over `--bg-elevated` — accent marks the connection's own state
  here, not an agent status), focus (`--ring`).
- **Motion**: color and border `--dur-fast`; none under `prefers-reduced-motion`.
- **Ownership**: `App.tsx` owns the state; `PaneTerminal` sends changes to the server and
  reports the server's `role-ack` back (the pill shows the confirmed role, and the initial
  `interact` default is never re-sent — but on every (re)connect the role frame IS sent first,
  so a role flipped while disconnected converges on the ack instead of getting stuck).
  The pill renders even with no pane selected: the role is a property of the connection,
  which exists regardless.

### Scrollback

- xterm keeps none (`scrollback: 0`). The attach stream lives in the alternate
  screen and herdr owns scrollback (wheel and touch gestures are forwarded to it), so the fit
  addon uses the full host width instead of reserving a phantom 15px scrollbar, and
  `.xterm-viewport` hides its scrollbar.

### Key bar (`.key-bar`)
- **Structure**: `<div class="key-bar" role="group" aria-label="Terminal keys">` of
  `<button type="button" class="key" data-key tabindex="-1">`: `Esc`, `Tab`, `Ctrl`
  (`aria-pressed`), four chevron keys (inline SVG + `aria-label` Up / Down / Left / Right) and
  `^C` (`aria-label="Control C"`). Rendered by `KeyBar.tsx`; `PaneTerminal` mounts it as the
  last child of `.terminal-stack`, under the xterm mount, only while a pane is selected AND the
  connection is interactive (observing hides it: an observer has nothing to send). Taps go through `term.input()` so
  they take the same `onData` → socket path as typed keys.
- **Variants**: none. `.key.is-armed` is the one-shot Control: the next single printable
  character is sent as its control code (A-Z and `@ [ \ ] ^ _`), then Control disarms; tapping
  it again while armed disarms it.
- **Spacing**: bar `--keybar-h` tall plus `env(safe-area-inset-bottom)` of bottom padding, no
  side padding (the host's `--space-2` is the inset); keys `--touch-target` tall,
  `min-width: --touch-target`, `0 --space-1` padding, `--space-1` gap, `--radius-sm`,
  `--font-mono` at `--fs-sm`; chevrons `--icon-size`.
- **States**: default (transparent, `--border`), hover (`--bg-hover`, only under
  `(hover: hover)` so a tapped key does not stay lit), active and armed (`--bg-elevated`,
  `--accent` border, `--text-strong`), focus (`--ring`). The bar is `display: none` on
  fine-pointer desktops and `display: flex` under `(pointer: coarse), (max-width: 768px)`; it
  scrolls sideways with a hidden scrollbar when the keys outgrow the viewport.
- **Accessibility**: `role="group"` + `aria-label` (not `toolbar`: the keys are out of the tab order, so the
  toolbar role would promise arrow-key navigation that does not exist); icon-only keys carry `aria-label`; Control
  carries `aria-pressed`. Keys are `tabindex="-1"` and cancel `pointerdown` and `mousedown`, so
  focus never leaves xterm's textarea and the soft keyboard stays open; hardware keyboards
  already have these keys, so the bar stays out of the tab order. Every key is a 40x40 target.
- **Motion**: background/border `--dur-fast`; none under `prefers-reduced-motion`.
- **Layout**: `flex: none` at the bottom of `.terminal-stack` (column, `height: 100%`) with a
  `--border` hairline on top; `.pane-terminal` above it is `flex: 1 1 auto; min-height: 0;
  overflow: hidden`, so the bar takes rows from the pty instead of covering them.

### Drawer + scrim (`.sidebar.is-open`, `.scrim`)
- **Structure**: `<= 768px` the `.sidebar` becomes `position: fixed` below the header and slides
  in from the left; `.scrim` is rendered while open and closes the drawer on click.
- **States**: closed (`translateX(-100%)`, `visibility: hidden` so rows leave the tab order),
  open (`translateX(0)`, `--shadow-drawer`). Toggle carries `aria-expanded`.
- **Motion**: `transform --dur-base --ease-out`; visibility flips after the slide-out.
- **Layout**: drawer top = header height + `env(safe-area-inset-top)`, bottom padding adds
  `env(safe-area-inset-bottom)`.

### Token gate (`.token-gate`)
- **Structure**: `<main class="token-gate-screen">` (grid, centers on `--bg`, `--space-4` + safe-area
  padding) → `<form class="token-gate" data-testid="token-gate" aria-labelledby>` card:
  `.token-gate-mark` (`/icons/icon.svg`, `calc(var(--mark-size) * 2)`), `<h1 class="token-gate-title">`
  "herdr web ui" (`brand-sub` dim), `.token-gate-copy` "This server requires an access token.",
  `<label>` + `<input class="token-gate-input" type="password" name="token"
  autocomplete="current-password" autofocus>` (named by its `<label for>`), `<button type="submit"
  class="token-gate-submit">` "Unlock", and `.token-gate-error` (`role="alert"`, referenced by the
  input's `aria-describedby`) only after a failed attempt. Rendered by `App` instead of the shell
  while `health.auth.required && !authenticated` or a session poll answers 401; the shell (and its
  WebSocket) never mounts while locked.
- **Variants**: none. `.token-gate-submit` is the system's one filled control (`--accent` fill, `--bg` text).
- **Spacing**: card `min(100%, calc(var(--sidebar-w) + 2 * var(--space-6)))` wide so the content
  column is exactly `--sidebar-w`; `--space-6` padding, `--radius-md`, `--hairline` `--border` on
  `--bg-panel`. Mark → title `--space-4`, title → copy `--space-1`, copy → label `--space-5`, label →
  input `--space-1`, input → button `--space-3`, button → error `--space-3`. Input and button are
  `--control-h` tall (`--touch-target` on coarse pointers), `--radius-sm`. Type: title `--fs-lg` / `--fw-bold` / `--tracking-tight`; copy
  `--fs-md` `--text-dim`; label `--fs-sm` `--fw-medium`; input `--fs-input` `--text-strong` on
  `--bg-elevated`; button `--fs-md` `--fw-semibold`; error `--fs-sm` `--danger-text` on
  `--danger-tint` with a `--status-blocked` border.
- **States**: idle (input autofocused, global `--ring`), hover on submit (`color-mix()` of `--accent`
  with `--text-strong`), active (`--accent` with `--bg`), submitting (button `disabled`, "Unlocking…",
  opacity 0.6, `cursor: progress`), invalid (`aria-invalid="true"` → `--status-blocked` border, error
  block "Token does not match." or the network error text; input re-selected), empty submit (no
  request, input focused). Unlock success unmounts the gate and mounts the shell.
- **Accessibility**: `<main>` landmark, one `<h1>`, real `<label for>`, `role="alert"` error,
  `aria-invalid` + `aria-describedby` on the input, Enter submits, 32px controls (40px on coarse pointers). The header Lock
  control is an `.icon-button.lock-button` with `aria-label="Lock"` and an inline SVG padlock,
  rendered only when `health.auth.required`.
- **Motion**: border/background/opacity `--dur-fast` `--ease-out` on the input and button only; no
  entrance animation; none under `prefers-reduced-motion`.
- **Layout**: full-viewport `min-height: 100dvh` grid; the card shrinks to `100%` of the padded
  viewport on phones and never scrolls horizontally.

## 6. Motion & Interaction

### Timing

| Type | Token | Duration | Easing | Usage |
|------|-------|----------|--------|-------|
| Micro | `--dur-fast` | 120ms | `--ease-out` | Hover/active background and border on rows and controls |
| Standard | `--dur-base` | 180ms | `--ease-out` | Drawer slide |
| Pulse | `--dur-pulse` | 1600ms | `--ease-out`, infinite, opacity 1 → 0.75 | Working badge, reconnecting dot (the 0.75 trough keeps `--status-working` text at 5.3:1 on `--bg-panel` and 4.7:1 on `--bg-hover`) |

`--ease-out` = `cubic-bezier(0.2, 0, 0, 1)`.

### Rules
- Only real state changes move: the drawer opening, an agent that is working, a socket that is
  reconnecting. Nothing else animates; there is no hero moment and no entrance animation.
- Only `transform` and `opacity` (and background/border color on hover) are animated.
- `prefers-reduced-motion: reduce` removes the pulse and the drawer transition; states still
  render, they just snap.
- Every interactive element has hover, active and `:focus-visible` states from the tokens above.

## 7. Depth & Surface

### Strategy
**Mixed: tonal-shift + hairlines.** Depth is four tonal steps (`--bg` → `--bg-panel` →
`--bg-elevated` → `--bg-hover`) separated by `--hairline` `--border` lines. There are no shadows
on resting surfaces; the one shadow in the system is `--shadow-drawer`, on the mobile drawer,
because it floats over the terminal.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--border)` | Header bottom, sidebar right, pills, controls |
| Dashed hairline | `var(--hairline) dashed var(--border)` | Empty state box, unknown badge |
| Tonal lift | `--bg-elevated` on `--bg-panel` | Selected row, chips, banners |
| Tinted lift | `--accent-tint` layered over `--bg-elevated` (`linear-gradient(tint, tint) base`) | Observe banner, observing pill — any accent-tinted surface gets the opaque base, whether it floats over the pty canvas or sits in the header |
| Drawer shadow | `--shadow-drawer` | Mobile drawer only |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA target. Measured contrasts on `--bg-panel`: `--text-dim` 6.0:1 (5.0:1 on `--bg-hover`, the
  darkest surface dim text and idle badges sit on), `--accent` 9.0:1,
  `--status-working` 8.7:1, `--status-blocked` 5.7:1, `--status-done` 9.4:1, `--text` 11+:1.
  The former `#4a5468` unknown-badge grey (2.5:1) was removed for this reason.
- Visible `--ring` focus on every interactive element via a global `:focus-visible` rule.
- Icon-only controls carry `aria-label`; the drawer toggle carries `aria-expanded` +
  `aria-controls`; the selected pane row carries `aria-current="true"`; status text
  (connection, banners, loading) uses `role="status"`.
- No emoji anywhere in markup; icons are inline SVG with `aria-hidden="true"`.
- `prefers-reduced-motion` honored (Section 6). Touch targets on coarse pointers: 40px rows, icon
  buttons, retry button, key-bar keys and gate controls (`--touch-target`); 32px controls on fine pointers.
- `document.title` is `<pane title> · herdr` while a pane is selected, else `herdr web ui`.

### Accepted Debt
| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| react-grab / react-scan / react-doctor not installed | `src/main.tsx`, `package.json` | Lead decision: no new dependencies in this pass (React Dev Tooling Gate skipped) | Revisit when a perf pass is scheduled |
| No real-browser Lighthouse run in this pass | whole app | `playwright-lighthouse` is not a dependency and adding one is out of scope; verification was typecheck, build, tests and screenshots at 375/768/1280 | Add when the dependency freeze lifts |
| Terminal theme values duplicated in `PaneTerminal.tsx` | `PaneTerminal.tsx` theme + `--term-*` | xterm.js cannot read CSS custom properties and the component must not read new inputs | Keep in sync by hand; the `--term-*` tokens are the reference |
| Drawer has no focus trap | `.sidebar.is-open` | Closed drawer leaves the tab order via `visibility: hidden`; trapping focus inside an open drawer needs a small focus utility that another lane owns (key bar / soft keyboard) | Add with the touch toolbar work |
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | xterm's screen-reader mode is off; enabling it changes the terminal's DOM and input behaviour and is a product decision | Decide with the herdr TUI owners |
