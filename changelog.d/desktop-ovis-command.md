### Added
- The desktop app can put the `ovis` command in your terminal: **Settings → About → Terminal
  command → Add the command** links it in `~/.local/bin` on a Mac and Linux (on a Mac also adding
  `~/.local/bin` to the shell profile's PATH once, when it is missing) and puts its folder on the
  user's Path on Windows, with no administrator step. `ovis login`, `ovis status` and `ovis approve`
  then work on the app's own Ovis. An `ovis` another install put there is left as it is.
