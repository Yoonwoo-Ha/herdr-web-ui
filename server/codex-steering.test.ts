import { describe, expect, it } from "bun:test";
import { codexSteeringPending, interruptCodexSteering, type CodexSteeringContext } from "./codex-steering.ts";

const hint = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const frame = (header = hint, composer = "› Ask Codex to do anything") => `› earlier input\n• Working (2s • esc to interrupt)\n• ${header}\n  ↳ send this now\n${composer}\n  gpt-6.1 default · /workspace\n`;
const working: CodexSteeringContext = { agent: "codex", working: true, screen: frame() };

describe("Codex's live steering buffer", () => {
  it("recognizes the native pending-steering panel beside an empty composer", () => {
    expect(codexSteeringPending(frame(), "send this now")).toBe(true);
    expect(codexSteeringPending(frame(hint, "›"), "send this now")).toBe(true);
  });

  it("recognizes a narrow pane's wrapped native hint", () => {
    expect(codexSteeringPending(frame("Messages to be submitted after next tool\ncall (press esc to interrupt and send\nimmediately)"), "send this now")).toBe(true);
  });

  for (const elapsed of ["1m 12s", "1h 2m 3s", "2m"]) it(`recognizes a working turn lasting ${elapsed}`, () => {
    expect(codexSteeringPending(frame().replace("2s • esc", `${elapsed} • esc`), "send this now")).toBe(true);
  });

  for (const [name, screen] of [
    ["quoted hint", `› explain this\n${hint}\n• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["old panel above a newer turn", `${frame()}\n• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["native next-turn queue", frame("Queued follow-up inputs")],
    ["nonempty composer", frame(hint, "› unsent user draft")],
    ["missing pending message", frame().replace("  ↳ send this now\n", "")],
    ["no native working status", frame().replace("• Working (2s • esc to interrupt)\n", "")],
    ["another open UI after the composer", `${frame()}Select Model and Effort\nenter select · esc back\n`],
  ]) it(`does not authorize Escape from ${name}`, () => {
    expect(codexSteeringPending(screen!, "send this now")).toBe(false);
  });
  // Codex 0.162.1, read from a live pane: the shortcuts hint under the composer, a wrapped entry,
  // a multi-line one, and a long one cut with a "…" row
  const live = (entries: string) => `› first task\n• Working (13s • esc to interrupt)\n• ${hint}\n${entries}› Ask Codex to do anything\n  gpt-5.1 default · /tmp/work · ⠇\n  ← for agents · ? for shortcuts                                    ⚠ 1 warning · f2 to view\n`;
  const long = `LLLL ${Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ")}`;

  it("recognizes Codex 0.162's panel above its shortcuts hint", () => {
    expect(codexSteeringPending(live("  ↳ send this now\n"), "send this now")).toBe(true);
  });

  it("matches the submitted message however Codex wrapped or cut it", () => {
    expect(codexSteeringPending(live("  ↳ older entry\n  ↳ second message that wraps around\n    the narrow pane\n"), "second message that wraps around the narrow pane")).toBe(true);
    expect(codexSteeringPending(live("  ↳ line one\n    line two\n"), "line one\nline two")).toBe(true);
    expect(codexSteeringPending(live(`  ↳ LLLL w0 w1 w2\n    w3 w4 w5\n    …\n`), long)).toBe(true);
  });

  it("reads a message whose own second line starts with the arrow", () => {
    // Codex indents continuation rows two deeper than the entry's arrow; an arrow there is text
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "explain\n↳ send this now")).toBe(true);
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "send this now")).toBe(false);
  });

  it("compares only the steering section's last entry, not a later section's", () => {
    const sections = "  ↳ older steer\n• Messages to be submitted at end of turn\n  ↳ send this now\n";
    expect(codexSteeringPending(live(sections), "send this now")).toBe(false);
    expect(codexSteeringPending(live("  ↳ send this now\n• Messages to be submitted at end of turn\n  ↳ queued for later\n"), "send this now")).toBe(true);
  });

  it("takes a trailing ellipsis for a cut only on its own row", () => {
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait for tests")).toBe(false);
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait…")).toBe(true);
    expect(codexSteeringPending(live("  ↳ …\n"), "anything")).toBe(false);
  });

  for (const [name, entries, text] of [
    ["an entry that was already waiting", "  ↳ older entry\n", "send this now"],
    ["an older entry above the newest one", "  ↳ send this now\n  ↳ typed in the terminal\n", "send this now"],
    ["a cut entry of another message", "  ↳ LLLL w0 w1 w9\n    …\n", long],
    ["an empty message", "  ↳ older entry\n", " "],
  ]) it(`does not take ${name} for the submitted message`, () => {
    expect(codexSteeringPending(live(entries!), text!)).toBe(false);
    // and without the shortcuts hint, as Codex 0.161 drew it
    expect(codexSteeringPending(live(entries!).replace(/\n.*for shortcuts.*\n$/, "\n"), text!)).toBe(false);
  });
});

function fixture(contexts: CodexSteeringContext[] = [working]) {
  let now = 0; let reads = 0;
  const effects: string[] = [];
  const io = {
    read: async () => contexts[Math.min(reads++, contexts.length - 1)]!,
    escape: async (fresh: () => boolean) => { effects.push(fresh() ? "Escape" : "Escape withheld"); },
    restarting: () => { effects.push("restart gate"); },
    now: () => now,
    wait: async (ms: number) => { now += ms; },
  };
  return { io, effects, elapsed: () => now, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe("explicit Codex Send now", () => {
  it("arms the restart gate before one Escape on a freshly checked native panel", async () => {
    const f = fixture(); await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
    expect(f.reads()).toBe(1);
  });

  for (const [name, explicit, context] of [
    ["ordinary Send racing with work", false, working],
    ["idle Codex", true, { ...working, working: false }],
    ["another working agent", true, { ...working, agent: "claude" }],
  ] as const) it(`never interrupts ${name}`, async () => {
    const f = fixture(); await interruptCodexSteering(explicit, "send this now", context, f.io);
    expect(f.effects).toEqual([]); expect(f.reads()).toBe(0);
  });

  it("waits for the native panel instead of appending Escape blindly", async () => {
    const f = fixture([{ ...working, screen: "• Working (2s • esc to interrupt)\n› send this now\n" }, working]);
    await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.reads()).toBe(2); expect(f.elapsed()).toBeGreaterThan(0);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
  });

  it("does not interrupt a turn that already finished after Enter", async () => {
    const f = fixture([{ ...working, working: false }]);
    await interruptCodexSteering(true, "send this now", working, f.io); expect(f.effects).toEqual([]);
  });

  for (const cause of ["disconnected", "read_only", "agent_blocked", "pending_target_changed", "input_not_ready"]) it(`keeps additional input cancelled after ${cause}`, async () => {
    const f = fixture(); f.io.read = async () => { throw new Error(cause); };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow(cause);
    expect(f.effects).toEqual([]);
  });

  it("does not claim success for working Codex without a recognized pending panel", async () => {
    const f = fixture([{ ...working, screen: frame("Queued follow-up inputs") }]);
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]); expect(f.elapsed()).toBeLessThanOrEqual(1500);
  });

  it("hands the key write a freshness check that fails once the deadline has passed", async () => {
    const f = fixture(); f.io.escape = async (fresh) => { f.advance(1600); f.effects.push(fresh() ? "Escape" : "Escape withheld"); };
    await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape withheld"]);
  });

  it("checks the deadline again after a slow screen read before sending Escape", async () => {
    const f = fixture(); f.io.read = async () => { f.advance(1501); return working; };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });
});
