### Changed
- The server uses a third to a half less CPU while several terminals print busily: the replay kept
  for a late joiner no longer re-encodes its whole tail on every chunk of output.
