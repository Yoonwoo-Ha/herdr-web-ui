/**
 * What a mouse event does on the screen, from the hit map of the last frame: the press makes a grab, and the drag,
 * the release and the wheel follow it. Over chrome a press selects a tab, a workspace or an agent's pane, runs the
 * sidebar toggle, or grabs a divider. Over a pane that is not focused a press only focuses it. Over the focused
 * pane the event goes to its program, in its own grid's cells, when the program asked for a mouse mode and shift
 * is not held; otherwise the wheel scrolls the pane's history here and a drag selects, and the release copies.
 * A program gets a drag and its release only if its press went there, it is focused, and the grab is still active.
 * Over an open overlay only its close control and its entries (the menu's) act.
 * The answer is a list of acts for the loop to perform; nothing here writes, sends or draws.
 */
import { isDeepStrictEqual } from "node:util";
import type { LayoutNode, SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type DividerName, dividerAt } from "../core/divider.ts";
import type { EngineHistory, ScreenPoint, ScreenRange } from "../emulator/index.ts";
import type { MouseInput } from "../model/effects.ts";
import type { Target } from "../model/focus.ts";
import type { Rect, SplitCells } from "./geometry.ts";
import { type GridCell, type HitMap, ordered } from "./paint.ts";

/** Rows the history moves for one notch of the wheel. */
const WHEEL_ROWS = 3;

/** What the pointer reads of a shown pane, as the last frame drew it. */
export interface PaneLook {
  /** the screen cells its terminal shows in */
  readonly rect: Rect;
  /** the grid row drawn at the rectangle's top (a terminal taller than its cells is drawn clipped) */
  readonly top: number;
  /** the grid column drawn at the rectangle's left (copy mode pans a terminal wider than its cells) */
  readonly left: number;
  /** the terminal's real grid */
  readonly grid: { readonly cols: number; readonly rows: number };
  /** the program asked for a mouse mode */
  readonly programMouse: boolean;
  /** the active screen is the alternate one */
  readonly altScreen: boolean;
  /** the emulator's count of screen switches and resets (EngineModes `screens`), which also moves when a switch was undone */
  readonly screen: number;
  /** the emulator drawn: a new one (a new attach) holds none of the old one's selection */
  readonly emulator: object;
  readonly history: EngineHistory;
}

/** A pane's displayed cells: program mouse routing still reads the live modes separately. */
export type PanePicture = Omit<PaneLook, "programMouse"> & { readonly contentVersion: number };

/** What the pointer reads of the screen at an event. */
export interface PointerScene {
  readonly hits: HitMap | null;
  /** the pane input goes to */
  readonly focus: string | null;
  /** the shown tab and its tree as drawn, for naming a divider */
  readonly tab: { readonly id: string; readonly root: LayoutNode } | null;
  readonly splits: readonly SplitCells[];
  look(pane: string): PaneLook | null;
  painted(pane: string): PanePicture | null;
  /** The model checks a painted menu identity before a press can cancel another button's gesture. */
  acceptsMenu?(entry: string): boolean;
}

export type PointerAct =
  | { readonly kind: "select"; readonly target: Target }
  | { readonly kind: "action"; readonly action: "toggle_sidebar" | "new_workspace" | "menu" }
  /** the top overlay's entry with this key (the menu's `entryKey`, as painted) was clicked */
  | { readonly kind: "choose"; readonly entry: string }
  /** to the focused pane's program, in its grid's cells */
  | { readonly kind: "forward"; readonly pane: string; readonly event: MouseInput }
  /** show the pane's screen this many rows above its newest rows */
  | { readonly kind: "scroll"; readonly pane: string; readonly fromBottom: number }
  | { readonly kind: "copy"; readonly pane: string; readonly range: ScreenRange; readonly contentVersion: number }
  /** the dragged divider's ratio; `done` at the release */
  | { readonly kind: "divider"; readonly grab: number; readonly tab: string; readonly name: DividerName; readonly ratio: number; readonly done: boolean }
  /** the selection changed: the next frame draws it */
  | { readonly kind: "redraw" }
  /** the top overlay's close control was clicked */
  | { readonly kind: "close_overlay" };

