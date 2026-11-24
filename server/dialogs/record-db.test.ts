import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withRecord } from "./record.ts";
import { parseFallbackPrompt } from "./fallback.ts";
import { parseInteractivePrompt } from "../prompt.ts";
import { parsedByPublicPrompt, type ParsedPrompt } from "./shared.ts";
import { agyRecord, type AgyPendingStep } from "./agy-record.ts";
import { hermesRecord, type HermesMessage } from "./hermes-record.ts";

/**
 * Real approvals recorded from Antigravity CLI 1.5.15 (its own login) and Hermes 0.21.5's classic CLI in an isolated
 * herdr-core (server/fixtures/record-cards/<agent>.json): the screen when the dialog was answered, the rows the
 * agent's database held then and after the answer, and the command that ran (strace), or the one refused. Antigravity
 * hides a heredoc's last lines ("⋯ (2 lines hidden)"), so that card stays the screen's.
 */
interface Turn<Rows> { turn: string; decision: "allow" | "deny"; screen: string; record: Rows; after: Rows; command: string }
const fixture = <Rows>(agent: string): Turn<Rows>[] =>
  JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/record-cards", `${agent}.json`), "utf8")).turns;

describe("agy's record", () => {
  const steps = (rows: { idx: number; payload: string }[]): AgyPendingStep[] => rows.map(({ idx, payload }) => ({ idx, payload: Buffer.from(payload, "base64") }));
  test.each(fixture<{ idx: number; payload: string }[]>("agy").map((turn) => [turn.turn, turn] as const))("%s", (_name, turn) => {
    const request = agyRecord.pending(steps(turn.record));
    expect(request?.command).toBe(turn.command);
    expect(agyRecord.pending(steps(turn.after))).toBeNull();
    const card = parsedByPublicPrompt.get(parseFallbackPrompt("agy", turn.screen))!;
    const shown = withRecord(card, request, turn.screen, agyRecord);
    if (turn.turn === "multi-a1") return expect(shown).toBe(card);
    expect([shown.record?.command, shown.optionSteps]).toEqual([turn.command, card.optionSteps]);
    expect(shown.body).toContain(turn.command);
  });

  test("bytes that are no permission request name no command, and leave no other step the only one waiting", () => {
    const [waiting] = steps(fixture<{ idx: number; payload: string }[]>("agy")[0]!.record);
    expect(agyRecord.pending([{ idx: 4, payload: new Uint8Array([0xff, 0xff]) }])).toBeNull();
    expect(agyRecord.pending([{ idx: 4, payload: new Uint8Array() }])).toBeNull();
    expect(agyRecord.pending([waiting!, { idx: 9, payload: new Uint8Array() }])).toBeNull();
  });
});

describe("hermes's record", () => {
  test("a call or row that does not read leaves no other call the only one open", () => {
    const call = (id: string, command: string) => ({ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command }) } });
    const ask = (...calls: unknown[]): HermesMessage => ({ role: "assistant", tool_calls: JSON.stringify(calls), tool_call_id: null });
    expect(hermesRecord.pending([ask(call("a", "ls"))])).toEqual({ id: "a", command: "ls" });
    expect(hermesRecord.pending([ask(call("a", "ls"), { id: "b", type: "function", function: { name: "terminal", arguments: "{" } })])).toBeNull();
    expect(hermesRecord.pending([ask(call("a", "ls")), { role: "assistant", tool_calls: "[{", tool_call_id: null }])).toBeNull();
    expect(hermesRecord.pending([ask(call("a", "ls")), { role: "tool", tool_calls: null, tool_call_id: "a" }])).toBeNull();
  });

  test.each(fixture<HermesMessage[]>("hermes").map((turn) => [turn.turn, turn] as const))("%s", (_name, turn) => {
    const request = hermesRecord.pending(turn.record);
    expect(request?.command).toBe(turn.command);
    if (turn.decision === "allow") expect(hermesRecord.pending(turn.after)).toBeNull();
    const drawn = parseInteractivePrompt("hermes", turn.screen);
    // a newline in the command breaks the panel's box: no card, the terminal answers it (dialogs/hermes.ts)
    if (turn.turn === "multi-a1") return expect(drawn).toBeNull();
    const card = parsedByPublicPrompt.get(drawn!) as ParsedPrompt;
    expect(card.responder).toBe("hermes-approval");
    const shown = withRecord(card, request, turn.screen, hermesRecord);
    // the panels the recording forced (a plugin's rule) show the command as their description, not in its own rows:
    // only Hermes's own dangerous-command panel, which draws it, gets it from the record
    if (!turn.turn.startsWith("danger")) return expect(shown).toBe(card);
    expect([shown.record?.command, shown.body, shown.optionSteps, shown.selectedIndex]).toEqual([turn.command, turn.command, card.optionSteps, card.selectedIndex]);
  });
});
