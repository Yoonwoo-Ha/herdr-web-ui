### Changed
- Growing OMO and GJC chats now parse appended transcript records incrementally, sharing the bounded
  live parser cache already used by OMP, Claude Code and Codex. Tool results, task completions,
  runtime notices, history resets and earlier responses keep their existing behavior.
