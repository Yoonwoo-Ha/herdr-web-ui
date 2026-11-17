import type { Page } from "playwright-core";

export async function sheetsSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"
    || !/^(?:sheet|scrim)-in$/.test((animation as CSSAnimation).animationName ?? "")), undefined, { timeout: 5_000 });
}

/**
 * A Back pressed, or a page load asked for, before that step lands is spent on it: Back leaves the closed surface's
 * entry and goes no further, and the load is dropped.
 */
export async function sheetEntryLeft(page: Page): Promise<void> {
  await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === undefined);
}
