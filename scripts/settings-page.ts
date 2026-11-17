import type { Page } from "playwright-core";

export async function sheetRisen(page: Page, selector = ".settings-dialog"): Promise<void> {
  await page.waitForFunction((selector) => document.querySelector(selector)?.getAnimations().length === 0, selector);
}

export async function openSettingsPage(page: Page, name: string, backName = "Back to settings"): Promise<void> {
  const dialog = page.locator(".settings-dialog");
  await dialog.waitFor();
  await sheetRisen(page);
  const tab = dialog.getByRole("tab", { name, exact: true });
  if (await tab.count() === 0) await dialog.getByRole("button", { name: backName, exact: true }).click();
  await tab.click();
  const panel = dialog.getByRole("tabpanel", { name, exact: true });
  await panel.waitFor();
  await openSettingsFolds(page);
}

export async function openSettingsFolds(page: Page): Promise<void> {
  const closed = page.locator(".settings-body:not([hidden]) details.settings-fold:not([open]) > summary");
  while (await closed.count() > 0) await closed.first().click();
}

export function themeSide(page: Page, side: "dark" | "light") {
  const switchTo = () => page.getByRole("group", { name: "Dark theme · Light theme", exact: true }).getByRole("button", { name: side === "dark" ? "Show dark themes" : "Show light themes", exact: true }).click();
  const cards = page.getByRole("radiogroup", { name: side === "dark" ? "Dark theme" : "Light theme", exact: true });
  return {
    async selectOption(id: string): Promise<void> {
      await switchTo();
      await cards.locator(`[data-theme-card="${id}"]`).click();
      await cards.locator(`[data-theme-card="${id}"][aria-checked="true"]`).waitFor();
    },
    async inputValue(): Promise<string> {
      await switchTo();
      return (await cards.locator('[role="radio"][aria-checked="true"]').getAttribute("data-theme-card")) ?? "";
    },
    async listed(): Promise<string[]> {
      await switchTo();
      return cards.locator("[data-theme-card]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-theme-card") ?? ""));
    },
  };
}
