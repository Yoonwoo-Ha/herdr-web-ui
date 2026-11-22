### Fixed
- A workspace of another PC's herdr-core machine (one added with `hc machine add`) that sits on a
  linked git worktree is drawn under its repository's row, as on this PC's own core. git is asked
  on that machine through the core; those worktrees are only drawn, never opened or removed from
  here.
