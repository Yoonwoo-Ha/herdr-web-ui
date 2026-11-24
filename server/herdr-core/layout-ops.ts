import type { PaneInfo, SessionSnapshot } from "../../shared/herdr-api.generated.ts";
import { type HcConnection, HcError } from "./connection.ts";
import type { Terminal } from "./hc-api.generated.ts";
import { AdapterError } from "./errors.ts";
import { foreignLayout, leaves, neighbour, OVIS_LAYOUT_DOC, type OvisLayout, type PaneDirection, resizeLeaf, setRatio, type SplitDirection, splitLeaf, swapLeaves, type TabLayout } from "./layout-doc.ts";
import { buildSnapshot, type CoreHost, type FirstTurn, type HcTerminal, keptLayout, LAYOUT_DOC, OTHER_WORKSPACE_ID, PANE_NAME_LABEL, SEEN_LABEL, type SessionOf, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "./snapshot.ts";
import { labeledWorktree, WORKTREE_LABEL } from "./worktrees.ts";

/**
 * Whether Ovis keeps this core's workspace and tab names and places in labels: only where no Herdr app
 * arranges them, its `herdr-app` document never written (or deleted: hc keeps a null value).
 */
export function ownsLayout(doc: unknown): boolean {
  return doc === null || doc === undefined;
}

/** What every terminal Ovis starts gets over its environment outside Windows: Ovis's terminal views draw 24-bit colour. */
export const TERMINAL_COLOUR: Readonly<Record<string, string>> = Object.freeze({ TERM: "xterm-256color", COLORTERM: "truecolor" });

/** How far a resize moves a pane's border when the call names no amount: this share of its split. */
export const RESIZE_STEP = 0.05;

/** A new workspace's or tab's id: `ovis-` and a random UUID, so no two clients make the same one. */
export const newLayoutId = (): string => `ovis-${crypto.randomUUID()}`;

/** Whether this core writes documents, by what its hello names (never its version): Ovis's layout needs `doc.set`. */
export function layoutCalls(hello: { methods: readonly string[] }): boolean {
  return hello.methods.includes("doc.set");
}

/** What an edit makes of Ovis's layout: the layout to write, or null and why nothing changes (null where no answer says why). */
export interface Edited { layout: OvisLayout | null; reason: string | null }

/**
 * One change to Ovis's layout document: read, edit what the snapshot shows (layout-doc.ts
 * `reconcile`), write back at the version read, read again and redo the edit once if another
 * writer came first. An edit that answers no layout writes nothing. Refused where the Herdr app
 * arranges the core, where hc cannot write a document (its hello names no `doc.set`), and where a
 * newer Ovis wrote it in a schema this one does not know. Answers whether it wrote, with what the
 * last edit made said besides. It needs only the core's line: a caller that edits the document and
 * starts no shell needs no store.
 */
export async function editLayout<T extends Edited>(hc: Pick<HcConnection, "call" | "hello">, change: (layout: OvisLayout) => T): Promise<Omit<T, "layout"> & { changed: boolean }> {
  if (!layoutCalls(await hc.hello())) throw new AdapterError("unsupported", "this herdr-core keeps no documents Ovis can write");
  for (let attempt = 0; ; attempt++) {
    // the document before the terminals: a list read after it holds every terminal a writer of that version had
    const doc = await hc.call("doc.get", { name: OVIS_LAYOUT_DOC });
    const [list, app] = await Promise.all([hc.call("terminal.list", {}), hc.call("doc.get", { name: LAYOUT_DOC })]);
    if (!ownsLayout(app.value)) throw new AdapterError("unsupported", "the Herdr app arranges this core's workspaces, tabs and panes");
    if (foreignLayout(doc.value)) throw new AdapterError("unsupported", "a newer Ovis keeps this core's layout");
    const { layout, ...made } = change(keptLayout(list.terminals, doc.value));
    if (!layout) return { ...made, changed: false };
    try {
      await hc.call("doc.set", { name: OVIS_LAYOUT_DOC, value: layout, version: doc.version });
      return { ...made, changed: true };
    } catch (error) {
      if (error instanceof HcError && error.kind === "conflict" && attempt === 0) continue;
      throw error;
    }
  }
}

/** The kept tab holding the pane, in a layout being edited; refused for a pane in a tab Ovis does not lay out (Other terminals, a helper's). */
function tabHolding(layout: OvisLayout, paneId: string): TabLayout {
  for (const workspace of layout.workspaces) for (const tab of workspace.tabs) if (leaves(tab.root).includes(paneId)) return tab;
  throw new AdapterError("unsupported", `pane ${paneId} is in a tab of its own terminal: it has no splits`);
}

/** A layout with one tab's tree or zoom changed. */
const withTab = (layout: OvisLayout, tabId: string, change: Partial<TabLayout>): OvisLayout => ({
  ...layout,
  workspaces: layout.workspaces.map((workspace) => ({ ...workspace, tabs: workspace.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...change } : tab)) })),
});

