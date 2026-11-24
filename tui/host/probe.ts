import { decodeCsi, decodeString, type Unstamped } from "../input/decode.ts";
import { ESC_WAIT_SLOW_MS, SEQUENCE_DROP_MS, SEQUENCE_LIMIT_BYTES } from "../model/deadlines.ts";
import type { Display } from "../../server/herdr-core/hc-api.generated.ts";
import type { ProbeResult, Rgb } from "./index.ts";

/**
 * The start probe's question, written once after enter: kitty keyboard flags, DECRQM 2026, the
 * foreground, background and cursor colours, the cell size in pixels, then DA1, which every
 * terminal answers and which therefore ends the probe. Never `CSI 6n`: its reply for row 1 reads
 * like a modified F3.
 */
export const DISPLAY_QUERY = "\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[16t";
export const PROBE_QUERY = `\x1b[?u\x1b[?2026$p${DISPLAY_QUERY}\x1b[c`;

/** A reply to the probe, as tui/input/decode.ts recognises its shape (the one place that knows them). */
export type Reply = Extract<Unstamped, { type: "reply" }>;

/** `rgb:R/G/B` with 1 to 4 hex digits a channel, or `#rrggbb`, as 0-255 values. */
function parseColor(text: string): Rgb | null {
  const hash = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text);
  if (hash) return [parseInt(hash[1]!, 16), parseInt(hash[2]!, 16), parseInt(hash[3]!, 16)];
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(text);
  if (!rgb) return null;
  const channel = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)];
}

const hex = (rgb: Rgb): string => "#" + rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("");

/** Send only what the host reported, using the core's RGB and pixel formats. */
export function displayFacts(probe: ProbeResult): Display | undefined {
  const { foreground, background, cursorColor, cellPixels } = probe;
  if (!foreground && !background && !cursorColor && !cellPixels) return undefined;
  return {
    ...(foreground && { fg: hex(foreground) }),
    ...(background && { bg: hex(background) }),
    ...(cursorColor && { cursor: hex(cursorColor) }),
    ...(cellPixels && { cell: [cellPixels.width, cellPixels.height] }),
  };
}

/** A later reply refreshes one reported fact, leaving the other known facts alone. */
export function displayAfter(display: Display | undefined, reply: Reply): Display | undefined {
  const changed = displayFacts(withReply(emptyProbe(), reply));
  return changed ? { ...display, ...changed } : display;
}

/** Light when the background's relative luminance is above one half. */
export function themeOf(background: Rgb | null): "light" | "dark" | null {
  if (!background) return null;
  const [r, g, b] = background;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? "light" : "dark";
}

export function emptyProbe(): ProbeResult {
  return { answered: false, kittyFlags: null, syncOutput: null, foreground: null, background: null, cursorColor: null, cellPixels: null, deviceAttributes: null, theme: null };
}

const numbers = (data: string) => (data === "" ? [] : data.split(";").map(Number));

export function withReply(result: ProbeResult, reply: Reply): ProbeResult {
  switch (reply.kind) {
    case "kittyFlags": return { ...result, kittyFlags: Number(reply.data) };
    case "mode": {
      const [mode, value] = numbers(reply.data);
      return mode === 2026 ? { ...result, syncOutput: value !== 0 && value !== 4 } : result;
    }
    case "color": {
      const which = reply.data.slice(0, 2);
      const rgb = parseColor(reply.data.slice(3));
      if (which === "10") return { ...result, foreground: rgb };
      if (which === "12") return { ...result, cursorColor: rgb };
      return { ...result, background: rgb, theme: themeOf(rgb) };
    }
    case "cellSize": {
      const [height, width] = numbers(reply.data);
      if (!width || !height || width > 1000 || height > 1000) return result;
      return { ...result, cellPixels: { width, height } };
    }
    case "deviceAttributes": return { ...result, answered: true, deviceAttributes: numbers(reply.data) };
    case "scheme": case "timeout": return result;
  }
}

const ESC = 0x1b;
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
const latin1 = (bytes: number[]) => String.fromCharCode(...bytes);

type State = "ground" | "esc" | "csi" | "osc" | "ss3" | "trail" | "pass" | "paste";

/**
 * Keeps the probe's replies out of what stdin delivers, whatever the read boundaries, and nothing
 * else. It works on whole escape sequences, the same way while the probe waits and after its limit:
 * - a byte that cannot start a reply passes at once;
 * - an unfinished sequence is held across any number of reads until it ends, or until its wait ends:
 *   ESC_WAIT_SLOW_MS for a lone ESC, `ESC [` or `ESC O` (the framer's own wait with the mouse and the
 *   kitty flag on, which `enter` turns on), SEQUENCE_DROP_MS after the first byte for a longer one;
 * - a finished sequence with a probe reply's shape stays here; any other (a key, a mouse report, a
 *   paste mark) goes out whole, and so does a held one whose wait ended;
 * - at most SEQUENCE_LIMIT_BYTES are held: a longer sequence is no reply and streams out as it comes.
 * A bracketed paste's text is never read for replies. After the DA1 reply the filter is done: what
 * follows in that read comes back as `rest`, untouched.
 */
