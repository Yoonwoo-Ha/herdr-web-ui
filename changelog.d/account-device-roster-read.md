### Fixed
- A phone or browser that reaches a PC through the account no longer shows a red
  "/api/machines failed (403)" card at the top of the sidebar: the PC answers its PC list with
  this PC alone, as the terminal connection already does, and a PC from before this fix keeps
  sending the list over that connection without the card.