/** A queued report validated and applied to its own gesture at replay time. */
export type DeferredMouse = (over: "overlay" | "screen", scene: PointerScene) => PointerAct[];

type Grab =
  | { readonly kind: "none" }
  | { readonly kind: "forward"; readonly pane: string; readonly button: MouseInput["button"]; readonly attachment: symbol; readonly screen: number; last: MouseInput }
  /** bound to the emulator and the screen (main or alternate) it was pressed on: the anchor means nothing on another */
  | ({ readonly kind: "select"; readonly pane: string; readonly anchor: ScreenPoint; readonly contentVersion: number } & ScreenOf)
  | { readonly kind: "divider"; readonly id: number; readonly tab: string; readonly name: DividerName; readonly rect: Rect; readonly direction: SplitDirection; readonly offset: number; moved: number | null };

interface Selection extends ScreenOf { readonly pane: string; readonly start: ScreenPoint; readonly end: ScreenPoint }

/** The screen a selection lies on: its emulator, the active screen, and the count of switches that led to it. */
interface ScreenOf { readonly emulator: object; readonly altScreen: boolean; readonly screen: number }
const screenOf = (look: PanePicture): ScreenOf => ({ emulator: look.emulator, altScreen: look.altScreen, screen: look.screen });
const onScreen = (look: ScreenOf, held: ScreenOf): boolean =>
  look.emulator === held.emulator && look.altScreen === held.altScreen && look.screen === held.screen;

const NONE: Grab = { kind: "none" };
const isWheel = (event: MouseInput): boolean => event.button !== undefined && event.button.startsWith("wheel");

/** How many rows above its newest rows a pane's screen shows. */
export function rowsAboveBottom(look: Pick<PaneLook, "history" | "grid">): number {
  return Math.max(0, look.history.total - look.grid.rows - look.history.viewportTop);
}

/** One screen's pointer: its grab, the selection and the grabs counted for the divider writes. */
export class Pointer {
  private grab: Grab = NONE;
  private selection: Selection | null = null;
  private grabs = 0;
  private readonly identities = new WeakMap<object, symbol>();

  /** A hold's gesture ledger: accepted presses open owners and matching releases close them in read order. */
  defer(): { continuation(event: MouseInput): boolean; bind(event: MouseInput, scene: PointerScene): DeferredMouse } {
    type Owner = { pane: string; button: MouseInput["button"]; live: Extract<Grab, { kind: "forward" }> | null };
    let owner: Owner | null = this.grab.kind === "forward" ? { pane: this.grab.pane, button: this.grab.button, live: this.grab } : null;
    const continuation = (event: MouseInput) => owner !== null &&
      (event.action === "motion" || event.action === "release") && event.button === owner.button;
    return {
      continuation,
      bind: (event, scene) => {
        const from = owner;
        if (from !== null && continuation(event)) {
          const mapping = (now: PointerScene) => {
            const picture = now.painted(from.pane);
            return [picture?.rect, picture?.top, picture?.left, picture?.grid];
          };
          const cells = mapping(scene);
          if (event.action === "release") owner = null;
          return (_over, now) => {
            const live = from.live;
            // An old continuation owns neither a replacement grab nor a press that never reached its program.
            if (live === null || this.grab !== live) return [];
            if (this.pressedScreen(live, now) === null || !isDeepStrictEqual(cells, mapping(now))) return this.cancel(now, event.at);
            return this.mouse("screen", event, now);
          };
        }
        let started: Owner | null = null;
        if (event.action === "press" && !isWheel(event)) {
          const hit = scene.hits?.at(event.col, event.row);
          owner = null;
          if (hit && "pane" in hit && hit.pane === scene.focus && scene.look(hit.pane)?.programMouse && !event.mods.shift) {
            owner = started = { pane: hit.pane, button: event.button, live: null };
          }
        }
        const matches = this.bind(event, scene);
        return (over, now) => {
          const valid = matches(now);
          const acts = valid ? this.mouse(over, event, now) : this.cancel(now, event.at);
          if (started !== null) started.live = valid && this.grab.kind === "forward" ? this.grab : null;
          return acts;
        };
      },
    };
  }

