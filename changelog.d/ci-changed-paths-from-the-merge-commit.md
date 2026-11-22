### Maintenance
- CI: what a pull request changed is read from the run's own merge commit, not from the base branch as
  the pull request last saw it, so the files of pull requests merged in between no longer keep its
  docs-only and browser-job skips from applying.
