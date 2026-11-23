/**
 * What the reducer asks its caller (the screen's loop) to do, as data. The reducer performs none of it.
 */
import type { HerdrAction } from "../../shared/herdr-keys.ts";
import type { InputEvent } from "../input/decode.ts";
import type { Target } from "./focus.ts";
import type { MoveAction } from "./keymap.ts";

export type KeyInput = Extract<InputEvent, { type: "key" }>;
export type TextInput = Extract<InputEvent, { type: "text" }>;
export type PasteInput = Extract<InputEvent, { type: "paste" }>;
export type MouseInput = Extract<InputEvent, { type: "mouse" }>;
/** What reaches a pane: the key, the text run (or what is left of it) or the paste, as read. */
export type PaneInput = KeyInput | TextInput | PasteInput;

/** What an overlay chose for the reducer to do once it closed: run an action, or focus a place. */
export type OverlayChoice = { readonly kind: "action"; readonly action: HerdrAction } | { readonly kind: "select"; readonly target: Target };

/** A terminal as the screen showed it when an action was chosen: its address and when the core made it (null: not known). */
export interface Seen { readonly id: string; readonly created: number | null }

/**
 * An action the reducer cannot finish itself, for the caller to perform: a layout write, a jump through the
 * agent list, the goto query, or a directional focus (the caller finds the neighbour on the drawn layout and
 * answers with a `select` event).
 */
export interface RunEffect {
  readonly type: "run";
  readonly action: HerdrAction | MoveAction;
  readonly target: Target | null;
  readonly index: number | null;
  /** a name typed into a field (rename, new tab) or the goto query */
  readonly name: string | null;
  /** a close: every terminal it ends, as the screen showed them; the caller ends nothing when the core holds others */
  readonly seen?: readonly Seen[];
  /** A directional focus or swap: the resolved neighbour at selection time, null at an edge. */
  readonly neighbor?: string | null;
  /** a pane moved to another workspace: that workspace */
  readonly to?: string;
}

export type Effect =
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
  /** An action or overlay/mode input refused at the hold boundary, before it changes any UI state. */
  | { readonly type: "busy"; readonly action: string }
  /** a mouse event for the caller's hit map: inside the top overlay, or over the screen's chrome and panes */
  | { readonly type: "mouse"; readonly over: "overlay" | "screen"; readonly event: MouseInput }
  /** a reply to the start probe (the host's colours, flags, cell size) */
  | { readonly type: "host_reply"; readonly kind: Extract<InputEvent, { type: "reply" }>["kind"]; readonly data: string };