/**
 * herdr's insertion boundary in the list as shown (an index before the item is taken out) as the
 * entry of the document it goes before: the first one at or after the boundary the document orders
 * (not a helper's tab, not Other terminals), null for the end.
 */
function anchorOf(shown: readonly string[], id: string, boundary: unknown, ordered: ReadonlySet<string>): string | null {
  if (typeof boundary !== "number" || !Number.isInteger(boundary) || boundary < 0 || boundary > shown.length) throw new AdapterError("invalid_params", "insert_index is out of range");
  return shown.slice(boundary).find((candidate) => candidate !== id && ordered.has(candidate)) ?? null;
}

/** The entry moved before `anchor` (to the end for null), in the order as it is now: another writer's move stays. */
function moveBefore<T extends { id: string }>(items: readonly T[], id: string, anchor: string | null): T[] {
  const item = items.find((candidate) => candidate.id === id)!;
  const rest = items.filter((candidate) => candidate.id !== id);
  const at = anchor === null ? -1 : rest.findIndex((candidate) => candidate.id === anchor);
  rest.splice(at === -1 ? rest.length : at, 0, item);
  return rest;
}

/** The pane's leaf turned into a split holding it and the new terminal `made`; a zoomed tab shows every pane again, so the new one is in view. */
export const splitEdit = (paneId: string, made: string, direction: SplitDirection) => (layout: OvisLayout): Edited => {
  const tab = tabHolding(layout, paneId);
  const root = splitLeaf(tab.root, paneId, made, direction);
  return { layout: root && withTab(layout, tab.id, { root, zoomed: null }), reason: null };
};

/**
 * The pane taken out of its tree and put beside `targetId`, a pane of its own tab (`tabId`), as a split
 * makes it: herdr moves only into another tab, herdr-core within the pane's own. A zoomed tab shows every
 * pane again, so the moved one is in view.
 */
export const moveBesideEdit = (paneId: string, tabId: string | undefined, targetId: string, split: SplitDirection) => (layout: OvisLayout): Edited => {
  const tab = tabHolding(layout, paneId);
  if (tab.id !== tabId) throw new AdapterError("unsupported", "herdr-core moves a pane into a tab only beside a pane of its own tab");
  if (!leaves(tab.root).includes(targetId)) throw new AdapterError("pane_not_found", `pane ${targetId} not found in tab ${tab.id}`);
  if (targetId === paneId) return { layout: null, reason: "same_pane" };
  const root = splitLeaf(tab.root, targetId, paneId, split);
  return { layout: root && withTab(layout, tab.id, { root, zoomed: null }), reason: null };
};

/** Two panes of one tab trading places: `target`, or the pane's neighbour toward `direction`, which the answer names. */
export const swapEdit = (source: string, target: string | null, direction: PaneDirection | null) => (layout: OvisLayout): Edited & { target: string | null } => {
  const tab = tabHolding(layout, source);
  const other = direction ? neighbour(tab.root, source, direction) : target;
  if (other === null) return { layout: null, reason: "no_neighbor", target: other };
  if (other === source) return { layout: null, reason: "same_pane", target: other };
  if (!leaves(tab.root).includes(other)) return { layout: null, reason: "cross_tab", target: other };
  return { layout: withTab(layout, tab.id, { root: swapLeaves(tab.root, source, other) }), reason: null, target: other };
};

