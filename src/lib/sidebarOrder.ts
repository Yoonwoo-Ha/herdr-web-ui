/**
 * The sidebar's Activity order for the Agents list, and "seen" finishes.
 *
 * Activity keeps a waiting agent on top and then the latest change, so the latest work is where
 * you look. Recency is herdr's `state_change_seq`, one counter per herdr session bumped on every
 * agent state change. `session.snapshot` leaves it off `panes` and carries it on `agents`.
 *
 * herdr reports DONE until one of its own clients shows the pane, and the sidebar draws DONE as
 * "finished, not looked at yet". Opening the pane here does not tell herdr, so a finish read in
 * the web UI would keep its dot. "Seen" is kept per browser and per PC instead: the
 * `state_change_seq` each pane had when it was last on screen. A DONE whose counter has not moved
 * past that was looked at, and is drawn as ready.
 */
import type { AgentStatus, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { knownStatus } from "./status.ts";

/** pane id → the `state_change_seq` it had when last viewed */
export type SeenRecord = Readonly<Record<string, number>>;

/** Each agent pane's `state_change_seq`. Panes without an agent have none. */
export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/**
 * What `liveSeqs` remembers between snapshots: each pane's last status, the changes it dated
 * itself (`bumped`), and for each pane the last stand-in herdr's own counter replaced
 * (`promoted`, stand-in → counter), so a record made at the stand-in can follow it (`carrySeen`),
 * and herdr's own counter per pane at the last call (`real`).
 */
export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; promoted: Map<string, { from: number; to: number }>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), promoted: new Map(), real: new Map() });

/**
 * `stateSeqs`, kept in step with pushed statuses. A pane-status push lands in the snapshot at once
 * (applyPaneStatus), but the counter only comes with the next roster read, up to POLL_MS later: a
 * pane sent a message would sit in its old place, and a finish seen through that gap would count as
 * viewed at the old counter. So a status that changed since the last call is dated now, just above
 * every counter known; herdr's own counter for that change is higher and takes over when it comes,
 * and the swap is kept in `memory.promoted`. A change that arrives with a new counter of herdr's (a
 * roster read that saw it first) keeps that counter, so herdr's order between changes stands, and
 * drops the pane's earlier stand-in, which dated an older change. A counter that went back means
 * herdr restarted: every stand-in is dropped. Mutates `memory`.
 */
export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  if ([...seqs].some(([id, real]) => real < (memory.real.get(id) ?? real))) {
    memory.bumped.clear();
    memory.promoted.clear();
  }
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      else {
        // herdr's counter moved with the change: it dates it, and a stand-in from before is stale
        memory.bumped.delete(pane.pane_id);
        memory.promoted.delete(pane.pane_id);
      }
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  for (const [id, real] of seqs) memory.real.set(id, real);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) {
    for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
    for (const id of memory.promoted.keys()) if (!open.has(id)) memory.promoted.delete(id);
    for (const id of memory.real.keys()) if (!open.has(id)) memory.real.delete(id);
  }
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real !== undefined && real > bump) memory.promoted.set(id, { from: bump, to: real });
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

/**
 * A DONE pane looked at since it finished: its counter is still the one recorded. A pane with no
 * counter, or never recorded, was not; nor one whose record is above its counter, which herdr's
 * counter never goes below in one session, so the record is from an earlier one.
 */
export function isSeenDone(pane: Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>, seen: SeenRecord): boolean {
  if (knownStatus(pane.agent_status) !== "done") return false;
  const seq = seqs.get(pane.pane_id);
  const at = seen[pane.pane_id];
  return seq !== undefined && seq === at;
}

/** The status to draw: a DONE already looked at here reads as ready, as herdr's own idle after a view. */
export function shownStatus(pane: Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>, seen: SeenRecord | null): AgentStatus | undefined {
  return seen && isSeenDone(pane, seqs, seen) ? "idle" : pane.agent_status;
}

/** A first record: everything open now counts as looked at. Used the first time the setting is on in a browser, so the lists start quiet. */
export function seedSeen(panes: readonly Pick<PaneInfo, "pane_id">[], seqs: ReadonlyMap<string, number>): SeenRecord {
  const record: Record<string, number> = {};
  for (const pane of panes) {
    const seq = seqs.get(pane.pane_id);
    if (seq !== undefined) record[pane.pane_id] = seq;
  }
  return record;
}

