/**
 * Settings -> Terminal -> Draw with libghostty: on a herdr-core server (`terminal-history`) libghostty
 * draws the pane over its xterm from every byte xterm was given, the ones before its module loaded
 * included; a Kitty graphics picture is drawn where it was placed and goes when the program deletes
 * it; typing still goes through xterm. herdr's own server, or the setting off, keep xterm alone and
 * never fetch the module. Demo fixtures only: no herdr, hc or user state.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface Frame { type: string; pane_id?: string; data?: string; text?: string; features?: string[] }
interface GhosttyFixture { inputs: Frame[]; print(data: string): void }
declare global { interface Window { ghosttyFixture: GhosttyFixture } }

/** The demo serves the pane; its features and the pane's bytes are the test's. */
function installGhosttyFixture(): void {
  const core = new URL(location.href).searchParams.get("server") === "core";
  // printed at attach, before libghostty's module can have loaded: it comes from the held bytes
  const first = "\x1b[H\x1b[2JBEFORE-LOAD\r\n";
  const sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }> = [];
  let pane: string | null = null;
  // a server lists its features before any pane's bytes; the demo lists them in its snapshot, after the attach
  let featured = false;
  let waiting: (() => void) | null = null;
  const state: GhosttyFixture = {
    inputs: [],
    print: (data) => { for (const socket of sockets) if (pane) socket.push({ type: "pty-data", fixture: "ghostty", pane_id: pane, data }); },
  };
  window.ghosttyFixture = state;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as (typeof sockets)[number];
    sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if ((frame.type === "snapshot" || frame.type === "features") && Array.isArray(frame.features) && core) {
        push({ ...frame, features: [...(frame.features as string[]), "terminal-history"] });
      } else if (frame.type === "pty-data") {
        // the demo's own recording would move the screen under the test
        if (frame.fixture !== "ghostty") return;
        const { fixture: _, ...output } = frame;
        push(output);
      } else push(frame);
      if (frame.type === "snapshot" || frame.type === "features") {
        featured = true;
        waiting?.();
        waiting = null;
      }
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (["input", "keys", "submit"].includes(frame.type)) state.inputs.push(frame);
      send(raw);
      if (frame.type === "attach" && frame.pane_id) {
        pane = frame.pane_id;
        const paint = () => socket.push({ type: "pty-data", fixture: "ghostty", pane_id: frame.pane_id, data: first });
        if (featured) paint();
        else waiting = paint;
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

/** a 4x4 square of one colour as a Kitty graphics picture, raw RGBA sent in the escape itself, shown 4 columns by 2 rows */
const kittySquare = (id: number, rgb: [number, number, number]): string => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) pixels.set([...rgb, 255], i * 4);
  return `\x1b_Ga=T,f=32,s=4,v=4,i=${id},c=4,r=2,q=2;${pixels.toString("base64")}\x1b\\`;
};

const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const print = async (page: Page, data: string, marker: string) => {
  await page.evaluate((data) => window.ghosttyFixture.print(data), `${data}${marker}\r\n`);
  await page.waitForFunction((marker) => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes(marker)), marker);
  await settled(page);
};
/** the colour at the middle of the pane's one Kitty picture, or null when it draws none */
const picture = (page: Page) => page.evaluate(() => {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".pane-frame.is-current .ghostty-image")];
  if (canvases.length !== 1) return canvases.length === 0 ? null : { count: canvases.length };
  const canvas = canvases[0]!;
  const [r, g, b] = canvas.getContext("2d")!.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
  return { rgb: [r, g, b], width: canvas.style.width, top: canvas.style.top };
});

