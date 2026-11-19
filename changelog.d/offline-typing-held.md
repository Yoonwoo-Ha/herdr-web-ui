### Fixed
- Keys typed into a terminal while the browser reports the device offline, and keys still waiting
  to go when the network went (the first keys for a new terminal, or for a pane coming back from
  idle) stay on screen as held input until you send or discard them. They are never sent by
  themselves when the network comes back, on the same connection or a new one, and no key queued
  behind them, Enter included, goes ahead of them. A server on the same device, reached directly
  rather than through the relay, still takes typing while offline.
