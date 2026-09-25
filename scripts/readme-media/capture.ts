/**
 * Regenerates the README media in docs/screenshots from a staged demo session (stage.ts):
 * screenshots at 2x, then a desktop and a phone walkthrough recorded as GIFs (needs ffmpeg).
 *
 *   bun run build && bun scripts/readme-media/capture.ts [shots] [video]
 */
import { stage } from "./stage.ts";
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
const { herdrRpc } = await import("../../server/herdr/client.ts");

const OUT = join(import.meta.dir, "../../docs/screenshots");
const what = process.argv.slice(2);
const want = (part: string) => what.length === 0 || what.includes(part);
mkdirSync(OUT, { recursive: true });
const demo = await stage();
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
const views = Object.fromEntries(demo.panes.map((x) => ["herdr-web-ui:view:" + x.pane, x.agent ? "chat" : "terminal"]));
// headless recordings draw no pointer: show one (desktop) or a touch ring (phone)
const pointer = (touch: boolean) => `(() => { const add = () => {
  const dot = document.createElement("div"); dot.id = "demo-pointer";
  Object.assign(dot.style, { position: "fixed", zIndex: 99999, pointerEvents: "none", left: "-40px", top: "-40px",
    width: ${touch ? "'34px'" : "'18px'"}, height: ${touch ? "'34px'" : "'18px'"}, marginLeft: ${touch ? "'-17px'" : "'-2px'"}, marginTop: ${touch ? "'-17px'" : "'-2px'"},
    borderRadius: "50%", background: ${touch ? "'rgba(255,255,255,.35)'" : "'rgba(255,255,255,.92)'"}, border: ${touch ? "'2px solid rgba(255,255,255,.8)'" : "'2px solid #111'"},
    transition: "transform .12s", opacity: ${touch ? "0" : "1"} });
  document.body.appendChild(dot);
  const at = (x, y) => { dot.style.left = x + "px"; dot.style.top = y + "px"; };
  addEventListener("mousemove", (e) => at(e.clientX, e.clientY), true);
  addEventListener("mousedown", () => dot.style.transform = "scale(.7)", true);
  addEventListener("mouseup", () => dot.style.transform = "", true);
  addEventListener("touchstart", (e) => { const t = e.touches[0]; at(t.clientX, t.clientY); dot.style.opacity = "1"; dot.style.transform = "scale(.8)"; }, true);
  addEventListener("touchmove", (e) => { const t = e.touches[0]; at(t.clientX, t.clientY); }, true);
  addEventListener("touchend", () => { dot.style.transform = ""; setTimeout(() => dot.style.opacity = "0", 250); }, true);
}; if (document.body) add(); else addEventListener("DOMContentLoaded", add); })()`;

async function shots() {
  await herdrRpc("pane.send_text", { pane_id: demo.pane("shell").pane, text: "git log --oneline --graph --decorate --color=always | cat && bun test\n" });
  const shot = async (name: string, key: string, mobile: boolean, then?: (page: any) => Promise<void>) => {
    await demo.reset();
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await demo.routes(page);
    await page.addInitScript((items) => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v as string); }, views);
    await page.goto(`${demo.base}/?pane=${encodeURIComponent(demo.pane(key).pane)}`);
    await Bun.sleep(4000);
    await then?.(page);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await context.close();
  };
  await shot("desktop-chat", "api", false);
  await shot("desktop-terminal", "shell", false);
  await shot("desktop-prompt", "web", false);
  await shot("mobile-chat", "api", true);
  await shot("mobile-terminal", "shell", true);
  await shot("mobile-sessions", "api", true, async (page) => { await page.locator(".drawer-toggle").tap(); await Bun.sleep(800); });
}

