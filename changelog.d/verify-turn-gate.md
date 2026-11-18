### Maintenance
- A check of the chat queue's turn gate drives the real `PendingInputs` class through every order
  of its callers' steps and of the events around them, within bounds, and asks that no queued
  message is offered or typed before the turn of the one before it was seen to start and finish.
  The project skill `.claude/skills/verify-turn-gate` says when and how to run it, and what it has
  found.
