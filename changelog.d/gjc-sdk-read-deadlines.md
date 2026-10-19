### Fixed
- GJC chats on a busy machine give cold session lookups up to five seconds per command and
  ten seconds overall instead of timing out after two seconds per command. Session snapshots
  retain the shorter status lookup budget; failed status lookups
  are held for 30 seconds without preventing chat reads from retrying.
