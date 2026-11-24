### Added
- OpenCode 2's permission requests get their own card: the whole shell command as it will run (with its
  `&&`, redirections and heredocs), the file edit with its patch, the URL or the MCP tool with its input, answered Allow once, Always allow or Deny through OpenCode's
  background service. The card closes when the terminal answers first; an OpenCode whose service is not
  reachable keeps the generic card.
