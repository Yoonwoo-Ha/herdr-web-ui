# herdr web ui Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented. The machine
copy of every token is the `:root` block in `src/styles.css`; every table below mirrors it value for
value. When a component needs a value that is not here, add it to both first.

## 1. Atmosphere & Identity

A warm terminal: an amber-phosphor console on lamp-lit graphite (dark) or ledger paper (light),
with chat-app clarity. Tonal surfaces and hairlines keep the chrome out of the way. There is ONE
chrome color, amber: selection, focus, the terminal cursor and the user's own action (Send, primary
buttons). Agent states carry the remaining saturated colors and none of them is amber. The user's
chat turns are neutral raised cards, so a long thread never turns into a wall of color. Dark is the
default, light follows the same hierarchy, and comfortable or compact density changes scale without
changing information architecture.

The signature is the amber status rail: a 3px bar on the selected pane row (whose mark box also
takes an amber edge), the same amber on focus, the chosen lens glyph and the terminal cursor, tying
“what I am looking at” to “where I am typing.”

## 2. Color

### Palette

Only tokens overridden by `[data-theme="light"]` have a light value. Both columns are literal CSS.

| Role | Token | Dark | Light |
|------|-------|------|-------|
| Surface/base | `--bg` | `#12100e` | `#eeeae2` |
| Surface/panel | `--bg-panel` | `#181613` | `#faf8f3` |
| Surface/elevated | `--bg-elevated` | `#211e1a` | `#f2eee6` |
| Surface/hover | `--bg-hover` | `#2a2621` | `#e8e2d6` |
| Surface/input | `--bg-input` | `#1c1916` | `#fffdf9` |
| Border | `--border` | `#2d2924` | `#dcd4c6` |
| Border/strong | `--border-strong` | `#3e3830` | `#c5baa8` |
| Text/primary | `--text` | `#d8d0c3` | `#2a251f` |
| Text/dim | `--text-dim` | `#9b9183` | `#685e52` |
| Text/strong | `--text-strong` | `#f2ebdf` | `#16120d` |
| Accent | `--accent` | `#f0a830` | `#8c5000` |
| Accent/tint | `--accent-tint` | `rgba(240, 168, 48, 0.13)` | `rgba(140, 80, 0, 0.1)` |
| Primary | `--primary` | `#f0a830` | `#c57d12` |
| Primary/hover | `--primary-hover` | `#f6bb55` | `#d48c1f` |
| Primary/text | `--primary-text` | `#1b1407` | `#1b1407` |
| Primary/tint | `--primary-tint` | `rgba(240, 168, 48, 0.16)` | `rgba(197, 125, 18, 0.14)` |
| Status/idle | `--status-idle` | `#9b9183` | `#685e52` |
| Status/working | `--status-working` | `#6cb8d6` | `#155a72` |
| Status/blocked | `--status-blocked` | `#ff7b70` | `#a82323` |
| Status/done | `--status-done` | `#93c36b` | `#2f6317` |
| Working/tint | `--status-working-tint` | `rgba(108, 184, 214, 0.14)` | `rgba(21, 90, 114, 0.12)` |
| Blocked/tint | `--status-blocked-tint` | `rgba(255, 123, 112, 0.14)` | `rgba(168, 35, 35, 0.12)` |
| Done/tint | `--status-done-tint` | `rgba(147, 195, 107, 0.14)` | `rgba(47, 99, 23, 0.12)` |
| Danger/tint | `--danger-tint` | `rgba(255, 123, 112, 0.12)` | `rgba(168, 35, 35, 0.1)` |
| Danger/text | `--danger-text` | `#ffd9d4` | `#8f1d1d` |
| Overlay/scrim | `--scrim` | `rgba(8, 6, 4, 0.55)` | `rgba(40, 32, 22, 0.35)` |
| Drawer shadow | `--shadow-drawer` | `0 0 40px rgba(0, 0, 0, 0.6)` | `0 0 40px rgba(40, 32, 22, 0.22)` |
| Popover shadow | `--shadow-pop` | `0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--border)` | `0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)` |
| Card shadow | `--shadow-card` | `0 4px 16px rgba(0, 0, 0, 0.35)` | `0 4px 16px rgba(40, 32, 22, 0.07)` |

