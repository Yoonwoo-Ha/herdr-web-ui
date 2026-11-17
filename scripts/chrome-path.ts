import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const LINUX_CHROME = "/opt/google/chrome/chrome";

/**
 * The browser a script launches: `CHROME_PATH` when it is set (the browser lane sets it), Google
 * Chrome's Linux package where it is installed, and otherwise the lockfile's Playwright Chromium,
 * which is what a Mac or a Windows PC has (`bun node_modules/playwright-core/cli.js install chromium`).
 */
export function chromePath(): string {
  return process.env["CHROME_PATH"] || (existsSync(LINUX_CHROME) ? LINUX_CHROME : chromium.executablePath());
}