/** The ratio of the tab's split at `path` (layout-doc.ts `setRatio`). */
export const ratioEdit = (tabId: string, path: readonly boolean[], ratio: number) => (layout: OvisLayout): Edited => {
  const tab = layout.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === tabId);
  const root = tab && setRatio(tab.root, path, ratio);
  return root ? { layout: withTab(layout, tabId, { root }), reason: null } : { layout: null, reason: "split_not_found" };
};

/** The pane's border toward `direction` moved by `amount` of its split (layout-doc.ts `resizeLeaf`). */
export const resizeEdit = (paneId: string, direction: PaneDirection, amount: number) => (layout: OvisLayout): Edited => {
  const tab = tabHolding(layout, paneId);
  const root = resizeLeaf(tab.root, paneId, direction, amount);
  return root ? { layout: withTab(layout, tab.id, { root }), reason: null } : { layout: null, reason: "unchanged" };
};

/** The tab shows the pane alone, or every pane again. */
export const zoomEdit = (paneId: string, mode: "toggle" | "on" | "off") => (layout: OvisLayout): Edited => {
  const tab = tabHolding(layout, paneId);
  if (leaves(tab.root).length < 2) return { layout: null, reason: "single_pane" };
  const on = mode === "toggle" ? tab.zoomed === null : mode === "on";
  if (on && tab.zoomed === paneId) return { layout: null, reason: "already_zoomed" };
  if (!on && tab.zoomed === null) return { layout: null, reason: "already_unzoomed" };
  return { layout: withTab(layout, tab.id, { zoomed: on ? paneId : null }), reason: null };
};

/** The pane's right press goes to its program (the terminal screen's passthrough), or opens the screen's menu again. */
export const passthroughEdit = (paneId: string, on: boolean) => (layout: OvisLayout): Edited => {
  const tab = tabHolding(layout, paneId);
  const now = tab.passthrough ?? [];
  if (now.includes(paneId) === on) return { layout: null, reason: on ? "already_on" : "already_off" };
  const next = on ? [...now, paneId] : now.filter((pane) => pane !== paneId);
  return { layout: withTab(layout, tab.id, { passthrough: next.length > 0 ? next : undefined }), reason: null };
};

/** A repository's workspace folds its worktree workspaces in the terminal screen's sidebar, or unfolds them. */
export const collapseEdit = (workspaceId: string, on: boolean) => (layout: OvisLayout): Edited => {
  const workspace = layout.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return { layout: null, reason: "workspace_not_found" };
  if (Boolean(workspace.collapsed) === on) return { layout: null, reason: on ? "already_collapsed" : "already_expanded" };
  const { collapsed: _was, ...rest } = workspace;
  return { layout: { ...layout, workspaces: layout.workspaces.map((candidate) => (candidate === workspace ? (on ? { ...rest, collapsed: true as const } : rest) : candidate)) }, reason: null };
};

/** A tab moved to herdr's `insertIndex` in `siblings`, its workspace's tabs as shown; a helper's tab follows its parent's and has no place of its own. */
export const tabOrderEdit = (workspaceId: string, tabId: string, siblings: readonly string[], insertIndex: unknown) => (layout: OvisLayout): Edited => {
  const workspace = layout.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace?.tabs.some((candidate) => candidate.id === tabId)) throw new AdapterError("unsupported", `tab ${tabId} follows the terminal that started it: it has no place of its own`);
  const anchor = anchorOf(siblings, tabId, insertIndex, new Set(workspace.tabs.map((candidate) => candidate.id)));
  return { layout: { ...layout, workspaces: layout.workspaces.map((candidate) => (candidate === workspace ? { ...candidate, tabs: moveBefore(candidate.tabs, tabId, anchor) } : candidate)) }, reason: null };
};

/** A workspace moved to herdr's `insertIndex` in `listed`, the workspaces as shown; Other terminals stays last. */
export const workspaceOrderEdit = (workspaceId: string, listed: readonly string[], insertIndex: unknown) => (layout: OvisLayout): Edited => {
  if (!layout.workspaces.some((candidate) => candidate.id === workspaceId)) throw new AdapterError("unsupported", `workspace ${workspaceId} holds no tab Ovis places`);
  const anchor = anchorOf(listed, workspaceId, insertIndex, new Set(layout.workspaces.map((candidate) => candidate.id)));
  return { layout: { ...layout, workspaces: moveBefore(layout.workspaces, workspaceId, anchor) }, reason: null };
};

