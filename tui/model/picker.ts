/**
 * The picker (herdr's `goto`, prefix+g), as herdr's: every terminal, grouped under its workspace in the world's order,
 * one row each. `/` starts a search that keeps the terminals whose words hold the typed characters in order; the rows
 * keep their order. Pure: the overlay keeps the terminals and the chosen one's pane; the view draws the matches.
 */
import type { Target, World } from "./focus.ts";

/** A terminal to jump to: its pane, its workspace, and the words the search matches (workspace, tab, pane, agent). */
export interface Place { readonly id: string; readonly workspace: string; readonly text: string }

/** Where focus moves when a terminal is chosen. */
export function placeTarget(place: Place): Target {
  return { kind: "pane", id: place.id };
}

/** Every terminal of every workspace, in the world's order. */
export function pickerPlaces(world: World): Place[] {
  return world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane): Place => ({
    id: pane.id, workspace: workspace.id, text: [workspace.name, tab.name, pane.name, pane.agent ?? ""].join(" "),
  }))));
}

/** Whether `query`'s characters (blanks dropped, case ignored) appear in `text` in order. */
function holds(text: string, query: readonly string[]): boolean {
  let at = 0;
  for (const char of text.normalize("NFC").toLowerCase()) if (char === query[at]) at++;
  return at === query.length;
}

/** The terminals that match `query`, in their order; with no query every one. */
export function pickerMatches(places: readonly Place[], query: string): Place[] {
  const wanted = [...query.normalize("NFC").toLowerCase()].filter((char) => !/\s/u.test(char));
  return wanted.length === 0 ? [...places] : places.filter((place) => holds(place.text, wanted));
}

/** A workspace's heading row chosen in the picker (herdr's pointer chooses headings too): its id, else null. */
export const chosenHeading = (chosen: string | null): string | null => (chosen?.startsWith("heading:") ? chosen.slice("heading:".length) : null);

/**
 * The picker's rows for `matches`, each by what it is: a workspace's heading (`heading:<workspace>`) before the first of
 * its terminals, then each terminal's pane. What is chosen is kept as one of these, wherever the world moves its row.
 */
export function pickerRows(matches: readonly Place[]): string[] {
  return matches.flatMap((place, index) => [...(index === 0 || matches[index - 1]!.workspace !== place.workspace ? [`heading:${place.workspace}`] : []), place.id]);
}

/** The index of the chosen terminal among `matches`: the one kept by `chosen`, else the first; -1 when nothing matches or a heading is chosen. */
export function chosenAt(matches: readonly Place[], chosen: string | null): number {
  if (matches.length === 0 || chosenHeading(chosen) !== null) return -1;
  const at = chosen === null ? -1 : matches.findIndex((place) => place.id === chosen);
  return at < 0 ? 0 : at;
}

/** The first terminal of the workspace `step` workspaces from the chosen one's among `matches`; -1 past the first or last workspace. */
export function workspaceStep(matches: readonly Place[], at: number, step: number): number {
  const order = [...new Set(matches.map((place) => place.workspace))];
  if (at < 0 || order.length === 0) return at;
  const next = order[order.indexOf(matches[at]!.workspace) + step];
  return next === undefined ? -1 : matches.findIndex((place) => place.workspace === next);
}
