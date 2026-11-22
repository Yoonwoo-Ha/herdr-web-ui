import { describe, expect, it } from "bun:test";
import { emptyProbe, PROBE_QUERY, type Reply, ReplyFilter, themeOf, withReply } from "./probe.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const ESC = "\x1b";
const ST = `${ESC}\\`;
const reply = (kind: Reply["kind"], data: string): Reply => ({ type: "reply", kind, data });

describe("the start probe's question", () => {
  it("asks for kitty flags, DECRQM 2026, OSC 10, 11 and 12, the cell size, then DA1 last", () => {
    expect(PROBE_QUERY).toBe(`${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`);
  });
});

describe("the probe's result", () => {
  it("collects the replies and reads light or dark from the background", () => {
    let result = emptyProbe();
    for (const each of [
      reply("kittyFlags", "1"), reply("mode", "2026;2"), reply("color", "10;rgb:0/0/0"), reply("color", "11;rgb:fafa/fafa/f0f0"),
      reply("color", "12;#010203"), reply("cellSize", "18;9"), reply("deviceAttributes", "62;22"),
    ]) result = withReply(result, each);
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [0, 0, 0], background: [250, 250, 240], cursorColor: [1, 2, 3],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "light",
    });
  });

  it("reads 1 to 4 hex digits a channel, and a colour it cannot read as none", () => {
    expect(withReply(emptyProbe(), reply("color", "11;rgb:ffff/0000/8080")).background).toEqual([255, 0, 128]);
    expect(withReply(emptyProbe(), reply("color", "10;rgb:f/0/8")).foreground).toEqual([255, 0, 136]);
    expect(withReply(emptyProbe(), reply("color", "11;nonsense"))).toMatchObject({ background: null, theme: null });
  });

  it("reads DECRQM 0 and 4 as no synchronized output, and another mode as nothing", () => {
    expect(withReply(emptyProbe(), reply("mode", "2026;0")).syncOutput).toBe(false);
    expect(withReply(emptyProbe(), reply("mode", "2026;4")).syncOutput).toBe(false);
    expect(withReply(emptyProbe(), reply("mode", "2026;1")).syncOutput).toBe(true);
    expect(withReply(emptyProbe(), reply("mode", "1004;1")).syncOutput).toBeNull();
  });

  it("calls a dark background dark and a light one light", () => {
    expect(themeOf([0, 0, 0])).toBe("dark");
    expect(themeOf([40, 44, 52])).toBe("dark");
    expect(themeOf([255, 255, 255])).toBe("light");
    expect(themeOf([253, 246, 227])).toBe("light");
    expect(themeOf(null)).toBeNull();
  });
});

describe("ReplyFilter", () => {
  const DA1 = `${ESC}[?62;22c`;

  it("keeps the replies, passes what is no reply, and hands back what follows the DA1 reply", () => {
    const filter = new ReplyFilter();
    const taken = filter.feed(bytes(`typed${ESC}[?1u${ESC}]11;rgb:0/0/0${ST}${ESC}[A${DA1}after${ESC}[?1u`), 0);
    expect(text(taken.input)).toBe(`typed${ESC}[A`);
    expect(taken.replies.map((each) => each.kind)).toEqual(["kittyFlags", "color", "deviceAttributes"]);
    expect(text(taken.rest!)).toBe(`after${ESC}[?1u`);
  });

  it("holds an unfinished sequence however many reads it takes, and keeps it when it ends as a reply", () => {
    const filter = new ReplyFilter();
    for (const read of [ESC, "]", "1", "1;rgb:ff", "ff/ffff/ffff", ESC]) expect(filter.feed(bytes(read), 0).input.length).toBe(0);
    expect(filter.feed(bytes("\\"), 0).replies).toEqual([reply("color", "11;rgb:ffff/ffff/ffff")]);
    expect(filter.holding).toBe(0);
  });

  it("lets a held sequence go whole when its wait ends: ESC_WAIT_SLOW_MS for ESC, `ESC [` and `ESC O`, SEQUENCE_DROP_MS for a longer one", () => {
    for (const [held, wait] of [[ESC, 150], [`${ESC}[`, 150], [`${ESC}O`, 150], [`${ESC}[6;`, 500], [`${ESC}]11;`, 500]] as const) {
      const filter = new ReplyFilter();
      filter.feed(bytes(held), 1000);
      expect([held, filter.deadline()]).toEqual([held, 1000 + wait]);
      expect(filter.expire(999 + wait).length).toBe(0);
      expect(text(filter.expire(1000 + wait))).toBe(held);
      expect(filter.deadline()).toBeUndefined();
    }
  });

  it("times a longer held sequence from its first byte", () => {
    const filter = new ReplyFilter();
    filter.feed(bytes(ESC), 0);
    filter.feed(bytes("[6;"), 100);
    expect(filter.deadline()).toBe(500);
  });

  it("holds at most SEQUENCE_LIMIT_BYTES of an endless sequence and streams the rest", () => {
    const filter = new ReplyFilter();
    let out = text(filter.feed(bytes(`${ESC}[`), 0).input);
    const chunk = bytes("1".repeat(65536));
    for (let i = 0; i < 16; i++) {
      out += text(filter.feed(chunk, 0).input);
      expect(filter.holding).toBeLessThanOrEqual(4096);
    }
    out += text(filter.feed(bytes("m"), 0).input);
    expect(out).toBe(`${ESC}[${"1".repeat(16 * 65536)}m`);
  });

  it("gives back a broken OSC whole when an ESC that does not end it comes, and goes on from that ESC", () => {
    const filter = new ReplyFilter();
    const taken = filter.feed(bytes(`${ESC}]11;rgb${ESC}[A`), 0);
    expect(text(taken.input)).toBe(`${ESC}]11;rgb${ESC}[A`);
  });

  it("never reads a bracketed paste's text for replies", () => {
    const filter = new ReplyFilter();
    const taken = filter.feed(bytes(`${ESC}[200~${DA1}${ESC}[?1u${ESC}[201~${ESC}[?1u`), 0);
    expect(text(taken.input)).toBe(`${ESC}[200~${DA1}${ESC}[?1u${ESC}[201~`);
    expect(taken.replies).toEqual([reply("kittyFlags", "1")]);
  });
});
