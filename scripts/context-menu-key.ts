import type { Page } from "playwright-core";

/**
 * The keyboard's context-menu key on the focused element, for a menu the app opens from the
 * browser's own `contextmenu` event (the sidebar rows, `onRowContextMenu`). macOS has no such key
 * and Chrome there ignores Shift+F10 (#1371), so on a Mac this fires the event that key makes: a
 * `contextmenu` with no pointer position, on the focused element.
 */
export async function contextMenuKey(page: Page): Promise<void> {
  if (process.platform !== "darwin") return page.keyboard.press("Shift+F10");
  await page.evaluate(() => document.activeElement?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
}
