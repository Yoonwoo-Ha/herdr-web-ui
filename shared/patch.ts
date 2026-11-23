/**
 * Codex's file edits: an `apply_patch` call carries the patch as its whole input, and the
 * `exec` tool's scripts carry it as the string argument of `tools.apply_patch(…)`.
 */

const BEGIN = "*** Begin Patch";
const CALL = "tools.apply_patch(";

/** The `"…"` or `` `…` `` literal that opens at `at`, quotes included; null when none closes. */
function literalAt(input: string, at: number): string | null {
  const quote = input[at];
  if (quote !== '"' && quote !== "`") return null;
  for (let end = input.indexOf(quote, at + 1); end >= 0; end = input.indexOf(quote, end + 1)) {
    let slash = end;
    while (input[slash - 1] === "\\") slash--;
    // An odd run of backslashes escapes this quote; an even one is escaped pairs.
    if ((end - slash) % 2 === 0) return input.slice(at, end + 1);
  }
  return null;
}

export function patchText(input: string): string | null {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(BEGIN)) return trimmed;
  // A scan, not a regex: a regex over the literal backtracks per character, takes tens of ms past
  // ~120KB and gives up (no match) past ~1.3MB, and a large edit's script is that big.
  let literal: string | null = null;
  for (let call = input.indexOf(CALL); call >= 0; call = input.indexOf(CALL, call + CALL.length)) {
    let at = call + CALL.length;
    while (at < input.length && /\s/.test(input[at]!)) at++;
    literal = literalAt(input, at);
    if (literal !== null) break;
  }
  if (literal === null) return null;
  let text: string;
  if (literal.startsWith("`")) text = literal.slice(1, -1).replace(/\\`/g, "`");
  else {
    try { text = JSON.parse(literal) as string; } catch { return null; }
  }
  return text.trimStart().startsWith(BEGIN) ? text.trimStart() : null;
}

export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const file = match[1]!.trim();
    if (!files.includes(file)) files.push(file);
  }
  return files;
}
