### Added
- A PC added through the relay is reached straight on its own network (or its Tailscale address)
  when this PC can reach it there, as the phone apps already do, and through the relay otherwise.
  Its saved addresses follow it, and when this PC changes networks or wakes from sleep it checks the
  direct route again and moves back to it without the PC showing as disconnected; terminals open on
  that PC reconnect when it moves.