  private identity(object: object): symbol {
    const known = this.identities.get(object);
    if (known) return known;
    const token = Symbol();
    this.identities.set(object, token);
    return token;
  }

  private paneStamp(pane: string, scene: PointerScene) {
    const p = scene.painted(pane);
    const l = scene.look(pane);
    return [p && this.identity(p.emulator), p?.contentVersion, p?.screen, p?.altScreen, p?.rect, p?.grid, p?.top, p?.left, p?.history,
      l && this.identity(l.emulator), l?.screen, l?.altScreen, l?.programMouse, l?.grid];
  }

  /** On a reported focus change, cancel a forward grab on any other pane. Selection and divider grabs keep their anchors. */
  focusChanged(pane: string | null): void {
    if (this.grab.kind === "forward" && this.grab.pane !== pane) this.grab = NONE;
  }

  /** A report belongs to the program screen that got the press, not merely the one seen when the report was read. */
  private pressedScreen(grab: Extract<Grab, { kind: "forward" }>, scene: PointerScene): PaneLook | null {
    const live = grab.pane === scene.focus ? scene.look(grab.pane) : null;
    return live?.programMouse && live.screen === grab.screen && this.identity(live.emulator) === grab.attachment ? live : null;
  }

  /** Bind a deferred report without retaining a frame's hit map, tree or grids. A redraw of the same
   * cells is harmless. A different hit, named divider, viewport, screen or program route is not. */
  bind(event: MouseInput, scene: PointerScene): (now: PointerScene) => boolean {
    const hit = scene.hits?.at(event.col, event.row);
    const focus = scene.focus;
    const site = mouseSite(event, scene);
    const panes = new Set([focus, hit && "pane" in hit ? hit.pane : null,
      this.grab.kind === "select" || this.grab.kind === "forward" ? this.grab.pane : null]);
    const pictures = new Map([...panes].flatMap((pane) => pane === null ? [] : [[pane, this.paneStamp(pane, scene)] as const]));
    return (now) => {
      if (now.focus !== focus || !isDeepStrictEqual(site, mouseSite(event, now))) return false;
      // Earlier reports in this queue may just have established the grab. Its pane, not the
      // pane under the moving pointer, owns a drag; a divider does not depend on terminal output.
      const grab = event.action !== "press" || isWheel(event) ? this.grab : NONE;
      const pane = grab.kind === "select" || grab.kind === "forward" ? grab.pane
        : grab.kind !== "divider" && hit && "pane" in hit ? hit.pane : null;
      return pane === null || isDeepStrictEqual(pictures.get(pane), this.paneStamp(pane, now));
    };
  }

  /** A stale report must not start or continue a grab. Close out only effects already delivered. */
  cancel(scene: PointerScene, at: number): PointerAct[] {
    const grab = this.grab;
    const acts = finished(grab);
    this.grab = NONE;
    // Balance a press already delivered, on its original attachment at its last valid cell. A stale
    // queued press never reached a program, so it has no forward grab to release.
    if (grab.kind === "forward" && this.pressedScreen(grab, scene)) {
      acts.push({ kind: "forward", pane: grab.pane, event: { ...grab.last, button: grab.button, action: "release", at } });
    }
    if (this.selection) acts.push({ kind: "redraw" });
    this.selection = null;
    return acts;
  }

