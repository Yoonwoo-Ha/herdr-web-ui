import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const LINUX_CHROME = "/opt/google/chrome/chrome";

export function chromePath(): string {
  return process.env["CHROME_PATH"] || (existsSync(LINUX_CHROME) ? LINUX_CHROME : chromium.executablePath());
}
