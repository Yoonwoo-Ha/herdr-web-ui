### Fixed
- Compact sidebar workspace rows now hide the `⋯` menu button while the inline rename field is open
  so it no longer covers the end of the input, drop the `2.5em` minimum width on short branch names,
  and keep the branch tail visible while the row menu is open (#3455).
- One-line agent rows with the context ring enabled now keep the hover `⋯` button beside the ring
  instead of covering it, and use a `mask-image` fade on the text so forced-colors mode does not
  strip the fade behind `⋯` (#3455).
