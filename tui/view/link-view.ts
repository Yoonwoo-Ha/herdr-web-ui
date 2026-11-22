/**
 * What the screen shows of the core link, and of a pane over it. The loop keeps the value and hands each of the link's
 * states through `shownLink`; the chrome and the pane scenes draw from it.
 */

import type { LinkState } from "../core/link.ts";
import type { PaneView } from "../core/pane.ts";

/** The link as the chrome draws it: online, or not, with the code of the state that took it offline (null: none yet). */
export interface ShownLink { readonly online: boolean; readonly code: string | null }

/** Before the link told its first state. */
export const LINK_UNKNOWN: ShownLink = { online: false, code: null };
const ONLINE: ShownLink = { online: true, code: null };

/**
 * What the screen shows once the link told `state`. A reconnect attempt (Connecting) keeps what was shown, so the
 * offline line and its code stay up while the screen keeps trying the socket.
 */
export function shownLink(before: ShownLink, state: LinkState): ShownLink {
  if (state.kind === "Online") return ONLINE;
  if (state.kind === "Connecting") return before;
  return { online: false, code: state.code };
}

/** A pane is drawn live only while its attach is Live and the link shows online; otherwise its last picture is dimmed. */
export function paneLive(view: Pick<PaneView, "state"> | undefined, link: ShownLink): boolean {
  return view?.state.kind === "Live" && link.online;
}
