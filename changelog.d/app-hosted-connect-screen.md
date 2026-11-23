### Changed
- The phone apps open the hosted Connect a PC screen when no PC is to open: on a first launch,
  after Change PC, and from a PC's Connect a PC, which keeps that PC to go back to. A saved PC
  still opens directly. Picking a PC of the account there makes the hosted app the PC the app
  opens next time.
- When that screen cannot load (no network, or no answer within about 8 seconds), the app's own
  Connect a PC page comes up instead, with one line saying so and Try again. Tailscale, SSH and
  address PCs open from it as before.
- Typing `demo` into the hosted screen's address field opens the demo the app carries.

### Maintenance
- `OVIS_APP_HOME=bundled` at `bun run build:web` builds a phone app whose first screen is its own
  Connect a PC page, as before.
