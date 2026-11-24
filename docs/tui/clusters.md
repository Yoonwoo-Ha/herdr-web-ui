# Cluster answers

This table gives the answer for each of the 41 clusters of r/herdr posts about the terminal screen: whether the screen solves it, helps with it, or leaves it to another part of Ovis or to herdr-core. The disposition words are solved (TUI-SOLVES), helped (TUI-HELPS), engine (NEEDS-ENGINE), other Ovis surface (OTHER-OVIS-SURFACE) and not ours (NOT-OURS).

| # | Cluster (short) | Disposition | Answer |
| --- | --- | --- | --- |
| 1 | no TUI client for core | TUI-SOLVES | a terminal screen on herdr-core (`tui/`) |
| 2 | no restore after reboot | NEEDS-ENGINE | not the screen's job; a kept terminal waiting for its new shell says so |
| 3 | app feature-poor, mods as band-aid | TUI-HELPS | the basics are built-in keys, herdr's menu and its right-click menus |
| 4 | TUI seen as abandoned | NOT-OURS | the screen is a maintained terminal client on the core API |
| 5 | Windows multi-line paste | TUI-HELPS | a paste is one bracketed block and is never submitted |
| 6 | TUI unusable on touch | OTHER-OVIS-SURFACE | Ovis browser and phone UI; the narrow layout serves phone SSH apps |
| 7 | which agent needs me | TUI-HELPS | agents in the sidebar by workspace; `prefix+o` jumps to the agent that needs you, and keys go to the next or previous agent |
| 8 | navigation across many | TUI-SOLVES | herdr's picker searched with `/`, navigation mode, number keys |
| 9 | no orchestration | NEEDS-ENGINE | not the screen's job |
| 10 | agent detection gaps | NEEDS-ENGINE | the screen shows what the core reports and never detects |
| 11 | prefix ergonomics | TUI-HELPS | herdr's keys including the user's direct bindings; help from the live keymap, searchable |
| 12 | organise panes, agents, workspaces | TUI-HELPS | move, swap and rename through the shared layout operations |
| 13 | no file, Markdown or image preview | TUI-HELPS | not in the screen (D2); Ovis's browser has the file viewer |
| 14 | weak out-of-box experience | TUI-HELPS | an empty core gets a first workspace with a shell at once; the sidebar shows workspaces and agent states |
| 15 | review and diffs force users out | OTHER-OVIS-SURFACE | Ovis's browser has the repo-changes view; the screen shows the Done marker only |
| 16 | multi-machine view | OTHER-OVIS-SURFACE | the screen shows the core it is connected to; other machines' terminals are not listed |
| 17 | no browser pane | NOT-OURS | nothing in the screen |
| 18 | app not a superset of the TUI | TUI-SOLVES | number-key focus, navigation while zoomed, keyboard copy mode, named workspaces; floating popups are not in the screen |
| 19 | plugin split | NEEDS-ENGINE | the screen adds no extension format |
| 20 | sandboxing and policy | NEEDS-ENGINE | nothing in the screen |
| 21 | client API gaps | NEEDS-ENGINE | after `missed` or a reconnect the state is replaced and replayed output is never acted on |
| 22 | naming of tabs and panes | TUI-HELPS | rename workspaces, tabs and panes in place, by key or right-click menu |
| 23 | distrust of direction | NOT-OURS | nothing in the screen |
| 24 | keyboard scroll, copy mode, search | TUI-HELPS | copy mode with vim keys and search in one pane |
| 25 | multi-repo and bare worktrees | TUI-HELPS | `Open worktree...` lists a repository's checkouts and the sidebar groups worktree workspaces under their repository; making or deleting a checkout runs git and is left to the browser |
| 26 | stability and compatibility | NEEDS-ENGINE | an "herdr-core is not answering" state; the screen never kills or restarts the core |
| 27 | no migration TUI to core | TUI-HELPS | not in the screen: Ovis's web UI has "Move everything to herdr-core" |
| 28 | OpenCode state tracking | NEEDS-ENGINE | state comes from the engine only |
| 29 | official mobile app immature | OTHER-OVIS-SURFACE | Ovis phone UI; the screen has close-workspace |
| 30 | single window or instance | TUI-SOLVES | several screens on one core, each with its own focus |
| 31 | messages collide with a draft | TUI-HELPS | rule only: nothing typed while a pane or the core is out of reach is sent later; no message queue UI |
| 32 | closing the window kills agents | TUI-SOLVES | quit is a detach and says so |
| 33 | third-party mobile clients | OTHER-OVIS-SURFACE | Ovis browser and phone UI; narrow layout and reopening the same place |
| 34 | ecosystem churn | NOT-OURS | nothing in the screen |
| 35 | UI polish (ids, close hints) | TUI-HELPS | herdr's dialogs, whose buttons name their keys |
| 36 | docs and terminology | TUI-HELPS | help filtered by command or key; the terms are in CONTRIBUTING.md |
| 37 | usage, cost, resource monitoring | TUI-HELPS | not in the screen: herdr-core reports none of it |
| 38 | config and plugin management | NOT-OURS | the screen's own settings hold no machine paths |
| 39 | one-off requests | NOT-OURS | only the missed-questions part: `prefix+o` jumps to the agent that needs you |
| 40 | long sessions hard to read | NEEDS-ENGINE | scrollback reading and search only |
| 41 | app remote flow, slow scrolling | OTHER-OVIS-SURFACE | Ovis browser; scrolling stays local to the client's emulator |
