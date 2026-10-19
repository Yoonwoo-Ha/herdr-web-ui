/**
 * Assembles app/www, what the iOS app carries: its own pages (app/web) and the demo, built from
 * this checkout's client with the demo's fixture transport (scripts/demo-build.ts), so the app
 * can be tried with no PC, as App Review must. Run `bun run build:web` in app/.
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemoApp } from "../../scripts/demo-build.ts";

const app = join(import.meta.dir, "..");
const www = join(app, "www");
rmSync(www, { recursive: true, force: true });
cpSync(join(app, "web"), www, { recursive: true });

const demo = join(www, "demo");
await buildDemoApp(demo);
const index = join(demo, "index.html");
const html = readFileSync(index, "utf8");
if (!html.includes('<script type="module"')) throw new Error("the demo's index.html has no module script to load the transport before");
writeFileSync(index, html.replace('<script type="module"', '<script src="./demo-transport.js"></script>\n    <script type="module"'));
