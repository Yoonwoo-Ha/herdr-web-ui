/**
 * A stand-in for the screen's entry on a pseudo-terminal, for `with-core.ts --pty --keys`:
 *
 *   bun tui/testing/probe-echo.ts
 *
 * It enters the real host (tui/host/unix.ts) the way the entry does: enter, listen, run the start
 * probe, then draw a frame, bracketed by `CSI ?2026h` and `CSI ?2026l` only when the host answered
 * DECRQM 2026 (as the painter does). It reports `SYNC true|false`, then one `EVENT` line for each
 * input event the framer makes of what it reads (`EVENT text <text>`, `EVENT key <mods+>KEY`, else
 * `EVENT <type>`). ctrl+b makes it leave and end with 0. Not a terminal: one line on stderr, exit 3.
 */
import { createUnixHost } from "../host/unix.ts";
import type { InputEvent } from "../input/decode.ts";
import { Framer } from "../input/framer.ts";

const ESC = "\x1b";
const host = createUnixHost();
const framer = new Framer();
const say = (line: string) => host.write(`${line}\r\n`);

function describe(event: InputEvent): string {
  if (event.type === "text") return `text ${event.text}`;
  if (event.type !== "key") return event.type;
  const mods = (["ctrl", "alt", "shift", "super"] as const).filter((mod) => event.mods[mod]);
  return `key ${[...mods, event.key].join("+")}`;
}

if (!host.enter()) {
  process.stderr.write("probe-echo: not a terminal\n");
  process.exit(3);
}
framer.setModes({ mouse: true, kitty: true });
host.onInput((bytes) => {
  for (const event of framer.feed(bytes, performance.now())) {
    say(`EVENT ${describe(event)}`);
    if (event.type === "key" && event.key === "B" && event.mods.ctrl) host.leave();
  }
});
const { syncOutput } = await host.probe();
const frame = `SYNC ${syncOutput === true}\r\n`;
host.write(syncOutput ? `${ESC}[?2026h${frame}${ESC}[?2026l` : frame);
