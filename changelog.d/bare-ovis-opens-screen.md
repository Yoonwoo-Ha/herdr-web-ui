### Changed
- `ovis` at a terminal joins a running herdr-core session in the terminal screen (`ovis --session NAME`
  selects another session). If no core answers, or the command's input or output isn't a terminal,
  it does exactly what `ovis status` does. It never asks to start a core.
- The terminal screen can create worktrees and delete linked checkouts through the local Ovis server.
