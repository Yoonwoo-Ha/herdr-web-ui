### Changed
- The phone app opens a PC away from home about 1.2 s faster: it tries the PC's same Wi-Fi and
  Tailscale addresses at once, and when none answers within 300 ms it opens the relay too and uses
  whichever connects first, instead of waiting 1.5 s for the direct addresses before the relay.
