### Fixed
- A Claude Code Bash approval that Ovis started Claude for is built from Claude's own request:
  the whole command and Claude's words, also when the dialog says "This command requires
  approval" or is taller than the pane. Two requests for the same command each get their own card.
- A long command in an approval card wraps inside the card instead of running out past its edge.