async function video(mode: "desktop" | "mobile") {
  await demo.reset();
  const shell = demo.pane("shell");
  const mobile = mode === "mobile";
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, colorScheme: "dark", ...(mobile ? { isMobile: true, hasTouch: true } : {}), recordVideo: { dir: join(OUT, `raw-${mode}`), size: mobile ? { width: 780, height: 1688 } : viewport } });
  const page = await context.newPage();
  await demo.routes(page);
  await page.addInitScript((items) => { for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v as string); }, views);
  await page.addInitScript(pointer(mobile));
  const glide = async (selector: string, click = true) => {
    const box = (await page.locator(selector).first().boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (mobile) { if (click) await page.locator(selector).first().tap(); return; }
    await page.mouse.move(x, y, { steps: 18 }); await Bun.sleep(180);
    if (click) await page.mouse.click(x, y);
  };
  const swipe = async (fromY: number, toY: number) => {
    const cdp = await context.newCDPSession(page);
    const x = 200; let y = fromY; const steps = 14;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) { y = fromY + (toY - fromY) * i / steps; await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] }); await Bun.sleep(25); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await page.goto(`${demo.base}/?pane=${encodeURIComponent(demo.pane("api").pane)}`);
  await Bun.sleep(3500);
  const row = (key: string) => `.pane-select[title^="${demo.pane(key).pane} "]`;
  if (!mobile) {
    await page.mouse.move(900, 500);
    await Bun.sleep(1200);
    await glide(".work-block-head"); await Bun.sleep(1600);              // open the folded work
    await page.mouse.wheel(0, -260); await Bun.sleep(1200);
    await glide(row("web")); await Bun.sleep(2200);                        // codex asks
    await glide(".prompt-card-options button"); await Bun.sleep(1800);    // answer from the chat
    await glide(row("shell")); await Bun.sleep(1200);                      // the real terminal
    await page.keyboard.type("git tag --list && bun test", { delay: 55 }); await page.keyboard.press("Enter"); await Bun.sleep(2600);
    await page.keyboard.press("Control+Shift+K"); await Bun.sleep(700);    // jump anywhere
    await page.keyboard.type("backup", { delay: 90 }); await Bun.sleep(700); await page.keyboard.press("Enter"); await Bun.sleep(2200);
    await glide('.view-switch button[title^="Live terminal"]', false); await Bun.sleep(600);
  } else {
    await Bun.sleep(800);
    await swipe(420, 700); await Bun.sleep(1200);                           // read back
    await page.locator(".drawer-toggle").tap(); await Bun.sleep(1300);     // every agent
    await page.locator(row("web")).tap(); await Bun.sleep(2200);          // codex asks
    await page.locator(".prompt-card-options button").first().tap(); await Bun.sleep(1800);
    await page.locator(".drawer-toggle").tap(); await Bun.sleep(1000);
    await page.locator(row("shell")).tap(); await Bun.sleep(1500);        // the terminal, with a key bar
    await herdrRpc("pane.send_text", { pane_id: shell.pane, text: "git log --oneline --graph --decorate --color=always | cat\n" }); await Bun.sleep(1800);
    await page.locator(".view-switch button").first().tap().catch(() => {}); await Bun.sleep(600);
    await page.locator(".drawer-toggle").tap(); await Bun.sleep(900);
    await page.locator(row("api")).tap(); await Bun.sleep(1500);
    await page.locator(".composer-text").tap(); await page.keyboard.type("Ship it, then tag v1.4.1", { delay: 60 }); await Bun.sleep(1500);
  }
  await context.close();
  const dir = join(OUT, `raw-${mode}`);
  const file = readdirSync(dir).find((f) => f.endsWith(".webm"))!;
  const webm = join(OUT, `demo-${mode}.webm`);
  renameSync(join(dir, file), webm);
  rmSync(dir, { recursive: true, force: true });
  // skip the page load; a palette per clip keeps the GIF small and the UI colours true
  const [skip, width] = mode === "desktop" ? ["3.2", "960"] : ["2.5", "320"];
  const filter = `fps=10,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const ffmpeg = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-ss", skip, "-i", webm, "-vf", filter, join(OUT, `demo-${mode}.gif`)]);
  if (ffmpeg.exitCode !== 0) throw new Error(ffmpeg.stderr.toString());
  rmSync(webm);
}

try {
  if (want("shots")) await shots();
  if (want("video")) { await video("desktop"); await video("mobile"); }
} finally {
  await browser.close();
  await demo.teardown();
}
process.exit(0);
