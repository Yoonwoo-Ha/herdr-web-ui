### Fixed
- `ovis status`, `add` and `pair --approve` against a machine profile now say when the plugin's
  settings file sets `OVIS_STATE_DIR` over the one the command was run with, name that file, and
  say how to reach the profile, instead of only that Ovis is not running.
