### Changed
- Growing OMP and Claude Code tasks now parse appended transcript records incrementally, reducing
  repeated work when long chats refresh while preserving tool results, notices and history resets.
  Live parser state shares Codex's bounded cache; earlier responses stay unchanged as new records arrive.
