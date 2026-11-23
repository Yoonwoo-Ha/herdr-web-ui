/**
 * The screen's layout writes: herdr's create, close, rename, split, zoom, resize, swap, move and reorder actions,
 * performed through the shared layout operations the server performs the browser's with (server/herdr-core/layout-ops.ts).
 * Every rule of the layout lives there; this module holds only the screen's policy on top:
 * - one write in flight: an action chosen while one is under way is dropped with a notice, never queued;
 * - nothing is sent again: an answer that never came (the line ended, a timeout) is reported as unknown, and the
 *   world shows what the core holds once the line is back;
 * - nothing is drawn ahead: the picture changes only when the core's documents and terminals say so;
 * - a close ends only the terminals the user saw: their addresses and created_ms are read again first.
 */

import type { HcConnection } from "../../server/herdr-core/connection.ts";
import { HcError, HcReplyError } from "../../server/herdr-core/connection.ts";
import { AdapterError } from "../../server/herdr-core/errors.ts";
import { foreignLayout, leaves, OVIS_LAYOUT_DOC, type PaneDirection, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type CloseTarget, layoutCalls, LayoutStore, type LayoutView, newLayoutId, ownsLayout, readCore, RESIZE_STEP, resizeEdit, swapEdit, TERMINAL_COLOUR, zoomEdit } from "../../server/herdr-core/layout-ops.ts";
import { type CoreHost, type FirstTurn, LAYOUT_DOC, OTHER_WORKSPACE_ID } from "../../server/herdr-core/snapshot.ts";
import { errorCode } from "../crash.ts";
import type { RunEffect, Seen } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";
import { keepsPlace } from "./world.ts";

/** What a layout write tells the screen: a notice (`calm` when it reports how things are, not a failure), or a pane to focus once shown. */
export type LayoutAnswer =
  | { readonly type: "notice"; readonly code: string; readonly data: Readonly<Record<string, string>>; readonly calm?: true }
  | { readonly type: "follow"; readonly target: Target; readonly away: string | null };

/** What a layout write did that the screen is still to show: the terminals a close ended (none for any other write). */
export interface LayoutDone {
  readonly ended: readonly string[];
  readonly dropInput?: "layout_unknown" | "not_closed";
  readonly refreshZoom?: true;
  /** The destination this successful create or move established, independent of subsequent focus changes. */
  readonly inputTarget?: string;
}

const NOTHING_ENDED: LayoutDone = { ended: [] };

/** A failed connection or a core reporting that it too lost the answer (for example, on a remote machine). */
function unknownAnswer(error: unknown): boolean {
  return error instanceof HcError && (!(error instanceof HcReplyError) || ["timeout", "offline", "closed"].includes(error.kind));
}

interface LayoutWritesOptions {
  /** the core's line (the screen's link) */
  hc: Pick<HcConnection, "call" | "hello">;
  /** how the screen reads terminals into the snapshot, the same as its world (world.ts `CoreWorld.model`) */
  model: { readonly firstTurn: FirstTurn; readonly host: CoreHost };
  /** the folder the screen was opened in: a new workspace starts there */
  folder: string | undefined;
  answer: (answer: LayoutAnswer) => void;
}

const SPLITS: Readonly<Record<string, SplitDirection>> = { split_vertical: "right", split_horizontal: "down" };
const SWAPS: Readonly<Record<string, PaneDirection>> = { swap_pane_left: "left", swap_pane_down: "down", swap_pane_up: "up", swap_pane_right: "right" };
const RESIZES: Readonly<Record<string, PaneDirection>> = { resize_pane_left: "left", resize_pane_down: "down", resize_pane_up: "up", resize_pane_right: "right" };

/** The core read afresh: the snapshot as the screen shows it, when the core made each terminal, and those whose program already ended. */
interface Fresh { readonly view: LayoutView; readonly created: ReadonlyMap<string, number>; readonly finished: ReadonlySet<string> }

/** Whether the terminals a close ends now are exactly the ones the user saw, each made at the time it was shown. */
function sameTerminals(ends: readonly string[], seen: readonly Seen[], created: ReadonlyMap<string, number>): boolean {
  if (ends.length !== seen.length) return false;
  const now = new Set(ends);
  return seen.every((one) => now.has(one.id) && (one.created === null || created.get(one.id) === one.created));
}

/** The place `id` moves to among `ids`, as herdr's insertion boundary: one up or one down; null at that end. */
function oneStep(ids: readonly string[], id: string, down: boolean): number | null {
  const at = ids.indexOf(id);
  if (at < 0 || (down ? at === ids.length - 1 : at === 0)) return null;
  return down ? at + 2 : at - 1;
}

export class LayoutWrites {
  private readonly store: LayoutStore;
  private busy = false;