  mouse(over: "overlay" | "screen", event: MouseInput, scene: PointerScene): PointerAct[] {
    // A refused press on another button has no release to forward and cannot end the initiating button's grab.
    if (event.action === "release" && this.grab.kind === "forward" && event.button !== this.grab.button) return [];
    if (over === "overlay") {
      // an open overlay owns the mouse: nothing reaches the chrome or a pane under it; its close control closes it.
      // A gesture that began before it opened ends at its release: a program that got the press gets that release,
      // a divider drag ends at the last ratio it moved to, and a selection is dropped, so nothing of it goes on once
      // the overlay closes. A wheel notch over it (a press report) does nothing and leaves the held grab alone.
      if (isWheel(event)) return [];
      if (event.action === "release") {
        const grab = this.grab;
        this.grab = NONE;
        if (grab.kind === "divider") return finished(grab);
        const look = grab.kind === "forward" ? this.pressedScreen(grab, scene) : null;
        return grab.kind === "forward" && look ? [{ kind: "forward", pane: grab.pane, event: inGrid(event, look) }] : [];
      }
      if (event.action !== "press" || event.button !== "left") return [];
      const hit = scene.hits?.at(event.col, event.row);
      if (!hit || !("part" in hit) || !hit.part.startsWith("overlay:")) return [];
      const [kind, entry] = splitId(hit.id);
      if (hit.id !== "close" && (kind !== "menu" || entry === "")) return [];
      if (kind === "menu" && scene.acceptsMenu?.(entry) === false) return [{ kind: "choose", entry }];
      // End any delivered gesture before the choice can change focus or reject a stale entry.
      const dropped = this.cancel(scene, event.at);
      if (hit.id === "close") return [...dropped, { kind: "close_overlay" }];
      return [...dropped, { kind: "choose", entry }];
    }
    if (isWheel(event)) return this.wheel(event, scene);
    if (event.action === "press") return this.press(event, scene);
    const grab = this.grab;
    if (event.action === "release") this.grab = NONE;
    switch (grab.kind) {
      case "forward": {
        const look = this.pressedScreen(grab, scene);
        if (!look) {
          this.grab = NONE;
          return [];
        }
        grab.last = inGrid(event, look);
        return [{ kind: "forward", pane: grab.pane, event: grab.last }];
      }
      case "select":
        return this.extend(grab, event, scene);
      case "divider":
        return this.drag(grab, event);
      case "none": {
        // with no grab only a move with no button held goes on: the focused program sees it only if it asked for any
        // motion (the pane machine's rule). A drag whose press went to no program, and its release, go nowhere.
        if (event.action !== "motion" || event.button !== undefined) return [];
        const hit = scene.hits?.at(event.col, event.row);
        const pane = hit && "pane" in hit ? hit.pane : null;
        const look = pane !== null && pane === scene.focus ? scene.look(pane) : null;
        return look && pane !== null && look.programMouse && !event.mods.shift ? [{ kind: "forward", pane, event: inGrid(event, look) }] : [];
      }
    }
  }

  /** Before input is routed to `pane`, drop a forward grab on any other pane and show the newest rows. */
  typed(pane: string, look: PaneLook | null): PointerAct[] {
    if (this.grab.kind === "forward" && this.grab.pane !== pane) this.grab = NONE;
    return look && rowsAboveBottom(look) > 0 ? [{ kind: "scroll", pane, fromBottom: 0 }] : [];
  }

  /**
   * The selection to draw in `pane`, in its grid's cells; null when there is none there. A selection whose pane lost
   * the focus, got a new emulator or switched its alternate screen is dropped here; a selection drag on a pane drawn
   * with another emulator or screen than its press is cancelled too, so its release copies nothing even after the
   * pane switched back. A drag whose pane only lost the focus keeps its anchor.
   */
  shown(pane: string, focus: string | null, look: PanePicture | null): { start: GridCell; end: GridCell } | null {
    const grab = this.grab;
    if (grab.kind === "select" && grab.pane === pane && look && !onScreen(look, grab)) this.grab = NONE;
    const selection = this.selection;
    if (!selection || selection.pane !== pane) return null;
    if (pane !== focus || !look || !onScreen(look, selection)) {
      this.selection = null;
      return null;
    }
    const top = look.history.viewportTop;
    return { start: { x: selection.start.x, y: selection.start.y - top }, end: { x: selection.end.x, y: selection.end.y - top } };
  }

