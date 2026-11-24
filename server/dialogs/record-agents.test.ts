import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord } from "./record.ts";
import { commandCut, withRecord } from "./record.ts";
import { parseFallbackPrompt } from "./fallback.ts";
import { parsedByPublicPrompt } from "./shared.ts";
import { copilotRecord } from "./copilot-record.ts";
import { gjcRecord } from "./gjc-record.ts";
import { grokRecord } from "./grok-record.ts";
import { lettaRecord } from "./letta-record.ts";
import { museRecord } from "./muse-record.ts";

/**
 * Real approvals recorded from each CLI in an isolated herdr-core (server/fixtures/record-cards/<agent>.json): the
 * screen when the dialog was answered, the agent's record then and after the answer, and the command that ran
 * (strace), or the one refused. The card shows the record's command exactly where the dialog on the screen shows it
 * whole; where the dialog cuts it (Grok's "… Ctrl+F to expand", Letta's "… output clipped") or draws it otherwise (the
 * gjc hook recorded drops a command's backslashes), the card stays the screen's. Copilot writes its request some
 * 30-50 ms after it draws the dialog: its record is the one read when the answer was sent.
 */
interface Turn { turn: string; condition: string; decision: "allow" | "deny"; screen: string; record: string[]; after: string[]; command: string }

const AGENTS: { agent: string; record: AgentRecord; whole: string[] }[] = [
  { agent: "gjc", record: gjcRecord, whole: ["short-a1", "long-a1", "multi-a1", "phone-a1", "short-d"] },
  { agent: "grok", record: grokRecord, whole: ["short-a1", "long-a1", "quote-a1", "short-d"] },
  { agent: "copilot", record: copilotRecord, whole: ["short-a1", "long-a1", "multi-a1", "quote-a1", "phone-a1", "short-d"] },
  { agent: "letta", record: lettaRecord, whole: ["short-a1", "short-d"] },
  { agent: "muse", record: museRecord, whole: ["short-a1", "long-a1", "multi-a1", "quote-a1", "phone-a1", "short-d"] },
];

for (const { agent, record, whole } of AGENTS) {
  const { turns } = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/record-cards", `${agent}.json`), "utf8")) as { turns: Turn[] };

  describe(`${agent}'s record`, () => {
    test.each(turns.map((turn) => [turn.turn, turn] as const))("%s", (_name, turn) => {
      const request = record.pending(turn.record.join("\n"));
      expect(request?.command).toBe(turn.command);
      const card = parsedByPublicPrompt.get(parseFallbackPrompt(agent, turn.screen))!;
      const shown = withRecord(card, request, turn.screen, record);
      if (whole.includes(turn.turn)) {
        expect([shown.record?.command, shown.optionSteps, shown.selectedIndex]).toEqual([turn.command, card.optionSteps, card.selectedIndex]);
        expect(shown.body).toContain(turn.command);
      } else expect(shown).toBe(card);
      // Letta cuts a longer command's preview: that dialog gets no card, the terminal answers it
      expect(commandCut(turn.screen, record)).toBe(agent === "letta" && !whole.includes(turn.turn));
      if (turn.decision === "allow" && request !== null) expect(record.pending(turn.after.join("\n"))?.id).not.toBe(request.id);
    });
  });
}
