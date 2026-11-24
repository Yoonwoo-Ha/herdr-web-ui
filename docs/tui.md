# Terminal screen (`ovis tui`)

`ovis tui` shows herdr-core's terminals in the terminal you type it in, laid out the way herdr
shows its own: a sidebar of workspaces and agents with their state, tabs, split panes, and herdr's
keys from your herdr config. It's part of Ovis, so there's nothing else to install or build. It
talks to [herdr-core](https://herdr.dev/core). It works without the Ovis server except for creating
and deleting worktree checkouts, and never needs an Ovis token. It runs on Linux and macOS.

Coming from herdr's own screen? herdr's session lives in herdr's server, which this screen doesn't
show. Ovis's web UI can move it over: **Settings → About → Terminals → Move everything to
herdr-core** rebuilds every workspace, tab and split on herdr-core
([Moving herdr's session to herdr-core](runtime-move.md)).

## Open it

```bash
ovis tui                    # the herdr-core session Ovis is set up for
ovis tui --session work     # another herdr-core session
```

In a checkout, run `bun scripts/plugin.ts tui`. `ovis tui --help` prints the usage and
`ovis tui -V` the version.

Plain `ovis` opens the same screen (`ovis --session work` too) when you type it at a terminal on a
running herdr-core session. If that session isn't running, or either standard input or output
isn't a terminal, it prints exactly what `ovis status` prints and exits with its code. Plain
`ovis` never asks to start herdr-core; use `ovis tui` for that.

It joins the core that `--session NAME` names, else the one `HC_SOCKET` or `HC_SESSION` names in
your environment, else the one Ovis's settings file names (the installer writes it there), else
hc's `default` session. A session name is letters, digits, `_`, `.` and `-`.

It opens where you left that core last time: the same workspace, tab and pane. If that place is
gone, it shows the nearest one and says so. When it connects or reconnects to a core with no
workspaces it opens one at once, as herdr's server does, with a shell in the folder you typed `ovis tui`
in, named after it (`~` in your home). If herdr-core can't start a shell in that folder (it was
removed, or can't be entered), the workspace opens in herdr-core's own folder as `~`, with a notice
naming the folder. Two screens that start together on an empty core open one between them: the
other waits, and opens it itself within 15 seconds if the first one left or died before it was
done.

`OVIS_TUI_BIN`, which pointed at the separate program the first version needed, isn't used any
more. `ovis tui` says so once when it finds it set.

### When herdr-core isn't running

At a terminal, `ovis tui` asks first:

```
herdr-core is not running. Start it? [Y/n]
```

Enter, `y` or `yes` starts it and opens the screen. Anything else, `n` or Ctrl+D included, prints
the command that starts it and exits with code 1. Only a line you send with Enter is an answer:
Ctrl+D after some text is a no. Keys you typed before the question showed up don't count either;
where the terminal can't throw them away, `ovis tui` reads no answer and prints the command
instead. A core started this way keeps running after you leave the screen, and it gets none of the
Ovis server's credentials or the SSH, tmux or pane variables of the shell you started it from.

Outside a terminal (a script, a pipe), `ovis tui` never asks: it prints that command and exits
with code 1.

## Keys

The keys are herdr's. The screen reads your herdr config (`$HERDR_CONFIG_PATH`, else
`$XDG_CONFIG_HOME/herdr/config.toml`, else `~/.config/herdr/config.toml`) and uses herdr's default
for anything it doesn't set, so the prefix is `ctrl+b` unless your config picks another one.
`prefix+?` shows herdr's help with your keys as your config sets them: it scrolls (`j`, `k`, the
arrows, page up and down) and `/` filters it by command or key. Above its sections it lists under
**Config Diagnostics** any binding the screen can't use and why. `prefix+shift+r` reads the config
again.

Outside the pane's own typing, a bar over the panes' last row shows the mode you're in (prefix,
navigate, resize, copy) and a few of its keys; while you type into a pane there is no such bar. The
defaults:

| Keys | What they do |
| --- | --- |
| `prefix+?` | help |
| `prefix+enter` | the menu (on a narrow window, the switcher) |
| `prefix+q` | detach (leave the screen) |
| `prefix+g` | Go to: every terminal under its workspace; `/` searches |
| `prefix+o` | jump to the agent that needs you most |
| `prefix+w`, `prefix+r`, `prefix+[` | navigate, resize and copy mode |
| `prefix+c`, `prefix+n`, `prefix+p`, `prefix+1..9` | new tab, next and previous tab, tab 1 to 9 |
| `prefix+v`, `prefix+minus` | split the pane (`\|` and `-`) |
| `prefix+h`, `j`, `k`, `l` | focus the pane to the left, below, above, right |
| `prefix+tab`, `prefix+shift+tab` | next and previous pane |
| `prefix+z`, `prefix+x` | zoom the pane, close the pane |
| `prefix+shift+n`, `prefix+shift+d` | new workspace, close workspace (it asks first) |
| `prefix+shift+w`, `prefix+shift+t`, `prefix+shift+p` | rename the workspace, tab or pane |
| `prefix+b` | hide or show the sidebar |
| `ctrl+alt+g` | lock and unlock |

