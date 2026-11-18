### Fixed
- The chat queue no longer types a queued message into the turn of the one before it when Send now is
  pressed as a turn ends, when herdr's status events arrive after a newer snapshot, when Send now is
  pressed twice during a Codex restart, when a status check reads an older snapshot, or when a
  message is sent to the queue right after the queue typed one.
- Two held messages with the same words both come back in Recover unsent text after the app
  replaces the page, instead of one.
- A typed answer to a question card from Claude, OmO, omp, Hermes or OpenCode sends its Enter only
  when the field still holds exactly that answer under the same question: words typed there
  meanwhile, or a question answered in the terminal, now stop it instead of being submitted.
