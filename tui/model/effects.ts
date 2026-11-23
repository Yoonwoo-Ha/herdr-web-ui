/**
 * What the reducer asks its caller (the screen's loop) to do, as data. The reducer performs none of it.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import type { InputEvent } from "../input/decode.ts";
import type { CopyCommand } from "./copy.ts";
import type { Target } from "./focus.ts";
import type { MoveAction } from "./keymap.ts";

export type KeyInput = Extract<InputEvent, { type: "key" }>;
export type TextInput = Extract<InputEvent, { type: "text" }>;
export type PasteInput = Extract<InputEvent, { type: "paste" }>;
export type MouseInput = Extract<InputEvent, { type: "mouse" }>;
/** What reaches a pane: the key, the text run (or what is left of it) or the paste, as read. */
export type PaneInput = KeyInput | TextInput | PasteInput;

/** What an overlay chose for the reducer to do once it closed: run an action, or focus a place. */
export type OverlayChoice = { readonly kind: "action"; readonly action: HerdrAction | "agents" } | { readonly kind: "select"; readonly target: Target };

/** A terminal as the screen showed it when an action was chosen: its address and when the core made it (null: not known). */
export interface Seen { readonly id: string; readonly created: number | null }

/**
 * An action the reducer cannot finish itself, for the caller to perform.
 * `zoom_follow`: the zoom of the target pane's tab moves to it, because focus went to a pane
 * that tab's shared zoom covered.
 */
export interface RunEffect {
  readonly type: "run";
  readonly action: HerdrAction | MoveAction | "zoom_follow";
  readonly target: Target | null;
  readonly index: number | null;
  /** a name typed into a field (rename, new tab) */
  readonly name: string | null;
  /** a close: every terminal it ends, as the screen showed them; the caller ends nothing when the core holds others */
  readonly seen?: readonly Seen[];
  /** A directional focus or swap: the resolved neighbour at selection time, null at an edge. */
  readonly neighbor?: string | null;
  /** a pane moved to another workspace: that workspace */
  readonly to?: string;
  /** For zoom_follow, the tab whose existing shared zoom must follow the target pane. */
  readonly zoomTab?: string;
  /** For zoom_follow, the pane shown when the move was made (null: none): the last pane once the document confirms the move. */
  readonly zoomFrom?: string | null;
}

export interface UnreadEffect { readonly type: "unread"; readonly pane: string }

export type Effect =
  | { readonly type: "copy"; readonly pane: string; readonly command: CopyCommand }
  /** level 6: send this input to the pane through its gate (encodeKey, or encodePaste) */
  | { readonly type: "pane"; readonly pane: string; readonly input: PaneInput }
  /** Pane input classified during a hold; its destination is resolved only after the write. */
  | { readonly type: "held_pane"; readonly input: PaneInput }
  | RunEffect
  /** the rest of a text run behind a run effect: dispatch it as an event once the effects before it are performed */
  | { readonly type: "input"; readonly event: TextInput }
  /** detach: close every channel, give the terminal back; no terminal is killed */
  | { readonly type: "quit" }
  /** read herdr's config again and answer with a `keys` event */
  | { readonly type: "reload_keys" }
  /** mark the pane's agent unread: its `herdr.seen` one below its turn (server/herdr-core/seen-label.ts `unread`) */
  | UnreadEffect
  /** An action or overlay/mode input refused at the hold boundary, before it changes any UI state. */
  | { readonly type: "busy"; readonly action: string }
  /** a mouse event for the caller's hit map: inside the top overlay, or over the screen's chrome and panes */
  | { readonly type: "mouse"; readonly over: "overlay" | "screen"; readonly event: MouseInput }
  /** a reply to the start probe (the host's colours, flags, cell size) */
  | { readonly type: "host_reply"; readonly kind: Extract<InputEvent, { type: "reply" }>["kind"]; readonly data: string };