  private press(event: MouseInput, scene: PointerScene): PointerAct[] {
    const dropped: PointerAct[] = [...finished(this.grab), ...(this.selection ? [{ kind: "redraw" } as const] : [])];
    this.grab = NONE;
    this.selection = null;
    const hit = scene.hits?.at(event.col, event.row) ?? null;
    if (hit === null) return dropped;
    if ("pane" in hit) {
      if (hit.pane !== scene.focus) return [...dropped, { kind: "select", target: { kind: "pane", id: hit.pane } }];
      const look = scene.look(hit.pane);
      if (!look) return dropped;
      if (look.programMouse && !event.mods.shift) {
        const press = inGrid(event, look);
        this.grab = { kind: "forward", pane: hit.pane, button: event.button, attachment: this.identity(look.emulator), screen: look.screen, last: press };
        return [...dropped, { kind: "forward", pane: hit.pane, event: press }];
      }
      const picture = scene.painted(hit.pane);
      if (event.button === "left" && picture && onScreen(look, picture)) {
        this.grab = { kind: "select", pane: hit.pane, anchor: pointOf(event, picture), contentVersion: picture.contentVersion, ...screenOf(picture) };
      }
      return dropped;
    }
    if (event.button !== "left") return dropped;
    const [kind, id] = splitId(hit.id);
    if (kind === "tab" || kind === "workspace") return [...dropped, { kind: "select", target: { kind, id } }];
    if (kind === "agent") return [...dropped, { kind: "select", target: { kind: "pane", id } }];
    if (hit.id === "toggle_sidebar" || hit.id === "new_workspace" || hit.id === "menu") return [...dropped, { kind: "action", action: hit.id }];
    const divider = namedSplit(hit.id, scene);
    if (divider && scene.tab) {
      const { split, name } = divider;
      const across = split.direction === "right";
      const first = (across ? split.divider.x - split.rect.x : split.divider.y - split.rect.y) + 1;
      const at = (across ? event.col - split.rect.x : event.row - split.rect.y) + 1;
      this.grab = { kind: "divider", id: ++this.grabs, tab: scene.tab.id, name, rect: split.rect, direction: split.direction, offset: first - at, moved: null };
    }
    return dropped;
  }

  private wheel(event: MouseInput, scene: PointerScene): PointerAct[] {
    const grabbed = this.grab.kind === "forward" || this.grab.kind === "select" ? this.grab.pane : null;
    const hit = grabbed === null ? scene.hits?.at(event.col, event.row) ?? null : null;
    const pane = grabbed ?? (hit && "pane" in hit ? hit.pane : null);
    // the wheel acts on the focused pane only: over another one it neither scrolls nor focuses
    if (pane === null || pane !== scene.focus) return [];
    const look = scene.look(pane);
    if (!look) return [];
    if (look.programMouse && !event.mods.shift) return [{ kind: "forward", pane, event: inGrid(event, look) }];
    if (event.button !== "wheelUp" && event.button !== "wheelDown") return [];
    const now = rowsAboveBottom(look);
    const next = event.button === "wheelUp" ? Math.min(now + WHEEL_ROWS, look.history.scrollback) : Math.max(0, now - WHEEL_ROWS);
    return next === now ? [] : [{ kind: "scroll", pane, fromBottom: next }];
  }

  private extend(grab: Extract<Grab, { kind: "select" }>, event: MouseInput, scene: PointerScene): PointerAct[] {
    const look = scene.painted(grab.pane);
    const live = scene.look(grab.pane);
    if (!look || !live || !onScreen(look, grab) || !onScreen(live, grab)) {
      // the pane's screen changed under the drag: nothing of it is selected or copied
      this.grab = NONE;
      const shown = this.selection !== null;
      this.selection = null;
      return shown ? [{ kind: "redraw" }] : [];
    }
    const end = pointOf(event, look);
    const moved = this.selection !== null || end.x !== grab.anchor.x || end.y !== grab.anchor.y;
    if (moved) this.selection = { pane: grab.pane, start: grab.anchor, end, emulator: grab.emulator, altScreen: grab.altScreen, screen: grab.screen };
    const acts: PointerAct[] = moved ? [{ kind: "redraw" }] : [];
    if (event.action === "release" && this.selection) {
      const range = ordered(this.selection);
      const top = look.history.viewportTop + look.top;
      const height = Math.min(look.rect.height, look.grid.rows - look.top);
      const width = Math.min(look.rect.width, look.grid.cols - look.left);
      const right = look.left + width;
      const entirelyShown = range.start.y >= top && range.end.y < top + height &&
        range.start.x >= look.left && range.start.x < right && range.end.x >= look.left && range.end.x < right &&
        (range.start.y === range.end.y || width === look.grid.cols);
      // Wheel-only drags can read unchanged history outside the viewport. After output, unseen rows may have
      // been replaced or pruned: only a range wholly shown in the new frame can authorize a fresh text read.
      if (grab.contentVersion === look.contentVersion || entirelyShown) {
        acts.push({ kind: "copy", pane: grab.pane, range, contentVersion: look.contentVersion });
      }
    }
    return acts;
  }

