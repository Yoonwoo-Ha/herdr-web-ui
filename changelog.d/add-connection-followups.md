### Fixed
- Add a connection → SSH tells a Tailscale PC that runs an Ovis older than 0.5 to update it there,
  instead of offering Add.
- The SSH list reads each file an Include names in the Host block the Include is in, and leaves
  out a host that a negated pattern on its own Host line excludes, as ssh does.
- The Ovis relay tab offers the relay's own pairing also while the account service answers with a
  server error.
