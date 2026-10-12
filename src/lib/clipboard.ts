/** Selects everything inside `node`, so the user can long-press or Ctrl+C it. */
export function selectContents(node: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Copies text. The clipboard API exists only in secure contexts (HTTPS or localhost), so on a
 * plain-HTTP LAN address it tries the browser's copy command. If copying is refused, it
 * selects the given node instead, ready for a long press or Ctrl+C.
 * Returns whether the text is on the clipboard.
 */
export async function copyText(text: string, fallback?: HTMLElement | null): Promise<boolean> {
  const initiator = document.activeElement;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no clipboard API here, or the browser refused */
  }
  // A refusal can come late. If focus has moved on by then, the user is elsewhere (the message box,
  // a terminal, perhaps mid-IME): taking focus to copy would cut into what they are typing.
  if (document.activeElement !== initiator) return false;
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  let copied = false;
  try {
    input.focus({ preventScroll: true });
    input.select();
    copied = document.execCommand("copy");
  } catch {
    /* the legacy copy command can be refused too */
  } finally {
    input.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && inputSelection.start !== null && inputSelection.end !== null) {
      active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    }
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
  if (copied) return true;
  if (fallback instanceof HTMLTextAreaElement || fallback instanceof HTMLInputElement) {
    fallback.focus();
    fallback.select();
  } else if (fallback) {
    selectContents(fallback);
  }
  return false;
}
