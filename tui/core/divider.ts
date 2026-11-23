/**
 * A split divider dragged with the mouse: named by the panes on its two sides so it can be found again on a
 * document someone else changed meanwhile, drawn ahead at the newest ratio while the drag lasts, and written to
 * the core's layout document with one write in flight at a time, across every divider, and each divider's newest
 * ratio kept for its next.
 */
import { type LayoutNode, leaves, type OvisLayout, setRatio, type SplitDirection } from "../../server/herdr-core/layout-doc.ts";
import { type Edited, ratioEdit } from "../../server/herdr-core/layout-ops.ts";
import { errorCode } from "../crash.ts";
import type { TabShape } from "./world.ts";

/** A divider by what lies on its two sides: the first pane (in tree order) of each side, and the split's direction. */
export interface DividerName { readonly first: string; readonly second: string; readonly direction: SplitDirection }

/** The divider of the split at `path` (false the first side, true the second); null where no split is. */
export function dividerAt(root: LayoutNode, path: readonly boolean[]): DividerName | null {
  let node = root;
  for (const second of path) {
    if ("leaf" in node) return null;
    node = second ? node.second : node.first;
  }
  if ("leaf" in node) return null;
  return { first: leaves(node.first)[0]!, second: leaves(node.second)[0]!, direction: node.split };
}

/**
 * Where the named divider is in `root`: the lowest split holding the first name on its first side and the second
 * on its second, in the named direction; null when the tree has no such split (it was closed, moved or turned).
 */
export function dividerPath(root: LayoutNode, name: DividerName): boolean[] | null {
  const path: boolean[] = [];
  let node = root;
  for (;;) {
    if ("leaf" in node) return null;
    const firstHere = leaves(node.first);
    const secondHere = leaves(node.second);
    if (firstHere.includes(name.first) && secondHere.includes(name.second)) return node.split === name.direction ? path : null;
    if (firstHere.includes(name.first) && firstHere.includes(name.second)) {
      path.push(false);
      node = node.first;
    } else if (secondHere.includes(name.first) && secondHere.includes(name.second)) {
      path.push(true);
      node = node.second;
    } else return null;
  }
}

/** The ratio of the named divider in whichever tab holds it now; `stale` and no layout when none does. */
export const dividerEdit = (name: DividerName, ratio: number) => (layout: OvisLayout): Edited => {
  for (const workspace of layout.workspaces) {
    for (const tab of workspace.tabs) {
      const path = dividerPath(tab.root, name);
      if (path) return ratioEdit(tab.id, path, ratio)(layout);
    }
  }
  return { layout: null, reason: "stale" };
};

/** Why a drag's write did not land: the divider was gone (`stale`), or the core refused the write (its code). */
export interface DividerRefusal { readonly code: "stale" | "layout_refused"; readonly reason: string | null }

export interface DividerWritesOptions {
  /** one read-edit-write of the layout document (layout-ops.ts `editLayout`) */
  edit: (change: (layout: OvisLayout) => Edited) => Promise<{ changed: boolean; reason: string | null }>;
  /** a write did not land; the drag's local ratio is dropped */
  refused: (refusal: DividerRefusal) => void;
  /** the core's own tree of tab `tab` as it stands now, with no local ratio in it; undefined where it shows no such tab */
  tree: (tab: string) => LayoutNode | undefined;
}

interface Drag {
  /** the newest grab of this divider */
  grab: number;
  readonly tab: string;
  readonly name: DividerName;
  ratio: number;
  /** the ratio of the write in flight or the last one answered */
  sent: number | null;
  /** the button was released */
  done: boolean;
  /**
   * The core's tree as last seen before its newest ratio was answered, at a move (the release included) or a draw
   * of its tab: once released and answered, the local ratio is drawn until the core's tree differs from it, also
   * when its tab was not drawn between the release and that change
   */
  over: LayoutNode | null;
}

/** Whether two trees differ; the same object (the core's view unchanged) needs no comparison. */
const differ = (one: LayoutNode, other: LayoutNode): boolean => one !== other && JSON.stringify(one) !== JSON.stringify(other);

const sameDivider = (drag: Drag, tab: string, name: DividerName): boolean =>
  drag.tab === tab && drag.name.first === name.first && drag.name.second === name.second && drag.name.direction === name.direction;

/**
 * The drags of one screen, one record a divider: a divider grabbed again takes its record over, and a divider whose
 * newest ratio is not written yet keeps it while another one is dragged. Every edit reads and writes the whole
 * document, so one is in flight at a time across all of them.
 */
export class DividerWrites {
  /** the dividers drawn at a local ratio, oldest first */
  private drags: Drag[] = [];
  /** the drag whose write is in flight */
  private writing: Drag | null = null;
  /** grabs whose divider was gone or whose write was refused: their later moves write nothing */
  private ended = -1;

  constructor(private readonly options: DividerWritesOptions) {}

  /** The pointer moved the divider of grab `grab` to `ratio`; `done` when the button was released there. */
  move(grab: number, tab: string, name: DividerName, ratio: number, done: boolean): void {
    if (grab <= this.ended) return;
    let drag = this.drags.find((one) => sameDivider(one, tab, name));
    if (!drag) {
      drag = { grab, tab, name, ratio, sent: null, done, over: null };
      this.drags.push(drag);
    }
    drag.grab = grab;
    drag.ratio = ratio;
    drag.done = done;
    drag.over = this.options.tree(tab) ?? drag.over;
    this.write();
  }

  /** The tab's shape as drawn: each dragged divider at its local ratio while its drag lasts and until the tree changes after it. */
  shape(tab: string, shape: TabShape | undefined): TabShape | undefined {
    if (!shape) return shape;
    let root = shape.root;
    for (const drag of [...this.drags]) {
      if (drag.tab !== tab) continue;
      if (drag.done && this.writing !== drag && drag.sent === drag.ratio) {
        drag.over ??= shape.root;
        if (differ(drag.over, shape.root)) {
          this.drags = this.drags.filter((one) => one !== drag);
          continue;
        }
        // the same tree, maybe rebuilt by a refresh of the core's view: the next draw compares this object first
        drag.over = shape.root;
      } else drag.over = shape.root;
      const path = dividerPath(root, drag.name);
      root = (path && setRatio(root, path, drag.ratio)) ?? root;
    }
    return root === shape.root ? shape : { ...shape, root };
  }

  /** Starts the write of the oldest divider whose newest ratio is unwritten, unless a write is in flight. */
  private write(): void {
    if (this.writing) return;
    const drag = this.drags.find((one) => one.sent !== one.ratio);
    if (!drag) return;
    this.writing = drag;
    drag.sent = drag.ratio;
    const grab = drag.grab;
    // only the grab that issued the write ends with it: a newer grab of the same divider writes its own ratio, and
    // its own answer says whether that landed
    const end = (refusal: DividerRefusal) => {
      this.ended = Math.max(this.ended, grab);
      if (drag.grab !== grab) {
        drag.sent = null;
        return;
      }
      this.drags = this.drags.filter((one) => one !== drag);
      this.options.refused(refusal);
    };
    this.options.edit(dividerEdit(drag.name, drag.ratio)).then((answer) => {
      this.writing = null;
      if (answer.reason === "stale") end({ code: "stale", reason: null });
      this.write();
    }, (error: unknown) => {
      this.writing = null;
      end({ code: "layout_refused", reason: errorCode(error) });
      this.write();
    });
  }
}
