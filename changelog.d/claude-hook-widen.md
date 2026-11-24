### Changed
- Claude Code's file writes and edits, web fetches and MCP tool calls in a Claude Ovis started are
  approved through Claude's own permission hook, as its shell commands already were: the card
  shows the file's path with the whole text written or the lines an edit takes out and puts in,
  the address fetched, or the MCP tool's name and arguments, from Claude's request itself.
- A Claude Ovis started reads DONE as soon as Claude's Stop hook says its turn ended, before the
  screen shows it; a prompt queued under the turn keeps it at work until its own turn ends.
