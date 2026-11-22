### Fixed
- On herdr-core with hc 0.1.21, a chat message to a Claude Code that was typed at a shell prompt is
  no longer refused with "Claude Code's input box in the terminal may not be empty" while the box
  shows only Claude's grey tip or suggested prompt. hc 0.1.21 paints the shell's lines before the
  full-screen program's screen, and Ovis read the shell's last line into that screen's top row, so
  its colors never matched the screen. Every full-screen program there, whether a shell started it
  or it is the terminal's own, is again read without history, so Ovis no longer makes hc scroll it
  to read its history (#3128).
