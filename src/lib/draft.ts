/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** special keys (Enter, arrows, ^C, ...) received while disconnected - undraftable, counted */
  readonly droppedSpecial: number;
}

export const EMPTY_DRAFT: InputDraft = { text: "", droppedSpecial: 0 };

const MAX_DRAFT_CHARS = 1024;

/** A single printable character: the same definition the one-shot Control uses. */
function isPrintableChar(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/** Folds one onData chunk into the draft: printable text accumulates, special keys count. */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  if (!isPrintableChar(data)) {
    // Enter, arrows, escape sequences, pastes - a draft is plain text only
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  if (draft.text.length >= MAX_DRAFT_CHARS) {
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  return { ...draft, text: draft.text + data };
}

export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && draft.droppedSpecial === 0;
}
