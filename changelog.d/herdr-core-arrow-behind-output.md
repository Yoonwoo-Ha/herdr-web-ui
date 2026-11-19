### Fixed
- On herdr-core, an arrow pressed right after Enter (Up for the shell's history, say) no longer
  holds up the terminal for 2 to 3 seconds. While the program's output was still on its way to the
  screen, the arrow waited for a pause in typing, and every key typed after it waited too.
