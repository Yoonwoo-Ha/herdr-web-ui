import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Whether the PC the hosted app opened on this page is inside its 24 hours in the account (new_until), as the relay shell
 * read it when it opened the app (shell.tsx enterApp). Security-triage C3, pin 1 (#16): while it is, nothing of that PC is
 * selected or opened without a tap on that exact session. `"unknown"` until the account's PCs are read, which holds the
 * same way (fails closed); null everywhere else, a PC's own window included. `beforeYou`: added to the account before this
 * device joined (admitted_before_you), held all the same but not new to this device: its one notice is the main area's card
 * (NewPcNotices), never a row in the sidebar.
 */
export type PcNewness = { readonly until: number; readonly beforeYou?: true } | "unknown" | null;

let current: PcNewness = null;
const listeners = new Set<() => void>();

export function setPcNewness(next: PcNewness): void {
  if (next === current || (next !== null && current !== null && next !== "unknown" && current !== "unknown" && next.until === current.until && next.beforeYou === current.beforeYou)) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

/** Held now: new (its window not passed on this clock) or not known yet. */
export function pcHeld(now = Date.now()): boolean {
  return current === "unknown" || (current !== null && now < current.until);
}

/** As pcHeld, and drawn again when the shell learns more or the window passes; `isNew`: tagged New PC in the sidebar. */
export function usePcNewness(): { readonly held: boolean; readonly isNew: boolean } {
  const known = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);
  const [, passed] = useState(0);
  const until = known !== null && known !== "unknown" ? known.until : null;
  useEffect(() => {
    if (until === null) return;
    const left = until - Date.now();
    if (!(left > 0)) return;
    // the directory only issues a 24-hour window: a timer never longer than that
    const timer = setTimeout(() => passed((count) => count + 1), Math.min(left, 86_400_000));
    return () => clearTimeout(timer);
  }, [until]);
  const now = Date.now();
  const held = known === "unknown" || (until !== null && now < until);
  return { held, isNew: held && known !== "unknown" && known?.beforeYou !== true };
}