Escape and `ctrl+[` after the prefix always cancel it. A binding of your config on them after the
prefix is dropped, with a note in the help.

A few of herdr's actions aren't built here: settings, the three worktree actions, edit scrollback
and clear pane. Their key shows a notice instead.

With an input method on (Korean, say), a letter typed after the prefix arrives composed and the
screen drops it with a notice to switch to the English keyboard.

A notice (a refused key, an action that isn't built, a problem with your config) shows in a box at
the top right of the screen for five seconds, the newest three at a time. It is never written into
the mode bar.

### Modes

- **Navigate** (`prefix+w`; on a narrow window it opens the switcher): `up` and `down` pick a workspace, `h` `j` `k` `l` or the arrows a
  pane, `n` and `p` a tab, `1`..`9` a workspace by number, `tab` and `shift+tab` the next and
  previous pane. Enter goes there, Escape cancels. Three keys herdr doesn't have: `shift+up` and
  `shift+down` move the workspace up and down the list, and `m` moves the focused pane into the
  workspace you point at.
- **Resize** (`prefix+r`): `h` `j` `k` `l` or the arrows grow the pane that way; Escape, Enter or
  `r` ends it.
- **Copy** (`prefix+[`): browses one pane's history. `h` `j` `k` `l` or the arrows move, `w` and
  `b` go by words, `0` and `$` to the row's ends, `g` and `shift+g` to the oldest and newest rows,
  `ctrl+u` and `ctrl+d` by half pages. `v` selects characters, `shift+v` whole lines, and `y`
  copies. `/` and Enter search, `n` and `shift+n` step through the matches. `f` labels up to nine
  links, paths and hashes on screen, and `1`..`9` copies one. A target cut off at the pane's edge,
  or one that may run across a line end, gets no label. Escape or `q` leaves and puts the pane back
  where it was. Search ignores case for English letters only.
- **Locked** (`ctrl+alt+g`): every key goes to the program in the pane, the prefix too, for a
  program that needs `ctrl+b` itself. `ctrl+alt+g` again, or a click on **LOCKED** in the bottom
  line, unlocks it. If your config uses `ctrl+alt+g` for something else, it keeps it, and there is
  no lock.

### The menu

`prefix+enter`, or a click or tap on **menu** at the foot of the sidebar's workspaces, opens herdr's
small menu above it: **settings** (not built yet), **help**, **reload config** and **detach**. The
arrows and Enter, or a click, choose; Escape closes it.

### Agents

The sidebar is herdr's: it lists the agents grouped by workspace, two rows each, a dot for the
state (`●` working, needs you and done, each in its colour; `○` idle), the workspace and tab, then
the agent, in herdr's own colours on a dark or a light terminal alike. A workspace in a git checkout
shows its branch under its name, read from git's own files when the screen's view changes, at each
key into a pane and at each focus change; the ahead and behind counts herdr adds are not shown. `prefix+o` jumps to the agent that needs you, blocked ones first, then
finished ones. As in herdr with its default settings, an agent that needs you or finishes shows no
notice: its mark in the sidebar changes.

### Mouse

A click focuses a pane, or picks a workspace, tab or agent in the sidebar and tab bar; **new** and
**menu** under the workspaces, `+` in the tab bar, `«` and `»` on the sidebar and a dialog's
buttons do what they say. Dragging a divider resizes the split. The wheel scrolls back through a
pane's history, and its scrollbar shows where you are. Dragging over text selects it, and letting go
copies it and clears the selection. In a program that reads the mouse itself, hold Shift to select.

A right click opens herdr's menu where you click, on a pane (anywhere in its box), a tab or a
workspace in the sidebar; nothing else has one. The arrows, the pointer over an entry and Enter, or a
click, choose (the screen asks your terminal for pointer motion, as herdr does: the menus and the
Go to picker follow the pointer, while in the switcher and Open worktree... the arrows or a click
choose, as in herdr's); Escape or a click outside closes it. A pane's menu renames, clears its name, swaps it with the focused pane,
splits, zooms or closes it; **Send right-clicks to pane** lets the program in it have your right
clicks (Shift still opens the menu), and stays with the pane when you move it to another tab. A tab's menu makes a tab, renames or closes it; a workspace's
renames or closes it. A workspace in a git checkout adds **Open worktree...**, which lists the
repository's checkouts from git's own files and opens one (grouped under the repository); a
repository's workspace with worktrees under it adds **Close group** and **Collapse**.
**New worktree** (on a git workspace or a repository's group) and **Delete worktree checkout...**
(on a worktree grouped under its repository) are done by the Ovis server, as in the browser: start
it with `ovis start`, and the launcher tells the screen where it answers on loopback. The screen
sends no token, follows no redirect, and doesn't use a proxy. Without a reachable local server,
the entry reports that it couldn't run. Removing a checkout closes its workspace but keeps the
branch.

### Copying

Everything the screen copies goes to your terminal as one OSC 52 write, so your terminal must
accept OSC 52. The screen never runs a clipboard program. A selection too large to send shows
**Selection exceeds the clipboard limit** and copies nothing.

## Leave it

`prefix+q` (or your config's detach key) leaves the screen and prints:

```
ovis tui: detached from herdr-core session default; its terminals and agents keep running.
```

Closing the terminal window does the same: nothing in herdr-core stops. If your config leaves no
key that can detach, the screen says so in the help, and the menu's **detach** entry still works.

A pane whose program ends closes, as in herdr: the pane beside it takes the room.

## Narrow windows and phones

At 64 columns or fewer the screen draws herdr's narrow layout: a two-row header (the workspace and
its state, the tab, and how many agents stand in each state) with a **switch** button at its right,
over the tab's panes laid out as on a wide window. Tap **switch** (or press `prefix+w` or
`prefix+enter`) for herdr's switcher: the agents, the workspaces, the shown workspace's tabs and the
menu, one tap or the arrows and Enter away.

On a phone, use the extra-keys row's CTRL for `ctrl+b`. Keys typed in the moment a pane is still
opening, right after you switch to it, are refused with a notice rather than kept for later.

## What it promises

- It never starts a herdr-core unless you answer yes.
- Nothing you type while herdr-core or a pane isn't reachable is sent later: the screen refuses it
  with a notice. While herdr-core doesn't answer, an **ERROR** bar over the panes' last row and each
  pane say **herdr-core is not answering** with the command that starts it, and the screen comes
  back by itself once the core answers again.
- While a change you made to the layout is carried out (a new workspace or tab, a split, a close, a
  rename, a move, a zoom, or the first workspace of an empty core), what you type, paste or click
  into a pane waits for it, in order, and then goes to the pane that change leaves you in. If the screen can't
  show that pane within two seconds, what waited is dropped with a notice, never sent to the pane
  you were in before. A key or a click that would open a menu or run another command in that moment
  (a right click on a pane, a tab or a workspace too) is refused with one `layout_busy` notice.
  Detach still leaves at once.
- It never takes a terminal's size by itself. When another screen or the browser has sized a
  terminal, its pane is drawn clipped with **sized by another viewer (COLSxROWS)** on its bottom
  edge (above the pane when it has no border) until you type in it.
- Leaving the screen never ends a program. Closing a workspace asks first.
- It starts no program of its own: no clipboard helper, no browser for links, no editor.
- It never talks to the Ovis server, and gets none of the server's settings: every `OVIS_*` name
  your shell exports (and `HERDR_WEB_*`, their old names) is left out of its environment, except
  the ones the screen reads itself, such as `OVIS_TUI_STATE_DIR`.
- It refuses to run inside one of its own panes, where it would draw itself into itself.
- If it crashes it gives your terminal back first, then writes a record holding codes only, never
  anything you typed.

It keeps its files in `$OVIS_TUI_STATE_DIR`, else `$XDG_STATE_HOME/ovis-tui`, else
`~/.local/state/ovis-tui`: one small file per core with the place you left (ids only, no names and
no text) and the crash records.

## Over SSH, tmux and mosh

When an SSH connection drops, the screen ends with it and gives the terminal back; your agents keep
running in herdr-core. Run it again and it opens where you were.

- **tmux:** run the screen inside tmux on the PC and a dropped connection doesn't end it;
  `tmux attach` shows it as it was. tmux keeps `ctrl+b` for itself, so with tmux's default keys
  herdr's prefix becomes `ctrl+b ctrl+b` (or set another prefix in your herdr config).
- **mosh:** the session survives sleep and network changes. mosh sends the keys you typed while the
  network was gone once it's back: that's mosh's own behaviour, and the screen can't tell them
  apart. Use SSH with tmux if anything typed offline must never arrive later.

## What it doesn't do

- Windows: `ovis tui` there prints one line and exits.
- Question cards, the readable last turn, pins, automatic tab names and the BG state: those come
  from the Ovis server. Answer an agent's question in its pane, as in herdr.
- Floating popups, a settings screen, edit scrollback and
  clear pane.
- Terminals of other PCs: it shows this PC's herdr-core only.
- Images: it doesn't draw Kitty graphics or sixel.
- Translations: it's in English.
- The picker's state filters (herdr's `a`, `b`, `w`, `i`, `d`).
- Keeping hidden tabs at a size: a terminal in a tab you don't see may reflow.
- A branch's ahead and behind counts in the sidebar: they need git itself, and the screen starts no
  program.
- An import from herdr: use **Move everything to herdr-core** in the web UI.

[docs/tui/parity.md](tui/parity.md) lists every difference from the browser and from herdr, with
its reason and what was measured.