/** The record with `paneId` seen at `seq`; the same object when nothing changes, so state does not churn. */
export function markSeen(record: SeenRecord, paneId: string, seq: number): SeenRecord {
  return record[paneId] === seq ? record : { ...record, [paneId]: seq };
}

/**
 * The record with each entry made at a stand-in counter moved onto the counter herdr gave that
 * change (`SeqMemory.promoted`); the same object when none was. Without it, a finish looked at
 * before the roster read brought its counter would read as not looked at once it did.
 */
export function carrySeen(record: SeenRecord, promoted: ReadonlyMap<string, { from: number; to: number }>): SeenRecord {
  let next: Record<string, number> | null = null;
  for (const [id, { from, to }] of promoted) if (record[id] === from) (next ??= { ...record })[id] = to;
  return next ?? record;
}

/**
 * What may be written to storage: herdr's own counters only. A look recorded at a stand-in
 * counter keeps the pane's last counter from `stored` (or nothing) until `carrySeen` has moved it
 * onto herdr's. A new page starts with no `SeqMemory.promoted`, so a stand-in read back from
 * storage could never be carried, and would leave the finish marked anyway; this way the
 * record on disk never holds a value herdr did not give.
 */
export function persistableSeen(record: SeenRecord, stored: SeenRecord | null): SeenRecord {
  if (Object.values(record).every(Number.isInteger)) return record;
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(record)) {
    if (Number.isInteger(at)) next[id] = at;
    else if (stored && Number.isInteger(stored[id])) next[id] = stored[id]!;
  }
  return next;
}

/**
 * The record without panes that closed, nor entries above the pane's live counter (`seqs`): herdr's
 * counter never goes below a look in one session, so such an entry is from before a restart that
 * kept the pane id. The same object when none went. An empty roster keeps it (herdr restarting).
 */
export function pruneSeen(record: SeenRecord, panes: readonly Pick<PaneInfo, "pane_id">[], seqs: ReadonlyMap<string, number> = new Map()): SeenRecord {
  if (panes.length === 0) return record;
  const open = new Set(panes.map((pane) => pane.pane_id));
  const gone = Object.keys(record).filter((id) => !open.has(id) || record[id]! > (seqs.get(id) ?? Infinity));
  if (gone.length === 0) return record;
  const next: Record<string, number> = { ...record };
  for (const id of gone) delete next[id];
  return next;
}

/**
 * Rows in Activity order: a blocked one first, then the most recent state change, then the
 * order given. State is not ranked otherwise: ranking moved a row the moment its state changed (a
 * pane sent a message fell below every DONE while it ran and jumped back when it finished), where
 * recency keeps the row just worked in on top while it runs and after it finishes.
 */
export function activityOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => {
      const pane = paneOf(row);
      return { row, index, rank: knownStatus(pane.agent_status) === "blocked" ? 0 : 1, recent: seqs.get(pane.pane_id) ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}

const seenKey = (machineId: string) => `herdr-web-ui:seen:${machineId}`;

/** This browser's record for a PC, or null when it has none yet. */
export function loadSeen(machineId: string): SeenRecord | null {
  try {
    const raw = localStorage.getItem(seenKey(machineId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0));
  } catch {
    return null;
  }
}

/**
 * Whether this browser has a record for any PC: the setting was turned on here before. Only a
 * record `loadSeen` accepts counts, so a damaged one does not keep the first use from starting quiet.
 */
export function anySeen(): boolean {
  try {
    const prefix = seenKey("");
    const ids: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
    return ids.some((machineId) => loadSeen(machineId) !== null);
  } catch { /* storage blocked */ }
  return false;
}

/** Drops the records of PCs no longer in the roster. */
export function forgetSeen(machineIds: Iterable<string>): void {
  const keep = new Set([...machineIds].map(seenKey));
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(seenKey("")) && !keep.has(key)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* storage blocked */ }
}

export function saveSeen(machineId: string, record: SeenRecord): void {
  try { localStorage.setItem(seenKey(machineId), JSON.stringify(record)); } catch { /* storage blocked: marks last for this page only */ }
}
