/**
 * The size rules of a pane, as values: pure, with no clock and no core. The pane machine (pane.ts)
 * holds one PaneSize per pane and asks these functions what to advertise and when to attach again.
 *
 * The screen never claims a terminal's size by itself. Every attach is a resumed plain viewer, so
 * herdr-core's own rule decides: alone, the terminal takes what this viewer advertises; beside a
 * viewer that drives it, theirs stays. Three sizes are kept apart:
 * - `wanted`: the pane's rectangle on this screen;
 * - `actual`: the terminal's size as the attach in use was told it: by its reply, then by the `size`
 *   events that came on it. The pane's emulator has this one. A `size` event that comes while no attach
 *   is in use does not change it: the next reply names the size, and until then `actual` stays the
 *   grid of the picture the pane still shows;
 * - `advertised`: what the attach in use last told the core, by its attach or by a RESIZE; null when
 *   no attach is in use. The core uses it the moment this viewer becomes the active one, so it says
 *   what the user's next input would set, not who owns the size. Equal sizes are never read as
 *   ownership;
 * - `chosen`: the size the last viewer chose, as far as this pane heard: the last size the core said
 *   the terminal has while somebody viewed it. Every `size` event sets it, also one heard while no
 *   attach is in use, except one that names the size of a terminal nobody views (UNVIEWED) while the
 *   pane shows no attach of its own. It is what a repaint advertises, and it ends with the attach.
 *
 * Only the user's own input sends a RESIZE (the take, in pane.ts). Everything else that leaves
 * `advertised` or the picture behind is repaired by attaching again, for one of two causes, each a
 * wait that exists only as long as what it describes:
 * - `ownAt`, this screen's rectangle changed: set while the attach in use advertises another size
 *   than the rectangle. It ends when the core was told (an attach left, or the take sent RESIZE),
 *   when the rectangle came back to what the channel advertises, and with the attach itself. The new
 *   attach advertises the rectangle;
 * - `foreignAt`, another viewer changed the size: set after a `size` event on the attach in use, while
 *   the terminal's size is neither the rectangle nor what that attach advertises. It ends when the
 *   repaint left, when the user's input took the terminal, when the terminal has one of those two
 *   sizes again (a later event, or a changed rectangle), and with the attach itself. The new attach
 *   advertises `chosen`, the size the last viewer chose, so it only repaints.
 * Both wait REATTACH_SETTLE_MS after the last such change; when both wait, the first kind is made.
 * A wait that outlived its cause would be counted again by a later attach: an attach with the
 * rectangle that nobody asked for, which between two idle screens takes the terminal back.
 *
 * Beside one other viewer, a repaint leaves the terminal at the size the last viewer chose, and one
 * that has nothing to repaint is not made:
 * - when another viewer leaves, the core hands the terminal to a viewer that stays, at the size its
 *   attach advertises. For that viewer's pane the emulator already has that grid: no repaint is owed;
 * - every new attach needs a CLOSE first, and when this screen is the terminal's only viewer that
 *   CLOSE leaves the terminal with nobody: the core runs it at its own size for such a terminal
 *   (UNVIEWED, 200x120) until the attach arrives. Nobody chose that size, so it is never `chosen`
 *   while the pane shows no attach of its own, and a lone viewer's resumed attach gets what it
 *   advertises (measured on hc 0.1.17 and 0.1.18, core.fake.live.test.ts "k1"): the terminal is back
 *   at the last size a viewer chose. Nothing the core says tells a terminal nobody views from one a
 *   viewer holds at exactly that size: its record is the same, field for field;
 * - another viewer can choose a size between the pane's CLOSE and its next attach, and while that
 *   attach is on its way. The core tells a line every change of a terminal's size in the order it
 *   made them, and the event for the size an attach itself set never ahead of that attach's reply
 *   (core.fake.live.test.ts "k2"). So what the pane hears in between is `chosen` when the attach
 *   leaves. And the pane knows when its repaint's attach changed the terminal's size: nobody viewed
 *   the terminal when the attach left, or something else was heard before its reply (`echo`). The
 *   core's event for the size the repaint advertised is then still to come, behind the first bytes
 *   of its stream, and everything heard before it was so before the attach was applied. When it
 *   comes while `chosen` is another size, the repaint took the terminal from that choice: it is
 *   owed again, at once (`overtaken`), advertising that choice. At once, because any other screen
 *   that heard the repaint's size waits REATTACH_SETTLE_MS before it repaints at it; should one
 *   have done so all the same (the reply was that slow), the size the pane is taking back is not a
 *   choice when it is heard again meanwhile (`again`). The repaint's size heard ahead of its reply
 *   is another viewer's choice of that very size, and a size heard behind the reply of a repaint
 *   that changed nothing is another viewer's later doing, as on any attach in use: neither is a
 *   sign of this repaint.
 * Three cases are left open, each until someone types or changes a window (docs/tui/parity.md says
 * what the user sees): an idle viewer whose window is exactly UNVIEWED attaching inside the pane's
 * gap, which nothing tells from nobody; a viewer attaching as a repaint leaves beside an idle viewer
 * that stays, when the core's reply overtakes that viewer's event (the repaint reads it as a later
 * choice and keeps the older size); and three or more viewers of which two repaint in one turn: on
 * the wire another screen's repaint and a choice are the same resumed attach, so a repaint can take
 * the other's older size for a choice. In each the terminal rests at a size some viewer chose with
 * its own rectangle, never at UNVIEWED, nothing attaches again, and the next key in a pane gives
 * that pane's rectangle back (size.test.ts names each).
 * So "alone, the terminal takes the pane's rectangle" holds at every attach that carries the rectangle
 * (the first, and each one after a change of the rectangle) and at the user's next input. In between
 * a pane can be alone at another size in one way only: it repainted at the size another viewer chose,
 * and that viewer left. It is then drawn clipped at that size until the user types into it.
 */

