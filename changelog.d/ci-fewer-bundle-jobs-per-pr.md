### Maintenance
- A pull request that changes only server or shared code builds and smoke-tests the remote bundle on
  Linux x64 and Windows; the Linux arm64 and macOS bundles are built for a pull request that changes
  the bundle or PTY host builds, the lockfile, the integrations' installers or the server's PTY and
  macOS code, and always for a `remote-v*` tag.
- The SSH job of the remote bundles fails on a GitHub-hosted runner without `sudo` or Docker instead
  of passing with the password checks skipped.
