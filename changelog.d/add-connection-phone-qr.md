### Changed
- Add a connection has no separate Phones and devices tab any more: the Ovis relay and Tailscale tabs
  end in the QR code a phone scans to connect that same way, under one line, "Scan it with the Ovis
  app on your phone". Tailscale shows this PC's Tailscale address with its pairing code (or the one
  step that gives it one).
- On a PC already in an Ovis account, the Ovis relay tab now shows a QR code too: it opens this PC
  in the Ovis app (or at app.ovis.sh), signs in to that account with the same provider, and asks to
  join the PC as any new device of the account does. It carries no code, key or token.