/** A new tab of a workspace: the workspace's id and name as shown, the tab's new id, and the worktree label its terminals carry. */
export interface NewTab { space: string; tab: string; workspaceName: string; worktree: Record<string, string> }
/** Where a new shell goes: a new workspace with its new ids, a new tab of a workspace, or a tab of its own in Other terminals; `name` as asked. */
export type ShellPlace = ({ kind: "workspace"; space: string; tab: string } | ({ kind: "tab" } & NewTab) | { kind: "other" }) & { name?: string };

/**
 * The labels a new workspace's or tab's shell starts with, as the Herdr app labels its own: a new
 * workspace's space and tab and the name given; a tab of a workspace takes the workspace's space, name
 * and worktree label, so it never renames the workspace by being its first terminal; a tab in Other
 * terminals is a terminal of its own with only the tab's name.
 */
export function newShellLabels(place: ShellPlace): Record<string, string> {
  switch (place.kind) {
    case "workspace": return { [SPACE_LABEL]: place.space, [TAB_LABEL]: place.tab, ...(place.name ? { [WORKSPACE_NAME_LABEL]: place.name } : {}) };
    case "tab": return { [SPACE_LABEL]: place.space, [TAB_LABEL]: place.tab, [WORKSPACE_NAME_LABEL]: place.workspaceName, ...place.worktree, ...(place.name ? { [TAB_NAME_LABEL]: place.name } : {}) };
    case "other": return place.name ? { [TAB_NAME_LABEL]: place.name } : {};
  }
}

/** What a close ends: a pane, a tab's panes, or a workspace's (with the rest of its repository's group when `group`). */
export type CloseTarget = { pane: string } | { tab: string } | { workspace: string; group: boolean };

/**
 * The terminals a close ends, in the snapshot as shown. As herdr: a repository's workspace closes over
 * every other workspace of the repository (its open worktrees, and any other one on its main checkout)
 * only when the group is meant.
 */
export function closeTargets(shown: SessionSnapshot, target: CloseTarget): string[] {
  if ("pane" in target) {
    const found = shown.panes.find((pane) => pane.pane_id === target.pane);
    if (!found) throw new AdapterError("pane_not_found", `pane ${target.pane} not found`);
    return [found.pane_id];
  }
  if ("tab" in target) {
    const panes = shown.panes.filter((pane) => pane.tab_id === target.tab);
    if (panes.length === 0) throw new AdapterError("tab_not_found", `tab ${target.tab} not found`);
    return panes.map((pane) => pane.pane_id);
  }
  const workspaceId = target.workspace;
  const panes = shown.panes.filter((pane) => pane.workspace_id === workspaceId);
  if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
  const facts = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId)?.worktree;
  const group = facts && !facts.is_linked_worktree ? shown.workspaces.filter((candidate) => candidate.workspace_id !== workspaceId && candidate.worktree?.repo_key === facts.repo_key).map((candidate) => candidate.workspace_id) : [];
  if (group.length > 0 && !target.group) throw new AdapterError("workspace_group_close_required", `workspace ${workspaceId} has open worktree workspaces: close the group`);
  return [...panes, ...shown.panes.filter((pane) => group.includes(pane.workspace_id))].map((pane) => pane.pane_id);
}

/** A name given to a workspace or a tab, or a pane's (null takes it off, and the terminal's own name shows again). */
export type RenameTarget = { workspace: string; name: string } | { tab: string; name: string } | { pane: string; name: string | null };

/**
 * The label calls of a rename, in the snapshot as shown: a workspace's or tab's name is a label on each
 * of its terminals, so it stays when the first one closes (snapshot.ts `groups` names a group by its
 * first terminal); a pane's is a label on its own (`key: ""` takes a label off, hc terminal.label).
 */
