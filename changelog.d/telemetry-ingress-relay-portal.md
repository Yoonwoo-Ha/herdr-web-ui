### Changed
- The daily anonymous usage counts now say when the app was opened from a device paired through
  the Ovis relay (through the relay or directly) or through Portal (`relay`, `portal`), which were
  counted as `unknown` and `proxy` before. Only those words are sent, never an address, a Portal
  name or a relay ID.
