### Fixed
- The phone app away from home reaches a PC on Tailscale even when the PC also names two LAN
  addresses: it keeps one of its two direct sockets for the Tailscale address instead of falling
  back to the relay.
- Opening a PC no longer closes one of the same device's other sessions for a connection attempt
  the app then drops: a session counts as the device's only once it is used.
