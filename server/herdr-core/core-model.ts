/**
 * The core model: what hc's snapshot and events say of a core's terminals and agents, as change
 * records. The herdr-core adapter turns them into herdr's frames; the terminal screen reads the same
 * records, so both clients show a terminal's state by one rule.
 */

import type { AgentStatus } from "../../shared/herdr-api.generated.ts";
import { titleStatus } from "../agent-identity.ts";
import { OVIS_LAYOUT_DOC } from "./layout-doc.ts";
import { agentOf, agentStatusOf, type CoreHost, type FirstTurn, foregroundOf, type HcForeground, type HcStatus, isRecord, LAYOUT_DOC, onOtherMachine, reportedFacts, shownStatusOf } from "./snapshot.ts";

/**
 * What of a status the rows draw beyond its state, as `coreModel` compares reports: the kind and
 * message of a blocked agent, and its progress, which the rows print as its exact percent. Read with
 * its app, as the snapshot reads them: agy's plan review draws none (snapshot.ts `agyPlanReview`).
 */
function shownFacts(report: unknown): string {
  if (!isRecord(report) || typeof report["state"] !== "string") return NO_FACTS;
  const facts = reportedFacts({
    state: report["state"],
    ...(typeof report["app"] === "string" ? { app: report["app"] } : {}),
    ...(typeof report["kind"] === "string" ? { kind: report["kind"] } : {}),
    ...(typeof report["msg"] === "string" ? { msg: report["msg"] } : {}),
    ...(typeof report["progress"] === "number" ? { progress: report["progress"] } : {}),
  });
  return JSON.stringify([facts.agent_kind ?? null, facts.agent_message ?? null, facts.agent_progress ?? null]);
}
const NO_FACTS = JSON.stringify([null, null, null]);

/** One hc event notification (herdr-core schema/README.md, Events). */
/** `machine`: the other machine an event is about (a `doc` there names no terminal); none for this core's own */
export interface HcEvent { type: string; terminal?: string; machine?: string; data?: Record<string, unknown> }

/**
 * A status report as hc sends it in a record or a `status` event; null when it is none. Its kind and
 * message stay, so an event reads agy's plan review as the snapshot does (snapshot.ts `agyPlanReview`).
 */
function statusOf(reported: unknown): HcStatus | null {
  if (!isRecord(reported) || typeof reported["state"] !== "string") return null;
  const { app, kind, msg } = reported;
  return { state: reported["state"], ...(typeof app === "string" ? { app } : {}), ...(typeof kind === "string" ? { kind } : {}), ...(typeof msg === "string" ? { msg } : {}) };
}

