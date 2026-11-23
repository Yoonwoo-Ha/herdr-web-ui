/**
 * Assembles app/www, what the iOS app carries: its own pages (app/web) and the demo, built from
 * this checkout's client with the demo's fixture transport (scripts/demo-build.ts), so the app
 * can be tried with no PC, as App Review must. Run `bun run build:web` in app/.
 *
 * OVIS_APP_URL names another https origin for the hosted shell than app.ovis.sh (APP_ORIGIN in
 * web/shell.js, and the native code's: hosted-origin.ts), for a test build whose relay pairing links
 * point at a shell served elsewhere. OVIS_APP_HOME=bundled keeps the app's own page as the first screen, where the
 * native code otherwise opens the hosted shell's (hosted-origin.ts, appHome).
 */
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemoApp } from "../../scripts/demo-build.ts";
import { appHome, appOrigin, writeNativeOrigin } from "./hosted-origin.ts";
import { pretendardCss } from "./pretendard.ts";

const app = join(import.meta.dir, "..");
const www = join(app, "www");
const appUrl = appOrigin(process.env["OVIS_APP_URL"]);
rmSync(www, { recursive: true, force: true });
cpSync(join(app, "web"), www, { recursive: true });
// error.html stands alone: Android serves it without the files beside it while a PC is open
const errorPage = join(www, "error.html");
const link = '<link rel="stylesheet" href="shell.css">';
const errorHtml = readFileSync(errorPage, "utf8");
if (!errorHtml.includes(link)) throw new Error("error.html no longer links shell.css the way build-web.ts inlines it");
const sheep = 'src="ovis-sheep.svg"';
if (!errorHtml.includes(sheep)) throw new Error("error.html no longer shows ovis-sheep.svg the way build-web.ts inlines it");
writeFileSync(errorPage, errorHtml
  .replace(link, `<style>${readFileSync(join(www, "shell.css"), "utf8")}</style>`)
  .replace(sheep, `src="data:image/svg+xml;base64,${readFileSync(join(www, "ovis-sheep.svg")).toString("base64")}"`));

if (appUrl) {
  const shellJs = join(www, "shell.js");
  const constant = 'export const APP_ORIGIN = "https://app.ovis.sh";';
  const script = readFileSync(shellJs, "utf8");
  if (!script.includes(constant)) throw new Error("shell.js no longer declares APP_ORIGIN the way build-web.ts replaces it");
  writeFileSync(shellJs, script.replace(constant, `export const APP_ORIGIN = ${JSON.stringify(appUrl)};`));
}
const home = appHome(process.env["OVIS_APP_HOME"], process.env["OVIS_APP_ACCOUNT"] !== "0");
if (home !== "hosted") {
  const shellJs = join(www, "shell.js");
  const constant = 'export const APP_HOME = "hosted";';
  const script = readFileSync(shellJs, "utf8");
  if (!script.includes(constant)) throw new Error("shell.js no longer declares APP_HOME the way build-web.ts replaces it");
  writeFileSync(shellJs, script.replace(constant, `export const APP_HOME = ${JSON.stringify(home)};`));
}
writeNativeOrigin(app, appUrl, home);

if (process.env["OVIS_APP_ACCOUNT"] === "0") {
  const shellJs = join(www, "shell.js");
  const constant = "export const ACCOUNT_SIGN_IN = true;";
  const script = readFileSync(shellJs, "utf8");
  if (!script.includes(constant)) throw new Error("shell.js no longer declares ACCOUNT_SIGN_IN the way build-web.ts replaces it");
  writeFileSync(shellJs, script.replace(constant, "export const ACCOUNT_SIGN_IN = false;"));
}

const demo = join(www, "demo");
await buildDemoApp(demo);
// the build's .gz and .br sidecars are for a server's Accept-Encoding; the app reads files itself,
// and Android's asset merger takes x.js and x.js.gz for the same asset
for (const file of readdirSync(demo, { recursive: true, encoding: "utf8" })) {
  if (file.endsWith(".gz") || file.endsWith(".br")) rmSync(join(demo, file));
}
// the hosted page's typeface for the app's own pages, from the font files the demo carries
writeFileSync(join(www, "pretendard.css"), pretendardCss(join(app, "../src/fonts/pretendard/pretendardvariable-dynamic-subset.css"), demo));
const index = join(demo, "index.html");
const html = readFileSync(index, "utf8");
if (!html.includes('<script type="module"')) throw new Error("the demo's index.html has no module script to load the transport before");
writeFileSync(index, html.replace('<script type="module"', '<script src="./demo-transport.js"></script>\n    <script type="module"'));