  constructor(private readonly options: LayoutWritesOptions) {
    const { hc } = options;
    this.store = new LayoutStore(hc, {
      snapshot: async () => (await this.fresh()).view,
      newId: newLayoutId,
      terminal: async (address) => {
        const found = await hc.call("terminal.get", { terminal: address });
        if (found.state !== "live") throw new AdapterError("pane_not_found", `terminal ${address} has finished`);
        return found;
      },
      terminalEnv: async () => ({ ...TERMINAL_COLOUR }),
    });
  }

  /** Whether `effect` is a layout action: one `run` performs. */
  writes(effect: RunEffect): boolean {
    return this.work(effect) !== null;
  }

  /**
   * Performs `effect` when it is a layout action and answers when it is done, with the terminals it ended (it never
   * rejects: a failure is a notice); null for any other action.
   */
  run(effect: RunEffect): Promise<LayoutDone> | null {
    const work = this.work(effect);
    if (work === null) return null;
    if (this.busy) {
      this.notice("layout_busy", { action: effect.action });
      return Promise.resolve(NOTHING_ENDED);
    }
    this.busy = true;
    return work().then((done) => done ?? NOTHING_ENDED, async (error: unknown): Promise<LayoutDone> => {
      await this.refused(effect.action, error);
      return unknownAnswer(error) ? { ended: [], dropInput: "layout_unknown" } : effect.action === "zoom_follow" ? { ended: [], refreshZoom: true } : NOTHING_ENDED;
    }).finally(() => {
      this.busy = false;
    });
  }

