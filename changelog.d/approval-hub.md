### Changed
- A Claude Code that Ovis starts on Windows now sends its Bash approvals through its own hook too,
  as on Linux and macOS, so a card shows the whole command. A Claude Code older than 2.1.286, or
  one whose version Ovis cannot read, keeps answering its approvals with keys.
