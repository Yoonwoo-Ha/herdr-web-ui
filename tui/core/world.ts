/**
 * What the core shows the screen: its workspaces, their tabs and each tab's panes, each tab's split tree and the pane
 * it zooms. Built from the core link's notices through the browser's own code: the shared core model's change records
 * (core-model.ts) say what an event changed, the terminals are read again from the core when a record says so, and the
 * browser's grouping, snapshot.ts `buildSnapshot`, turns them into workspaces and tabs. A pane is its terminal: its id
 * is the terminal's address.
 */

import type { CoreChange } from "../../server/herdr-core/core-model.ts";
import { type LayoutNode, OVIS_LAYOUT_DOC } from "../../server/herdr-core/layout-doc.ts";
import { buildSnapshot, coreHost, type FirstTurn, type HcTerminal, isRecord, LAYOUT_DOC } from "../../server/herdr-core/snapshot.ts";
import { nestHelpers, sidebarAgents } from "../../shared/agent-roster.ts";
import { type AgentGroup, groupAgentRows, knownStatus, type KnownStatus, rollupStatus } from "../../shared/attention.ts";
import type { AgentStatus, PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import { folderName } from "../../shared/pane-title.ts";
import { worktreeGroups } from "../../shared/worktree-groups.ts";
import type { World } from "../model/focus.ts";
import type { LinkNotice } from "./link.ts";

/** One tab as the screen lays it out: its tree over terminal addresses and the pane a zoom shows alone. */
export interface TabShape { readonly root: LayoutNode; readonly zoomed: string | null }

/** The zoom a tab of the state core's world carries: the zoomed pane, or nothing. */
const zoomOf = (shape: TabShape | undefined): { zoomed?: string } => (shape?.zoomed ? { zoomed: shape.zoomed } : {});

/** One pane as the chrome draws it (never reading agent_status off a tab or workspace). */
interface PaneSummary {
  readonly label: string;
  readonly title: string;
  readonly folder: string;
  readonly agent: string | null;
  readonly status: AgentStatus;
  readonly parentId?: string;
}

/** One row of the agent lists (the sidebar's Agents section, the full-screen list), ordered by shared/attention.ts. */
interface AgentRowView {
  readonly paneId: string;
  readonly name: string;
  readonly agent: string;
  readonly folder: string;
  readonly status: AgentStatus;
  /** a helper agent started by another agent row */
  readonly helper: boolean;
  /** the section the row stands in: its family's most urgent state (a blocked helper brings its agent up) */
  readonly group: AgentGroup;
  /** the name of the workspace the agent's pane is in */
  readonly workspace: string;
}

interface WorkspaceRowView { readonly id: string; readonly name: string; readonly number: number; readonly status: KnownStatus }

/** A top-level workspace in the sidebar and the linked worktree workspaces grouped under it (shared/worktree-groups.ts). */
interface WorkspaceGroupView extends WorkspaceRowView { readonly children: readonly WorkspaceRowView[] }

export interface CoreView {
  readonly world: World;
  readonly tabs: ReadonlyMap<string, TabShape>;
  readonly panes: ReadonlyMap<string, PaneSummary>;
  readonly tabStatuses: ReadonlyMap<string, KnownStatus>;
  readonly workspaceGroups: readonly WorkspaceGroupView[];
  readonly agents: readonly AgentRowView[];
  /** true when Ovis arranges this core; false when the Herdr app's layout document (`herdr-app`) arranges it */
  readonly ownsLayout: boolean;
}

const EMPTY: CoreView = {
  world: { workspaces: [] },
  tabs: new Map(),
  panes: new Map(),
  tabStatuses: new Map(),
  workspaceGroups: [],
  agents: [],
  ownsLayout: true,
};

/** The one read of the core the world asks for: every terminal, finished ones too (`all`), as the core holds them now. */
export interface CoreRead {
  readonly method: "terminal.list";
  readonly params: { readonly all: true };
  /** the newest status told before this read was asked for */
  readonly told: number;
}

/**
 * A terminal whose program ended by itself keeps its place in its tab, its last picture and "ended (code)" drawn there
 * (the pane machine's Ended state), for as long as the core keeps its finished record: until something removes it (hc
 * 0.1.17 and 0.1.18 keep it until `terminal.rm`). A terminal someone killed, or one finished by the core stopping, leaves
 * at once, as in the browser.
 */
export function keepsPlace<T extends object>(record: T): T {
  const fields = record as Record<string, unknown>;
  return fields["state"] === "finished" && fields["reason"] === "exited" ? { ...record, state: "live" } : record;
}

function byAddress(terminals: readonly unknown[]): Map<string, Record<string, unknown>> {
  const records = new Map<string, Record<string, unknown>>();
  for (const record of terminals) if (isRecord(record) && typeof record["address"] === "string") records.set(record["address"], record);
  return records;
}

/**
 * The panes that need the user, in the order one key jumps through them: the blocked rows, then the done rows, each the
 * longest in that state first (`since`: when the screen saw a row's state begin; a tie keeps the list's order).
 */
export function jumpOrder(rows: readonly Pick<AgentRowView, "paneId" | "status">[], since: ReadonlyMap<string, number>): string[] {
  const inState = (state: KnownStatus) => rows.filter((row) => knownStatus(row.status) === state).sort((a, b) => (since.get(a.paneId) ?? 0) - (since.get(b.paneId) ?? 0));
  return [...inState("blocked"), ...inState("done")].map((row) => row.paneId);
}

function buildAgents(snapshot: ReturnType<typeof buildSnapshot>, panes: ReadonlyMap<string, PaneSummary>, seqs: ReadonlyMap<string, number>): AgentRowView[] {
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
  const workspaceOf = new Map(snapshot.panes.map((pane) => [pane.pane_id, workspaces.get(pane.workspace_id) ?? ""]));
  // the browser's rows (shared/agent-roster.ts), read from the snapshot as the screen shows it: with the agent and the
  // state the core model told since the last read
  const shown = {
    ...snapshot,
    panes: snapshot.panes.map((pane) => {
      const summary = panes.get(pane.pane_id);
      return summary ? { ...pane, agent_status: summary.status, agent: summary.agent ?? undefined } : pane;
    }),
  };
  const rows = nestHelpers(sidebarAgents(shown)).flatMap((entry) => {
    const summary = panes.get(entry.pane.pane_id);
    return summary ? [{ machine: { id: "local" }, entry, id: entry.pane.pane_id, summary }] : [];
  });
  type Row = (typeof rows)[number];
  const agentIds = new Set(rows.map((row) => row.id));
  return groupAgentRows<Row>(rows, {
    sort: "wait",
    status: (row) => row.summary.status,
    name: (row) => row.summary.label || row.summary.agent || row.id,
    seqs: () => seqs,
  }).flatMap(({ group, rows: groupRows }) => groupRows.map(({ id, summary }): AgentRowView => ({
    paneId: id,
    name: summary.label || summary.title || summary.agent || id,
    agent: summary.agent ?? "",
    folder: summary.folder,
    status: summary.status,
    helper: summary.parentId !== undefined && agentIds.has(summary.parentId),
    group,
    workspace: workspaceOf.get(id) ?? "",
  })));
}

/**
 * A tab's tree from the snapshot's layout: its splits carry the path of each split in their ids (`split_<n>_root`,
 * `split_<n>_01`: 0 the first side, 1 the second) and its panes come in the order `place()` walks the tree, so the tree
 * is the splits by path with the panes as leaves in that order.
 */
export function treeOf(layout: Pick<PaneLayoutSnapshot, "splits" | "panes">): LayoutNode | null {
  const splits = new Map(layout.splits.map((split) => [split.id.slice(split.id.indexOf("_", "split_".length) + 1), split]));
  const leaves = layout.panes.map((pane) => pane.pane_id);
  let next = 0;
  const build = (path: string): LayoutNode | null => {
    const split = splits.get(path === "" ? "root" : path);
    if (!split) {
      const leaf = leaves[next++];
      return leaf === undefined ? null : { leaf };
    }
    const first = build(`${path}0`);
    const second = build(`${path}1`);
    if (!first || !second) return first ?? second;
    return { split: split.direction === "down" ? "down" : "right", ratio: split.ratio, first, second };
  };
  return leaves.length === 0 ? null : build("");
}

/** The terminals and documents the link told of, and what they show. */
export class CoreWorld {
  private records = new Map<string, Record<string, unknown>>();
  private readonly docs = new Map<string, unknown>();
  private readonly firstTurns = new Map<string, number>();
  /** what the shared core model last told of a terminal's state, newer than its record until the next read */
  private readonly told = new Map<string, { shown: AgentStatus; agent: string | null; at: number }>();
  private tellings = 0;
  /** the screen's own recency (UB Q7: each client keeps its own): when it saw each terminal's shown state begin */
  private readonly since = new Map<string, { status: AgentStatus; at: number }>();
  private changes = 0;
  /** a view with terminals was dated: what turns up after it is newer than all of it */
  private dated = false;
  private wanted = false;
  private reading: CoreRead | null = null;
  private shown: CoreView = EMPTY;
  private stale = false;
  private version = "";

  /**
   * What the link's core model is made with: the first turn each terminal had when this screen first saw it, and this
   * PC as the core's host, so the model's change records and the world's own view read every terminal by one rule.
   */
  readonly model: { firstTurn: FirstTurn; host: ReturnType<typeof coreHost> } = {
    firstTurn: (terminal) => {
      const first = this.firstTurns.get(terminal.address);
      if (first !== undefined) return first;
      const turn = terminal.turn ?? 0;
      this.firstTurns.set(terminal.address, turn);
      return turn;
    },
    host: coreHost(false),
  };

  /** Takes one notice of the link; answers whether what the screen shows may have changed. */
  notice(notice: LinkNotice): boolean {
    switch (notice.type) {
      case "state":
        return false;
      case "snapshot":
        this.records = byAddress(notice.terminals);
        for (const address of this.firstTurns.keys()) if (!this.records.has(address)) this.firstTurns.delete(address);
        this.told.clear();
        this.wanted = false;
        this.reading = null;
        break;
      case "doc":
        if (notice.name !== LAYOUT_DOC && notice.name !== OVIS_LAYOUT_DOC) return false;
        this.docs.set(notice.name, notice.doc.value ?? null);
        break;
      case "event":
        if (!this.changed(notice.changes)) return false;
        break;
    }
    this.stale = true;
    return true;
  }

  /** A status the model told is shown at once; any other change asks for the terminals to be read again. */
  private changed(changes: readonly CoreChange[]): boolean {
    let shown = false;
    for (const change of changes) {
      if (change.type === "status") {
        this.told.set(change.terminal, { shown: change.shown, agent: change.agent, at: ++this.tellings });
        shown = true;
      } else {
        this.wanted = true;
      }
    }
    return shown;
  }

  /** The read to make now: one at a time, and only after a change asked for it; null when none is due. */
  nextRead(): CoreRead | null {
    if (!this.wanted || this.reading) return null;
    this.wanted = false;
    this.reading = { method: "terminal.list", params: { all: true }, told: this.tellings };
    return this.reading;
  }

  /**
   * The core's answer to `read` (null: the call failed; a change since asks again). An answer to a read made before the
   * last snapshot is dropped. Answers whether what the screen shows may have changed.
   */
  answer(read: CoreRead, terminals: readonly unknown[] | null): boolean {
    if (read !== this.reading) return false;
    this.reading = null;
    if (terminals === null) return false;
    this.records = byAddress(terminals);
    for (const [address, told] of this.told) if (told.at <= read.told) this.told.delete(address);
    this.stale = true;
    return true;
  }

  /** hc's version, for the snapshot's own field */
  setVersion(version: string): void {
    this.version = version;
  }

  view(): CoreView {
    if (!this.stale) return this.shown;
    this.stale = false;
    const appDoc = this.docs.get(LAYOUT_DOC) ?? null;
    const ovisDoc = this.docs.get(OVIS_LAYOUT_DOC) ?? null;
    const snapshot = buildSnapshot([...this.records.values()].map(keepsPlace) as unknown as HcTerminal[], appDoc, this.version, this.model.firstTurn, ovisDoc, undefined, this.model.host);
    const tabs = new Map<string, TabShape>();
    for (const layout of snapshot.layouts) {
      const root = treeOf(layout);
      if (root) tabs.set(layout.tab_id, { root, zoomed: layout.zoomed ? layout.focused_pane_id ?? null : null });
    }
    const panes = new Map<string, PaneSummary>();
    for (const pane of snapshot.panes) {
      const parent = (pane as unknown as { parent_pane_id?: string }).parent_pane_id;
      const told = this.told.get(pane.pane_id);
      panes.set(pane.pane_id, {
        label: pane.label ?? "",
        title: pane.title ?? pane.terminal_title ?? "",
        folder: folderName(pane.foreground_cwd ?? pane.cwd ?? ""),
        agent: told ? told.agent : pane.agent ?? null,
        status: told ? told.shown : pane.agent_status,
        ...(parent === undefined ? {} : { parentId: parent }),
      });
    }
    const order = new Map(snapshot.layouts.map((layout) => [layout.tab_id, layout.panes.map((pane) => pane.pane_id)]));
    const tabStatuses = new Map<string, KnownStatus>();
    for (const tab of snapshot.tabs) tabStatuses.set(tab.tab_id, rollupStatus((order.get(tab.tab_id) ?? []).map((id) => panes.get(id)?.status)));
    const workspaceRow = (workspace: (typeof snapshot.workspaces)[number]): WorkspaceRowView => ({
      id: workspace.workspace_id,
      name: workspace.label,
      number: workspace.number,
      status: rollupStatus(snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id).map((pane) => panes.get(pane.pane_id)?.status)),
    });
    for (const address of this.since.keys()) if (!panes.has(address)) this.since.delete(address);
    // what is first seen in this view dates from it: every terminal of the first snapshot alike; one that turns up later
    // (a reconnect, a `missed` snapshot, a read) from a step after every change seen before, so it never stands ahead of
    // an agent already waiting. A change of state dates from a step of its own.
    let fresh: number | null = null;
    for (const [address, { status }] of panes) {
      const was = this.since.get(address);
      if (was === undefined) this.since.set(address, { status, at: fresh ??= this.dated ? ++this.changes : this.changes });
      else if (was.status !== status) this.since.set(address, { status, at: ++this.changes });
    }
    if (panes.size > 0) this.dated = true;
    const since = new Map([...this.since].map(([address, { at }]) => [address, at]));
    // a status that left a pane with no agent is newer than its record, which the snapshot still lists as an agent's
    // until the next read: such a pane is no agent row meanwhile
    const agentless = new Set([...this.told].flatMap(([address, told]) => (told.agent === null ? [address] : [])));
    const agents = buildAgents({ ...snapshot, agents: snapshot.agents.filter((agent) => !agentless.has(agent.pane_id)) }, panes, since);
    this.shown = {
      tabs,
      panes,
      tabStatuses,
      workspaceGroups: worktreeGroups(snapshot.workspaces).map(({ workspace, children }) => ({ ...workspaceRow(workspace), children: children.map(workspaceRow) })),
      agents,
      ownsLayout: appDoc === null,
      world: {
        workspaces: snapshot.workspaces.map((workspace) => ({
          id: workspace.workspace_id,
          name: workspace.label,
          tabs: snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).map((tab) => ({
            id: tab.tab_id,
            name: tab.label,
            root: tabs.get(tab.tab_id)?.root,
            ...zoomOf(tabs.get(tab.tab_id)),
            panes: (order.get(tab.tab_id) ?? []).map((id) => {
              const created = this.records.get(id)?.["created_ms"];
              const agent = panes.get(id)?.agent ?? null;
              return { id, name: panes.get(id)?.label ?? "", ...(typeof created === "number" ? { created } : {}), ...(agent ? { agent } : {}) };
            }),
          })),
        })),
        agents: agents.map((agent) => agent.paneId),
        waiting: jumpOrder(agents, since),
      },
    };
    return this.shown;
  }
}