export class ReplyFilter {
  private state: State = "ground";
  private held: number[] = [];
  private heldAt = 0;
  private trailLeft = 0;
  private pasteMatched = 0;

  get holding(): number {
    return this.held.length;
  }

  /** When the held sequence must be let go (`expire`); undefined when nothing is held. */
  deadline(): number | undefined {
    if (this.held.length === 0) return undefined;
    const short = this.held.length === 1 || (this.held.length === 2 && (this.held[1] === 0x5b || this.held[1] === 0x4f));
    return this.heldAt + (short ? ESC_WAIT_SLOW_MS : SEQUENCE_DROP_MS);
  }

  /** The held sequence, whole, once its wait has ended by `now`; empty otherwise. */
  expire(now: number): Uint8Array {
    const due = this.deadline();
    if (due === undefined || now < due) return new Uint8Array(0);
    const out = Uint8Array.from(this.held);
    this.held = [];
    this.state = "ground";
    return out;
  }

  feed(bytes: Uint8Array, now: number, passDisplay = false): { input: Uint8Array; replies: Reply[]; rest: Uint8Array | null } {
    const out: number[] = [];
    const replies: Reply[] = [];
    const release = () => { for (const byte of this.held) out.push(byte); this.held = []; };
    const hold = (byte: number) => {
      if (this.held.length === 0) this.heldAt = now;
      this.held.push(byte);
      if (this.held.length > SEQUENCE_LIMIT_BYTES) { release(); this.state = "pass"; }
    };
    /** a finished CSI or OSC: kept when it has a reply's shape, else out whole */
    const finish = (event: Unstamped | undefined) => {
      if (event?.type === "reply" && !(passDisplay && (event.kind === "color" || event.kind === "cellSize"))) {
        replies.push(event);
        this.held = [];
      } else release();
      this.state = "ground";
      return event?.type === "reply" && event.kind === "deviceAttributes";
    };

    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      switch (this.state) {
        case "ground":
          if (byte === ESC) { this.state = "esc"; hold(byte); } else out.push(byte);
          break;
        case "esc":
          if (byte === 0x5b) { this.state = "csi"; hold(byte); } else if (byte === 0x5d) { this.state = "osc"; hold(byte); } else if (byte === 0x4f) { this.state = "ss3"; hold(byte); } else if (byte === ESC) {
            release();
            this.state = "esc";
            hold(byte);
          } else { hold(byte); release(); this.state = "ground"; }
          break;
        case "ss3":
          if (byte >= 0x40 && byte <= 0x7e) { hold(byte); release(); this.state = "ground"; } else { release(); this.state = "ground"; i--; }
          break;
        case "csi": {
          const body = latin1(this.held.slice(2));
          // rxvt ends a shifted `CSI n ~` key with `$`, which ECMA-48 counts as an intermediate byte
          if (byte === 0x24 && /^\d+$/.test(body)) { hold(byte); release(); this.state = "ground"; break; }
          if (byte >= 0x20 && byte <= 0x3f) { hold(byte); break; }
          if (byte < 0x40 || byte > 0x7e) { release(); this.state = "ground"; i--; break; }
          hold(byte);
          const final = String.fromCharCode(byte);
          if (body === "" && (final === "M" || final === "[")) { this.trailLeft = final === "M" ? 3 : 1; this.state = "trail"; break; }
          if (body === "200" && final === "~") { release(); this.state = "paste"; this.pasteMatched = 0; break; }
          if (finish(decodeCsi(body, final, true, false))) {
            return { input: Uint8Array.from(out), replies, rest: bytes.subarray(i + 1) };
          }
          break;
        }
        case "osc":
          if (this.held[this.held.length - 1] === ESC) {
            if (byte === 0x5c) {
              hold(byte);
              finish(decodeString("osc", latin1(this.held.slice(2, -2)), true));
            } else {
              this.held.pop();
              release();
              this.state = "esc";
              hold(ESC);
              i--;
            }
          } else if (byte === 0x07) {
            hold(byte);
            finish(decodeString("osc", latin1(this.held.slice(2, -1)), true));
          } else hold(byte);
          break;
        case "trail":
          hold(byte);
          if (--this.trailLeft === 0) { release(); this.state = "ground"; }
          break;
        case "pass":
          out.push(byte);
          if (byte >= 0x40 && byte <= 0x7e) this.state = "ground";
          break;
        case "paste":
          out.push(byte);
          this.pasteMatched = byte === PASTE_END[this.pasteMatched] ? this.pasteMatched + 1 : byte === ESC ? 1 : 0;
          if (this.pasteMatched === PASTE_END.length) this.state = "ground";
          break;
      }
    }
    return { input: Uint8Array.from(out), replies, rest: null };
  }
}
