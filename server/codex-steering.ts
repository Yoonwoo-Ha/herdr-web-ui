import { stripVTControlCharacters } from "node:util";

export interface CodexSteeringContext { agent: string | null; working: boolean; screen: string }
interface SteeringIO {
  read: () => Promise<CodexSteeringContext>;
  escape: (fresh: () => boolean) => Promise<void>;
  restarting: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const STEERING_HINT = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const compact = (text: string) => text.replace(/\s/g, "");
function lastLine<T>(lines: T[], matches: (line: T) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (matches(lines[index]!)) return index;
  return -1;
}
/** The rows under the composer: the model and folder (with `fast` after the effort in Fast mode), context left, warnings, and (0.162) the shortcuts hint. */
export const FOOTER = /^(?:\S+(?:[ \t]+\S+){0,3}[ \t]+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)(?:[ \t]+[Ff]ast)?[ \t]*·|\d+% context left\b|⚠\s*\d+\s*warnings?\b|(?:←[^·]*·\s*)?\?\s*for shortcuts\b|[/\\]|[A-Za-z]:\\)/;

export function codexSteeringPending(screen: string, text: string): boolean {
  // the indent is kept beside the trimmed text: Codex tells an entry from its continuation rows by it
  const rows = stripVTControlCharacters(screen).split(/\r?\n/).map((raw) => {
    const line = raw.replace(/^│/, "").replace(/\s*│\s*$/, "").trimEnd();
    return { indent: line.length - line.trimStart().length, text: line.trim() };
  }).filter((row) => row.text);
  const lines = rows.map((row) => row.text);
  const composer = lastLine(lines, (line) => /^[›»](?:\s+Ask Codex to do anything)?$/.test(line));
  if (composer < 0) return false;
  const footer = lines.slice(composer + 1);
  if (footer.length > 4 || footer.some((line) => !FOOTER.test(line))) return false;
  const status = lastLine(lines.slice(0, composer), (line) => /^[•◦]\s*(?:Working|Reconnecting(?:\.{3}|…)?(?: waiting for network)?)\s*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)$/.test(line));
  if (status < 0) return false;
  const panel = rows.slice(status + 1, composer);
  const isEntry = (row: { text: string }) => /^↳\s*\S/.test(row.text);
  const first = panel.findIndex(isEntry);
  if (first < 1) return false;
  if (compact(panel.slice(0, first).map((row) => row.text).join("").replace(/^[•◦]\s*/, "")) !== compact(STEERING_HINT)) return false;
  // the steering section ends at the next header: Codex lists end-of-turn and rejected inputs under their own
  const next = panel.findIndex((row, index) => index > first && /^[•◦]/.test(row.text));
  const section = panel.slice(first, next < 0 ? panel.length : next);
  // an entry starts at the arrows' indent; a deeper arrow is the message's own text on a continuation row
  const indent = section[0]!.indent;
  const entry = section.slice(lastLine(section, (row) => row.indent === indent && isEntry(row)));
  // Codex cuts a long entry with a "…" row of its own; an ellipsis ending a text row is the message's
  const cut = entry.length > 1 && entry[entry.length - 1]!.text === "…";
  const shown = compact((cut ? entry.slice(0, -1) : entry).map((row) => row.text).join("").replace(/^↳/, ""));
  const sent = compact(text);
  if (!sent || !shown) return false;
  return cut ? sent.startsWith(shown) : shown === sent;
}

export async function interruptCodexSteering(explicit: boolean, text: string, submitted: CodexSteeringContext, io: SteeringIO): Promise<void> {
  if (!explicit || submitted.agent !== "codex" || !submitted.working) return;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  const deadline = now() + 1500;
  const unconfirmed = () => new Error("Codex immediate delivery was not confirmed. Check the terminal before sending again.");
  while (now() < deadline) {
    const current = await io.read();
    if (now() >= deadline || current.agent !== "codex") throw unconfirmed();
    if (!current.working) return;
    if (codexSteeringPending(current.screen, text)) {
      io.restarting();
      await io.escape(() => now() < deadline);
      return;
    }
    await wait(Math.min(50, deadline - now()));
  }
  throw unconfirmed();
}
