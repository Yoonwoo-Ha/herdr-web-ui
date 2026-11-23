/**
 * The menu, as herdr's: four entries (settings, the keys' help, reload the config, detach), chosen with the arrows and
 * Enter or by a click. It opens by a click on the sidebar's menu button, or by the screen's own key after the prefix.
 */
import type { KeyInput } from "./effects.ts";
import type { HerdrAction } from "../../shared/herdr-keys.ts";

/** The menu's entries, in herdr's order: each runs its action. */
export const MENU_ENTRIES = ["settings", "help", "reload_config", "detach"] as const satisfies readonly HerdrAction[];

/** The cursor over a list of `entries` after an arrow key (wrapping round), or null for any other key. */
export function movedCursor(entries: readonly unknown[], cursor: number, event: KeyInput): number | null {
  if (Object.keys(event.mods).length > 0 || entries.length === 0) return null;
  const step = event.key === "ARROW_DOWN" ? 1 : event.key === "ARROW_UP" ? -1 : 0;
  return step === 0 ? null : ((cursor + step) % entries.length + entries.length) % entries.length;
}
