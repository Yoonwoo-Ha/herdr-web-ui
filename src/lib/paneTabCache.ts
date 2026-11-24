import type { LayoutCell } from "./layoutMap.ts";

export function visitPaneTab(previous: readonly string[], current: string | null, liveTabs: ReadonlySet<string>): readonly string[] {
  const surviving = previous.filter((id) => liveTabs.has(id) && id !== current);
  return current !== null && liveTabs.has(current) ? [current, ...surviving].slice(0, 4) : surviving.slice(0, 4);
}

/** Only previously mounted panes survive: new hidden splits must not acquire an attach. */
export function cachedPaneCells(
  tabs: readonly string[], current: string | null,
  panes: readonly { readonly pane_id: string; readonly tab_id: string }[],
  lastCells: ReadonlyMap<string, LayoutCell>, shownIds: ReadonlySet<string>,
): LayoutCell[] {
  const cachedTabs = new Set(tabs.filter((id) => id !== current));
  return panes.flatMap((pane) => {
    const cell = lastCells.get(pane.pane_id);
    return cachedTabs.has(pane.tab_id) && !shownIds.has(pane.pane_id) && cell ? [cell] : [];
  });
}

/**
 * The order panes keep in the canvas: a keyed child that changes rank is moved in the DOM by React,
 * and moving a frame resets the scrollTop of everything it scrolls (the chat view lands on its
 * oldest row). React moves a child when one placed before it stood after it before, so every frame
 * keeps its place in the walk below except a drawn frame the layout now wants later: an explicit
 * swap moves one of the exchanged frames, keeping the keyboard order on the visual one, and never a
 * frame of another tab mounted between them. A split inserts its pane at the new pane's layout
 * place (an insert moves no sibling), a cached pane keeps its place, and a tab switch appends the
 * presented frames instead of reordering the ones already mounted.
 */
export function orderedPaneCells<T extends { readonly paneId: string }>(
  previous: readonly string[], cells: readonly T[], drawn: ReadonlySet<string>,
): T[] {
  const byId = new Map(cells.map((cell) => [cell.paneId, cell]));
  const mounted = new Set(previous);
  const layoutsDrawn = cells.filter((cell) => drawn.has(cell.paneId));
  // the drawn frames already mounted, in the layout's order, and those the walk passed before their turn
  const due = layoutsDrawn.filter((cell) => mounted.has(cell.paneId));
  const passed = new Set<string>();
  const order: T[] = [];
  for (const id of previous) {
    const cell = byId.get(id);
    if (cell === undefined) continue;
    if (!drawn.has(id)) order.push(cell);
    else if (due[0]?.paneId !== id) passed.add(id);
    else {
      order.push(due.shift()!);
      while (due[0] !== undefined && passed.has(due[0].paneId)) order.push(due.shift()!);
    }
  }
  order.push(...due);
  for (const cell of layoutsDrawn.filter((candidate) => !mounted.has(candidate.paneId))) {
    // a split's pane goes where the layout puts it: before the next frame the layout draws after it
    const after = layoutsDrawn.slice(layoutsDrawn.indexOf(cell) + 1).find((candidate) => order.includes(candidate));
    order.splice(after === undefined ? order.length : order.indexOf(after), 0, cell);
  }
  const placed = new Set(order.map((cell) => cell.paneId));
  return [...order, ...cells.filter((cell) => !placed.has(cell.paneId))];
}
