### Changed
- Add a connection's Tailscale tab never asks for a terminal: Open with Tailscale has this PC run
  `tailscale serve` itself and then shows the phone QR code, Tailscale off opens the Tailscale app
  (macOS, Windows), Get Tailscale links to the download for this PC's system, and the tab moves on
  by itself once Tailscale is on. The command shows only when Tailscale refuses the serve.