export function renamePlan(shown: SessionSnapshot, target: RenameTarget): { addresses: string[]; labels: Record<string, string> } {
  if ("workspace" in target) {
    const panes = shown.panes.filter((pane) => pane.workspace_id === target.workspace);
    if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${target.workspace} not found`);
    return { addresses: panes.map((pane) => pane.pane_id), labels: { [WORKSPACE_NAME_LABEL]: target.name } };
  }
  if ("tab" in target) {
    const panes = shown.panes.filter((pane) => pane.tab_id === target.tab);
    if (panes.length === 0) throw new AdapterError("tab_not_found", `tab ${target.tab} not found`);
    return { addresses: panes.map((pane) => pane.pane_id), labels: { [TAB_NAME_LABEL]: target.name } };
  }
  if (!shown.panes.some((pane) => pane.pane_id === target.pane)) throw new AdapterError("pane_not_found", `pane ${target.pane} not found`);
  return { addresses: [target.pane], labels: { [PANE_NAME_LABEL]: target.name ?? "" } };
}

/**
 * The labels that move a pane to a new tab, named `tabName`, of another workspace (`place`), or to Other
 * terminals (null): its terminal, its program and its id stay. It takes that workspace's name with it,
 * so it never renames the workspace by becoming its first terminal. `key: ""` takes a label off.
 */
export function moveLabels(place: NewTab | null, tabName: string): Record<string, string> {
  const at = place === null
    ? { [SPACE_LABEL]: "", [TAB_LABEL]: "", [WORKSPACE_NAME_LABEL]: "", [WORKTREE_LABEL]: "" }
    : { [SPACE_LABEL]: place.space, [TAB_LABEL]: place.tab, [WORKSPACE_NAME_LABEL]: place.workspaceName, [WORKTREE_LABEL]: "", ...place.worktree };
  return { ...at, [TAB_NAME_LABEL]: tabName };
}

/** The core as a caller shows it, and whether Ovis keeps its layout (ownsLayout), from one read of the app's document. */
export interface LayoutView { shown: SessionSnapshot; own: boolean }

/** How a caller reads the core into a snapshot. */
export interface ReadOptions {
  firstTurn?: FirstTurn;
  sessionOf?: SessionOf;
  host: CoreHost;
  /** finished terminals too (`terminal.list` with `all`), each through `shown` before the snapshot groups it */
  all?: boolean;
  /** the terminals as the caller shows them; unset, as listed */
  shown?: (terminals: Terminal[]) => HcTerminal[];
}

/**
 * The core read once into the snapshot a caller shows, with whether Ovis keeps its layout (ownsLayout) from the
 * same read of the app's document, and the terminals as hc listed them.
 */
export async function readCore(hc: Pick<HcConnection, "call" | "hello">, read: ReadOptions): Promise<LayoutView & { terminals: Terminal[] }> {
  const [list, app, ovis, hello] = await Promise.all([
    hc.call("terminal.list", read.all ? { all: true } : {}),
    hc.call("doc.get", { name: LAYOUT_DOC }),
    hc.call("doc.get", { name: OVIS_LAYOUT_DOC }),
    hc.hello(),
  ]);
  const shown = buildSnapshot(read.shown ? read.shown(list.terminals) : list.terminals, app.value, hello.version, read.firstTurn, ovis.value, read.sessionOf, read.host);
  return { shown, own: ownsLayout(app.value), terminals: list.terminals };
}

/** What differs between the callers of a layout store. */
export interface LayoutStoreOptions {
  /** the core as the caller shows it, read afresh */
  snapshot: () => Promise<LayoutView>;
  /** a new workspace's or tab's id */
  newId: () => string;
  /** a live terminal's record, refused for one finished or gone */
  terminal: (address: string) => Promise<HcTerminal>;
  /** what every shell the store starts runs in, over the core's own and under a call's `env`; unset, the core's own */
  terminalEnv?: () => Promise<Record<string, string>>;
  /** where a split starts in place of the pane's own folder; unset, that folder */
  startFolder?: (folder: string | undefined) => string | undefined;
}

/** How a new shell starts: in `cwd`, with `env` over the store's, carrying `labels` besides its place. */
export interface NewShell { cwd?: string; env?: Record<string, string>; labels?: Record<string, string> }

type EndResult = { terminal: string; step: "removed" } | { terminal: string; step: "kill" | "rm"; error: unknown };

/**
 * The one writer of Ovis's layout on a core: workspaces and tabs are shells hc starts and labels, names
 * are labels, and order, splits and zoom are one document (docs/herdr-core-layout.md). Each operation
 * reads the core afresh, so whether Ovis keeps the layout is decided on every call, and throws an
 * AdapterError, in herdr's codes, for what it refuses.
 */
export class LayoutStore {
  constructor(private readonly hc: Pick<HcConnection, "call" | "hello">, private readonly options: LayoutStoreOptions) {}

  /** The snapshot, for a call that changes the layout Ovis keeps in labels: refused where the Herdr app arranges this core. */
  async ownLayout(): Promise<SessionSnapshot> {
    const { shown, own } = await this.options.snapshot();
    if (!own) throw new AdapterError("unsupported", "the Herdr app arranges this core's workspaces, tabs and panes");
    return shown;
  }

  async label(addresses: string[], labels: Record<string, string>): Promise<void> {
    await Promise.all(addresses.map((address) => this.hc.call("terminal.label", { terminal: address, labels })));
  }

  /**
   * Ends each terminal and removes its record, as closing a herdr pane does: all at once (a program
   * can take seconds to end), every one tried before the first failure is answered. A terminal in
   * `finished` (its program already ended) only has its record removed.
   */
  async end(addresses: string[], finished: ReadonlySet<string> = new Set()): Promise<void> {
    const failed = (await this.endEach(addresses, finished)).find((one) => one.step !== "removed");
    if (failed) throw failed.error;
  }

  /** Same close, with the outcome for each address in request order, including the call that failed. */
  endEach(addresses: string[], finished: ReadonlySet<string>): Promise<EndResult[]> {
    return Promise.all(addresses.map(async (terminal): Promise<EndResult> => {
      let step: "kill" | "rm" = "kill";
      try {
        if (!finished.has(terminal)) await this.hc.call("terminal.kill", { terminal });
        step = "rm";
        await this.hc.call("terminal.rm", { terminal });
        return { terminal, step: "removed" };
      } catch (error) {
        return { terminal, step, error };
      }
    }));
  }

  /** A shell hc keeps (a lost program comes back as a shell), labeled `labels`: its terminal's address, as hc answered the start. */
  private async runShell(labels: Record<string, string>, { cwd, env }: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
    const given = { ...await this.options.terminalEnv?.(), ...env };
    const used = Object.keys(given).length > 0 ? given : undefined;
    // a terminal a client starts has had nothing finish yet (herdr-app docs/labels.md)
    return (await this.hc.call("terminal.run", { keep: true, labels: { [SEEN_LABEL]: "0", ...labels }, ...(cwd !== undefined ? { cwd } : {}), ...(used ? { env: used } : {}) })).address;
  }

  /**
   * A shell started (`runShell`), answered as herdr answers a new one: the workspace, tab and pane it shows as in the
   * snapshot right after.
   */
  async startShell(labels: Record<string, string>, start: { cwd?: string; env?: Record<string, string> } = {}) {
    const address = await this.runShell(labels, start);
    const { shown } = await this.options.snapshot();
    const root_pane = shown.panes.find((pane) => pane.pane_id === address);
    const tab = root_pane && shown.tabs.find((candidate) => candidate.tab_id === root_pane.tab_id);
    const workspace = root_pane && shown.workspaces.find((candidate) => candidate.workspace_id === root_pane.workspace_id);
    if (!root_pane || !tab || !workspace) throw new AdapterError("internal", `hc started ${address}, but it is not in the snapshot`);
    return { workspace, tab, root_pane };
  }

  /** The worktree label of a workspace's terminals as written, for a terminal joining it; none for a workspace outside git. */
  async worktreeLabelOf(shown: SessionSnapshot, workspaceId: string): Promise<Record<string, string>> {
    if (!shown.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.worktree) return {};
    for (const pane of shown.panes.filter((candidate) => candidate.workspace_id === workspaceId)) {
      const raw = (await this.options.terminal(pane.pane_id)).labels?.[WORKTREE_LABEL];
      if (labeledWorktree({ [WORKTREE_LABEL]: raw ?? "" })) return { [WORKTREE_LABEL]: raw! };
    }
    return {};
  }

  /** One change to Ovis's layout document (`editLayout`). */
  edit<T extends Edited>(change: (layout: OvisLayout) => T): Promise<Omit<T, "layout"> & { changed: boolean }> {
    return editLayout(this.hc, change);
  }

  /**
   * A new workspace: a shell hc starts, labeled with its space and tab as the Herdr app labels its own.
   * The app adopts it there (herdr-app src/window.rs `reconcile`), and until then, or without the app,
   * the snapshot groups it by those labels (snapshot.ts `groups`). Names live in the app's document,
   * which Ovis never writes: a name given here is a label.
   */
  async createWorkspace({ name, cwd, env, labels }: NewShell & { name?: string }) {
    return this.startShell({ ...newShellLabels({ kind: "workspace", space: this.options.newId(), tab: this.options.newId(), name }), ...labels }, { cwd, env });
  }

  /**
   * A new workspace's shell alone (`createWorkspace` without its snapshot): its terminal's address, as hc answered the
   * start. For a caller that shows the core by its own reads: what it throws is hc's answer to the start and nothing
   * else, so a start hc refused is told from a snapshot that could not be read after one it made.
   */
  startWorkspace({ name, cwd, env, labels }: NewShell & { name?: string }): Promise<string> {
    return this.runShell({ ...newShellLabels({ kind: "workspace", space: this.options.newId(), tab: this.options.newId(), name }), ...labels }, { cwd, env });
  }

  /**
   * A new tab of a workspace, starting where that workspace's first pane works, as herdr's does, unless
   * `cwd` says. "Other terminals" is no space of the app's: a tab there is a terminal of its own.
   */
  async createTab(workspaceId: string, { name, cwd, env, labels }: NewShell & { name?: string }) {
    const { shown } = await this.options.snapshot();
    const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace && workspaceId !== OTHER_WORKSPACE_ID) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const folder = cwd ?? (shown.panes.find((pane) => pane.workspace_id === workspaceId)?.cwd || undefined);
    const place: ShellPlace = workspaceId === OTHER_WORKSPACE_ID
      ? { kind: "other", name }
      : { kind: "tab", space: workspaceId, tab: this.options.newId(), workspaceName: workspace!.label, worktree: await this.worktreeLabelOf(shown, workspaceId), name };
    return this.startShell({ ...newShellLabels(place), ...labels }, { cwd: folder, env });
  }

  /** The terminals a close ends in `shown` (closeTargets). Other terminals holds terminals no workspace made: they close one by one. */
  endsOf(shown: SessionSnapshot, target: CloseTarget): string[] {
    if ("workspace" in target && target.workspace === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals holds terminals no workspace made: close them one by one");
    return closeTargets(shown, target);
  }

  /** Ends what a close names in the snapshot read now (endsOf). */
  async close(target: CloseTarget): Promise<void> {
    await this.end(this.endsOf((await this.options.snapshot()).shown, target));
  }

  /** Labels a name (renamePlan). Other terminals holds terminals no workspace made: it has no name to change. */
  async rename(target: RenameTarget): Promise<void> {
    if ("workspace" in target && target.workspace === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals holds terminals no workspace made: it has no name to change");
    const plan = renamePlan(await this.ownLayout(), target);
    await this.label(plan.addresses, plan.labels);
  }

  /**
   * A split: one more shell labeled with the pane's workspace and tab (in `cwd`, else the pane's folder),
   * then the pane's leaf in Ovis's document turned into a split holding both. hc has no focus to move.
   * Answers the new pane as the snapshot right after its start showed it.
   */
  async split(paneId: string, direction: SplitDirection, { cwd, labels }: Pick<NewShell, "cwd" | "labels"> = {}): Promise<PaneInfo> {
    const shown = await this.ownLayout();
    const pane = shown.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
    const held = (await this.options.terminal(paneId)).labels ?? {};
    // only a tab its labels make takes another pane: one in Other terminals, or a helper's under its parent's tab, is one terminal's own
    if (held[SPACE_LABEL] !== pane.workspace_id || held[TAB_LABEL] !== pane.tab_id) throw new AdapterError("unsupported", `pane ${paneId} is in a tab of its own terminal: it does not split`);
    if (!layoutCalls(await this.hc.hello())) throw new AdapterError("unsupported", "this herdr-core keeps no documents Ovis can write");
    // no shell for a split the document cannot hold
    if (foreignLayout((await this.hc.call("doc.get", { name: OVIS_LAYOUT_DOC })).value)) throw new AdapterError("unsupported", "a newer Ovis keeps this core's layout");
    // the workspace's name as shown, and the tab's own where it has one, stay when the split pane closes
    const workspaceName = shown.workspaces.find((candidate) => candidate.workspace_id === pane.workspace_id)?.label;
    const names = { ...(workspaceName ? { [WORKSPACE_NAME_LABEL]: workspaceName } : {}), ...(held[TAB_NAME_LABEL] ? { [TAB_NAME_LABEL]: held[TAB_NAME_LABEL] } : {}), ...(held[WORKTREE_LABEL] ? { [WORKTREE_LABEL]: held[WORKTREE_LABEL] } : {}) };
    const own = pane.cwd ?? undefined;
    const folder = cwd ?? (this.options.startFolder ? this.options.startFolder(own) : own);
    const { root_pane } = await this.startShell({ [SPACE_LABEL]: pane.workspace_id, [TAB_LABEL]: pane.tab_id, ...names, ...labels }, folder ? { cwd: folder } : {});
    try {
      await this.edit(splitEdit(paneId, root_pane.pane_id, direction));
    } catch (error) {
      // the shell runs and shows to the right of the tab (layout-doc.ts `reconcile`): said, so nobody splits again for it
      const reason = error instanceof AdapterError || error instanceof HcError ? error.message : String(error);
      throw new AdapterError("layout_not_saved", `pane ${root_pane.pane_id} started, but could not be placed ${direction === "right" ? "right of" : "below"} ${paneId} (${reason}); it shows at the right of the tab`);
    }
    return root_pane;
  }

  /** A tab moved within its workspace (tabOrderEdit); answers the workspace it is in. */
  async moveTab(tabId: string, insertIndex: unknown): Promise<{ changed: boolean; reason: string | null; workspace: string }> {
    const shown = await this.ownLayout();
    const tab = shown.tabs.find((candidate) => candidate.tab_id === tabId);
    if (!tab) throw new AdapterError("tab_not_found", `tab ${tabId} not found`);
    const siblings = shown.tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id).map((candidate) => candidate.tab_id);
    return { ...await this.edit(tabOrderEdit(tab.workspace_id, tabId, siblings, insertIndex)), workspace: tab.workspace_id };
  }

  /** A workspace moved among the workspaces (workspaceOrderEdit); Other terminals stays last. */
  async moveWorkspace(workspaceId: string, insertIndex: unknown): Promise<{ changed: boolean; reason: string | null }> {
    if (workspaceId === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals stays last");
    const shown = await this.ownLayout();
    if (!shown.workspaces.some((candidate) => candidate.workspace_id === workspaceId)) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const listed = shown.workspaces.map((candidate) => candidate.workspace_id);
    return this.edit(workspaceOrderEdit(workspaceId, listed, insertIndex));
  }

  /**
   * A pane moved to a new tab of another workspace, or to Other terminals, by its labels alone
   * (moveLabels). A helper with no labels shows under its parent's tab (snapshot.ts `groups`), never in
   * Other terminals. Answers the pane as it was before.
   */
  async moveToNewTab(paneId: string, workspaceId: string, tabName: string): Promise<PaneInfo> {
    const before = await this.ownLayout();
    const pane = before.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new AdapterError("pane_not_found", `pane ${paneId} not found`);
    const workspace = before.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!workspace && workspaceId !== OTHER_WORKSPACE_ID) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
    const parent = workspaceId === OTHER_WORKSPACE_ID ? (await this.options.terminal(paneId)).parent : undefined;
    if (parent && parent !== paneId && before.panes.some((candidate) => candidate.pane_id === parent)) throw new AdapterError("unsupported", `pane ${paneId} shows under the terminal that started it: it cannot go to Other terminals`);
    const place = workspaceId === OTHER_WORKSPACE_ID ? null : { space: workspaceId, tab: this.options.newId(), workspaceName: workspace!.label, worktree: await this.worktreeLabelOf(before, workspaceId) };
    await this.label([paneId], moveLabels(place, tabName));
    return pane;
  }
}
