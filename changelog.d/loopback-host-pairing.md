### Changed
- A browser on the same PC that opens an install with no token, which has never paired a device,
  under another name, such as the PC's hostname or a reverse proxy on that PC that passes its own
  domain, is now asked to pair, as it already was once a device had been paired. Local names
  (`localhost`, `*.localhost`, a `127.x` address, `[::1]`) and this PC's own tailnet name or
  address work as before. Pair that browser, or set `OVIS_TOKEN` and sign in with it.
- Through `tailscale serve`, a device signed in to Tailscale as this PC's owner gets in without
  pairing only at this PC's full `*.ts.net` name or its `100.x` address. Opened under another name
  (a short MagicDNS name, the IPv6 address, a domain of your own), it is now asked to pair.
- Paired devices, a token and a Portal sign-in work as before, under any name.