  private drag(grab: Extract<Grab, { kind: "divider" }>, event: MouseInput): PointerAct[] {
    const across = grab.direction === "right";
    const extent = across ? grab.rect.width : grab.rect.height;
    const first = (across ? event.col - grab.rect.x : event.row - grab.rect.y) + 1 + grab.offset;
    const ratio = extent > 0 ? first / extent : 0.5;
    if (event.action !== "motion") return finished(grab);
    grab.moved = ratio;
    return [{ kind: "divider", grab: grab.id, tab: grab.tab, name: grab.name, ratio, done: false }];
  }
}

function namedSplit(id: string, scene: PointerScene) {
  const path = pathOf(id);
  const split = path && scene.splits.find((candidate) => candidate.id === id);
  const name = split && scene.tab ? dividerAt(scene.tab.root, path) : null;
  return split && name ? { split, name } : null;
}

/** Only the hit at this coordinate; divider ids are paths, not identities. */
function mouseSite(event: MouseInput, scene: PointerScene) {
  const hit = scene.hits?.at(event.col, event.row) ?? null;
  return [scene.tab?.id, hit, hit && "id" in hit ? namedSplit(hit.id, scene) : null];
}

/** The end of a divider drag that moved, at the last ratio it moved to: at its release, or when its grab is dropped. */
function finished(grab: Grab): PointerAct[] {
  return grab.kind === "divider" && grab.moved !== null ? [{ kind: "divider", grab: grab.id, tab: grab.tab, name: grab.name, ratio: grab.moved, done: true }] : [];
}

/** `tab:<id>` and its kin: the kind and the id; anything else: the whole id as the kind. */
function splitId(id: string): [string, string] {
  const at = id.indexOf(":");
  return at < 0 ? [id, ""] : [id.slice(0, at), id.slice(at + 1)];
}

/** A split's path from its id (`split_<n>_root`, `split_<n>_01`: 0 the first side, 1 the second). */
function pathOf(id: string): boolean[] | null {
  const match = /^split_\d+_(root|[01]+)$/.exec(id);
  if (!match) return null;
  return match[1] === "root" ? [] : [...match[1]!].map((step) => step === "1");
}

/** The event's cell in the pane's grid: clamped into the pane's rectangle, then through the rows and columns the frame clips. */
function gridCell(event: MouseInput, look: Pick<PaneLook, "rect" | "top" | "left" | "grid">): GridCell {
  const { rect } = look;
  const col = Math.min(Math.max(event.col, rect.x), rect.x + Math.max(0, rect.width - 1));
  const row = Math.min(Math.max(event.row, rect.y), rect.y + Math.max(0, rect.height - 1));
  return {
    x: Math.min(col - rect.x + look.left, Math.max(0, look.grid.cols - 1)),
    y: Math.min(row - rect.y + look.top, Math.max(0, look.grid.rows - 1)),
  };
}

function inGrid(event: MouseInput, look: PaneLook): MouseInput {
  const cell = gridCell(event, look);
  return { ...event, col: cell.x, row: cell.y };
}

/** The event's cell in the whole kept screen (history included), where a selection is kept. */
function pointOf(event: MouseInput, look: PanePicture): ScreenPoint {
  const cell = gridCell(event, look);
  return { x: cell.x, y: look.history.viewportTop + cell.y };
}
