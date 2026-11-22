### Fixed
- Switching tabs no longer flashes a chat and scrolls it from the oldest message to the newest:
  a pane holds the frame it already has and a tab switch appends the presented ones instead of
  reordering the frames already mounted, so React moves none of them and the `scrollTop` of what a
  moved frame scrolled is no longer reset to 0. A split inserts its pane at the new pane's place
  without moving a sibling, and an explicit swap still reorders the two frames so Tab follows the
  left-to-right order, moving no frame of another tab.
