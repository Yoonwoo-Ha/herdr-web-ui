### Added
- OpenCode 2.0 or later: its questions are answered from the chat's prompt card through OpenCode's
  own background service instead of keystrokes, one question at a time with Back to change an earlier
  answer, and sent together after the last. Permissions, OpenCode 1 and other prompts keep the
  existing generic fallback card and Terminal.

### Fixed
- Native question answers stay bound to the current pane, session and form. Local service discovery
  rejects stale or non-loopback endpoints, bypasses environment proxies, and bounds slow requests.
- Polling does not invalidate an unchanged question or turn an acknowledged answer into an error.
  A temporary service outage keeps an already displayed native card and its unsent edits.
- Back and question tabs preserve unsent edits, and multiselect submissions include both checks
  and custom text. Abandoned drafts are bounded and expire after 30 minutes.
