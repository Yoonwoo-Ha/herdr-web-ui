import type { Page } from "playwright-core";

export type Lens = "chat" | "terminal";

export async function openLens(page: Page, lens: Lens, how: "click" | "tap" = "click"): Promise<void> {
  if (await page.evaluate(() => matchMedia("(max-width: 640px)").matches)) {
    const toggle = page.locator(".app-header .lens-toggle");
    await toggle.waitFor();
    if ((await toggle.getAttribute("data-view")) !== lens) await toggle[how]();
    return;
  }
  await page.locator(".app-header .view-switch").getByRole("button", { name: lens === "chat" ? "Chat" : "Terminal", exact: true })[how]();
}
