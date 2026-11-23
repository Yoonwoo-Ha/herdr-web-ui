/**
 * The picker (herdr's `goto`, prefix+g): every place to jump to (each workspace, each tab, each agent) in one list that
 * the user filters by typing. The match is the screen's own: the query's characters must appear in the place's text in
 * order (a subsequence), and the best matches come first. Pure: the overlay keeps the places and the chosen place's
 * identity; the view draws `pickerMatches`, and Enter jumps to the chosen match, else the best.
 */
import type { Target, World } from "./focus.ts";

/** A place to jump to: `text` is what is matched and drawn. An agent's id is its pane's. */
export interface Place { readonly kind: "workspace" | "tab" | "agent"; readonly id: string; readonly text: string }

/** Where a place is when focus moves there. */
export function placeTarget(place: Place): Target {
  return { kind: place.kind === "agent" ? "pane" : place.kind, id: place.id };
}

/** Workspaces, then every tab of every workspace, then the agents in the world's order (the browser's). */
export function pickerPlaces(world: World): Place[] {
  const tabs = world.workspaces.flatMap((workspace) => workspace.tabs.map((tab, at) => ({ id: tab.id, text: `${workspace.name}/${tab.name || String(at + 1)}` })));
  const where = new Map(world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab, at) => tab.panes.map((pane) => [pane.id, { pane, text: `${workspace.name}/${tab.name || String(at + 1)}` }] as const))));
  return [
    ...world.workspaces.map(({ id, name }): Place => ({ kind: "workspace", id, text: name || id })),
    ...tabs.map(({ id, text }): Place => ({ kind: "tab", id, text })),
    ...(world.agents ?? []).flatMap((id): Place[] => {
      const found = where.get(id);
      if (found === undefined) return [];
      const name = found.pane.agent || found.pane.name;
      return [{ kind: "agent", id, text: name ? `${name} ${found.text}` : found.text }];
    }),
  ];
}

/** The identity the picker keeps for its chosen place: never a row number, which moves as the list changes. */
export function placeKey(place: Place): string {
  return `${place.kind}:${place.id}`;
}

/** How well a text matches: lower is better in every field, compared in this order. */
interface Score { readonly tier: number; readonly runs: number; readonly start: number }

const MATCH_TEXT = (text: string): string[] => [...text.normalize("NFC").toLowerCase()];
const WORD = /[\p{L}\p{N}]/u;

/** The fewest runs of adjacent characters a subsequence match of `query` in `text` takes, and where its first starts. */
function subsequence(text: readonly string[], query: readonly string[]): { runs: number; start: number } | null {
  // best[j]: the best (runs, start) with the query's characters so far matched and the last one at text[j]
  let best: ({ runs: number; start: number } | null)[] = text.map((char, j) => char === query[0] ? { runs: 1, start: j } : null);
  for (let i = 1; i < query.length; i++) {
    const next: ({ runs: number; start: number } | null)[] = text.map(() => null);
    let before: { runs: number; start: number } | null = null;
    for (let j = 0; j < text.length; j++) {
      // `before` holds the best match ending two or more places left of j
      if (j >= 2) before = better(before, best[j - 2] ?? null);
      if (text[j] !== query[i]) continue;
      const adjacent = j > 0 ? best[j - 1] ?? null : null;
      next[j] = better(adjacent, before === null ? null : { runs: before.runs + 1, start: before.start });
    }
    best = next;
  }
  return best.reduce<{ runs: number; start: number } | null>((found, one) => better(found, one), null);
}

function better(a: { runs: number; start: number } | null, b: { runs: number; start: number } | null): { runs: number; start: number } | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.runs < a.runs || (b.runs === a.runs && b.start < a.start) ? b : a;
}

/**
 * The score of `text` for a query of at least one character (blanks dropped), or null when it does not match: a prefix of
 * the text (the whole text among them, being the shortest), then a prefix of a word in it (after a character that is no
 * letter or digit), then any subsequence. A substring needs no tier of its own: it is the one-run subsequence.
 */
function score(text: readonly string[], query: readonly string[]): Score | null {
  const at = (start: number) => query.every((char, i) => text[start + i] === char);
  if (at(0)) return { tier: 0, runs: 1, start: 0 };
  for (let start = 1; start + query.length <= text.length; start++) {
    if (!WORD.test(text[start - 1]!) && at(start)) return { tier: 1, runs: 1, start };
  }
  const loose = subsequence(text, query);
  return loose === null ? null : { tier: 2, ...loose };
}

/** The places that match `query`, best first; with no query every place, in order. */
export function pickerMatches(places: readonly Place[], query: string): Place[] {
  const wanted = MATCH_TEXT(query).filter((char) => !/\s/u.test(char));
  if (wanted.length === 0) return [...places];
  const scored = places.flatMap((place, order) => {
    const text = MATCH_TEXT(place.text);
    const found = score(text, wanted);
    return found === null ? [] : [{ place, order, length: text.length, ...found }];
  });
  scored.sort((a, b) => a.tier - b.tier || a.runs - b.runs || a.start - b.start || a.length - b.length || a.order - b.order);
  return scored.map(({ place }) => place);
}

/** The index of the chosen place among `matches`: the one kept by `chosen`, else the best (0); -1 when nothing matches. */
export function chosenAt(matches: readonly Place[], chosen: string | null): number {
  if (matches.length === 0) return -1;
  const at = chosen === null ? -1 : matches.findIndex((place) => placeKey(place) === chosen);
  return at < 0 ? 0 : at;
}
