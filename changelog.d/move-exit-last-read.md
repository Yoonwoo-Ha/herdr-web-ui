### Fixed
- The move to herdr-core types no exit command into an agent that took work, or switched to another
  conversation, while the move checked its input box: the box and then the agent are read once more
  as the last thing before the keys. A move stopped this way says why ("An agent started working
  again.") and no longer lists an agent it never typed into as left behind.
