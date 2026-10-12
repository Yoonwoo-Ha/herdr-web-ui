# herdr web ui Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented. The machine
copy of every token is the `:root` block in `src/styles.css`; every table below mirrors it value for
value. When a component needs a value that is not here, add it to both first.

## 1. Atmosphere & Identity

A warm terminal: an amber-phosphor console on lamp-lit graphite (dark) or ledger paper (light),
with chat-app clarity. Tonal surfaces and hairlines keep the chrome out of the way. There is ONE
chrome color, amber: focus, the chosen lens, the terminal cursor and the user's own action (Send, primary
buttons). Agent states carry the remaining saturated colors and none of them is amber. The user's
chat turns are neutral raised cards, so a long thread never turns into a wall of color. Dark is the
default, light follows the same hierarchy, and comfortable or compact density changes scale without
changing information architecture. A dark report look, a neutral charcoal one, Catppuccin, lilac and forest are
opt-in palettes (Settings → Appearance → Colors); amber stays the default and the look before settings load.

The sidebar is one grid: a leading cell that says who or what a row is (the coding agent's brand
mark, else the place's own glyph), a title, and a trailing cell that says how it is. Workspaces
and Agents are independent lists, as in herdr's Spaces and Agents panels; tab and pane navigation
stays over the terminal and in the palette. Sections are parted by space and a dim head, never by
a rule; the Agents list's workspace cards are an edge around rows, not a line between sections.
Hover and selection are one neutral fill at two strengths. Brand marks are the only color
there that is not a state, and a ready row draws no state at all. Amber connects focus, the chosen
lens glyph and the terminal cursor.

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
| Chat bubble edge | `--bubble-border` | `transparent` | `var(--border)` |
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
| Notice | `--notice` | `#e8c55c` | `#7a5a00` |
| Overlay/scrim | `--scrim` | `rgba(8, 6, 4, 0.55)` | `rgba(40, 32, 22, 0.35)` |
| Glass bar | `--bar-bg` | `color-mix(in srgb, var(--bg-panel) 72%, transparent)` | same expression |
| Glass card | `--card-glass` | `color-mix(in srgb, var(--bg-elevated) 80%, transparent)` | same expression |
| Glass blur | `--glass-blur` | `saturate(180%) blur(20px)` | same |
| Drawer shadow | `--shadow-drawer` | `0 0 40px rgba(0, 0, 0, 0.6)` | `0 0 40px rgba(40, 32, 22, 0.22)` |
| Popover shadow | `--shadow-pop` | `0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--border)` | `0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)` |
| Card shadow | `--shadow-card` | `0 4px 16px rgba(0, 0, 0, 0.35)` | `0 4px 16px rgba(40, 32, 22, 0.07)` |
| Document surface | `--pdf-page` | `#ffffff` | `#ffffff` |

`--pdf-page` is the one color with the same value in both columns, on purpose: a PDF page is
paper, not UI, and the viewer (`.file-viewer-pdf`) must not tint it for the theme. It is named in
`src/styles.css` under the same note and no theme or palette block overrides it.

### Opt-in palettes

`settings.palette` (`amber` default, `report`, `charcoal`, `catppuccin`, `lilac`, `forest`) is written as `data-palette`. The
tables above are amber, the base blocks; the five opt-in palettes override them in
`[data-theme][data-palette]` blocks of `src/styles.css`, which hold the complete values.

`--bubble-border` is the edge of the chat's user bubble. It is `transparent` where `--bg-elevated`
alone parts the bubble from `--bg`: dark amber, dark report, dark charcoal, dark lilac and dark forest. It is `var(--border)`
where the two surfaces sit close: every light theme (the `[data-theme="light"]` block sets it for
all palettes) and dark Catppuccin, whose elevated surface is darker than its canvas.

- **Dark report** is a near-black blue-grey canvas with hairlines: `--bg` `#0a0d12`, panel and
  terminal `#0f1319`, text `#b4bdc9` / `#8792a3` / `#e8ecf2`. Primary (the user's action) is white
  `#e8ecf2` with `#0a0d12` text; accent is electric blue `#4c9aff`, kept for small marks. Agent
  states use meaning colors (working `#f5b544`, input `#ff6b7a`, done `#3ddc97`, idle `#8792a3`).
  Terminal cursor `#4c9aff`, selection `#1f3a66`. It has near-square corners (`--radius-sm/md/lg/xl/2xl`
  = `2/3/3/4/6px`) and no resting card shadow (`--shadow-card: none`).
- **Charcoal** is a neutral Ghostty-style dark: `--bg` `#0f0f0f`, panel and terminal `#171717`, text
  `#cbc7c0` / `#918c85` / `#f5f2ec`, accent and primary near-white `#e8e4dc` with `#171717` text,
  muted states (working `#c2a2af`, input `#e0877f`, done `#a7b789`, idle `#9a958e`), terminal cursor
  `#cbc7c0`, selection `#49443d`. It keeps amber's rounded corners and card shadow.
- In light both use plain paper (`--bg` `#f2f2f0`, panel `#fafaf9`, text `#242424`, primary ink
  `#242424` with `#fafaf9` text): report with a blue `#1f5fcc` accent and cursor, charcoal with an
  ink accent and cursor `#242424`.
- **Catppuccin** follows [catppuccin.com/palette](https://catppuccin.com/palette/), its style guide
  and its Zed port: Mocha in dark, Latte in light. In both the content (chat canvas `--bg`,
  terminal) is Base, the chrome (`--bg-panel`: sidebar, the header over it and on a phone, tabs) and elevated surfaces Mantle,
  dimmed text Subtext1, cursor Rosewater, selection Overlay2 at 25% over Base. Dark uses palette
  colors (only the primary hover `#d3b3f8`, Mauve lightened, and the tints are derived): Base
  `#1e1e2e`, Mantle `#181825`, input Crust, hover Surface0, text Text `#cdd6f4` / Subtext1 `#bac2de`,
  accent and primary Mauve `#cba6f7` with Crust text, states Blue / Maroon / Green, idle Subtext0
  (Maroon, not Red, keeps input AA on a hovered row), cursor `#f5e0dc`, selection `#3b3d4f`. Light
  keeps Latte's surfaces and text: Base `#eff1f5` (also input), Mantle `#e6e9ef`, hover Crust
  `#dce0e8` (the darkest surface Subtext1 stays AA on), idle Subtext1, cursor `#dc8a78`, selection
  `#d2d4dc`. Latte's accents are under 4.5:1 on these surfaces, so each keeps its hue and is darkened
  until it passes AA: Mauve `#712fc6` (primary hover is plain Latte Mauve `#8839ef`), Blue `#1750bf`,
  Red `#ac0c2f`, Green `#28651b`. It keeps amber's rounded corners.
- **Lilac** is one quiet lavender, flat on every surface (no gradient, no translucency). Light is
  the look it was drawn for: a pale lavender canvas `--bg` `#f0eefc` under paler chrome `--bg-panel`
  `#f6f5fe` (elevated `#fbfaff`, hover `#e8e5f8`, input `#fdfcff`), indigo ink (text `#2b2d4d` /
  `#545779` / `#17193a`), and an indigo accent and primary `#4a42c2` with white text. States are
  darkened until their badges pass AA on a hovered row: working `#1f4aa6`, input `#9c2044`, done
  `#1f5c39`, idle `#545779`. Terminal `#f8f7fe`, cursor `#4a42c2`, selection `#dcd7f8`. Dark is the
  same hue at night: canvas `#16152b`, chrome `#1c1b34` (elevated `#23223f`, hover `#2c2a4f`), text
  `#dcdaf4` / `#a5a2cc` / `#f2f1ff`, a pale lilac accent and primary `#b3abff` with `#17163a` text,
  states working `#85b8ff`, input `#ff94ad`, done `#92d9ab`, terminal `#18172f`, selection
  `#3a3768`. It keeps amber's rounded corners and card shadow, tinted indigo in light.

- **Forest** is a low-saturation green-grey, flat on every surface, meant to be restful over a long
  session (a preference, not a medical claim). In dark the canvas `--bg` `#101a16` sits under
  chrome `--bg-panel` `#16231d` (elevated `#1d2d25`, hover `#263b30`, input `#132019`), borders `#2d4437` / `#3d5b49`, text `#d4e5d8` / `#9ab9a3` / `#edf7ef`, a pale green
  accent and primary `#8fd3a2` (hover `#a7dfb5`) with `#102016` text. States keep hues of their
  own: working `#79c7d4`, input `#ffa294`, done `#91d69a`, idle `#9ab9a3`; danger text `#ffd7d0`,
  scrim `rgba(6, 14, 10, 0.6)`. Terminal `#16231d`, cursor `#8fd3a2`, selection `#31513e`. Light is
  the same hue by day: canvas `#eaf2ed`, chrome `#f7fbf8` (elevated `#edf5ef`, hover `#e1eee5`,
  input `#ffffff`), borders `#c9ddd0` / `#a7c3b2`, ink `#20352a` / `#4f6d5a` / `#15291e`, a green
  accent `#2c7648` (darkened until it is AA on a hovered row) and primary `#397f50` (hover
  `#2f6e44`) with white text, states working `#166578`, input `#a02b20`, done `#225f32`, idle
  `#4f6d5a`, danger text `#9d3022`, scrim `rgba(24, 52, 35, 0.35)` and shadows tinted the same
  green. Terminal `#f7fbf8`, cursor `#2c7648`, selection `#cfe5d5`. Tints are these colors at a
  low alpha (0.1–0.16). It keeps amber's rounded corners and card shadow, and has syntax colors
  of its own (below).

### Terminal theme

xterm.js reads a JavaScript theme, so `src/lib/settings.ts` `terminalTheme()` mirrors these four
CSS tokens verbatim for each resolved theme and palette (`settings.test.ts` checks the match).

| Role | Token | Dark | Light | xterm key |
|------|-------|------|-------|-----------|
| Background | `--term-bg` | `#181613` | `#faf8f3` | `background` |
| Foreground | `--term-fg` | `#d8d0c3` | `#2a251f` | `foreground` |
| Cursor | `--term-cursor` | `#f0a830` | `#8c5000` | `cursor` |
| Selection | `--term-selection` | `#4a3d26` | `#f0d9ae` | `selectionBackground` |

### Syntax highlighting

Code in the chat and in the file viewer is colored by `--syntax-*` tokens. Four follow the
palette: `--syntax-comment` is `--text-dim`, `--syntax-function` is `--accent`,
`--syntax-inserted` is `--status-done` and `--syntax-deleted` is `--status-blocked`. The other six are literals per block
(each at least 4.5:1 on `--bg-panel` and `--bg-elevated`); light charcoal uses the light report
column. Catppuccin follows Catppuccin's own mapping: keywords are mauve, so `--syntax-function` is
blue there instead of `--accent`, and Latte's colors are darkened to stay readable.

| Block | keyword | string | number | type | variable | meta |
|-------|---------|--------|--------|------|----------|------|
| Dark amber | `#e8875f` | `#a8c17c` | `#d6a0c9` | `#6cb8d6` | `#e0c08f` | `#b49dd6` |
| Light amber | `#a33a17` | `#4b6b18` | `#8a3f7a` | `#155a72` | `#7a5418` | `#5d4791` |
| Dark report | `#f78c6c` | `#3ddc97` | `#f5b544` | `#7fd4ff` | `#c9d1dc` | `#b392f0` |
| Light report and charcoal | `#b3261e` | `#22743a` | `#8a5300` | `#0b6e8a` | `#3b3b3b` | `#6f42c1` |
| Dark charcoal | `#d7a08a` | `#a7b789` | `#c2a2af` | `#9fb4c2` | `#dcd8d0` | `#b8a5c9` |
| Catppuccin Mocha | `#cba6f7` | `#a6e3a1` | `#fab387` | `#f9e2af` | `#f5e0dc` | `#f5c2e7` |
| Catppuccin Latte | `#712fc6` | `#2f7620` | `#b44201` | `#905c13` | `#4c4f69` | `#bc1d91` |
| Dark forest | `#e6a96d` | `#91d69a` | `#d2b18a` | `#79c7d4` | `#d4e5d8` | `#c2a0d8` |
| Light forest | `#9c4f15` | `#225f32` | `#865d13` | `#166578` | `#20352a` | `#68489c` |

`--syntax-function` in Catppuccin: Mocha `#89b4fa`, Latte `#0b59f4`.

### File viewer

- `--notice` colors a note that the view is partial (a file cut short, code too long to color): the
  size in the header's meta line becomes `256 KB of 1.3 MB`, always beside a warning icon so the
  color is not the only sign. It is a warning yellow, at least 4.5:1 on
  `--bg`, `--bg-panel` and `--bg-elevated`: amber `#e8c55c` / `#7a5a00`, dark report `#f5b544`, light
  report and charcoal `#8a5300`, dark charcoal `#d9b26a`, Catppuccin Mocha `#f9e2af` (yellow), Latte
  `#8a5710`.
- `--line-number` colors the line numbers beside code: tertiary text, quieter than the code. It is
  `--text-dim`, except in Catppuccin, whose `--text-dim` (subtext1) is nearly `--text`: Mocha
  overlay2 `#9399b2` (5.8:1), Latte `#64677d` (subtext0 darkened to 4.9:1 on `--bg`).

### Rules
- Amber is the one chrome color. Accent (selected, focused, informational) and primary (the user's
  action: Send, primary buttons) are both amber; in light, accent is the darker text-safe ochre and
  primary the brighter fill carrying ink text. Agent states never use amber. The report palette
  keeps the same split, accent (blue) marks and primary (white, or ink on paper) acts, and there
  agent states never use blue.
- Agent state has a written label as well as color. The sidebar's compact glyphs keep their labels
  in tooltips and screen-reader text; other surfaces draw the words. In the sidebar ready and
  unknown draw no glyph and keep their label for assistive tech; elsewhere unknown uses dim text
  and a dashed badge edge.
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
| Reading | `--fs-chat` | `15px` | `14px` | Chat prose, the user's bubble, live narration; the message box with a mouse |
| Large | `--fs-lg` | `16px` | `15px` | Header title, modal title |
| Title | `--fs-xl` | `18px` | `17px` | Markdown h1 |
| Display | `--fs-display` | `22px` | `21px` | The empty chat's greeting |
| Input | `--fs-input` | `16px` | `16px` | Mobile-safe text input |
| Pairing | `--fs-pairing` | `32px` | `26px` | The pairing code in Settings → Devices |

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif` | Chrome and chat prose |
| `--font-mono` | `"Symbols Nerd Font Mono", "JetBrains Mono Web", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace` | Code, paths, keys, terminal-adjacent metadata |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--lh-code` | `1.6` | Code blocks; the message box with a mouse |
| `--lh-prose` | `1.65` | Chat prose and the user's bubble |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls |
| `--fw-semibold` | `600` | Labels and titles |
| `--fw-bold` | `700` | Brand |
| `--tracking-tight` | `-0.01em` | Brand and primary titles |
| `--tracking-display` | `-0.02em` | The display line |
| `--tracking-caps` | `0.06em` | Uppercase operational labels |

### Faces
- The app ships its typefaces (`src/fonts/`, licenses in `THIRD_PARTY_NOTICES.md`) and loads
  nothing from another host: it is served from the user's PC, often with no internet route.
  Both are `font-display: swap`.
- Pretendard Variable, the first name in `--font-ui`, is upstream's dynamic subset: 92 chunks
  split by `unicode-range`, so the browser fetches only those whose characters a page draws
  (measured on the demo's chat: three chunks, 90 KB, in English; eight more, 200 KB, with the
  interface and an answer in Korean). The service worker precaches none and keeps each one once
  fetched.
- What the chunks cover (their `unicode-range`s): Latin, all 11,172 Hangul syllables, hiragana
  and katakana, and 435 CJK ideographs. The type is therefore the same on every device for
  Latin and Korean only. Kanji and Chinese text fall through `--font-ui` to the device's sans-serif,
  so a Japanese line is kana in Pretendard beside kanji in the device's face, and Chinese is
  the device's face almost throughout. The app ships no Japanese or Chinese face.
- JetBrains Mono regular is the code face of the chat and the chrome, loaded under the family
  name `"JetBrains Mono Web"`. The name is the app's own so that the terminal never takes it:
  xterm's stack (`src/lib/fontFamily.ts`) names `"JetBrains Mono"`, sizes every cell from the
  first font that matches, and keeps meaning the copy installed on the device.
- Chat reading scale: prose, the user's bubble and live narration are `--fs-chat` on
  `--lh-prose`; `strong` is `--fw-semibold` in `--text-strong`; inline code and code file chips
  are `0.87em` of their line; a code block is `--fs-sm` on `--lh-code`; headings are h1 `--fs-xl`,
  h2 `--fs-lg`, h3 to h6 `--fs-chat`. Work heads, tool rows, settled narration, a compaction's summary and
  meta keep their sizes. The chat scales all of them by `--chat-scale` (`--chat-fs-body` is the scaled
  `--fs-chat`), so the Chat font size setting names the body size and the prose is one step above it.

### Settings
- `theme`: `dark`, `light`, or `system`; default `dark`.
- `palette`: `amber`, `report`, `charcoal`, `catppuccin`, `lilac` or `forest`; default `amber`.
- `density`: `comfortable` or `compact`; default `comfortable`.
- `sidebarRows`: `one` or `two`; default `two`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
  During a two-finger pinch the font follows the fingers live and a badge above the grid shows the
  size in pixels; the grid refits locally and the shared pty resizes once when a finger lifts.
  Cancellation restores the starting size.
- A split pane that would have fewer than 80 columns at that size draws in the largest smaller
  whole-pixel size that gives it 80, never below `10px` (Settings → Terminal → Fit 80 columns in
  a split pane, on by default). A pane alone in its tab or zoomed, a pane that `10px` cannot bring
  to 80 columns, and a pane this browser only watches or mirrors keep the user's size. The saved
  size never changes for this; in such a pane a pinch still saves the size it shows, and the pane
  draws it once it has the room.
- Terminal and chat font families are comma-separated lists, default empty. They go in front of the
  terminal's built-in fonts (after the bundled Symbols Nerd Font Mono, which only draws icons) and of
  `--font-ui` in the chat's prose (as `--font-chat`), never in place of them; code in the chat keeps
  `--font-mono`. A file viewer's Markdown preview takes the chat font size and family too.
  At most 200 characters, with `;`, `{`, `}`, `<`,
  `>`, `\` and control characters stripped and names with spaces quoted.
- Composer Enter behavior and folded thinking visibility are preferences, not typography tokens.
- `highlightCode` colors code in the chat and the file viewer by its language (default on; off
  shows plain text).
- File viewer: `wrapCode` (wrap long lines instead of scrolling sideways; default off) and
  `markdownWidth`: `readable` (the chat lane, `--chat-w`, centered; default) or `full`.
  These layout choices stay on this device, like chat width; code highlighting is shared across browsers.
  The viewer loads the first 256 KB of a text file through one bounded streaming reader, with abort
  on close or navigation and a 5 s fetch deadline. Partial text ends at the last whole line when
  one exists; the response's Content-Range supplies the total, and an empty 416 opens empty.
  A Markdown file its Preview cannot
  be parsed for within 2 s, or whose Preview would draw over 60 000 elements, opens as its source
  with a notice; code a worker cannot highlight within 2 s stays plain with one, and code of over
  20 000 lines is one text without line numbers, with one too.
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
| `--radius-xl` | `16px` | Modals and bottom sheets |
| `--radius-2xl` | `24px` | The composer's input card |
| `--radius-pill` | `999px` | Pills and dots |

### Sizes

Comfortable values are `:root`; the final column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header below `769px` |
| `--header-h-wide` | `46px` | — | App header from `769px`, in either density (`--header-h` takes this value there) |
| `--sidebar-w` | `320px` | `300px` | Sidebar/drawer; the default while the user has not dragged the sidebar's edge |
| `--control-h` | `34px` | `32px` | Buttons and fields |
| `--touch-target` | `40px` | — | Coarse-pointer minimum |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Palette, worktree, device and background-task list rows; chat and composer list height caps |
| `--chip-h` | `20px` | `18px` | Badge/pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `32px` | `26px` | Command-palette mark box |
| `--dot-size` | `7px` | — | Connection dot |
| `--rail-w` | `3px` | — | Device and quoted-content rails |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Settings and dialog content |
| `--pending-max-h` | `min(20dvh, 12rem)` | — | Pending-message stack ceiling |
| `--chat-w` | `--content-w`, then the pane's lane as one length | — | Chat lane: transcript, composer column, held list. Settings → Chat width: Narrow `--content-w`; Default follows the pane (min 820px, max `60rem` = 960px, 71% of the pane between; the px floor wins where 60rem is under it); Wide `72rem` (1152px); Full `100%` |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |
| `--context-line` | `calc(var(--fs-lg) * var(--lh-base))` = `24px` | `21.75px`, through the scale | The selected pane's crumb row, min and max height. Scoped to `.context`, not `:root`, so it follows `--fs-lg`/`--lh-base` in either density |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-header` | `4` | A phone's glass header, over the transcript that scrolls under it |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions |
| `--z-scrim` | `15` | Mobile drawer scrim |
| `--z-drawer` | `20` | Mobile drawer |
| `--z-modal` | `30` | Dialog scrims |
| `--z-palette` | `35` | Command palette scrim, over every scrim dialog (a `showModal()` dialog sits in the top layer above it) |
| `--z-droplet` | `40` | In-app alert, over dialogs |

### In-app alert

One set for both themes: the card is island black wherever it shows.

| Token | Value | Usage |
|-------|-------|-------|
| `--droplet-bg` | `#000` | Drop, anchor and card |
| `--droplet-text` | `#f5f5f7` | Pane name |
| `--droplet-text-dim` | `rgba(245, 245, 247, 0.62)` | Ended detail, blank mark |
| `--droplet-blocked` | `#ff8a80` | Needs-input detail and dot |
| `--droplet-done` | `#9fd47a` | Finished detail and dot |
| `--droplet-mark-bg` | `rgba(255, 255, 255, 0.1)` | Agent mark disc |
| `--droplet-ring` | `rgba(255, 255, 255, 0.1)` | Card hairline |
| `--droplet-shadow` | `rgba(0, 0, 0, 0.35)` | Drop shadow under the liquid |

### Shell
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is sidebar plus
  `.terminal-host`. While a phone's soft keyboard is up (`data-keyboard`), `--app-height` follows
  `visualViewport` so the keyboard does not cover input; otherwise the shell is `100dvh`, because an
  iPhone home screen app reports a visual viewport shorter than the screen without a keyboard.
- The header is one line at every width. Anatomy, left to right: mobile drawer toggle / desktop
  sidebar toggle and the command palette (`.header-side`); the flexible context, agent mark and
  title then the PC › workspace › folder crumb; segmented Chat/Terminal switch; the connection
  chip while the bridge is not live (herdr version in its tooltip), the offline pill, sign out and
  the More menu (`⋯`). Theme lives in Settings and the palette; the herdr version is also read
  in Settings.
- From `769px` the header is two zones. Over the sidebar, `.header-side` is the sidebar's own top
  row (toggle at its start, palette at its end) on `--bg-panel`, as wide as `--sidebar-w`, and the
  sidebar's seam runs to the top of the window. Over the pane, the header takes the pane's
  surface: under the chat lens `--bg` with no bottom rule, the transcript scrolling under a
  `--space-5` fade from `--bg`; under the terminal lens, with no pane, or with a pane herdr could
  not restore, `--term-bg` and the rule. A tab strip takes the same surface as the header over
  it from `769px` (`--strip-bg`: `--bg` under the chat lens, `--term-bg` otherwise, `--bg-panel`
  below `769px`) and keeps its hairline, under the chat the one line over the transcript (no
  fade under it). The update notice and a PC's action banner are drawn in the pane column, over
  the tab strip, never across the window: the sidebar and its top row stay one piece. A layout
  call the palette made that a PC's bridge from before the route answered 404 to reads there too,
  for a moment, as a `.pane-notice` line of `--status-blocked` `--fs-xs` text under a hairline
  ("This PC's bridge does not offer this yet"); the tab's menu says the same at the strip's end. With the
  sidebar collapsed the toggle and the palette sit in the one bar. Below `769px` the header is the `--bg-panel` bar with
  its rule: the installed app's `theme-color` matches it. Over the chat, when the transcript is right
  under it (no tab strip or notice between), that bar is glass, as an iPhone's is: `--bar-bg` behind
  `--glass-blur` at `--z-header`, pulled over the pane by its own height (`--header-over`), so the
  transcript scrolls on under it while its first line, the banners and anything else at the pane's
  top start below it. The xterm mount is not fitted under the chat, so this resizes no pty.
- From `769px` the sidebar's right edge is a grip (`.sidebar-resizer`, `role="separator"`): drag
  it to resize the sidebar between `240px` and `520px`, never past half the window; the arrow
  keys move the focused edge `16px`, Home and End go to the limits, and a double-click returns to
  `--sidebar-w`. The seam shows `--border-strong` under a pointer and `--accent` while held or
  focused. The chosen width is kept per device (`herdr-web-ui:sidebar-width`) and written as
  `--sidebar-user-w` on `.app`; the sidebar and its top row in the header both read
  `--sidebar-shown-w`. A phone's drawer keeps `--sidebar-w`.
- The sidebar keeps its width on desktop until its edge is dragged, and is a `<=768px` drawer. The desktop collapse removes its
  column; the drawer uses a scrim and keeps safe-area insets. On touch, a mostly horizontal swipe in
  from the left `24px` edge opens the drawer and a swipe to the left closes it. While the finger is
  down the drawer is under it and the scrim darkens with it; let go, it stays open when more than half
  shows or a flick (`0.35` px/ms, not after a `100ms` rest) went that way, and slides the rest from there.
- The terminal stack contains a positioned terminal surface, then composer or key bar. The xterm
  mount stays alive under the chat lens; changing views never creates a second connection.
- At `<=480px` the brand name, the offline pill and desktop-only control labels go, and the
  palette's button gives its room to the title: the palette is the More menu's first item there.
  Icons and selected context remain.

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
  Every surface on a `.modal-scrim` (dialogs, the palette, the row sheet) rises from the bottom
  edge as an iPhone's sheet does (`--dur-sheet` on `--ease-spring`, the scrim darkening with it),
  follows a finger dragged down from its head or from a list at its top, and drops
  (`--dur-sheet-out`) however it closes. Let go past `30%` of its height, or flicked down, it
  closes through the same close as its scrim; short of that it springs back. A busy dialog
  (a deed pending) does not follow the finger. A stroke on a sheet or its scrim pans nothing
  behind it (`touch-action: none`); the sheet's own lists still scroll and keep their overscroll.
  A closed sheet's drop is drawn in a closed shadow root, so no query of the page sees it.
  lib/sheets.ts.
- While a phone's keyboard is up (`data-keyboard`), the scrim is `--app-height` tall instead of the
  whole screen, so a sheet and its text field sit above the keyboard, and the sheet drops its
  safe-area padding.
- Escape, explicit close and scrim click close dialogs; first meaningful control receives focus.
- A confirm (`.confirm-dialog`, `alertdialog`, 420px) asks before something that cannot be undone:
  Cancel has the focus, Tab stays between the two buttons, the danger action sits at the right,
  and a failure shows inside it. A no gives the focus back to what opened it. A refusal the owner
  named (git refusing a dirty checkout) turns the action into its escalation (**Delete anyway**),
  with the refusal's words above it. Closing a repository workspace over open worktrees says so
  and closes the group, as herdr's `--group` does.

### Field (`.field`, `.input`, `.select`)
- Stacked uppercase label, optional hint and `--bg-input` field. Desktop fields use `--fs-sm`;
  small-screen fields retain `--fs-input` to avoid focus zoom.
- Focus names the edge with accent; errors use blocked/danger tokens and `role="alert"`.

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--bg-hover`. Headings are dim uppercase micro labels.
- The sidebar's row menu (`.row-menu`) is a `.menu` drawn through a portal at fixed coordinates,
  under its `⋯` with right edges aligned, above it when the screen ends first, and over the drawer.
  Both the button and right-click offer the same native workspace actions: Rename workspace,
  Close workspace/group, New/Open worktree for repository roots, Delete worktree checkout for
  linked worktrees, and Expand/Collapse for a group. Pane renaming stays in the pane menu;
  Move pane to… is in header More. The
  danger item takes `--status-blocked`. The popover is as tall as its items, up to the room on
  its side of the button (it scrolls only on a screen too short for it). At `<=640px` it is a `.modal` bottom sheet (`.row-sheet`):
  a grip, the row's name and place, 48px rows and a Cancel button; Tab stays among them. The
  rows scroll between the head and Cancel (`.row-sheet-items`), which stay put, when the sheet's
  92% of the screen cannot hold them. Escape, a press outside and
  focus leaving it close it (on a desktop a scroll or a resize too), and focus returns to the
  `⋯`. Arrow keys move between items. A row that leaves the roster takes its open menu with it.
  A workspace right-click opens at the pointer and leaves pane selection and keyboard focus
  unchanged. It follows herdr's workspace scope: Rename, Close workspace/group, repository
  worktree actions, and Expand/Collapse for a group. Dismissal restores the prior focus. The
  explicit `⋯` uses those same actions at its button. An edited name keeps the browser's paste menu;
  touch long press still reorders. Agents and PC headers keep the browser's context menu.
  Agent rows only select their pane; they have no secondary action button or app context menu.

- Close follows herdr's `ui.confirm_close`: a workspace close, or a pane close that takes its
  workspace with it, asks in a confirm first. A busy pane also asks before it stops. After a
  confirmed close, focus lands on the header's workspace-list toggle.
- Tab and pane menus follow herdr's target scopes. A tab's menu contains New tab, Rename tab
  and Close tab, plus Move tab left/right when a neighbouring position exists and no move is pending.
  The pane's own context menu carries pane actions; it opens at the pointer
  without changing which pane is focused. The pane header's ellipsis opens the same menu on touch.
- **Move pane to…** (header More) opens a menu under the header button
  (`MovePaneMenu`): a dim uppercase MOVE TO micro label with the pane's name under it
  (`.move-pane-head`), then New tab and the workspace's other tabs, every other workspace under
  a hairline, and New workspace under another. A pick moves the pane at once (`POST
  /api/pane/move`); the app stays on a moved pane that was open, also under the new id herdr
  gives a pane that changes workspace, and waits for the move's answer before it would read a
  roster without the pane as the pane gone. A refusal reads as the row's or the strip's inline
  error, herdr's own too ("Move failed: the tab is zoomed; unzoom it in herdr, then move the
  pane"): a `changed: false` answer never closes the menu as if the pane had moved.

### Badge (`.badge`)
- Agent states read **READY**, **RUN**, **INPUT**, **DONE**; unknown reads **—**. **BG** is a pane
  whose turn ended while work it started still runs in the background (`background_wait`): it
  stands in for DONE or READY until that work's turn ends.
- Idle is elevated/dim; working, blocked and done use their own tint and text. RUN carries a small
  breathing dot before the word; the word itself never fades. BG takes the working tint and text,
  holding still; a tab's dot for it is a working-coloured ring.
- The written label and unknown dashed edge keep color from being the only signal.
- The sidebar's compact variant weights each state by how much it asks of the user. Waiting for
  an answer is the one filled glyph, a filled message circle in `--status-blocked`; finished and
  not yet looked at is an 8px dot in `--status-done`, as an unread mark is; working is the same
  dot in `--status-working` that breathes (`--dur-breathe`); BG is an 8px ring in
  `--status-working` held still, since nothing about it moves until its work ends; ready and
  unknown draw nothing. A pane herdr could not restore
  draws a warning triangle in `--status-blocked`. The element, its label and its tooltip are there
  for every state, and each drawn state has its own glyph as well as its color. Background tasks
  are a quiet count beside it (`.background-count`), not a badge.

### Pill (`.pill`)
- Mono metadata at `--chip-h`. Offline is the one header pill that stays, and uses danger tokens. A deep link that could not open what it named, and Copy link, say so in a plain `.header-note` pill for a moment (8 s, 1.6 s for Link copied). The note takes the flexible context's place and ellipsizes when narrow, keeping the lens and More controls in view.

### Sidebar roster row and footer
- No top bar. The sidebar opens with the plan panel (when Settings puts it there), the PC workspace groups and a separate **Agents** list spanning the connected PCs. A workspace starts from the `+` on its PC's header, or from the **New workspace**
  button in the dashed **No workspaces yet** box of an empty PC. **Add PC** lives in Settings →
  Remote PCs and in the command palette. Search lives in the command palette, not the roster.
- Every row sits on one grid, built from existing tokens as `--side-*` aliases on `.sidebar-shell`:
  a `--control-h` leading cell, the title, and a `--control-h` trailing status cell, the same two
  columns as the header zone's buttons above the list. One-line rows and section heads are
  `--control-h` tall, agent rows `--control-h` + `--space-3`; fills use `--radius-md`.
  Hover is `color-mix(in srgb, var(--bg-hover) 50%, var(--bg-panel))`, only where a pointer hovers;
  selection is `--bg-hover`; keyboard focus draws the ring inside the row and no fill. No rule
  separates sections: `--space-4` and a dim `--fs-sm` head do.
- The PC/workspace list and the lower Agents list scroll independently above the fixed footer.
  Agents takes the height of its rows, at most half the sidebar, docked above the footer; the
  workspace list has the rest. The Agents heading stays outside its scroll area and shows its
  count only while folded. A list that is cut fades out at its lower edge. An empty or folded
  Agents list gives its space back; PC and workspace folds do not hide agent rows. In the drawer
  (`max-width: 768px`) the list starts folded.
- A PC's header is the head of its workspaces, and the caret beside its `+` is the one fold over
  them. The roster has no label or fold of its own.
- A repository's parent row keeps `workspace.label`; its opened linked
  worktree rows show their actual checkout branches. Each row's compact status
  glyph rolls up all of the workspace's panes as herdr does (blocked, then done, then working,
  then ready); a folded worktree parent rolls up its whole group.
  Clicking its name opens the
  selected pane in that workspace, else the last viewed pane, else the pane herdr has focused,
  else its first pane. Tabs are selected from the tab strip; panes are selected on the canvas or from the command palette.
- A top-level workspace row starts with a folder glyph in the grid's leading cell, under the
  PC's monitor; the row's mark and name follow it. For a repository workspace with linked
  worktree workspaces that folder is the group's fold, a button (`.workspace-toggle`) in
  `--text`: open while the worktrees show, closed while they are folded, when a dim `+N` after
  the name counts the checkouts put away. For any other workspace it is a dim glyph and no
  control. Worktree rows have no folder: they sit one cell in, their marks under the parent's.
  Worktree folds are remembered at
  `herdr-web-ui:worktree-group-collapsed:<machineId>:<repo_key>`; a folded group keeps the selected
  child visible, and status snapshots preserve a deliberate fold.
- Worktree branches come from the existing `GET /api/worktree/list`, matched by repository key,
  open workspace ID and normalized checkout path. A listing-confirmed detached checkout reads
  **Detached HEAD**; without matching branch metadata, the workspace name remains the fallback.
  A custom workspace name appears beside the branch in dim text; the default name made by
  replacing branch slashes with dashes is omitted. Full branch, workspace name and checkout
  path remain in the tooltip. Disk-only checkouts do not become sidebar rows.
- Create/open responses seed the branch immediately, open the parent group and reveal the
  selected row within the upper workspace scroll area, including on a phone. Inventory reads
  run once per repository with opened linked worktrees, through that PC's bound API. Structural
  checkout changes and returning to the visible page refresh them immediately; a serial 30 s
  backstop runs only while visible and online. Status changes and renames do not cause git
  inventory reads. Stale requests cannot overwrite a new branch or another PC's cache; a failed
  read retains earlier metadata only for the same workspace, repository and checkout path.
  This adds no status subscription or server contract.
- **Agents** is an independent pane list: agents from each PC's `snapshot.agents`
  join the matching pane in `snapshot.panes`; pane agent metadata supplies entries missing
  from that list, including a recognized OmO pane. Each row opens that agent's pane: the agent's
  bare brand mark, the pane's title, and one dim line naming the agent, then the PC (only when two
  or more are registered), the workspace and the tab (only when the workspace has two or more tabs
  or the tab was renamed, and never when it repeats the workspace). An agent with a live name
  leads that line with it in `--font-mono` and `--text` (`.agent-name`); the kind takes the label's
  place beside it, and the tooltip keeps the name. Its background-task count and
  compact status sit at the right. A pane that waits for an answer is not listed apart or moved
  up: its state shows on its workspace row and its agent row, and the alerts say the rest. Pane state is
  authoritative when the agent roster and pane status differ. The workspace and agent lists
  share the existing combined machine roster and its SSE updates; neither adds a status subscription.
  A disconnected PC's saved workspace and agent rows are dimmed, inert and draw no state until that PC reconnects.
- Appearance's **Workspace cards** is off by default: the Agents list is flat and every row names
  its own place. On, in the **Workspaces** order the Agents list puts each workspace's agents on a PC in a card,
  a workspace with one agent included: a `--hairline` `--border` edge with `--radius-lg`, `--space-1`
  inside and `--space-2` between cards, and no fill, so a row's hover and selection read as they do
  outside it. The card opens with a `--space-6` line in `--text-dim` `--fs-xs`: a `--space-4`
  folder in the leading cell, then the workspace's name, after the PC's when two or more PCs are
  registered (`machine · workspace`). The line is the card's name, not a control. A row in a card
  leaves the PC and the workspace out of its dim line (`agentContext` with `grouped`); its tooltip
  still names them, and the card's list is labelled by its head for screen readers. A row in a card
  with nothing else to say (no live name, no tab of its own) says its kind there, even the one its
  mark or title already says, rather than leave the line empty. The head of
  a disconnected PC's card dims with its rows. **Activity** mixes workspaces, so it draws no cards
  and every row names its own place. Appearance's **Pin agents** is off by
  default: rows carry no star and saved pins lead nothing. On, pinned agents, when the list has them, sit in their own
  section above the cards, and a pinned row is not repeated in its workspace's card.
- Appearance's **Sidebar rows** is **Two lines** by default; on **One line** a workspace row is
  its name. Two lines draws the row as the roster did before it was one line, on an agent row's
  height and type: the title of the pane the row opens, and under it in `--text-dim` `--fs-xs` the place,
  "workspace · folder" with no name said twice (`taskRowLines`, lib/paneName.ts). A shell titled
  by its folder leads with the workspace instead; a linked worktree is placed by its branch,
  then its own workspace name. The folder, the mark, the status cell, the menu and the fold
  count stay where they are, and the menu and rename still act on the workspace. The choice
  is per device and applies at once.
- Appearance's **Agents order** is **Workspaces** by default: the Agents list in herdr's
  workspace, tab and pane order. **Activity** pins a blocked agent on top and orders the rest by
  their most recent state change (herdr's `state_change_seq`, read from the snapshot's `agents`),
  within each PC, so the agent just worked in stays on top while it runs and after it finishes.
  It changes only the Agents list, which then draws no workspace cards; herdr's order and the
  workspace rows stay as they are.
- Appearance's **Quiet opened finishes** is off by default. herdr reports DONE until one of its
  own clients shows the pane, so an agent opened here would keep its finished dot. On, a DONE
  opened here (selected while the page is visible) since it finished draws as ready in the
  Agents list and in its workspace's roll-up. "Opened" is kept per PC in this browser
  (`herdr-web-ui:seen:<pc>`) and dropped with the PC. The first time it is turned on in a
  browser, everything open on the connected PCs counts as opened, so the lists start quiet; a PC
  first seen later starts with nothing opened, so its finishes keep their dots until opened.
  Storage holds herdr's own counters only, so a page reloaded within the poll window after
  leaving a finish it watched shows that finish's dot again rather than guess. herdr's counter
  only goes up within a session, so a look recorded above it is from before a herdr restart and
  is dropped.
- Each workspace row holds its folder (top-level rows), a leading glyph, the name (on two lines,
  the title over the place) and the compact state at the right. The leading glyph is the brand mark of the agent in the pane the row opens; a row that opens a
  shell shows the terminal glyph, and a linked worktree without an agent the branch glyph. The
  mark never stands for another pane's agent; the row's tooltip lists every agent in the
  workspace. A custom worktree workspace name follows the branch on the same line in dim text.
  Selection uses a neutral rounded fill; workspace rows have no amber rail or separate reorder
  gutter. Drag the row itself, or press `Alt+↑/↓` while its selector is focused, to reorder it.
  On a touch screen (`pointer: coarse`) the browser's drag is off: a long press (400ms, still
  within 8px) lifts the row (`.is-lifted`: `--bg-elevated` with `--shadow-card`), it follows
  the finger, the list scrolls near its edges, and a 2px `--accent` line (`data-drop`) shows
  where it lands. Alt+Up/Down moves the focused row one step at a time.
  Dragging is disabled while a name field is open. Each workspace's `⋯` opens its row menu
  (`.row-menu-toggle`: no width at rest; shown on hover, focus, selection and while its menu is
  open; always on touch). Inline server failures
  stay beside their workspace. A repository's workspace moves past the
  next or previous group with its worktrees, and a worktree moves among its siblings only.
- A title that is a working directory written out (`/home/me/dev/api`, `~/dev/api`, `C:\work\api`)
  shows as its last folder, here, in the header, the palette and every alert; the full path stays
  in the row's tooltip. Parent workspace names stay fixed and linked checkouts are named by branch;
  agent rows show their pane's own title. Each row's
  place is available to screen readers, without repeating what its title already says. The
  palette, which has no header, names the workspace and folder once when they are the same.
- A PC group header is a monitor icon in the leading cell, the name in `--text-strong` semibold, “Host” for
  the local machine (also when it is the only PC: the name alone does not say which computer it
  is), and a state dot (done = connected, working pulse = connecting/reconnecting, blocked =
  error, idle = disconnected), then the fold's caret (`.machine-toggle`, always shown; the name
  itself is not a control) and a `+` in the status column that starts a workspace on that
  PC (disabled while it is offline). An SSH PC's manage button sits before the
  caret and shows on hover, focus, while its panel is open, while the PC is not connected, and always
  on touch. Connected is the dot alone; every other state is also written under the name, with the server's
  error clamped to two lines and complete in the tooltip.
- A repository's worktree workspaces (`workspace.worktree.is_linked_worktree`)
  sit indented under the row of the workspace on its main checkout (`.worktree-children`), without
  a tree hairline; a worktree whose repository workspace is not open stays at the top level.
- Rows use only shared theme tokens in dark and light. Touch keeps row menus and folds visible,
  with `--touch-target` controls, and draws no hover fill; reduced motion removes row transitions
  and keeps the working dot's breath (opacity only).
- Footer holds the contextual **Install app** action and Settings with the plan meters beside it,
  as rows on the same grid with no rule above.
  It carries no product name or version: the running versions are read in Settings.

### Plan meters (`.usage*`)
- Beside Settings, one button holding up to four chips (three and `+N` past that), one per
  account in the user's order: provider mark, mono `--fs-2xs` percent of the limit chosen in
  Settings, the plan's week or its session (used, or left when Settings says so), and a 2px bar on a `--border-strong` track
  filled to that percent. From 80% used the percent and bar take `--status-blocked`; amber stays
  chrome. A limit that runs out before its reset at its pace so far takes `--status-blocked` on
  the bar alone. A chip whose numbers are stale or missing dims. An account hidden in Settings is
  left out of the strip and the popover; with every account hidden, neither shows.
- The button opens a popover above the footer (`--shadow-pop`, `--radius-lg`), as wide as the
  footer and scrolling when it outgrows the sidebar: per account its mark, name and plan pill with
  the email or login right-aligned and ellipsized, then one row per limit (label, reset time, right-aligned percent) over a 4px bar. A problem
  note is dim, red for an expired sign-in or a failed request. Where the window's start is known, a
  2px `--text-strong` mark on the bar sits where an even pace would be by now, and a dim `--fs-2xs`
  line under it gives the rate, with **Runs out in …** in `--status-blocked` when it comes before
  the reset; once that time has gone by it reads **Runs out before reset** until the reset.

### New workspace dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. Directory defaults to
  the selected pane cwd and name is an optional workspace label.
- Recent folders appear as neutral `.btn` chips with `--radius-pill` and `--space-2` gaps: the
  three most recent, on one row that never wraps. Each shows the folder basename with ellipsis
  and the full path in its tooltip and accessible name. Clicking puts the folder in Directory and
  starts nothing. History is per PC in this browser and retained after panes close. Only a
  successful workspace start puts its folder first; a folder merely seen in a connected PC's panes
  goes behind what is kept, since a pane's folder follows every `cd` of its shell. Pending and partial
  failures disable the chips. New tab keeps its workspace folder and shows no recent chips.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.
- As **New tab** (from a row's `⋯` menu, the header's More menu, the strip's `+` or the palette),
  the same dialog is titled `New tab · <workspace>`, shows the workspace's folder as a fact in a
  dashed box (`.new-session-folder`: a worktree's checkout, else the folder of the pane in front)
  instead of asking for one, and its name is the tab's (optional; the placeholder is the number
  herdr gives it). Submit calls `POST /api/tab/create` with the same agent launch.

### Tab strip and pane canvas
- The tab strip is shown even for one pane, as herdr's TUI shows its single tab and `+`.
  Tabs retain their names, status dots, active underline, keyboard navigation, rename field and
  close confirmation. A right-click opens tab actions at the pointer, including Move tab left/right
  when a neighbouring position exists. Desktop tabs have no close or dropdown buttons. Touch and narrow layouts show a `⋯` beside
  the selected tab for the same menu; Shift+F10 or the menu key opens it from a focused tab.
  Pane actions are not tab actions. Up to 768px, where a split tab shows one pane at a time, the
  tab's menu lists the tab's panes first, the open one marked current, over a hairline.
- Mouse dragging previews an accent insertion line, with edge scrolling for an overflowing strip.
  The snapshot's tab order is authoritative: a tab's stable `number` is not its place. A drop calls
  `tab.move` with an insertion boundary before removal, within that workspace and PC. The visible
  order changes with herdr's snapshot, keeping selection and keyboard focus; a refusal shows an
  inline error. One request waits for acknowledgement before another move is accepted. Escape,
  a tab-list change or leaving the workspace cancels an unsent drag. Touch keeps native sideways
  scrolling and uses Move tab left/right in the selected tab's menu; Alt+Shift+Left/Right provides
  the same adjacent moves only while a tab has keyboard focus.
- `PaneCanvas` draws every pane in the active tab at `layouts[].panes[].rect`, normalized to
  the layout's own area. Panes share thin, square boundaries: `--border-strong` when inactive,
  `--accent` around the selected pane. The compact header names its pane and provides the
  ellipsis for touch and keyboard access. A lone or zoomed pane is borderless; its menu button
  stays at the top-right (visible on hover/focus, always on touch).
- A left click or keyboard focus selects the actual pane. Right-click opens the clicked pane's
  menu without changing the selected pane: Rename pane, Clear pane name when named, Swap with
  focused pane when another is selected, Split right, Split down, Zoom/Unzoom pane, the
  right-click policy, Close pane. It appears at the pointer, clamped to the window. Up/Down
  stop at the ends, hover selects, Enter acts, Escape and an outside click dismiss.
- Split selects the new pane (`focus:true`), like the TUI. Swap exchanges the right-clicked
  pane with the previously selected pane and retains the latter's focus. A close confirms when
  the pane is busy or is the last pane of the workspace. Rename is herdr's label; clearing it
  returns to its automatic title. Herdr owns every resulting layout and name.
- Up to 768px a split has no room: the canvas shows the selected pane alone, full size and
  borderless as a zoomed one, with no split boundary, and the tab's menu picks another. The
  other panes stay mounted and hidden at the same full size. This is only what the browser draws:
  herdr's layout and zoom are not changed, and a wider window draws the split again.
- Zoom uses herdr's zoom flag and focused pane. The other panes keep their mounted terminals
  hidden, preserving attachments and drafts; unzoom restores their rectangles. Web selection
  stays local to this browser and does not change herdr's focus in another client.
- Drag the actual split boundary to resize, with an 8px hit region and native 0.1–0.9 ratio
  limits. Its keyboard separator accepts arrow keys. `layout.set_split_ratio` receives the
  binary path (false first, true second), at most 30 times a second, one request in flight;
  release flushes the final ratio. A tab/topology change cancels the drag.
- Every pane keeps its own xterm, attachment, input ownership, lens, chat state and file-path
  context. Only the active pane may take keyboard focus after an asynchronous operation.
- Switching tabs retains an outgoing terminal only while its explicit submit awaits a receipt;
  its chat/input UI is unmounted and its grid is not resized. The receipt settles the original
  draft before the pane attachment is released. No input is replayed. A canvas that already released
  its panes while away opens a replacement as view-only until the user returns.
- The unlocked app owns one connection per visited PC, shared by its pane mounts. A pane leaving
  the canvas sends detach and loses its automatic-delivery lease, while the PC connection keeps
  receiving authoritative held/removal receipts. Returning exposes the same pending ID for an
  explicit Send now. Only an actual disconnect, PC removal, sign-out or app teardown suspends
  connection proof; reconnect/reload never resumes pending delivery.
  A newly split pane awaiting its first snapshot does not unmount its siblings. Geometry is
  fitted inside each rendered pane; layout rectangles are never used as PTY dimensions.
- Plain right-click can be passed to a mouse-reporting terminal when enabled for that pane.
  Modified clicks, pane frames and non-reporting/read-only terminals still open the menu.
  Native app shortcuts stay Mod+Shift in the browser, so Ctrl+key continues to reach the PTY.

### Worktree dialog (`.worktree-modal`)
- From a workspace row's menu, as herdr's prefix+shift+g: **New worktree** asks for the branch
  (required), where to start from (HEAD when empty, ignored for a branch that exists) and a
  name, then checks the branch out under herdr's worktree folder and opens it as a
  workspace grouped with the repository's; its pane is selected. **Open worktree…** lists the
  repository's other checkouts as rows (branch, mono path, an **Already open** pill), and a row
  opens or returns to that workspace. herdr's own words explain a refusal, inside the dialog.
- The branch arrives filled in as herdr's own form fills it (`worktree/brave-valley-07f8`:
  adjective, noun, four hex digits) and selected, so typing replaces it. The name is the branch
  with its slashes as dashes and follows the branch until it is typed over.
- **Agent** is the New workspace dialog's picker, under the name: the agent last started, Shell
  for none. It starts in the checkout's pane once the checkout is made. One that fails to start
  leaves the worktree there: the dialog says why, locks its fields, and its button reads **Open**.
- The browser demo answers the same list/create/open/remove worktree APIs with fictional
  checkout records, so its branch rows and dialogs work without a filesystem or live herdr.

### Header context and connection
- A selected pane shows agent mark + title (`--fs-md`), then on the same line the crumb
  PC › workspace › folder (`--fs-xs`, `--text-dim`). The folder shows as its last name, and only
  when the title, the PC or the workspace does not already say it (`lib/headerCrumb.ts`). The
  title may shorten with an ellipsis; the crumb never does: when it does not fit whole beside the
  whole title it is not drawn, and the title has the row. The full path is in the context's
  tooltip and at the top of the More menu. With no selection, the brand fills the context slot.
- The More menu (`.header-more-button`, the `RowMenu` popover, a bottom sheet at `<=640px`) opens
  with the location on two lines, "PC › workspace" then the full path in mono, and holds **New
  tab** (the selected pane's workspace), **Browse files** and **Alerts**, each under the condition
  its own button had; at `<=480px` **Command palette** is its first item. The Alerts item says
  this device's state in words after its label ("On in the app", "On in this tab", "On, pushed to
  this device", "Off on this device") and switches it: it is a `menuitemcheckbox` with
  `aria-checked` in the popover and a button with `aria-pressed` in the sheet. While alerts are off on this device the
  More button carries a `--dot-size` `--accent` dot and its name says "alerts are off": the dot
  marks the state that needs a look, never "on".
- The segmented Chat/Terminal view switch lives in the header. There is no floating view-toggle pill.
- Connection is one quiet chip, drawn only while the bridge is not live: a pulsing dot plus the
  written reconnecting/disconnected state. Below `900px` it keeps only its dot; the word stays as
  its accessible text and in its tooltip. While live the chip takes no room and stays in the
  document as a `role="status"` a screen reader can read (`.conn-live`; never `display: none`).

### Chat turn (`.chat-turn`)
- The chat lens is a centered `--chat-w` transcript over the still-attached terminal surface.
  At the Default chat width the lane follows the pane: min 820px, max 60rem (960px at a 16px
  root), 71% of the pane (`.terminal-stack`) between. `PaneTerminal` measures the pane and writes
  the lane on its stack as one length, and a file viewer over the app measures the pane that
  opened it and writes the same on itself for its Markdown preview (both `lib/chatLane.ts`),
  `min(max(820px, 60rem), <the pane's share>px)` (`chatLaneLength`,
  `lib/settings.ts`); `--chat-w` never holds that percentage, because each column would resolve
  it against its own box and they would differ by their gutters.
  The ceiling is in rem because Wide is (`72rem`), and it stays `60rem` inside the length, so
  Default is never wider than Wide at a root font of 11.4px and up, also when that size changes
  while the page is open (under 11.4px the 820px floor is itself wider than Wide's 72rem). The
  floor stays in px (`--content-w` is px); under a 13.67px root, where 60rem is less than 820px, the
  floor wins and Default is the same lane as Narrow.
  Structured Claude/omp transcripts fall back to ANSI-stripped pane scrollback when unavailable.
- The register is Codex / gajae-code-app: a quiet document. User turns are right-aligned neutral
  cards (`--bg-elevated`, a `--bubble-border` edge, `--radius-lg` on all four corners, ≤80% wide,
  no avatar or name). Assistant turns have no header: the answer is plain prose.
- Space separates exchanges, not a rule: the transcript's gap is `--space-3`, so an answer sits
  close under its prompt, and a user turn that follows an assistant turn takes `--space-5` more.
  The one rule of an exchange is the hairline under its folded work block.
- Meta (time, copy) fades in on hover or focus and takes no click or tap while unseen; with any
  coarse pointer (a phone, or a touch screen beside a mouse) it is always visible. With a mouse and no touch screen (`(hover: hover) and
  (pointer: fine) and (not (any-pointer: coarse))`): from 481px a user turn's time and copy sit
  beside its bubble, and an answer has one copy glyph (it copies Markdown) with a **Plain text**
  text button in the regular weight beside it. Otherwise the answer keeps two labelled buttons,
  glyph + MD and glyph + TXT; where the primary pointer is coarse each is a `--touch-target` target on a
  one-line row, as is a user turn's copy, and a skill list under a user turn clears that target.
- Markdown supports headings, lists (a task item `- [x]` / `- [ ]` shows a checked or empty box in
  place of its bullet, not clickable), links, quotes, tables, inline/fenced code and code-copy
  actions.
  Markdown files use the same renderer in the file viewer. **Open in a new tab** opens an
  app link to the resolved absolute file on its own PC, independent of the originating pane.
  **Open raw file** (Code glyph) opens the original bytes; Download still saves those bytes.
  The reader page and dialog share **Show source** (Braces glyph, pressed while the source shows, so it
  never looks like Open raw file), highlighted source with CSS-counter line
  numbers, and **Copy file** for complete text (selecting the source if clipboard copy fails).
  There is no separate Raw action. HTML blocks in Markdown files are parsed in the preview worker
  with HTML enabled; local images still pass through the file endpoint's image-size check.
  The page has an h1 and no Close or new-tab action; the dialog keeps its focus trap and sheet swipe.
  Actions use the existing header icon-button primitive, labels and focus states. On a phone the
  name and Close occupy the first row, with actions below; a reader page has no Close.
  A link keeps `--accent` and a file chip reads in `--text-strong` with a dotted underline; both
  underlines are `--text-dim` at rest and both take the accent on hover and focus-visible.
  Code blocks are `--radius-lg` and never scroll inside: one longer than 30 lines opens at its
  first 20 behind **Show all N lines**. On touch a block has a header strip (language, copy);
  with a mouse and no touch screen the strip becomes a corner control over the block's top right,
  shown on hover or focus-within (no transition under reduced motion).
  Fenced code is colored by role (`--syntax-*`) up to 100 KB, in a worker past 2 KB; a longer block,
  or one the worker cannot color within 2 s, stays plain with a note under it. Past 20 000 lines
  code is drawn as one text rather than an element per line, so it never holds the page.
  A table fills the reply's width; its cells, file paths included, break between words only, so a
  column is never narrower than its longest word, and a table without room scrolls sideways in
  its own box.
  Thinking renders as a folded block only when **Show thinking** is enabled.
- Auto-follow stops when the reader scrolls up; later output raises a **New messages** pill.
- An empty chat is greeted from the composer (`.composer-greeting`, below), only where the agent's
  conversation was read and holds no turn. A chat still loading, one whose read failed, an agent
  whose transcript could not be read and a pane with no recognized agent keep their own lines
  (`Loading conversation…`, the error, the terminal-output fallback, `No conversation yet — say
  something below`), as does an agent that is working or asking. A history read again after it
  changed is loading, not empty. The server answers the terminal-output fallback for an agent
  that has not written its transcript yet (a new Claude Code or Codex pane before its first
  message), so those are not greeted; an omo session not yet written answers an empty
  conversation and is.

### Work block (`.work-block`, `.work-row`)
- One per assistant turn: a `▸ Worked for 7s · 1 edit · 2 commands` header (duration = next turn's
  timestamp minus this one's; "Working…" in `--status-working` behind a breathing dot while the agent runs;
  "Needs you" in `--text-dim` behind a still `--status-blocked` dot while the
  agent is blocked, by the pane's status and not by whether a prompt card was parsed) over
  one-line rows on the header's own left edge, which is the prose edge too (the hover plate
  overhangs it by `--space-1`).
- A row is caret + verb + object: `▸ Read src/metrics.ts`, `▸ Edited src/pages/Reports.tsx`,
  `▸ Ran pnpm test`. The caret is always shown; there is no per-tool icon and no separator. The
  verb (Read, Edited, Wrote, Ran; `lib/toolVerbs.ts`, by exact tool id) is in the interface face,
  `--fs-sm`, `--text-dim`; the object is mono `--fs-xs`. A tool the table does not know, a call
  with no object, or a call summed up by something other than its own command or path (omp's
  `intent`: `bash Checking ports`) keeps its id in mono `--text` in the verb's place. A failed row
  turns the verb or id `--status-blocked` and adds the word "failed": after the object under a
  verb (`▸ Ran pnpm test [failed]`), after the id otherwise.
- A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane. Under
  a verb the tool's own id (`exec`, `Bash`, `apply_patch`) is the first line of that detail
  (`.work-row-tool`, mono, dim) and the row's title.
- Mid-work narration sits between rows. While the turn runs it is the agent's voice: answer prose
  (`--text`, `--fs-chat` on `--lh-prose`) on the prose edge. Once the turn settles it is a quiet
  row again: `--text-dim`, `--fs-sm`.
- Only the running turn's block is open (working or blocked). A settled turn folds to its header
  with a hairline under it, and the header reads as a footnote: `--text-dim`, regular weight (the
  live one keeps medium weight and its state color). The answer is outside the fold. A settled
  turn stays open when its work holds text the answer does not end on: text with no answer at all
  (an action or Codex commentary came last) or text recorded after the answer, so the agent's
  words are never behind the fold. A block the reader opened or folded stays as they left it, and
  so does one they focused or clicked inside: the fold at the end of a turn never takes the rows
  from under them.
- The header is one line: the counts (`.work-block-summary`) take the width the title and the
  failure count leave and end in an ellipsis. `· 1 failed` (`.work-block-failed`) is its own item
  and is never cut, because the fold hides the failed row; at the largest chat type on the
  narrowest phone the title wraps to a second line instead.
- An OmO or omp `task` row opens to the tasks it starts (`.chat-task-calls`): each summary in
  `--text`, the agent as a hairline mono pill, the prompt in the bounded mono input box.

### Plan (`.bg-tasks-plan`, `.bg-step`, `.plan-count`)
- A pane's plan has no control of its own: it shares the composer's background-task chip
  (`.bg-tasks-toggle`, beside the add button in the input card's last row). With a plan the chip
  starts with the list-checks glyph, the word **Plan** and `done/total` in tabular figures; running
  background tasks follow after a hairline as their glyph and number. The chip keeps the working
  tint while a step or a task is left, and goes quiet once every step is done and nothing runs. A
  narrow card drops the words and keeps the glyphs and numbers. The chip shows only in the chat
  lens, and not for an offline PC's cached plan. The sidebar's agent row repeats the count beside
  the background count, in its quiet mono figures and with no box (`.plan-count`).
- The chip opens one list above the card: a **Plan** heading with `N of M done`, the steps in wave
  order (a status glyph, the name, what a running step does now, then a dim state · time · teammate
  line; a waiting step's name is dim), then a **Background tasks** heading over the tasks list when
  the pane has tasks to show. The steps are read again every few seconds while the list is open.

### Background tasks ended (`.chat-task-results`)
- Where OmO reports background tasks that ended, or a Claude Code subagent ends (its
  `<task-notification>`, drawn once however many records carry it), the transcript shows one `--bg-elevated` card
  (hairline edge, `--radius-lg`) on the prose column: a dim `--fs-xs` line with the layers icon,
  "2 background tasks ended" and the time, then one hairline-separated row per task.
- A row is the status icon (`--status-done` check, `--status-blocked` x, dim slash for
  cancelled), the task's summary (`--fs-sm`, medium) over a dim `--fs-xs` meta line (agent ·
  model · duration · turns · tool calls · tokens), and the status word at the right in the
  icon's color, with the skill caret. Opened, the task's answer renders as Markdown, indented to
  the title, bounded to 60vh.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp,
  omo or codex question, approval or plan menu.
- Placement: docked on the composer's column, directly above the input card, on the card's width
  and gutter (`--chat-w`). It is not part of the transcript and does not scroll with it. The
  stack from the top is transcript, held messages (folded to their caption while a card is
  open), prompt card, input card; PaneTerminal owns that order (`.prompt-dock`) and ChatView,
  which owns the prompt, renders the card into it. The dock is an `aria-live="polite"` region, as
  the transcript's log was for the card. It stays rendered while it is empty (zero height, never
  `display: none`): a live region that appears together with its content is not announced.
- Type: the card follows Settings → Chat font size and Chat font, as the transcript does. The dock
  scales the `--fs-*` tokens by `--chat-scale` and sets `--font-chat`; the reference text, the
  keycaps and the step numbers stay `--font-mono`. The height limit does not scale.
- Look: `--bg-elevated`, a `--border-strong` hairline, `--radius-xl`, no shadow. The title is
  the card's one red (`--status-blocked`, `--fs-sm`, semibold); the "input needed" badge is read
  by assistive tech and not drawn. The question is prose in `--text-strong`. Reference text (the
  command of an approval, a plan, a diff: the prompt's `body`) is the card's one mono box
  (`--bg`, `--fs-xs`); a question in words is never set in mono.
- Height: at most the larger of 60% of the app's height (`--app-height`, so a phone's keyboard
  counts) and six touch rows (`240px`), at every width. Only the reference text gives way: six
  lines at rest, two at the least (one for a one-line command), scrolling in itself with a fade
  on its fold. The header, step chips, question, hint, options, custom answer and confirm row
  never shrink. A card still taller than its limit scrolls as a whole with a fade at its bottom
  edge, and the confirm row of a typed pick stays pinned on that edge. The card's scroll is
  contained (`overscroll-behavior: contain`), so a drag past its top is never the page's
  pull-to-refresh.
- The confirm row is kept short, since it is pinned over the options: its question
  (`Send 2. <label>?`) shows two lines at most and scrolls in itself, whatever the label's
  length, and Confirm and Cancel are one group on one line, beside the question when there is
  room and under it when there is not.
- Each prompt that appears has a card of its own: the next prompt opens at its top with nothing
  picked or typed, also when it asks the same question again. An answer that comes back after
  its card is gone (the next prompt is showing, or another pane is open) changes nothing on
  screen.
- The composer keeps the resize grip's hit strip (`--composer-grip-h`) for itself under the card,
  as it does under the held messages: the grip never lies over the card's last row.
- A form of several questions (omo) shows a row of step chips (`.prompt-card-steps`) under the
  header: a chip per question, pill-shaped, mono number or a check once answered (`--accent`), the
  one asked now with an `--accent` border, `--accent-tint` fill and a `--primary` number. The title
  then reads `Question 1 of 2`; the review after the last question keeps the chips, all checked.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own labelled field. The prompt id names what the prompt says and which asking of it this is; an answer to another prompt, or to an earlier asking of the same one, is rejected with `prompt_changed`.
- Options are flat full-width rows (`.prompt-card-option`), not boxes in the box: the menu's
  number as a keycap (mono, `--fs-2xs`, a `--border-strong` outline; the option's name keeps
  `1.`), the label, its description under it in `--text-dim`. All rows weigh the same: none is
  filled, outlined or put first as a default, since herdr has no ground to recommend one. Hover
  and focus fill a row `--bg-hover`; a checked or typed pick gets `--accent-tint` + an `--accent`
  border and keycap. A `(Recommended)` suffix, the agent's own mark, renders as a tag. On a
  coarse pointer a row is `--touch-target` tall.
- While a card that takes typed answers is open the message box's placeholder says how:
  `Type 1–3 to choose…`, or `Type 1–3 or your own reply…` when the card has a custom answer.
  Enter in an empty box answers nothing. A typed pick of an approval, plan or menu waits for
  Confirm in the card. After an answer pressed in the card with the keyboard or the mouse, focus
  moves to the message box, unless the user moved it somewhere else while the answer was on its
  way or the card is gone. A tap or a pen never moves it there (that would raise the on-screen
  keyboard). The press itself says what made it, not the device: a key or a mouse hands the focus
  on with a coarse pointer too (a tablet with a keyboard), and a tap does not on a touch-screen
  laptop with a fine pointer. Only a press that does not say what made it is read by the device's
  pointer, and stays out of the message box where that is coarse.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE surface: the stack, the transcript and the composer region all sit on `--bg`,
  and the composer column equals the transcript column (`--chat-w`, same `--space-4` gutter,
  `--space-3` at `480px` and below).
  On a phone (`<=768px`), while the card follows the transcript directly (no held message, pending
  row or prompt card between them) and no greeting stands over it, the card floats over the
  transcript's end as an iPhone's input bar does: the composer rises `--composer-over`
  (`--space-8`) into the transcript, whose last lines fade into `--bg` and blur behind the card on
  `--card-glass` and `--glass-blur`.
  The input box is a card: `--bg-elevated`, hairline border, `--radius-2xl`, `--shadow-card`
  (the only other card on this surface is the prompt card docked over it, while an agent asks);
  focus turns its border `--accent` (no inner outline). Above it the completion popover and the
  background-task list; inside, the image strip is its own row at the top, then the auto-growing
  message box as a row of its own at the card's full width, then ONE row of controls under it:
  on the left the add button (lucide `Plus`, named "Attach files"), the mic when voice input
  shows it (see Voice input), and the background-task chip; on the right the status content and ONE round Send/Stop button.
- Empty chat (`.composer-greeting`): one line on the composer's column, directly over it,
  `What should <agent> do in <folder>?` in `--text-strong`, `--fs-display`, `--fw-semibold`, `--tracking-display`, centred,
  and under it `PC · full path` in `--text-dim`, `--fs-sm`. Both wrap anywhere. While dictation's
  recording pill is open over the composer the greeting is hidden (its box stays). No suggestion
  chips or starter prompts. The greeting is out of the flow, so it takes no row from the terminal
  surface. In a mouse-driven window from `769px` the composer is moved up (a transform, nothing
  else changes size) so the greeting and the input card sit at the pane's vertical centre; a
  phone keeps the composer docked with the greeting above it. The first message sent removes the
  greeting and the composer is back at the bottom at once: it snaps, with no animation. Held
  messages keep the composer docked. Once a message went out, the greeting stays away for that
  pane until the conversation shows a turn or becomes another history: another lens, another
  pane or a failed read does not bring it back. A stack too short for the composer and the
  greeting leaves the greeting out (`.is-out`, hidden and `aria-hidden`) and the chat shows its
  own empty line. While the composer is lifted, the completion menu's height is capped to the
  room over the input card, where it scrolls. On a coarse pointer the greeting takes no touch:
  a tap or drag on it reaches the chat under it, which puts the keyboard away.
- The round button (`.composer-action`, a `--space-8` / `32px` circle with a `--space-4` glyph) is
  Send or Stop in the same place at the same size, so only the glyph changes: Send is `--primary`
  with lucide `ArrowUp`; Stop is `--text-strong` with a `--bg` square, and turns
  `--status-blocked` on hover and focus. Not connected, Stop is disabled and loses its fill
  (`--border-strong` outline, `--text-dim` glyph). A coarse pointer keeps that compact visible
  circle inside a transparent `--touch-target` / `40px` button, so tapping remains easy.
- The status content (`.composer-status`, `role="status"`) sits between the two control groups,
  pushed to the button's side. It draws, at `--fs-xs`: the model pill and the uploading
  or reconnecting sentence in `--text-dim`. The background-task chip is a button in the left controls;
  its count is repeated here as `.visually-hidden` text, so a change is still announced. The agent's written name, its separator, the state words
  `READY` / `RUN` / `INPUT` / `DONE` / `BG` and the sentence `Reasoning high` stay in it for assistive tech only
  (`.visually-hidden`): the header names the pane, and the state is told by Stop, the live row
  and the prompt card. No state word is drawn in the chat composer.
- The model pill (`.composer-pill`) holds the agent mark, the model, the reasoning level and the
  context ring in one quiet surface: `--bg-hover` fill, `--radius-pill`, `--control-h` tall,
  `--space-3` inline padding, `--space-2` between its parts. The model is in `--text` at
  `--fw-medium`; the level follows a middle dot in `--text-dim`, as the agent's own words with
  only the first letter drawn as a capital (`::first-letter`, the text is not rewritten); a pane
  that records no level draws no dot and no dash, only the name. On the
  fill the ring's track is `--border-strong`; a ring left bare on the card keeps `--border`. It is display only: a `span` with no role, no
  focus, no hover or pressed state, no pointer cursor and no chevron; the ring inside it is the
  one thing to press on desktop; mobile keeps the ring inert. The `title` of the model is the id as received, and the level's is its
  sentence; behind a name the id is also repeated as `.visually-hidden` text, since a touch
  cannot reach a title. A pane that names no model draws no pill: the mark and the ring stand
  alone, with a dim `Model —` and the level between them if the pane records only a level.
- The model is drawn by name only where its id is one `modelLabel` (`src/lib/modelName.ts`) can
  name for certain, from the vendor's own regular naming and matched whole:
  `claude-<family>-<major>[-<minor>]`, also behind `anthropic/`, is `<Family> <major>.<minor>`
  (`Opus 5.5`, `Sonnet 5`); `gpt-<version>` is `GPT-<version>` and `gpt-<version>-sol` is `GPT-<version>-Sol`, as
  Codex's own status line writes it; `glm-<version>` is `GLM-<version>`. A name is never guessed. The rule is the
  vendor's id syntax, not a list of released versions, so a new model needs no change and a
  well-formed id of a version that does not exist is named too. Any other id — a dated snapshot, another tier or
  product suffix, another provider's prefix, another vendor, a spelling that is not the vendor's
  canonical one (a leading zero as in `claude-sonnet-5-05`, uppercase, a stray separator or
  space) — is drawn exactly as received in
  `--font-mono` at regular weight (`.composer-model.is-id`), so it reads as an identifier and no
  suffix is dropped.
- What does not fit the row gives way in this order: the task chip's words (icon and count below
  a `640px` card), then the reasoning level and model name according to the measured row. A long
  identifier can shorten inside the pill; the context ring remains visible. The row is measured
  again after fonts arrive and the context label opens or closes. The input card keeps one row
  of controls on desktop and phones.
- Every agent has one primary control: Stop while working with an empty draft, Send with text,
  and Send at rest. Uploads and in-flight sends disable Send without clearing its text. There
  is no separate Queue button or send menu. The placeholder is `Message <agent>…`; message text
  uses `--fs-chat` scaled by `--chat-scale` on `--lh-code` with a fine pointer. Otherwise it
  uses that scaled size or `--fs-input`, whichever is larger, keeping the 16px floor that avoids
  iOS zoom. Changing Chat font size or density resizes an automatic box around its existing
  draft; a height chosen with the grip stays chosen.
- A local desktop composer shows the first visible account in Settings order for its agent's
  provider as a read-only usage reference inside the model pill. Plan-wide five-hour session is
  preferred, with weekly fallback; scoped, failed and unavailable limits do not substitute.
  The title names the account and reset times. This is not active-account detection. Mobile and
  remote panes omit it. The context ring is inert on mobile; details stay on desktop.
- Working Send on a supporting bridge adds a pending message above the input card, before the
  prompt dock. `PendingMessages` uses the chat's column and neutral user-bubble surface: plain
  text aligned right, with no outer card. Its scrolling stack is capped by `--pending-max-h`
  (`min(20dvh, 12rem)`). The text stays selectable. Its separate ↑ Send now action sends it, and the small sibling X
  discards it. Actions keep a 40px touch target on phones.
  Sending disables that item's actions; errors stay inline. Uncertain messages offer Copy and
  Discard saved copy, with no retry action. Desktop and phones share this flow.
- Accepted pending messages clear only the draft prefix acknowledged by the bridge. Actual
  Enter delivery removes the pending row and refreshes the transcript. Next-turn delivery and
  an explicit Send now action claim the same server ID; connection loss never resumes automatic input.
  Previously held browser messages retain their explicit Send now/Discard recovery.
- Not connected, the sentence `Reconnecting… message held here, never queued` is said once and
  whole: it is the placeholder while the box is empty and moves into the status content once
  there is a draft (`composerStatusHint`), on a phone too. A sentence there (this one, or
  `Uploading file…`) is never ellipsized: where it does not fit beside the model it takes a line
  of its own under it, without its leading dot, and wraps there; its `title` repeats it. Only
  the sentence takes a line: the mark, the model, the level and the ring stay one row over it
  (`.composer-status-meta`), where the label gives way exactly as it does with no sentence. The
  status content is then left-aligned, beside the add button. The primary control and add are disabled. With a draft, the reconnecting sentence is said instead of
  `Uploading file…`, never both: the attachment's own tile says it is uploading.
- The resize grip is a short bar on the card's top edge. On a fine pointer (`(hover: hover) and
  (pointer: fine) and (not (any-pointer: coarse))`) the bar is drawn while the card is hovered,
  while it is dragged, on its own keyboard focus, and while a manual height is set; on any coarse
  pointer it is always drawn. Its hit area lies above the card (`--composer-grip-h`), and the
  composer keeps that strip free after the held-message list and after a prompt card.
- The stack over the input card, on its column, is written once (PaneTerminal): held messages,
  then the prompt card (see Prompt card), then the input card.
- Held messages (`.composer-queue`) are quiet rows on the input card's column, above it: the
  card's width and gutter at every window width, no tint and no box. One `--border` hairline
  above the group, then one caption line in `--text-dim` at `--fs-xs` (a clock and the sentence
  `Held until the agent is ready`, plus `· 2 messages` from two; a translation too long for a
  phone's column takes a second line, it is never cut), then a row per message: its text, still
  a box to edit (transparent until focused, up to four lines, two at `480px` and below),
  `Send now` and `Discard`. Hairlines between rows run the column's width; every line of text starts `--space-3`
  in. The list, not the group, has the height limit (two and a half rows, then it scrolls), and it
  gives way before the caption does. "Queued messages (n)" and each row's "Message n" stay for
  assistive tech only (`.visually-hidden`).
- When the agent is ready the sentence becomes `Held message — review and send`, in `--text`, and
  the `--accent` goes on the clock and on the outline of `Send now`; the hairline stays `--border`.
  Nothing is sent without that button.
- While a prompt card is open, or in a short phone window (`480px` wide and `600px` tall or
  less, as a media query: Android's keyboard shrinks the window to that, iOS Safari's does not),
  the rows fold into the caption, which becomes a disclosure button (`aria-expanded`, a chevron,
  `--touch-target` tall on touch) and counts a single message too. The rows stay mounted and one
  tap opens them. A list that is ready, a row being edited and a row with an error are never
  folded away; while a row's error holds the rows open the caption is plain text, not a button.
  When the button goes, focus on it moves to the list, unless it went because the pane changed.
- At `480px` and below a held row is its text, `Send now` and a `--touch-target` X whose name is
  still `Discard`.
- `/` completions come from `GET /api/pane/commands` and group built-in, user and project commands;
  `@` completions query `GET /api/pane/files`. Arrow keys navigate, Enter/Tab accepts, Escape closes.
- Paste, picker or drag/drop accepts up to four files per action; an image is stored as a paste, any other
  file under its own sanitised name. Each uploads through `POST /api/pane/image` and inserts a removable
  editable `@path` mention.
- While a phone's keyboard is up, a tap on the transcript or a drag down it (`32px`) puts the
  keyboard away. Each only blurs the field, so the draft stays. The prompt card, which can stand
  where the transcript was on a short screen, does the same: a tap on its text (never on an
  option, a box or its field), or a drag down it once the card and its reference text are
  scrolled to their top.
- On a touch screen, picking a pane (drawer, palette, notification) or switching its lens never
  raises the keyboard: the user reads first, and a tap on the message box or the grid raises it.
  A desktop's picked pane takes typing at once.
- Enter sends and Shift+Enter breaks by default; with **Enter sends** off, Mod+Enter sends. IME Enter
  is ignored. Stop sends Escape. While the agent works and a draft shows Send in Stop's place,
  Escape in the box is Stop; an open completion menu takes the first Escape. Working Send
  schedules a pending message; its Send now action submits that same message now.

### Voice input
- A mic button sits beside the add button in the composer and beside Send in the terminal input line; it
  fills with `--accent` while recording. Dictated text is inserted at the caret, never sent.
- `voiceInput`: `auto`, `on` or `off`; default `auto`. Auto puts the mic in the composer only, not on
  a phone (the composer's `(max-width: 640px), (pointer: coarse)`), and leaves it out where dictation
  cannot work (no HTTPS, or no key and no browser recognition). On shows it in both inputs and on a
  phone, disabled with its reason where it cannot work.
- The recording pill shows Cancel, a **Recording** label, the level bars, a mono timer and Done.
  Amber only; `--danger` stays for errors.

### Command palette
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes across all connected PCs
  and the selected PC's actions. PC names participate in search. Recent panes
  lead an empty query; arrows in the search field cycle through visible results, Enter activates
  and Escape closes. IME candidate, commit and cancel keys stay with composition. Buttons reached
  with Tab keep their native activation, and arrow navigation scrolls the selected result into view.
- Actions cover new workspace, new tab, lens/sidebar/theme, settings, notifications, lock and refresh, with
  `.kbd` hints resolved from this browser's shortcut settings; disabled bindings have no hint.
  With a pane selected they add herdr's **Split pane right / down**, the same **and open it**
  (herdr's `--focus`: the new pane is opened here only then) and, in a tab of several panes,
  **Zoom pane** / **Unzoom pane**.
- Rows are grouped as herdr's Goto picker groups them: a `.menu-heading` per PC/workspace (PC
  name when multiple PCs are registered, workspace name, a linked worktree's branch in mono when
  the name does not say it, the row count), Recent (up to
  three, an unsearched and unfiltered list only) before the workspaces, Actions last. The
  workspaces stand in PC then roster order (a move in the sidebar moves the section); a search puts
  the best match's workspace first, and finds a tab by the name the strip shows it under ("Tab 2").
  A row's subtitle is "tab · folder" (the tab only in a workspace with several), "workspace · folder"
  under Recent, with the owning PC shown when more than one is registered. A result selects its
  captured PC and pane together. Disconnected PCs and stale recent targets are omitted.
- Branch inventories are read only while the palette is open, under each connected PC's own
  `MachineContext`, and accepted only for that PC's current workspace signature. Recent entries
  store both machine and pane IDs; existing per-PC history migrates into the combined list.
  New workspace, pane operations and plugin actions keep the selected PC's context and are not
  retargeted by hovering or searching another PC's panes.
- Status chips (`.palette-filter`, a `radiogroup`) sit between the search and the list: All, then
  INPUT, RUN, READY, DONE, BG in `STATUS_WORD`'s words with counts over all connected PCs. The
  checked chip takes its badge's tint and text (All and READY the neutral hover fill); a chip no
  pane answers to keeps a dashed edge. A chip is `--control-h` minus `--space-2` tall, and on a
  coarse pointer `--control-h` minus 2px with a `--touch-target` hit area. The row scrolls sideways
  without a scrollbar where it does not fit. A status filter leaves the actions out; `>` at the
  start of the query shows the actions alone and hides the chips.
- The footer (`.palette-footer`) names the picked row's place (PC › workspace › tab, omitting
  the PC for a single-PC roster) and its path in
  mono; on a desktop it also carries the `.kbd` hints for Left/Right (workspace) and `>` (actions).
- Keys: Left and Right step to the previous or next section from a row, or from the search field
  while the caret sits at the text's edge; inside the text they move the caret. herdr's picker
  letters (`b` `w` `i` `d` `a` for a filter, `/` back to the search) act only while the focus is
  outside the search field, so they never take a letter from a query. A letter puts the focus on
  the first row, also when it names the filter already shown. Left and Right on the chips move the
  filter. The pick is a row, not a place: a pane leaving the filter above it moves the pick with its
  row, and a picked row that leaves hands its place, and the focus, to the row now there (the search
  when none is left). Below 640px the sheet is one fixed height, the chips and footer staying put.

### Settings dialog
- A Settings shortcut opened over a file preview places Settings above it (`--z-modal + 2`, one
  above the preview). Settings owns Escape until it closes; the preview keeps its history entry
  underneath for the next Back or close. With no preview open Settings stays at `--z-modal`. The
  command palette opened from its shortcut shows above both (`--z-palette`).
- One page at a time. From 641px the dialog is two columns at a fixed size (`--content-w` wide,
  `40rem` tall, so turning a page never moves its edge): a `13rem` list of pages on `--bg`
  (icon + name, the open one on `--bg-hover` with its glyph in `--accent`) and the open page
  beside it under its own title and the close button. A phone shows one of the two: the sheet
  (`92%` tall) opens on the list, drawn as one card of rows with a chevron each, and a page
  replaces it under a Back to settings control. The dialog's accessible name stays **Settings**
  on every page; the list is a vertical `tablist` with one Tab stop, and the arrows walk it
  (beside an open page they turn the page too). Escape closes the dialog from any page.
- Each step into Settings is an entry of the browser's history (`lib/settingsHistory.ts`): the
  dialog, the page a phone opens from its list, the key bar editor. The system Back button (and
  an edge swipe) takes one step out and never leaves the app from inside Settings; the Back
  control, the X, Escape and the scrim take the same entries off. Beside the list, turning pages
  replaces the one entry. A reload steps out of the entries it finds; Forward reopens the page.
- Pages, in order: **Appearance** (theme, colors, density, language, sidebar rows), **Chat**
  (panes open in, show thinking, chat width, chat font size and family, highlight code; then
  **Composer**: Enter sends, suggestion chip; then **Quick replies**; then **File viewer**: wrap long
  lines, Markdown width), **Terminal** (font size, 80 columns in a split, font family, wheel
  speed, input mode, Key bar), **Alerts**, **Voice input**, **Subscription usage**,
  **Shortcuts** (the platform-resolved global bindings), **Phone & devices** (the phone address,
  Keep screen on, Install; then paired devices), **Remote PCs**, **About** (Updates, herdr,
  the repository links). A button that points at Updates opens the dialog on About.
- Every page is built from the same parts (`components/SettingsControls.tsx`). A group is an
  optional caption (`--fs-sm`, `--fw-semibold`, `--text-dim`, sentence case) over one card:
  `--bg-elevated`, hairline `--border`, `--radius-lg`, its rows parted by hairlines and never
  boxed on their own. A row is a label (`--fs-sm`, `--fw-medium`, `--text-strong`) with at most
  one dim sentence under it (`--fs-xs`, no wider than `54ch`) and one control at the end of the
  line. The controls are a switch, a segmented control for two to four short choices, a select
  for five or more, a stepper (minus, value in `--font-mono`, plus, in one bordered well) and a
  text field; inside a card they sit on `--bg-input`. On a phone a control that needs the line
  (three or more segments, a text field, or a long sentence above it) goes under its label at
  the card's width, its segments sharing it equally; the rest stay on the label's line.
- Terminal keeps Key bar as a compact description and Edit key bar button. That button opens
  a detail screen in the same dialog with its own scroll body and a Back to settings control.
  Back or Escape returns to the Terminal page's scroll position and focuses Edit key bar;
  closing the dialog resets it for the next open. The detail lists the terminal keys
  in their display order. Every key can be
  removed or moved with up/down buttons; those controls keep `--touch-target` hit areas on phones.
  Add key offers the supported key catalog, and Ctrl/Alt/Shift toggles add or remove held-modifier
  buttons. Custom combination chooses one key or printable character plus modifiers, with its cap
  previewed before Add. Saved combinations send exactly those modifiers; ordinary keys inherit the
  held modifiers. Restore defaults returns the original row. The keyboard mode control stays first.
- A font family is a text field saved when it is left, on Enter or when the dialog closes, not
  per keystroke.
- Remote PCs: an **Add PC** row (label, one-line description, button) opens the PC
  setup dialog and closes Settings behind it; when that dialog closes, focus lands on the header's
  workspace-list toggle. Under the row, once the server has answered, the bridge auto-update switch.
- Install (a row of the Phone group) reflects installed, promptable or browser-instructions state;
  About links the repository.
- The running versions are always written, since the sidebar carries none. Updates opens with
  **Running vX.Y.Z (commit)**: the server's version and commit, or the client's own build version
  before the server answers and where it names neither. While the server runs another version than
  this tab was built from (updated, not yet reloaded), a second line names the tab's own. The
  **herdr** section opens with
  **Running herdr X.Y.Z**; where herdr cannot be updated from here (Windows, an older server) the
  section is that line alone, from the health check.
- Subscription usage: the on switch with one description, then (when on) Used / Remaining,
  Weekly / Session and, under an **Accounts** caption, one card of accounts (`.usage-accounts`):
  one `--touch-target` row per account
  (mark, name, dim ellipsized email, then 28px move-up, move-down and eye controls in fixed columns;
  a move that cannot happen keeps its column but is not shown). A hidden account's row fades and
  its eye closes; it stays listed so it can be shown again.

### Terminal host, key bar and drawer
- **Find in terminal** in the header's More menu and Mod+Shift+F opens a find bar above the
  grid. It uses the existing input and icon-button primitives: a query, match ordinal,
  previous/next and close controls, with a dim note that scrolling is shared by all clients.
  A phone places the query above the controls so neither counts nor touch targets are cut.
  Enter searches backward initially, then advances forward; Shift+Enter goes backward.
  Escape closes the bar and returns desktop focus to the terminal without changing its viewport.
  Searches are explicit, literal and supplied by herdr; no browser scrollback is added.
- `TerminalViewportTools` paints accent overlays for native, inclusive cell ranges after checking
  the corresponding text and cell widths in xterm's current attach buffer. The current result has
  a stronger fill and outline. The native response supplies at most 1024 ranges around a result;
  the match count remains exact, and highlighting covers that returned window rather than every
  match in unlimited history. Output, reflow and stale responses invalidate highlight data.
- Automatic refresh uses `jump:false` only after an explicit search response includes both
  `matches` and `scroll`. Older bridges can ignore unknown request fields, so they receive no
  automatic search POST. Their explicit count and previous/next navigation remain unchanged.
  Read-only views also send no automatic search POST and cannot drag the history scrollbar.
- The separate history scrollbar sits in a reserved gutter alongside the grid and is hidden
  when herdr reports no scrollback. Dragging the thumb, clicking the track or its focused arrows,
  Page Up/Down and Home/End call `pane.scroll`; this moves the shared viewport for every client,
  including the TUI. Pending pointer moves are coalesced, requests retain their owning PC/pane,
  and a failed request displays an error instead of inventing a local history position.
- Explicit Find cancels unsent scrollbar offsets and waits for a native scroll already sent;
  the scrollbar is disabled until that search ends, so an older drag cannot overwrite its result.
- xterm has `scrollback: 0`; wheel/touch gestures reach herdr's alternate-screen scrollback. The
  mount clips its own gutter and hides the unused xterm scrollbar.
- Terminal banners stack top-right for ended, reconnecting, observe and held-draft review states.
- The mobile key bar starts with Esc, Tab and `^C`, then sticky Ctrl/Alt/Shift, Enter and arrows;
  it never steals typing focus. Modifiers remain highlighted until toggled off,
  leaving the pane/lens or disconnecting; each exposes `aria-pressed`.
- That is the default row. Settings → Terminal → Key bar can add, remove and reorder every
  terminal key and register exact combinations. Removing a held modifier clears it immediately.
  A deliberately empty row retains only the keyboard mode control on a touch screen.
- The mobile drawer slides over a scrim. Closed visibility removes its controls from the tab order.

### In-app alert
- While the app is on screen, a pane that needs input, finishes a turn (by the device's Finished
  choice) or ends drops a card from the top edge: a black drop falls from above the safe area,
  spreads into the card, and its text shows. It hangs from `env(safe-area-inset-top)` only, so a
  Dynamic Island, a notch and a desktop window take the same path; no device is guessed.
- In the phone layout (768px and under) the card is one line, 44px high and as wide as its text
  (340px at most): the pane's name, then what happened. A long name is cut short, what happened is
  not, and the dot is left out. Wider than that it is the two-line card, 64px high.
- One at a time; a newer one folds the current one away first. Tap opens the pane; a drag or flick
  up puts it away; it leaves by itself 3.6s after its text shows, and waits while touched.
- Not for the pane already open, and not while the app is hidden (system notifications cover that).
- Reduced motion: it fades in and out where it rests, without falling or spreading.

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
| Spin | `--dur-spin` | `1600ms` | One turn of a stepped spinner (the command palette's busy arc); the step count sets the frame rate |
| Breathe | `--dur-breathe` | `2000ms` | The sidebar's working dot: full for 40% of the cycle, six steps down to opacity 0.5, held, six steps back; every dot shares the document clock's phase, so several runs breathe together. It replaced a spinning arc that read as flicker beside the rows |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Finite transitions |
| Pulse easing | `--ease-pulse` | `steps(2, jump-none)` | Endless working and reconnecting dots; avoids drawing every display refresh |
| Spring easing | `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | Voice recording pill enter (180ms, scale 0.96->1 + opacity, from the mic button) and exit (120ms); a phone's sheet rising and springing back |
| Sheet in | `--dur-sheet` | `360ms` | A phone's sheet rising, and springing back after a short drag |
| Sheet out | `--dur-sheet-out` | `240ms` | A phone's sheet dropping, however it closed |

### Rules
- Only state changes move: hover/press, the drawer, a phone's sheets, settings switches, working and
  reconnecting.
- From `641px` dialogs and their scrims snap open and closed; they have no entrance or exit
  animation. At `<=640px` they are bottom sheets and move as an iPhone's do (Modal, above): what a
  finger drags follows the finger, and the rest rises and drops.
- The voice recording waveform is the one surface allowed to draw every frame: only while
  recording, driven by the live microphone level, transform-only (`scaleY` on 7 bars). The pill is
  a state change, not a dialog, so the snap rule above does not apply to it.
- `prefers-reduced-motion: reduce` removes pulses, drawer/control transitions, sheet rise and drop,
  smooth chat scrolling and settings toggle motion; a drag still follows the finger. State remains legible without animation.
  One exception: the sidebar's RUN dot keeps its stepped breath, opacity only and nothing moving,
  so a running agent does not look frozen.
- Under reduced motion the voice pill swaps its bars for one level bar updated at 4 Hz and drops
  the ring and the morph; the **Recording** label and the timer stay.

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
  has text plus color. Compact sidebar states add distinct glyphs and keep their text accessible;
  ready and unknown draw nothing there, and unknown uses a dashed badge edge elsewhere.
- Touch targets grow to `--touch-target`; fields stay `--fs-input` where mobile zoom is a risk.
- On a touch screen (`hover: none` and `pointer: coarse`) the app is an app, not a page: its
  chrome (header, sidebar, tab strip, key bar, menus, sheet heads and feet, buttons, tabs, labels)
  is not selectable and opens no link callout, while the transcript, code, files and fields are;
  page pinch zoom remains available on ordinary content, while the terminal's two-finger pinch
  sizes its font; landscape does not inflate text. A pressed button dims to `0.55` at once in place
  of the amber `:active` box; a list row (sidebar, agent, menu, sheet, Settings page) fills instead.
- `prefers-reduced-motion` is honored. Lucide/inline SVG decoration is hidden from assistive tech.
- Global shortcuts use the convention **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. Settings lists the global bindings and allows changing their final key or disabling
  them, with duplicate assignments blocked and known browser/OS reservations warned about.
  Reservations vary by browser and installed-app mode; a warning is not a guarantee of delivery.
  Bindings belong to this browser, not the remote PC or pane. Hold-to-dictate remains fixed.
- Text-field selection and IME composition keep their keys. Focus-local list/tab navigation and
  reordering are separate from global bindings; they must not intercept terminal input.
  Global actions target the selected pane, and a handled shortcut must never also reach its PTY.
- On touch screens app actions stay in buttons and menus, including the palette in More on phones.
  The key bar sends terminal input only; it is not an app-action toolbar. Hardware keyboards use
  the same global bindings on phones and desktops.
- `document.title` is `<pane title> · herdr` while selected, otherwise `herdr web ui`.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
| Terminal colors exist in CSS and JavaScript | `styles.css`, `settings.ts` | xterm consumes a JS theme | Keep `terminalTheme()` verbatim with `--term-*` |
