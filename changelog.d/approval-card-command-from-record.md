### Changed
- The approval card of gjc, Muse Code, Letta Code, Grok Build and GitHub Copilot CLI shows the shell command
  as the agent wrote it in its own session record, letter for letter, instead of the rows its dialog wrapped on
  the screen, wherever that dialog draws the whole command; the card still answers by keys, and only while the
  same request is on the screen. A Letta dialog that clips its command gets no card: answer it in the terminal.

### Fixed
- Answers to Grok's and Muse's approval cards are no longer refused as changed while the agent's timer ticks.
