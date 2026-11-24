/**
 * One item of a `--keys` list (tui/testing/run.ts, tui/testing/with-core.ts) as the bytes a terminal sends for it:
 * `enter`, `tab`, `esc`, `space`, `backspace`, `up`, `down`, `left`, `right` and `ctrl+<letter>` are keys; a mouse
 * report is `[shift+]<what>@<col>:<row>` in 0-based screen cells, sent as SGR (mode 1006), where <what> is `press`,
 * `drag` (a motion with the left button held), `release`, `click` (press and release), `rclick` (the right button's
 * press and release), `move` (a motion with no button held), `wheelup` or `wheeldown`;
 * anything else is typed as written.
 */

const KEYS: Record<string, string> = {
  enter: "\r", tab: "\t", esc: "\x1b", space: " ", backspace: "\x7f", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
};

/** the SGR button number of each mouse item, and whether it ends with `m` (a release) */
const MOUSE: Record<string, [button: number, release: boolean][]> = {
  press: [[0, false]], drag: [[32, false]], release: [[0, true]], click: [[0, false], [0, true]], rclick: [[2, false], [2, true]], move: [[35, false]],
  wheelup: [[64, false]], wheeldown: [[65, false]],
};

const SHIFT = 4;

export function keyBytes(item: string): string {
  const named = KEYS[item];
  if (named !== undefined) return named;
  const ctrl = /^ctrl\+([a-z])$/.exec(item);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  const mouse = /^(shift\+)?(press|drag|release|click|rclick|move|wheelup|wheeldown)@(\d{1,4}):(\d{1,4})$/.exec(item);
  if (mouse) {
    const [, shift, what, col, row] = mouse;
    return MOUSE[what!]!.map(([button, release]) => `\x1b[<${button + (shift ? SHIFT : 0)};${Number(col) + 1};${Number(row) + 1}${release ? "m" : "M"}`).join("");
  }
  return item;
}
