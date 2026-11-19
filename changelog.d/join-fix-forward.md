### Fixed
- The trial join (fleet preview) finds herdr when HOME is reached through a link, and its consent
  promises to turn lingering on only where it then does.
- Running the trial join again keeps the earlier trial server running when that run is interrupted
  before it changes anything, or when the `--port` it asks for is already taken when the run starts.
- An interrupted trial join no longer leaves a half-made folder or unit file behind, a second Ctrl+C no
  longer cuts its rollback short, and after the add it says that the account's list may still name the
  machine.
- Where the trial join cannot see its server stopped under systemd, it names the command that also
  disables the service.
