### Fixed
- Scrolling a terminal (for example the Jump to bottom button appearing) no longer restyles every
  element of the terminal's pane: two Settings style rules made Chrome and Edge recompute styles
  for the whole pane on any change inside it, even with Settings closed.