  private work(effect: RunEffect): (() => Promise<LayoutDone | void>) | null {
    const { action, target } = effect;
    const id = target?.id;
    const store = this.store;
    if (action === "new_workspace") {
      return async () => this.follow((await store.createWorkspace(this.options.folder === undefined ? {} : { cwd: this.options.folder })).root_pane.pane_id, null);
    }
    if (id === undefined) return null;
    if (action === "new_tab") return async () => this.follow((await store.createTab(id, effect.name ? { name: effect.name } : {})).root_pane.pane_id, null);
    if (Object.hasOwn(SPLITS, action)) return async () => this.follow((await store.split(id, SPLITS[action]!)).pane_id, null);
    if (action === "close_pane" || action === "close_tab" || action === "close_workspace") {
      const close: CloseTarget = action === "close_pane" ? { pane: id } : action === "close_tab" ? { tab: id } : { workspace: id, group: false };
      return () => this.close(action, close, effect.seen ?? []);
    }
    if (action === "rename_workspace") return () => store.rename({ workspace: id, name: effect.name ?? "" });
    if (action === "rename_tab") return () => store.rename({ tab: id, name: effect.name ?? "" });
    if (action === "rename_pane") return () => store.rename({ pane: id, name: effect.name || null });
    if (action === "zoom") return async () => {
      const result = await store.edit(zoomEdit(id, "toggle"));
      if (result.changed) return { ended: [], refreshZoom: true };
      this.unchanged(action, result);
      return NOTHING_ENDED;
    };
    if (action === "zoom_follow" && effect.zoomTab !== undefined) {
      return async () => {
        await store.edit((layout) => {
          const tab = layout.workspaces.flatMap((workspace) => workspace.tabs).find((candidate) => candidate.id === effect.zoomTab);
          // A different writer may have unzoomed this tab or moved the target while the intent waited.
          return tab && tab.zoomed !== null && leaves(tab.root).includes(id)
            ? zoomEdit(id, "on")(layout)
            : { layout: null, reason: "stale" };
        });
        return { ended: [], refreshZoom: true };
      };
    }
    if (Object.hasOwn(SWAPS, action)) return async () => this.unchanged(action, await store.edit((layout) => {
      const result = swapEdit(id, null, SWAPS[action]!)(layout);
      return effect.neighbor !== undefined && result.target !== effect.neighbor
        ? { layout: null, reason: "target_changed" } : result;
    }));
    if (Object.hasOwn(RESIZES, action)) return async () => this.unchanged(action, await store.edit(resizeEdit(id, RESIZES[action]!, RESIZE_STEP)));
    if (action === "move_tab_previous" || action === "move_tab_next") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const workspace = shown.tabs.find((tab) => tab.tab_id === id)?.workspace_id;
        const to = oneStep(shown.tabs.filter((tab) => tab.workspace_id === workspace).map((tab) => tab.tab_id), id, action === "move_tab_next");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "move_tab_next" ? "last" : "first" });
        else this.unchanged(action, await store.moveTab(id, to));
      };
    }
    if (action === "navigate_move_up" || action === "navigate_move_down") {
      return async () => {
        const { shown } = (await this.fresh()).view;
        const to = oneStep(shown.workspaces.map((workspace) => workspace.workspace_id).filter((one) => one !== OTHER_WORKSPACE_ID), id, action === "navigate_move_down");
        if (to === null) this.unchanged(action, { changed: false, reason: action === "navigate_move_down" ? "last" : "first" });
        else this.unchanged(action, await store.moveWorkspace(id, to));
      };
    }
    if (action === "navigate_move_pane" && effect.to !== undefined) {
      const to = effect.to;
      return async () => this.follow(id, (await store.moveToNewTab(id, to, effect.name ?? "")).tab_id);
    }
    return null;
  }

  /** The core as the screen shows it, read now (the same terminals its world shows: world.ts `keepsPlace`), with each terminal's created_ms and state. */
  private async fresh(): Promise<Fresh> {
    const { terminals, ...view } = await readCore(this.options.hc, { ...this.options.model, all: true, shown: (listed) => listed.map(keepsPlace) });
    return {
      view,
      created: new Map(terminals.map((terminal) => [terminal.address, terminal.created_ms])),
      finished: new Set(terminals.filter((terminal) => terminal.state !== "live").map((terminal) => terminal.address)),
    };
  }

  /** A close, once the core still holds exactly the terminals the user saw: it ends those and no other; anything else ends nothing. */
  private async close(action: string, target: CloseTarget, seen: readonly Seen[]): Promise<LayoutDone> {
    let fresh: Fresh;
    try {
      fresh = await this.fresh();
    } catch (error) {
      // Even a lost answer here is only a lost read: the close has not sent a kill or removal.
      this.notice("layout_refused", { action, reason: errorCode(error) });
      return NOTHING_ENDED;
    }
    const { view, created, finished } = fresh;
    const ends = this.store.endsOf(view.shown, target);
    if (!sameTerminals(ends, seen, created)) {
      this.notice("target_changed", { action });
      return NOTHING_ENDED;
    }
    const results = await this.store.endEach(ends, finished);
    const ended: string[] = [];
    let dropInput: LayoutDone["dropInput"];
    const failure = results.find((one) => one.step !== "removed");
    for (const one of results) {
      if (one.step === "removed" || (one.error instanceof HcReplyError && one.error.kind === "not_found")) ended.push(one.terminal);
      else if (!(one.error instanceof HcReplyError) || unknownAnswer(one.error)) dropInput = "layout_unknown";
      // The kill succeeded (or the program was already finished), but its record remains. Don't type into it.
      else if (one.step === "rm") dropInput ??= "not_closed";
    }
    if (dropInput === "layout_unknown") this.notice("layout_unknown", { action });
    else if (failure) await this.refused(action, failure.error);
    return dropInput ? { ended, dropInput } : { ended };
  }

  private follow(pane: string, away: string | null): LayoutDone {
    this.options.answer({ type: "follow", target: { kind: "pane", id: pane }, away });
    return { ended: [], inputTarget: pane };
  }

  private notice(code: string, data: Readonly<Record<string, string>>, calm = false): void {
    this.options.answer({ type: "notice", code, data, ...(calm || data.action === "zoom_follow" ? { calm: true } : {}) });
  }

  /** An edit that changed nothing says why, calmly: the precondition was gone on the document as it is now. */
  private unchanged(action: string, answer: { changed: boolean; reason: string | null }): void {
    if (!answer.changed) this.notice("layout_unchanged", { action, reason: answer.reason ?? "unchanged" }, true);
  }

  /** One notice per failed action, by its stable code. */
  private async refused(action: string, error: unknown): Promise<void> {
    if (error instanceof AdapterError) {
      if (error.code === "unsupported") this.notice(...await this.unsupported(action));
      else if (error.code === "layout_not_saved") this.notice("layout_not_saved", { action });
      else this.notice("layout_refused", { action, reason: error.code });
      return;
    }
    if (error instanceof HcError && error.kind === "conflict") this.notice("layout_conflict", { action }, true);
    // the line ended or the answer never came: what happened is unknown, and nothing is sent again
    else if (unknownAnswer(error)) this.notice("layout_unknown", { action });
    else this.notice("layout_refused", { action, reason: errorCode(error) });
  }

  /** Why the store refused: the Herdr app arranges the core, a newer Ovis wrote the layout, or the core keeps no documents. */
  private async unsupported(action: string): Promise<[string, Record<string, string>]> {
    const { hc } = this.options;
    try {
      const [app, ovis, hello] = await Promise.all([hc.call("doc.get", { name: LAYOUT_DOC }), hc.call("doc.get", { name: OVIS_LAYOUT_DOC }), hc.hello()]);
      if (!ownsLayout(app.value)) return ["app_owned", { action }];
      if (!layoutCalls(hello)) return ["layout_refused", { action, reason: "no_documents" }];
      if (foreignLayout(ovis.value)) return ["layout_refused", { action, reason: "foreign_layout" }];
    } catch {
      // the reads failed too: the store's own answer stands
    }
    return ["layout_refused", { action, reason: "unsupported" }];
  }
}
