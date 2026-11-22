### Fixed
- A Chat message queued for a Claude Code session whose own turn has ended while its teammates or
  background agents keep working is sent at that rest again, as typing in its terminal would be,
  instead of waiting under "Next turn" until all that work is over. Claude Code reports such a
  session as working and writes no turn end of its usual kind then; its answer, and its Stop hooks'
  summary where it runs any, now mark the rest.