/** A terminal's labels as hc sends them, its string values only. */
function labelsOf(labels: unknown): Record<string, string> {
  if (!isRecord(labels)) return {};
  return Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** What an event says of a terminal's OpenCode session (startHerdrCoreAdapter `noteSession`), so a turn too short for any read is still remembered. */
export type SessionNote = (address: string, status: HcStatus | null | undefined, records: unknown, labels: Readonly<Record<string, string>> | undefined) => unknown;

/**
 * What the core model learned from hc's snapshot or one event, each change in the order it
 * happened, whoever subscribed to it:
 * - `status`: what a terminal shows changed, or its program reported a status that did not wait
 *   for the turn's end: `shown` as the snapshot shows it (snapshot.ts `shownStatusOf`), `agent` the
 *   agent it runs (snapshot.ts `agentOf`), `status` its program's own report;
 * - `created`, `exited` (a program that ended by itself, always followed by `closed`), `closed`
 *   (also a terminal killed or removed), `updated` (what a fresh snapshot shows of it changed),
 *   each naming the terminal when hc named one;
 * - `layout`: the arrangement or the labels of terminals changed.
 */
export type CoreChange =
  | { type: "status"; terminal: string; status: HcStatus | null; shown: AgentStatus; agent: string | null }
  | { type: "created" | "exited" | "closed" | "updated"; terminal?: string }
  | { type: "layout" };

/**
 * What the core model is told from outside: `firstTurn`, the turn each terminal had when this
 * process first saw it; `host`, where the core's terminals run; `observeSeen`, told each terminal's
 * turn and labels as they are learned (seen-label.ts SeenMarker); `noteSession`, told what each
 * report says of an OpenCode session.
 */
interface CoreModelOptions {
  firstTurn: FirstTurn;
  host: CoreHost;
  observeSeen?: (address: string, turn: number, labels: Record<string, string>) => void;
  noteSession?: SessionNote;
}

/**
 * What hc's snapshot and events say of this core's terminals, as change records. `seed` takes the
 * terminals of hc's snapshot at the start of the stream; `event` each event after it. Events given
 * before the seed wait for it and are answered by it; another machine's are none of this core's.
 */
export function coreModel({ firstTurn, host, observeSeen, noteSession }: CoreModelOptions): { seed: (terminals: unknown) => CoreChange[]; event: (event: HcEvent) => CoreChange[] } {
  /**
   * What each terminal's status is shown from, as the snapshot shows it (snapshot.ts
   * `shownStatusOf`): its program's word, its turn and its labels, from hc's snapshot and then its
   * events, with the status last told. Until hc's snapshot is in, events wait in `early`.
   */
  type Known = { status: HcStatus | null; front: HcForeground | null; cwd: string | undefined; argv: string[] | undefined; pid: number | null; title: string | null; turn: number; first: number; labels: Record<string, string>; shown: AgentStatus };
  const known = new Map<string, Known>();
  /** the agent a terminal runs, read as the snapshot reads it (snapshot.ts `agentOf`) */
  const agentNow = (status: HcStatus | null, entry: Known | undefined) => agentOf({ status, foreground: entry?.front ?? null, cwd: entry?.cwd, argv: entry?.argv, pid: entry?.pid }, host);
  let early: HcEvent[] | null = [];
  const remember = (record: unknown) => {
    if (!isRecord(record) || typeof record["address"] !== "string") return;
    const status = statusOf(record["status"]);
    const turn = typeof record["turn"] === "number" ? record["turn"] : 0;
    const labels = labelsOf(record["labels"]);
    const first = firstTurn({ address: record["address"], turn });
    noteSession?.(record["address"], status, record["records"], labels);
    known.set(record["address"], { status, front: foregroundOf(record["foreground"]), cwd: typeof record["cwd"] === "string" ? record["cwd"] : undefined, argv: Array.isArray(record["argv"]) && record["argv"].every((word) => typeof word === "string") ? record["argv"] : undefined, pid: typeof record["pid"] === "number" ? record["pid"] : null, title: typeof record["title"] === "string" ? record["title"] : null, turn, first, labels, shown: shownStatusOf(status, turn, labels, first) });
    observeSeen?.(record["address"], turn, labels);
  };
  const told = (paneId: string, status: HcStatus | null, shown: AgentStatus): CoreChange => ({ type: "status", terminal: paneId, status, shown, agent: agentNow(status, known.get(paneId)) });
  const changed = (type: "created" | "exited" | "closed" | "updated", paneId: string | undefined): CoreChange => (paneId ? { type, terminal: paneId } : { type });
  /** A turn or a look (the `herdr.seen` label) that changes what a terminal shows is told as its status. */
  const retell = (paneId: string): CoreChange[] => {
    const entry = known.get(paneId);
    if (!entry) return [];
    const shown = shownStatusOf(entry.status, entry.turn, entry.labels, entry.first);
    if (shown === entry.shown) return [];
    entry.shown = shown;
    return [told(paneId, entry.status, shown)];
  };
  /** what each terminal's last report said beyond its state (kind, message, progress), which only a snapshot carries */
  const reported = new Map<string, string>();
  const event = (event: HcEvent): CoreChange[] => {
    // another machine's terminal is none of this PC's panes (snapshot.ts `onOtherMachine`)
    if (event.machine !== undefined || (event.terminal !== undefined && onOtherMachine(event.terminal))) return [];
    if (early) { early.push(event); return []; }
    const paneId = event.terminal;
    switch (event.type) {
      case "status": {
        if (!paneId) return [];
        const report = event.data?.["status"];
        // a new kind, message or progress step (or one gone) reaches the rows through a fresh snapshot
        const facts = shownFacts(report);
        const before = reported.get(paneId) ?? NO_FACTS;
        reported.set(paneId, facts);
        const changes = facts !== before ? [changed("updated", paneId)] : [];
        const status = statusOf(report);
        noteSession?.(paneId, status, event.data?.["records"], known.get(paneId)?.labels);
        const entry = known.get(paneId);
        if (!entry) return [...changes, told(paneId, status, agentStatusOf(status))];
        const was = entry.status?.state;
        entry.status = status;
        const shown = shownStatusOf(status, entry.turn, entry.labels, entry.first);
        // a turn ends with this status, then the `turn` event that counts it: whether it is done
        // is decided there (herdr-app docs/labels.md)
        if (was === "working" && (shown === "idle" || shown === "done")) return changes;
        entry.shown = shown;
        return [...changes, told(paneId, status, shown)];
      }
      case "turn": {
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry || typeof event.data?.["turn"] !== "number") return [];
        entry.turn = event.data["turn"];
        observeSeen?.(paneId!, entry.turn, entry.labels);
        return retell(paneId!);
      }
      case "created":
        remember(event.data);
        return [changed("created", paneId)];
      case "finished":
        // herdr says pane_exited only for a program that ended by itself; a pane someone closed is
        // pane_closed alone, so it raises no "terminal ended" alert. hc's `killed` is a
        // terminal.kill (the Herdr app closing a tab, Ovis's pane.close, `hc kill`); a signal sent
        // from anywhere else finishes as `exited`
        if (event.data?.["reason"] !== "killed") return [changed("exited", paneId), changed("closed", paneId)];
        return [changed("closed", paneId)];
      case "removed":
        if (paneId) { known.delete(paneId); reported.delete(paneId); }
        return [changed("closed", paneId)];
      case "lost":
      case "restarted":
        return [changed("updated", paneId)];
      case "labels": {
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry) return [{ type: "layout" }];
        entry.labels = labelsOf(event.data?.["labels"]);
        observeSeen?.(paneId!, entry.turn, entry.labels);
        return [...retell(paneId!), { type: "layout" }];
      }
      case "foreground": {
        // a program that reports nothing is named from the process in front of it (snapshot.ts `agentOf`)
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry) return [];
        const before = agentNow(entry.status, entry);
        entry.front = foregroundOf(event.data);
        if (agentNow(entry.status, entry) === before) return [];
        return [changed("updated", paneId), told(paneId!, entry.status, entry.shown)];
      }
      case "title": {
        // an agent that reports nothing may say in its own title whether it works (agent-identity.ts `titleStatus`):
        // a change there reaches the rows through a fresh snapshot; any other title shows in the next one
        const entry = paneId ? known.get(paneId) : undefined;
        if (!entry) return [];
        const title = typeof event.data?.["title"] === "string" ? event.data["title"] : null;
        // only where no report gives a status: none, or a word that says nothing (an error)
        const agent = agentStatusOf(entry.status) === "unknown" ? agentNow(entry.status, entry) : null;
        const before = titleStatus(agent, entry.title);
        entry.title = title;
        return titleStatus(agent, title) !== before ? [changed("updated", paneId)] : [];
      }
      case "doc":
        return event.data?.["name"] === LAYOUT_DOC || event.data?.["name"] === OVIS_LAYOUT_DOC ? [{ type: "layout" }] : [];
      default:
        // size changes many times a second and shows in the next snapshot
        return [];
    }
  };
  const seed = (terminals: unknown): CoreChange[] => {
    // what each terminal reported as the stream starts: a first event that drops a message or progress is a change
    const here = (Array.isArray(terminals) ? terminals : []).filter((terminal) => !isRecord(terminal) || typeof terminal["address"] !== "string" || !onOtherMachine(terminal["address"]));
    for (const terminal of here) {
      if (!isRecord(terminal) || typeof terminal["address"] !== "string" || reported.has(terminal["address"])) continue;
      reported.set(terminal["address"], shownFacts(terminal["status"]));
    }
    for (const record of here) remember(record);
    const waiting = early ?? [];
    early = null;
    return waiting.flatMap((next) => event(next));
  };
  return { seed, event };
}
