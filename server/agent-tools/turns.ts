import type { AcpChild, AcpChildren } from "../acp/children.ts";
import { KeeperRequestError } from "../acp/client.ts";
import type { Ledger, ToolChild } from "./ledger.ts";
import { HARNESS_LIMITS, answer, harnessStopReason, refuse } from "../../shared/harness-tool.ts";
import type { SessionRef, SessionState, Untrusted } from "../../shared/harness-contract.generated.ts";

export function untrusted(from: string, text: string): Untrusted {
  const bytes = Buffer.from(text);
  return { untrusted: true as const, from, text: bytes.subarray(0, 65536).toString("utf8"), ...(bytes.length > 65536 ? { truncated: true as const } : {}) };
}
export const childRef = (row: ToolChild, child: AcpChild): SessionRef => ({ address: row.terminal, drive: "acp", machine: "local", harness: row.harness, agent_session_id: child.client.session, parent: row.parent, started_by: "agent" });
export function childState(child: AcpChild, row?: ToolChild): SessionState {
  const { client } = child;
  const turn = row?.turns.at(-1)?.n ?? null;
  if (client.agentGone || client.keeperGone) return { state: "gone", turn };
  if (client.pending().length) return { state: "waiting_human", turn, on: "approval" };
  return { state: !client.connected || client.turn?.running ? "working" : client.turn ? "done" : "idle", turn };
}
export class ChildTurns {
  private readonly watches = new Map<AcpChild, () => void>();
  private readonly closing = new AbortController();
  constructor(private readonly ledger: Ledger, private readonly acp: AcpChildren, private readonly now: () => number) {}
  close(): void { this.closing.abort(); for (const off of this.watches.values()) off(); this.watches.clear(); }
  forget(child: AcpChild): void { this.watches.get(child)?.(); this.watches.delete(child); }
  watch(child: AcpChild): void {
    if (this.watches.has(child)) return;
    const change = () => {
      const row = this.ledger.children.get(child.terminal);
      const turn = row?.turns.at(-1);
      const client = child.client;
      if (row && row.id === child.id && client.connected && row.held !== (client.holdGeneration !== null)) {
        row.held = client.holdGeneration !== null;
        this.ledger.save();
      }
      if (!row || row.id !== child.id || !turn || turn.end !== null || turn.seq === null || turn.seq !== client.turnSequence || !client.connected || !client.turn || client.turn.running) return;
      turn.end = harnessStopReason(client.turn.stopReason ?? (client.agentGone ? "gone" : "unknown"));
      this.ledger.audit(row, "turn", turn.n, turn.end);
      this.ledger.save();
    };
    this.watches.set(child, child.client.onChange(change));
    change();
  }
  async send(child: AcpChild, row: ToolChild, args: Record<string, unknown>, expectedMode: string) {
    const key = typeof args.key === "string" ? args.key : null;
    const accepted = (n: number, duplicate: boolean) => answer("accepted", { session: row.terminal, accepted: true, turn_id: `${row.id}.${n}`, key, duplicate });
    if (row.held || child.client.terminalReady) return refuse("taken_over", "A person holds this child.");
    if (child.client.pending().length) return refuse("waiting_human", "A person must answer the child's card.");
    const duplicate = key && row.turns.find(t => t.key === key);
    if (duplicate) return duplicate.seq === null ? refuse("unavailable", "Delivery of the original prompt is unconfirmed.") : accepted(duplicate.n, true);
    if (this.now() - row.created >= HARNESS_LIMITS.child_minutes * 60_000) {
      await this.acp.markTimeLimit(child.id);
      return refuse("time_limit", "This child no longer takes new work.");
    }
    if (child.client.status !== "idle" && child.client.status !== "done") return refuse("busy", "This child is not ready for a new prompt.");
    const n = (row.turns.at(-1)?.n ?? 0) + 1;
    const turn: ToolChild["turns"][number] = { key, n, seq: null, end: null };
    row.turns.push(turn);
    this.ledger.save();
    try { await child.client.submit(String(args.task), expectedMode); }
    catch (error) {
      if (error instanceof KeeperRequestError && [-32004,-32002,-32005].includes(error.code)) {
        row.turns = row.turns.filter(t => t !== turn);
        this.ledger.save();
      }
      if (error instanceof KeeperRequestError && error.code === -32005) return refuse("busy", "A turn or decision is already pending.");
      if (error instanceof KeeperRequestError && error.code === -32004) return refuse("not_granted", "Child permission mode changed.");
      return refuse(child.client.terminalReady ? "taken_over" : "unavailable", "Delivery could not be confirmed. Do not repeat without checking.");
    }
    turn.seq = child.client.turnSequence;
    this.ledger.save();
    this.ledger.audit(row, "send", n);
    this.forget(child); this.watch(child);
    return accepted(n, false);
  }
  async wait(child: AcpChild, row: ToolChild, ms: number, signal: AbortSignal) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => { if (row.held || child.client.terminalReady || childState(child, row).state !== "working") resolve(); };
    const off = child.client.onChange(check);
    const timer = setTimeout(resolve, ms);
    const close = () => resolve();
    const end = AbortSignal.any([signal, this.closing.signal]);
    end.addEventListener("abort", close, { once: true });
    try { if (end.aborted) close(); else check(); await promise; }
    finally { off(); clearTimeout(timer); end.removeEventListener("abort", close); }
    return row.held || child.client.terminalReady ? refuse("taken_over", "A person holds this child.") : answer("state", { session: row.terminal, state: childState(child, row) });
  }
  result(child: AcpChild, row: ToolChild, id: unknown) {
    if (child.client.status === "unknown") return refuse("taken_over", "ACP does not own this conversation.");
    const state = childState(child, row);
    const turn = id === undefined ? row.turns.at(-1) : row.turns.find(t => `${row.id}.${t.n}` === id);
    if (id !== undefined && !turn) return refuse("unknown_session", "Unknown turn.");
    if (!turn || state.state === "waiting_human" || turn.end === null || !child.client.connected) return answer("state", { session: row.terminal, state });
    const latest = turn.seq === child.client.turnSequence ? child.client.turn : null;
    return answer("result", { session: row.terminal, turn_id: `${row.id}.${turn.n}`, stop_reason: harnessStopReason(turn.end), end_from: "acp", answer_from: latest ? "acp" : null,
      final_message: latest?.text ? untrusted(row.terminal, latest.text) : null, error: latest?.error ? untrusted(row.terminal, latest.error) : null, usage: latest ? child.client.usage : null,
      model: latest && child.client.model && /^[\w.:-]+(?:\/[\w.:-]+)*$/.test(child.client.model) ? child.client.model : null });
  }
}