### Terminal theme

xterm.js reads a JavaScript theme, so `src/lib/settings.ts` `terminalTheme()` mirrors these four
CSS tokens verbatim for each resolved theme.

| Role | Token | Dark | Light | xterm key |
|------|-------|------|-------|-----------|
| Background | `--term-bg` | `#181613` | `#faf8f3` | `background` |
| Foreground | `--term-fg` | `#d8d0c3` | `#2a251f` | `foreground` |
| Cursor | `--term-cursor` | `#f0a830` | `#8c5000` | `cursor` |
| Selection | `--term-selection` | `#4a3d26` | `#f0d9ae` | `selectionBackground` |

### Rules
- Amber is the one chrome color. Accent (selected, focused, informational) and primary (the user's
  action: Send, primary buttons) are both amber; in light, accent is the darker text-safe ochre and
  primary the brighter fill carrying ink text. Agent states never use amber.
- Agent state is always written as a label as well as colored. Unknown uses dim text and a dashed
  edge rather than inventing a fifth state color.
- Tints are named tokens; components do not introduce ad hoc translucent state colors.
- `theme: "system"` follows `prefers-color-scheme`; `src/lib/settings.ts` writes the resolved
  `data-theme`, `color-scheme`, and matching PWA `<meta name="theme-color">`.

## 3. Typography

### Scale

