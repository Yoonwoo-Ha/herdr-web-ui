### Fixed
- Opening a finished pane clears its DONE dot only after its answer or terminal output is
  actually visible. Covered panes, loading or failed chats, and terminal reconnections keep
  unread finishes marked.
- Reading older chat keeps the finish unread. Jumping to the latest answer clears it only
  after the jump arrives; small scrolls above the end show the way back. Resizing and restoring
  a short chat work without an extra scroll.
- An older answer cannot clear a newer finish. Agents whose chat cannot prove completion keep
  the dot conservatively; opening their Terminal view can acknowledge the output.
- Read finishes stay read across pane switches and browser tabs on the same device. Every
  web-server restart or update brings read DONE dots back; read records are not carried across
  server restarts.
