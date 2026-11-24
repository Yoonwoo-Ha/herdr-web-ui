### Changed
- Add a connection's Ovis relay tab, in this PC's own window signed in to its account, lays its top
  out as the Tailscale tab's: the account QR code, the six-digit pairing code beside it on a press, then
  the other PCs this PC can reach (its Tailscale login's PCs and its ssh config hosts) with Add,
  which opens Add PC for that host to add it to your account over SSH; a PC already in your account
  says so. A field at the foot takes a PC not in the list.
- The Tailscale tab lists each PC once, however many ssh config aliases reach it, and takes a PC
  not in the list in a field at its foot.