| Level | Token | Comfortable | Compact | Typical use |
|-------|-------|-------------|---------|-------------|
| Micro | `--fs-2xs` | `11px` | `10px` | Badges, hints, kbd |
| Meta | `--fs-xs` | `12px` | `11px` | Subtitles, field labels |
| Small | `--fs-sm` | `13px` | `12px` | Controls, row titles |
| Body | `--fs-md` | `14px` | `13px` | Body and dialog copy |
| Large | `--fs-lg` | `16px` | `15px` | Header title, modal title |
| Display | `--fs-xl` | `18px` | `17px` | Markdown h1 |
| Input | `--fs-input` | `16px` | `16px` | Mobile-safe text input |

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif` | Chrome and chat prose |
| `--font-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace` | Paths, keys, terminal-adjacent metadata |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls |
| `--fw-semibold` | `600` | Labels and titles |
| `--fw-bold` | `700` | Brand |
| `--tracking-tight` | `-0.01em` | Brand and primary titles |
| `--tracking-caps` | `0.06em` | Uppercase operational labels |

### Settings
- `theme`: `dark`, `light`, or `system`; default `dark`.
- `density`: `comfortable` or `compact`; default `comfortable`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
- Composer Enter behavior and folded thinking visibility are preferences, not typography tokens.
- All settings share one sanitized `localStorage["herdr-web-ui:settings"]` record.

## 4. Spacing & Layout

### Base unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Tight icon and control gaps |
| `--space-2` | `8px` | Row and menu gaps |
| `--space-3` | `12px` | Control padding |
| `--space-4` | `16px` | Section and modal padding |
| `--space-5` | `20px` | Wide modal padding |
| `--space-6` | `24px` | Card breathing room |
| `--space-8` | `32px` | Large separation |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Chips and inner controls |
| `--radius-md` | `8px` | Buttons, inputs, selected rows |
| `--radius-lg` | `12px` | Menus and chat surfaces |
| `--radius-xl` | `16px` | Modals and composer |
| `--radius-pill` | `999px` | Pills and dots |

### Sizes

Comfortable values are `:root`; the final column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header |
| `--sidebar-w` | `320px` | `300px` | Sidebar/drawer |
| `--control-h` | `34px` | `32px` | Buttons and fields |
| `--touch-target` | `40px` | — | Coarse-pointer minimum |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Roster and palette rows |
| `--chip-h` | `20px` | `18px` | Badge/pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `32px` | `26px` | Roster mark box |
| `--dot-size` | `7px` | — | Connection dot |
| `--rail-w` | `3px` | — | Selected-row rail |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Chat/settings content |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions |
| `--z-scrim` | `15` | Mobile drawer scrim |
| `--z-drawer` | `20` | Mobile drawer |
| `--z-modal` | `30` | Dialog and palette scrims |

### Shell
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is sidebar plus
  `.terminal-host`. `--app-height` follows `visualViewport` so the soft keyboard does not cover input.
- Header anatomy, left to right: mobile drawer toggle / desktop sidebar toggle; flexible context
  title plus PC/workspace/cwd subtitle; segmented Chat/Terminal switch; the connection chip (herdr
  version in its tooltip) and meta actions for palette, notifications, settings and lock. Theme
  lives in Settings and the palette; the herdr version also sits in the sidebar footer.
- The sidebar is fixed-width on desktop and a `<=768px` drawer. The desktop collapse removes its
  column; the drawer uses a scrim and keeps safe-area insets.
- The terminal stack contains a positioned terminal surface, then composer or key bar. The xterm
  mount stays alive under the chat lens; changing views never creates a second connection.
- At `<=480px`, labels shed in priority order: version, brand name, context subtitle, connection
  text and desktop-only control labels. Icons and selected context remain.

## 5. Components

### Button (`.btn`, `.icon-button`)
- `.btn` is a medium text control. Variants: neutral, `.btn-primary`, `.btn-danger`, `.btn-ghost`.
  Primary uses `--primary`; danger uses danger tint plus blocked border; ghost removes fill/edge.
- `.icon-button` is a square unlabeled visual control with mandatory `aria-label`; `.is-outlined`
  adds the border. Both families use `--control-h`, `--radius-md`, focus ring, hover and disabled.
- Coarse pointers grow controls to `--touch-target`.

### Segmented control (`.segmented`)
- One `aria-pressed="true"` option receives hover fill and strong text; the group itself is an
  elevated, bordered `--radius-md` track.
- Used for Chat/Terminal, theme and density. It is not a generic tab list.

### Keyboard hint (`.kbd`)
- An inline mono keycap: `18px` high, strong bottom edge, `--radius-sm`, `--fs-2xs`.
- `Mod` resolves to `⌘` on Apple platforms and `Ctrl` elsewhere.

### Modal (`.modal*`)
- `.modal-scrim` centers an `aria-modal` dialog at `--z-modal`; `.modal` is a capped scrollable
  column with header, body and footer and `--shadow-pop`.
- At `<=640px`, it becomes a bottom sheet with top `--radius-xl` corners and safe-area padding.
- Escape, explicit close and scrim click close dialogs; first meaningful control receives focus.

### Field (`.field`, `.input`, `.select`)
- Stacked uppercase label, optional hint and `--bg-input` field. Desktop fields use `--fs-sm`;
  small-screen fields retain `--fs-input` to avoid focus zoom.
- Focus names the edge with accent; errors use blocked/danger tokens and `role="alert"`.

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--bg-hover`. Headings are dim uppercase micro labels.

### Badge (`.badge`)
- Agent states read **READY**, **RUN**, **INPUT**, **DONE**; unknown reads **—**.
- Idle is elevated/dim; working, blocked and done use their own tint and text. RUN carries a small
  breathing dot before the word; the word itself never fades.
- The written label and unknown dashed edge keep color from being the only signal.

### Pill (`.pill`)
- Mono metadata at `--chip-h`. The herdr version is a sidebar-footer pill; offline is the one header pill and uses danger tokens.

### Sidebar roster row and footer
- Top bar: **New session** only. Search lives in the command palette, not the roster.
- A workspace header shows drag handle, number, editable label, roll-up status and rename action.
  Drag/drop reorders; `Alt+↑/↓` on the handle is the keyboard equivalent.
- Every pane row is two lines: agent/shell mark, then the editable title alone on line one (full
  width), and the status chip followed by workspace and cwd on line two. Mark boxes are neutral;
  the selected row gets the amber rail and an amber-edged mark box. Row actions rename or arm a
  3-second, second-click close. Inline server failures stay beside their row.
