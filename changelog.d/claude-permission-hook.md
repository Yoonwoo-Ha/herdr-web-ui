### Changed
- A Claude Code that Ovis starts on this PC sends its Bash approvals to Ovis through Claude Code's
  own permission hook, over a socket only your account can open. When the terminal's Bash dialog
  shows that very command, the approval card shows it whole, however the pane wraps it, and the
  card's Yes or No goes to Claude as the hook's answer instead of keys. Everything else still
  answers with keys, and the terminal's own dialog stays usable: the card's other options, an
  alert's answer buttons, a command too long for the card or with characters it could not show as
  they are, a Claude started outside Ovis, and Claude on Windows.
