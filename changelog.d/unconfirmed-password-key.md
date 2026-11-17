### Fixed
- When the connection drops before the bridge confirms a key sent as a password (at a masked
  prompt, or as a pane taken back from another app's hold is drawn), the terminal now says a key may
  not have reached it, on a bridge that confirms keys (by receipt, or by ping on an older one).
  Nothing of the key itself is kept in the browser.
