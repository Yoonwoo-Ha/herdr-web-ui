### Changed
- `ovis tui` opens Ovis's own terminal screen, built into Ovis: there is no separate program to
  build any more, and `OVIS_TUI_BIN` is no longer used (it says so once). It still shows
  herdr-core's terminals with herdr's keys from your herdr config, on Linux and macOS. With no
  herdr-core running it asks `Start it? [Y/n]` at a terminal instead of only exiting. It draws like
  herdr's own screen: herdr's help that scrolls and filters (`prefix+?`), its small menu, its Go to
  picker of every terminal (`prefix+g`), its right-click menus, and on a narrow window herdr's
  layout and switcher. It adds copy mode with search and copy hints (`prefix+[`) and a lock that
  sends every key to the pane (`ctrl+alt+g`) ([docs/tui.md](docs/tui.md)).
- Plain `ovis` at a terminal prints the help everywhere: it no longer opens the separate terminal
  program on a PC where one had been built. `ovis tui` opens the screen.
