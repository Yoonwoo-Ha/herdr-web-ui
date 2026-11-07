### Fixed
- A Claude pane's chat no longer shows "Conversation unavailable", or an empty new chat, when a
  Claude started inside the pane (`claude -p` from a hook or a script) took herdr's report of the
  pane's session: the chat reads the session the pane's own Claude names in its PID record.
