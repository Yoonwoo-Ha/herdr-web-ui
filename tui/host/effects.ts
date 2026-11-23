/**
 * What of a pane's program, and of the user's own copy, reaches the host terminal: OSC 52 clipboard writes under the
 * browser's size cap, and the bell. Only the focused pane's: the bell, a clipboard write, a title or a cursor shape of
 * any other pane leaves the host alone. Nothing here starts a clipboard helper; the host terminal does the copy.
 */
import { MAX_OSC52_BYTES } from "../../shared/osc52.ts";
import type { EngineEvents } from "../emulator/index.ts";

type EngineEffect = Parameters<NonNullable<EngineEvents["onEffect"]>>[0];

/** OSC 52 bytes for the host, or why there are none: nothing to copy, or more than MAX_OSC52_BYTES. */
export type Osc52 = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly code: "empty" | "too_large" };

/** `ESC ] 52 ; c ; <base64> ESC \\`: the host's one clipboard, whatever selection the program named. */
export function osc52(data: Uint8Array): Osc52 {
  if (data.length === 0) return { ok: false, code: "empty" };
  if (data.length > MAX_OSC52_BYTES) return { ok: false, code: "too_large" };
  return { ok: true, bytes: new TextEncoder().encode(`\x1b]52;c;${Buffer.from(data).toString("base64")}\x1b\\`) };
}

/** The bytes a program's effect writes to the host: the focused pane's bell and clipboard write; nothing for any other pane. */
export function effectBytes(effect: EngineEffect, focused: boolean): Uint8Array | null {
  if (!focused) return null;
  if (effect.type === "bell") return Uint8Array.of(0x07);
  const content = effect.contents.find((item) => item.mime.startsWith("text/plain")) ?? effect.contents[0];
  const write = content ? osc52(content.data) : null;
  return write?.ok ? write.bytes : null;
}
