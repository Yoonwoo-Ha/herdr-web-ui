### Fixed
- On a herdr-core PC, a pane whose window did not have the focus (another app in front, the Mac
  app in the background) drew the terminal at its own size while the program drew for another
  one, so an agent's live block left old copies stacked at the top of the view. Such a pane now
  draws at the terminal's real size, and sizes it to its window again once it is used.
