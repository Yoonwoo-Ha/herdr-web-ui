### Fixed
- app.ovis.sh no longer stops at "Something went wrong" (Unable to preload CSS) on every start after
  a phone asked for one of its files during a deployment: a file the site lacks is now a 404 the
  browser asks for again, not the page kept as that file for a year. When the app's code still
  fails to load, the page reloads once by itself, then offers Try again instead of the crash screen.
