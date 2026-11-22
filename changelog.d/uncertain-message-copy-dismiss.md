### Fixed
- The X on an unconfirmed message dismisses only its saved display copy, including while offline.
  Exact dismissed IDs stay hidden after reconnecting or reloading; no pending input is cancelled
  or resent, and uncertain delivery is not treated as confirmation. When this connection still holds
  the message, the PC also drops its unconfirmed record, so the pane takes queued messages again,
  and dismissing a copy in another tab never hides the message from the tab that still holds it.
  ([#4176](https://github.com/devswha/ovis/pull/4176) by @odfalik)
