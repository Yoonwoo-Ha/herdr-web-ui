### Fixed
- On Unix, when the last viewer explicitly detaches from a herdr terminal, the attach now has up
  to 2 seconds to deliver keys and wheel scrolls it already accepted. Windows attaches still
  close immediately, as do attaches with a pending lone Ctrl+B or whose viewer's connection is
  closed or revoked.
