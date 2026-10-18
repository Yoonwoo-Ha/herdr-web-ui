### Fixed
- Wrapped and multiline message drafts are sized with an out-of-flow measurement field instead of
  collapsing the live input, preserving transcript spacing and the paragraph being read (#1337).

### Maintenance
- Composer geometry regressions freeze the demo conversation while keeping it idle, so turn
  completion cannot change the transcript during measurements on phone and desktop.