async function open(browser: Browser, server: number, prefix: string, kind: "core" | "herdr", ghostty: boolean): Promise<{ page: Page; wasm: string[]; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript((ghostty) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false }));
    localStorage.setItem("ovis:terminal-ghostty", JSON.stringify(ghostty));
  }, ghostty);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const wasm: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(".wasm")) wasm.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "warning" && message.text().includes("libghostty")) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal&server=${kind}`);
  // attached, not visible: once libghostty draws, xterm's own rows are hidden under it
  await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "BEFORE-LOAD" }).waitFor({ state: "attached" });
  return { page, wasm, errors };
}

const app = mkdtempSync(join(tmpdir(), "terminal-ghostty-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installGhosttyFixture.toString()})()</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      {
        const { page, wasm, errors } = await open(browser, server.port, prefix, "core", true);
        await page.locator(".pane-frame.is-current .pane-terminal[data-renderer='ghostty']").waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-row")].some((row) => row.textContent?.includes("BEFORE-LOAD")));
        assert.equal(wasm.length, 1, "core: the module is fetched once");
        assert.equal(await page.locator(".pane-frame.is-current .xterm-rows").evaluate((rows) => getComputedStyle(rows).visibility), "hidden", "core: xterm's own text is hidden under libghostty's");

        await print(page, `\x1b[5;3H${kittySquare(7, [255, 0, 0])}`, "RED-PLACED");
        const red = await picture(page);
        assert.deepEqual(red?.rgb, [255, 0, 0], `core: the Kitty picture is drawn (${JSON.stringify(red)})`);
        const cell = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".pane-frame.is-current .ghostty-layer")!).getPropertyValue("--ghostty-ch")));
        assert.equal(red?.top, `${4 * cell}px`, "core: at the row it was placed on");

        // a dark palette names no ANSI colours: they are xterm's own, not black
        await print(page, "\x1b[31mRED-TEXT\x1b[0m\r\n", "COLOURED");
        const ansiRed = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .ghostty-row span")].find((span) => span.textContent?.includes("RED-TEXT"))?.style.color);
        assert.equal(ansiRed, "rgb(204, 0, 0)", "core: ANSI red is xterm's red under a palette that names none");

        // a wide character after a combining accent keeps its two cells: the accent is part of the cell before it
        await print(page, "e\u0301\u754cX\r\n", "COMBINED");
        assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".pane-frame.is-current .ghostty-wide")].map((cell) => cell.textContent)), ["\u754c"], "core: the wide cell is the CJK character, not the accent");

        await print(page, "\x1b_Ga=d,d=I,i=7,q=2\x1b\\", "RED-DELETED");
        assert.equal(await picture(page), null, "core: a picture the program deletes goes");

        // typing still goes through xterm, to the pane
        await page.locator(".pane-frame.is-current .pane-terminal").click();
        await page.keyboard.type("x");
        await page.waitForFunction(() => window.ghosttyFixture.inputs.some((frame) => frame.type === "input" && frame.text === "x"));
        assert.deepEqual(errors, [], "core: no page errors");
        await page.context().close();
      }
      for (const [kind, ghostty] of [["herdr", true], ["core", false]] as const) {
        const { page, wasm, errors } = await open(browser, server.port, prefix, kind, ghostty);
        await page.evaluate((data) => window.ghosttyFixture.print(data), `${kittySquare(8, [0, 0, 255])}AFTER\r\n`);
        await page.locator(".pane-frame.is-current .xterm-rows", { hasText: "AFTER" }).waitFor({ state: "attached" });
        await settled(page);
        assert.equal(await page.locator(".pane-frame.is-current .pane-terminal[data-renderer]").count(), 0, `${kind}${ghostty ? "" : ", off"}: xterm draws`);
        assert.equal(await page.locator(".pane-frame.is-current .ghostty-layer").count(), 0, `${kind}${ghostty ? "" : ", off"}: no libghostty layer`);
        assert.deepEqual(wasm, [], `${kind}${ghostty ? "" : ", off"}: the module is never fetched`);
        assert.deepEqual(errors, [], `${kind}${ghostty ? "" : ", off"}: no page errors`);
        await page.context().close();
      }
      console.log("PASS libghostty: draws a herdr-core pane from its first byte with Kitty pictures; herdr's own and off stay xterm");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
