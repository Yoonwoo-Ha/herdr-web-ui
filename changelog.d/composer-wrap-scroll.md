### Fixed
- Wrapped and multiline message drafts are sized with an out-of-flow measurement field instead of
  collapsing the live input, preserving transcript spacing and the paragraph being read (#1337).
- The measurement field shares the live input's Korean, Japanese and Chinese line-breaking rules,
  including Korean placeholder wrapping, so localized drafts keep their natural height.

### Maintenance
- Composer geometry regressions freeze the demo conversation while keeping it idle, so turn
  completion cannot change the transcript during measurements on phone and desktop.
- Settings and PWA draft checks target the visible input explicitly; locale regressions cover
  native draft and placeholder heights on phone and desktop.
