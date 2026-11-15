### Fixed
- On Windows, installing a branch or a commit with `install.ps1` (`OVIS_REF`) builds it from its own
  sources, as `install.sh` does, instead of failing with "Cannot find module" while herdr runs. Running
  it again with `OVIS_REF` naming that branch or commit builds a branch an earlier install left on the
  release's binary from source. A build that fails or is cut off (Ctrl+C, a closed window, a restart)
  is built again by the next run, unless the checkout still holds the packages and client of an
  earlier build, which make a cut-off build look finished. `OVIS_REF` naming another branch or commit
  than the installed one, or a branch that has moved since it was installed, is said, and nothing is
  stopped or changed.
