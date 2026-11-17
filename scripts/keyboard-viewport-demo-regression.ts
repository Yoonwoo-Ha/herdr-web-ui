import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-viewport-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

  const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  },
});

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      await checkMobileViewport(browser, `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app`, panes.api);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop();
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
