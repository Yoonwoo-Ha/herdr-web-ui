### Fixed
- On Windows, installing a branch or a commit with `install.ps1` (`OVIS_REF`) builds it from its own
  sources, as `install.sh` does, instead of failing with "Cannot find module" while herdr runs. Running
  it again with `OVIS_REF` naming that branch or commit builds a branch an earlier install left on the
  release's binary from source. A build that fails or is cut off (Ctrl+C, a closed window, a restart)
  is built again by the next run, also one cut off while it installed its packages or over the
  packages and client of an earlier build: the plugin's launcher now marks a build from source as
  finished only once it is. A server of an earlier build still running is stopped first; one that
  cannot be is named by the process its start recorded, and nothing is built. `OVIS_REF` naming
  another branch or commit than the installed one, or a branch that has moved since it was
  installed, is said, and nothing is stopped or changed.
- `install.sh` and `install.ps1` run again with `OVIS_REF` over an installed Ovis that needs no
  build say the commit it is at and that `OVIS_REF` does not move it, instead of nothing.
