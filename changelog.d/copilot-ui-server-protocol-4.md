### Fixed
- Chat reads the foreground session from Copilot's `--ui-server` again with Copilot CLI 1.0.113
  and later, which speak protocol 4. Panes on an older CLI (protocol 3) keep their Chat; any other
  version uses Terminal.
