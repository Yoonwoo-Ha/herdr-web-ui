### Changed
- The Android app carries the hosted shell (Connect a PC, My PCs and every relay PC's page) and
  serves it from the app at `https://app.ovis.sh` itself, with no network: My PCs opens at once
  offline, with no wait for the hosted screen, and an update keeps the sign-in, keys and pairings
  stored there. A worker the network's copy left behind is cleared on the first start, before any
  page of it runs.

### Maintenance
- `bun run build:web` puts the shell into the Android build (`OVIS_APP_SHELL_DIR` names the
  dist-shell to carry, else it is built from the checkout). `OVIS_APP_SHELL=hosted`, the default
  with `OVIS_APP_URL`, loads it from the network as before, for a preview app; Gradle refuses to
  package that as the store app or as an app bundle.