import { REATTACH_SETTLE_MS } from "../model/deadlines.ts";

export interface Size { cols: number; rows: number }

export const sameSize = (a: Size | null, b: Size | null): boolean => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;

/** where herdr-core runs a terminal nobody views (hc 0.1.17 and 0.1.18): the one sign of it, since the core's record names no viewers */
const UNVIEWED: Size = { cols: 200, rows: 120 };

/**
 * Where the pane's own attach stands when a `size` event comes while no attach of the pane is shown: `none` left since the one before
 * was closed, one is `sent` (its reply not in), or one is in use and `unshown` (its first paint is not on the host yet).
 */
export type AttachStage = "none" | "sent" | "unshown";

export interface PaneSize {
  readonly wanted: Size;
  readonly actual: Size | null;
  readonly advertised: Size | null;
  /** the last size the core said the terminal has while somebody viewed it: what a repaint advertises; null when no attach is in use any more */
  readonly chosen: Size | null;
  /** the attach on its way or in use only repaints: it advertised `chosen`, not a rectangle that changed */
  readonly repaint: boolean;
  /**
   * the repaint's attach changes the terminal's size, and the core's event for the size it advertised is still to come. Before the
   * attach leaves: nobody views the terminal. Once it left: nobody did then, or something else was heard before its reply
   */
  readonly echo: boolean;
  /**
   * the repaint that advertised `advertised` took the terminal from a newer choice and is being made again: until the new attach
   * leaves, that size heard once more is the pane's own doing coming back (another screen that repainted at it), not a choice
   */
  readonly again: boolean;
  /** when the rectangle last changed, while the attach in use advertises another size; else null */
  readonly ownAt: number | null;
  /** when a `size` event on the attach in use last left `actual` neither `wanted` nor `advertised`, while it still is; else null */
  readonly foreignAt: number | null;
}

