### Fixed
- On the herdr-core runtime, a DeepSeek Harness (`dsh-tui`) pane shows its chat again instead of
  only the terminal: its session is read from the dsh-tui host process that runs below the
  `dsh-tui` launcher in front.
- On herdr, on Linux, a Claude pane whose Claude runs inside a sandbox wrapper (bubblewrap through
  `@anthropic-ai/sandbox-runtime`, say) shows its chat when the wrapper's processes carry herdr's
  agent hint `HERDR_AGENT=claude` and herdr has the session the wrapper reported. herdr-core, which
  names only the first process in front, keeps the terminal for such a pane. The chat is read
  from the store the wrapper hands Claude (`CLAUDE_CONFIG_DIR`) instead of `~/.claude`. When the
  hinted processes name different stores, or no session is reported, the pane keeps the terminal.