- A PC group header is caret, monitor, name, “This PC” for the local machine and a state dot
  (done = connected, working pulse = connecting/reconnecting, blocked = error). Connected says
  nothing more; every other state is written under the name, with the server's error clamped to
  two lines and complete in the tooltip.
- Single-pane workspaces merge their workspace handle into the pane row.
- Footer holds the contextual **Install app** action, Settings, product name and herdr version.

### New session dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. Directory defaults to
  the selected pane cwd and name is an optional workspace label.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.

### Header context and connection
- A selected pane shows agent mark + title over workspace + cwd. With no selection, the brand fills
  the context slot.
- The segmented Chat/Terminal view switch lives in the header. There is no floating view-toggle pill.
- Connection is one quiet chip: a dot plus the written live/reconnecting/disconnected state;
  reconnecting pulses the dot. On phones the chip keeps only its dot.

### Chat turn (`.chat-turn`)
- The chat lens is a centered `--content-w` transcript over the still-attached terminal surface.
  Structured Claude/omp transcripts fall back to ANSI-stripped pane scrollback when unavailable.
- The register is Codex / gajae-code-app: a quiet document. User turns are right-aligned neutral
  cards (`--bg-elevated`, hairline edge, `--radius-lg` with a `--radius-sm` tail corner, ≤80% wide,
  no avatar or name) and open a new exchange with a hairline above. Assistant turns have no header: the answer is plain prose; a meta row (MD / TXT
  copy, time) fades in on hover (always visible on coarse pointers).
- Markdown supports headings, lists, links, quotes, tables, inline/fenced code and code-copy actions.
  Thinking renders as a folded block only when **Show thinking** is enabled.
- Auto-follow stops when the reader scrolls up; later output raises a **New messages** pill.

