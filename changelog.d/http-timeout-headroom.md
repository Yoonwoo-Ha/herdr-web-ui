### Fixed
- Slow API requests can return their result or timeout error instead of losing the HTTP connection
  while bounded Herdr calls are still running.
