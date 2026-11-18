### Fixed
- A queued chat message whose page left the pane, or whose pane's terminal restarted, while the
  message was being sent is held for Send now also when the agent only put that send off. It used
  to go back to "queued" until the next turn's end, though it could no longer be sent on its own.
- A new workspace's first message is held, not sent on its own, when the page that asked for it
  switched to watching, or opened the pane and left it, while the workspace was made and its agent
  launched. It is held too when the pane's terminal restarted meanwhile.

### Maintenance
- A TLA+ model of the pending-message lease checks, for every order of events, that nothing of a
  queued, held or first message is typed after its page left. The project skill
  `.claude/skills/verify-pending-lease` says when and how to run it.