### Work block (`.work-block`, `.work-row`)
- One per assistant turn: a `▸ Worked for 7s · 1 edit · 2 commands` header (duration = next turn's
  timestamp minus this one's; "Working…" in `--status-working` behind a breathing dot while the agent runs) over
  one-line rows `▸ [icon] name / summary` in mono, indented under the header; mid-work narration
  sits between rows as dim, one-step-smaller prose. The newest turn opens by default, older ones
  fold. A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp
  or codex question, approval or plan menu.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own field. The prompt content hash rejects a stale answer with `prompt_changed`.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE surface: the stack, the transcript and the composer region all sit on `--bg`,
  and the composer column equals the transcript column (`--content-w`, same `--space-4` gutter).
  The only card is the input box: `--bg-elevated`, hairline border, `--radius-xl`, `--shadow-card`;
  focus turns its border `--accent` (no inner outline). Above it the agent/status line and the
  completion popover; inside, ONE row — attach control | auto-growing textarea | Send / Queue /
  Stop — with the controls bottom-aligned so they stay beside the last line as the box grows;
  the image strip is its own row above that line.
- The status line ends, on fine pointers, with `/` commands and `@` files keycaps (plus `Mod+Enter`
  sends when **Enter sends** is off); the placeholder is just `Message <agent>…`.
- `/` completions come from `GET /api/pane/commands` and group built-in, user and project commands;
  `@` completions query `GET /api/pane/files`. Arrow keys navigate, Enter/Tab accepts, Escape closes.
- Paste, picker or drag/drop accepts up to four png/jpeg/gif/webp files per action. Each gets a local
  preview, uploads through `POST /api/pane/image`, and inserts a removable editable `@path` mention.
- Enter sends and Shift+Enter breaks by default; with **Enter sends** off, Mod+Enter sends. IME Enter
  is ignored. While working, Stop sends Escape and Queue stores the next message.

### Command palette
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes and actions. Recent panes
  lead an empty query; arrows cycle, Enter activates and Escape closes.
- Actions cover new session, lens/sidebar/theme, settings, notifications, lock and refresh, with
  `.kbd` hints where a global shortcut exists.

### Settings dialog
- Appearance: Dark / Light / System, Comfortable / Compact, terminal font `10–22px`.
- Composer: Enter sends. Chat: Show thinking. Shortcuts: the complete platform-resolved table.
- Install reflects installed, promptable or browser-instructions state; About links the repository.

### Terminal host, key bar and drawer
- xterm has `scrollback: 0`; wheel/touch gestures reach herdr's alternate-screen scrollback. The
  mount clips its own gutter and hides the unused xterm scrollbar.
- Terminal banners stack top-right for ended, reconnecting, observe and held-draft review states.
- The mobile key bar is Esc, Tab, one-shot Ctrl, arrows and `^C`; it never steals xterm focus.
- The mobile drawer slides over a scrim. Closed visibility removes its controls from the tab order.

### Token gate
- A centered password card replaces the entire shell while authentication is required. It has a real
  label, autofocused field, primary Unlock button and linked alert text.
- Success mounts the shell; Lock unsubscribes push, deletes auth and returns to the gate.

### Role (no control surface)
- `interact` types and resizes; `observe` does neither. The server enforces both and the WS protocol
  carries `role` / `role-ack`.
- The app connects as `interact` and exposes no role switch. An observe acknowledgement still gates
  local input, adopts server geometry and displays the view-only banner.

## 6. Motion & Interaction

### Timing

| Type | Token | Value | Usage |
|------|-------|-------|-------|
| Micro | `--dur-fast` | `120ms` | Hover, active, toggle and control state |
| Standard | `--dur-base` | `180ms` | Drawer slide; reserved dialog timing token |
| Pulse | `--dur-pulse` | `1600ms` | Working and reconnecting dots (trough opacity 0.35; text never pulses) |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | All tokenized motion |

### Rules
- Only state changes move: hover/press, the drawer, settings switches, working and reconnecting.
- Dialogs and their scrims snap open and closed; they have no entrance or exit animation. On mobile,
  their static layout changes to a bottom sheet.
- `prefers-reduced-motion: reduce` removes pulses, drawer/control transitions, smooth chat scrolling
  and settings toggle motion. State remains legible without animation.

## 7. Depth & Surface

### Strategy

**Tonal shift + hairline, with shadow reserved for overlays.** Resting shell surfaces have no shadow.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--border)` | Shell, fields, controls |
| Strong edge | `var(--border-strong)` | Hover/focus separation |
| Dashed edge | `var(--hairline) dashed var(--border)` | Unknown/empty states |
| Tonal lift | `--bg-elevated` on `--bg-panel` | Selection, chips, tracks |
| Tinted lift | Named tint over an opaque surface | Primary and agent states |
| Drawer shadow | `--shadow-drawer` | Mobile drawer |
| Overlay shadow | `--shadow-pop` | Menus, palette and modal cards |
| Card shadow | `--shadow-card` | The composer's input box — the one resting card in chat mode |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA is the target; do not document numeric contrast without measuring both shipped themes
  and every actual backing surface.
- Global `:focus-visible` uses `--ring`; interactive controls remain keyboard reachable except the
  touch key bar, which intentionally preserves terminal focus and has hardware-key equivalents.
- Icon-only controls carry `aria-label`; toggles expose `aria-pressed` or `role="switch"`; selected
  pane exposes `aria-current`; dialogs expose `role="dialog"` and `aria-modal`.
- Status, loading and composer progress use `role="status"`; failures use `role="alert"`. Agent state
  is text plus color, and unknown adds a dashed edge.
- Touch targets grow to `--touch-target`; fields stay `--fs-input` where mobile zoom is a risk.
- `prefers-reduced-motion` is honored. Lucide/inline SVG decoration is hidden from assistive tech.
- Global shortcuts use the convention **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. The settings table is the discoverable source of the complete mapping.
- `document.title` is `<pane title> · herdr` while selected, otherwise `herdr web ui`.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
| Terminal colors exist in CSS and JavaScript | `styles.css`, `settings.ts` | xterm consumes a JS theme | Keep `terminalTheme()` verbatim with `--term-*` |
