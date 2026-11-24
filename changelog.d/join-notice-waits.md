### Fixed
- The "a new device joined" notice now waits on the PC until someone sees it: a window of that PC opened
  later (the desktop app, localhost, or app.ovis.sh through the relay) still shows it, also after a
  restart, until one window dismisses it, which clears it everywhere. The new device itself never
  sees a notice about its own join.
