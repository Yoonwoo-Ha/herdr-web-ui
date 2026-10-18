### Fixed
- Choosing Jump to latest remembers bottom-follow before the virtual list scroll completes.
  Switching to Terminal immediately after that choice and returning to Chat no longer restores
  the older reading position. This fixes explicit Jump-to-latest intent, not arbitrary upward
  restoration on long, active or reasoning-heavy tabs.
- Remember bottom-follow without measuring rendered rows or looking up a turn anchor; readers away
  from the end retain the existing paragraph-and-offset restoration.