export function newPaneSize(wanted: Size): PaneSize {
  return { wanted, actual: null, advertised: null, chosen: null, repaint: false, echo: false, again: false, ownAt: null, foreignAt: null };
}

/** Whether the next attach only repaints: another viewer's resize waits and no change of the rectangle does. */
const repaints = (size: PaneSize): boolean => size.ownAt === null && size.foreignAt !== null && size.chosen !== null;

/** This screen gave the pane another rectangle (a host resize, a layout change); the same rectangle changes nothing. */
export function rectangleChanged(size: PaneSize, wanted: Size, now: number): PaneSize {
  if (sameSize(size.wanted, wanted)) return size;
  return {
    ...size,
    wanted,
    // nothing waits when the channel advertises this rectangle already (it came back), or when no attach is in use (the next one carries it)
    ownAt: size.advertised !== null && !sameSize(wanted, size.advertised) ? now : null,
    // a rectangle that is the terminal's own size owes no repaint
    foreignAt: sameSize(size.actual, wanted) ? null : size.foreignAt,
  };
}

/**
 * The core said the terminal's size on the attach in use: the bytes on that stream may now be laid
 * out for another grid than the one its first paint was drawn for, which a repaint puts right. None
 * is owed when the terminal comes to the rectangle, or to the size this attach itself advertises
 * (another viewer left and the core fell back to it): either ends the wait an earlier event began.
 * The pane views the terminal, so the size is one a viewer chose; a repaint's own event that comes
 * this late is still told apart (`overtaken`).
 */
export function sizeTold(size: PaneSize, actual: Size, now: number): PaneSize {
  if (overtaken(size, actual)) return { ...size, actual, echo: false, again: true, foreignAt: now };
  const settled = sameSize(actual, size.wanted) || sameSize(actual, size.advertised);
  return { ...size, actual, chosen: actual, echo: false, foreignAt: settled ? null : now };
}

/**
 * Whether `told`, heard on the repaint in use, is the core's event for the size that attach set
 * (`echo`) after another size was heard: the repaint took the terminal from the size a viewer chose
 * before it was applied. It is then made again at once, advertising that choice.
 */
export function overtaken(size: PaneSize, told: Size): boolean {
  return size.repaint && size.echo && sameSize(told, size.advertised) && size.chosen !== null && !sameSize(size.chosen, size.advertised);
}

/**
 * The core said the terminal's size while the pane shows no attach of its own (`stage`). It is the
 * size the last viewer chose, unless it is the size of a terminal nobody views: then the pane's own
 * CLOSE, or another viewer's, left it behind, and a repaint's attach will change the terminal's size.
 * With an attach in use (`unshown`) the emulator follows all the same, as on a shown attach.
 */
export function sizeHeard(size: PaneSize, told: Size, now: number, stage: AttachStage): PaneSize {
  const unviewed = sameSize(told, UNVIEWED);
  if (stage === "none") {
    if (size.again && sameSize(told, size.advertised)) return size;
    return unviewed ? { ...size, echo: true } : { ...size, chosen: told, echo: false };
  }
  const inUse = stage === "unshown";
  // the size the attach advertised. In use: its own event, which says whether it took the terminal from a choice (sizeTold). Ahead
  // of the reply, where the core never sends that event: another viewer chose that very size, and the attach changes nothing
  if (sameSize(told, size.advertised)) return inUse ? sizeTold(size, told, now) : { ...size, chosen: told, echo: false };
  // ahead of the reply, and until the repaint's own event, what is heard was so before the attach was applied; and while the pane
  // views the terminal, the size of a terminal nobody views can only be from before: either way the attach changed the size
  const before = size.repaint && (!inUse || size.echo || unviewed);
  const heard = inUse ? sizeTold(size, told, now) : size;
  return { ...heard, chosen: unviewed ? size.chosen : told, echo: before };
}

/**
 * The pane closes the attach in use to attach again. What that attach advertised and what waits stay
 * until the new attach leaves, which reads them; an event of its own that was still awaited is not
 * awaited any more, so that what the pane hears next says whether somebody views the terminal.
 */
