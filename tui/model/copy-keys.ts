/** Fixed actions also feed the common mode bar and help. */
export const COPY_KEYS = {
  copy_leave: ["esc", "q"],
  copy_find: ["/"],
  copy_hints: ["f"],
  copy_yank: ["y"],
  copy_char: ["v"],
  copy_line: ["shift+v"],
  copy_left: ["h", "left"],
  copy_down: ["j", "down"],
  copy_up: ["k", "up"],
  copy_right: ["l", "right"],
  copy_word: ["w"],
  copy_back: ["b"],
  copy_start: ["0"],
  copy_end: ["$"],
  copy_oldest: ["g"],
  copy_newest: ["shift+g"],
  copy_half_up: ["ctrl+u"],
  copy_half_down: ["ctrl+d"],
  copy_older: ["n"],
  copy_newer: ["shift+n"],
  copy_label: ["1..9"],
} as const;

export type CopyAction = keyof typeof COPY_KEYS;
