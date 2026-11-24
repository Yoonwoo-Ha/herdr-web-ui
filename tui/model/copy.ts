import { type CopyAction, COPY_KEYS } from "./copy-keys.ts";
import type { PaneInput } from "./effects.ts";
import { boundIn, charChords, keyChords, type KeyAction, type Keymap } from "./keymap.ts";
import { editField, field, type Field, isEnter, type OverlayInput } from "./overlays.ts";

export const isCopyAction = (action: KeyAction): action is CopyAction => Object.hasOwn(COPY_KEYS, action);
export type CopyMotion = Exclude<CopyAction, "copy_find" | "copy_leave" | "copy_label" | "copy_hints" |
  "copy_yank" | "copy_char" | "copy_line" | "copy_older" | "copy_newer">;

export type CopyCommand =
  | { readonly kind: "enter" }
  | { readonly kind: "move"; readonly motion: CopyMotion }
  | { readonly kind: "select"; readonly shape: "char" | "line" }
  | { readonly kind: "find"; readonly query: string }
  | { readonly kind: "step"; readonly toward: "older" | "newer" }
  | { readonly kind: "hints" }
  | { readonly kind: "pick"; readonly digit: number }
  | { readonly kind: "yank" }
  /** copy mode ended (a key, a copy, a focus change, a resize): its view is given back now, in input order */
  | { readonly kind: "leave" };

export type CopyMode = { readonly name: "copy"; readonly pane: string } & (
  | { readonly phase: "browse" | "hints" }
  | { readonly phase: "query"; readonly field: Field }
);

type CopyStep = {
  readonly mode: CopyMode | null; readonly command?: CopyCommand;
};

/** Copy owns input until it leaves. Its history commands are performed outside the reducer. */
export function copyInput(mode: CopyMode, input: PaneInput, keymap: Keymap): CopyStep {
  if (mode.phase === "query") {
    if (input.type === "key" && input.key === "ESCAPE" && Object.keys(input.mods).length === 0) return copyAction(mode, "copy_leave", null);
    if (input.type === "key" && isEnter({ kind: "key", event: input })) {
      return { mode: { name: "copy", pane: mode.pane, phase: "browse" }, command: { kind: "find", query: mode.field.graphemes.join("") } };
    }
    return { mode: { ...mode, field: editField(mode.field, copyFieldInput(input)) } };
  }
  const chords = input.type === "key" ? keyChords(input) : input.type === "text" ? charChords(input.text, false) : [];
  const bound = boundIn(keymap.modeKeys.copy, chords);
  return bound && isCopyAction(bound.action) ? copyAction(mode, bound.action, bound.index) : { mode };
}

export function copyAction(mode: CopyMode, action: CopyAction, index: number | null): CopyStep {
  switch (action) {
    case "copy_leave": return { mode: null };
    case "copy_hints": return mode.phase === "query" ? { mode } :
      { mode: { name: "copy", pane: mode.pane, phase: "hints" }, command: { kind: "hints" } };
    case "copy_label": return mode.phase === "hints" && index !== null
      ? { mode, command: { kind: "pick", digit: index } } : { mode };
  }
  if (mode.phase !== "browse") return { mode };
  switch (action) {
    case "copy_find": return { mode: { name: "copy", pane: mode.pane, phase: "query", field: field("") } };
    case "copy_yank": return { mode, command: { kind: "yank" } };
    case "copy_char": return { mode, command: { kind: "select", shape: "char" } };
    case "copy_line": return { mode, command: { kind: "select", shape: "line" } };
    case "copy_older": return { mode, command: { kind: "step", toward: "older" } };
    case "copy_newer": return { mode, command: { kind: "step", toward: "newer" } };
    case "copy_left": case "copy_down": case "copy_up": case "copy_right": case "copy_word": case "copy_back":
    case "copy_start": case "copy_end": case "copy_oldest": case "copy_newest": case "copy_half_up": case "copy_half_down":
      return { mode, command: { kind: "move", motion: action } };
  }
}

function copyFieldInput(input: PaneInput): OverlayInput {
  switch (input.type) {
    case "key": return { kind: "key", event: input };
    case "text": return { kind: "text", event: input };
    case "paste": return { kind: "paste", event: input };
  }
}
