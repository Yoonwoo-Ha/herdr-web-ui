### Changed
- Settings → Devices and PCs → Add a connection is three tabs, as herdr's Add a machine: SSH lists the
  PCs saved in herdr, the hosts of the PC's ssh config and the other PCs of its Tailscale login, and
  Add opens the PC setup with the address filled in; Phones and devices holds the Tailscale address,
  the pairing code and Portal; Ovis relay signs in to the Ovis account. A Tailscale PC is added over
  SSH, never through the relay.
- The devices list drops its "Connected to this PC" title; what is not connected now is dimmed, and a
  PC added here that is not connected can be removed from its row.

### Removed
- Add a connection no longer pairs through the relay without the Ovis account, takes a code from
  another PC, or adds Tailscale PCs through the relay. PCs added that way before keep working.