export function reattaching(size: PaneSize): PaneSize {
  return size.echo ? { ...size, echo: false } : size;
}

/**
 * What the next attach advertises: the rectangle, or, when it is a repaint after another viewer's
 * resize and no change of the rectangle waits, the size the last viewer chose (`chosen`).
 */
export function attachSize(size: PaneSize): Size {
  return repaints(size) && size.chosen ? size.chosen : size.wanted;
}

/**
 * An attach left, advertising `advertised`: whatever waited was for it, and its reply alone will make nothing wait. A repaint that
 * leaves while nobody views the terminal sets its size, unless it advertises the very size such a terminal has.
 */
export function attachSent(size: PaneSize, advertised: Size): PaneSize {
  const repaint = repaints(size);
  return { ...size, advertised, ownAt: null, foreignAt: null, repaint, echo: repaint && size.echo && !sameSize(advertised, UNVIEWED), again: false };
}

/**
 * The attach reply: the terminal's size once that attach was applied, which is the size the last
 * viewer chose. It never schedules a new attach. Only a repaint whose own size it names keeps what
 * was heard while it was on its way: whether it took the terminal from that choice, the core's event
 * for its size says (`overtaken`). A reply that names another size: a viewer that drives the terminal
 * leads, and the repaint changed nothing.
 */
export function replied(size: PaneSize, actual: Size): PaneSize {
  const led = size.repaint && sameSize(actual, size.advertised);
  return { ...size, actual, chosen: led && size.chosen ? size.chosen : actual, echo: led && size.echo };
}

/**
 * The user's input left on a channel that advertises the rectangle (the take sent RESIZE first where
 * it did not): the core was told, and this viewer is now the active one, so the core sets the
 * terminal to the rectangle. Both waits end at once, not only when the `size` event confirms it: a
 * repaint fired in between would read the old size and hand the terminal back.
 */
export function took(size: PaneSize): PaneSize {
  return { ...size, advertised: size.wanted, repaint: false, echo: false, again: false, ownAt: null, foreignAt: null };
}

/**
 * The attach in use is over for another reason than the pane's own new attach (its line ended, its
 * program ended or lost its shell, the pane left the tab or failed): nothing is advertised any more,
 * what was heard of other viewers' sizes is not this attach's any more, and what waited for that
 * attach waits no longer. The next attach starts from the rectangle.
 */
export function detached(size: PaneSize): PaneSize {
  return { ...size, advertised: null, chosen: null, repaint: false, echo: false, again: false, ownAt: null, foreignAt: null };
}

/**
 * The emulator refused the terminal's size: the pane cannot be drawn at it. `actual` becomes `drawn`, the grid an emulator took
 * last, or null when the pane shows no picture, so nothing is laid out at the refused size.
 */
export function refused(size: PaneSize, drawn: Size | null): PaneSize {
  return { ...size, actual: drawn };
}

/** When the pane must attach again, or null when nothing waits. `attachSize` says what that attach advertises. */
export function reattachDue(size: PaneSize): number | null {
  if (size.ownAt !== null) return size.ownAt + REATTACH_SETTLE_MS;
  if (size.foreignAt !== null) return size.foreignAt + REATTACH_SETTLE_MS;
  return null;
}

/** The real grid's size when another viewer sized the terminal (the pane is then drawn clipped, with that size in its notice), else null. */
export function sizedBy(size: PaneSize): Size | null {
  return size.actual !== null && !sameSize(size.actual, size.wanted) ? size.actual : null;
}

/**
 * The first row of the real grid a clipped pane draws: the part that holds the cursor, as far down as
 * the grid goes; columns are drawn from 0. The mouse is mapped through the same offset.
 */
export function clipTop(cursorRow: number, actualRows: number, shownRows: number): number {
  return Math.max(0, Math.min(cursorRow - shownRows + 1, actualRows - shownRows));
}
