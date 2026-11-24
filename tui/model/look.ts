/**
 * Who looks at what: the pane a person has in front of them, which the screen tells every Herdr client by raising
 * `herdr.seen` (server/herdr-core/seen-label.ts). Pure: the caller gathers the facts, and keeps what changes between two
 * calls.
 */

/**
 * What the screen knows at one moment of the pane it shows and of the person in front of it. A person sees the last
 * frame the host took, so the pane and what lies over it are that frame's as long as the model agrees: a focus move or
 * a closed overlay is in front of nobody until a frame shows it.
 */
export interface LookState {
  /** the host's focus as it last reported it; null: it never reported any */
  readonly hostFocused: boolean | null;
  /** an input event (a key, text, a paste, a click) was read after the shown pane's last turn ended */
  readonly inputAfterTurn: boolean;
  /** the focused pane, when that frame showed it focused; null: none, or the focus moved and no frame shows it yet */
  readonly pane: string | null;
  /** that pane is Live: its first paint is complete and drawn */
  readonly live: boolean;
  /** that frame drew the pane's picture */
  readonly drawn: boolean;
  /** an overlay (help, a dialog, the menu) covers the panes, in that frame or since */
  readonly overlay: boolean;
  /** the core's line is up */
  readonly online: boolean;
}

/**
 * The pane a person looks at, or null. A person is there while the host reports focus in; on a host that never
 * reports focus, an input event read after the pane's last turn is the proof. The pane is the focused one of the shown
 * tab (never another pane of a split, never one a key moved to before a frame showed it), Live, drawn in the last frame
 * with no overlay over it, on a line that is up.
 */
export function look(state: LookState): string | null {
  const present = state.hostFocused ?? state.inputAfterTurn;
  return present && state.pane !== null && state.live && state.drawn && !state.overlay && state.online ? state.pane : null;
}
