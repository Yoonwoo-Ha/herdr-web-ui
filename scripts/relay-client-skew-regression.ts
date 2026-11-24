/**
 * An older client against this checkout's server, the reverse of `relay-e2e-regression.ts --skew`. The phone app
 * carries its own copy of the client (docs/native-app.md, "The app carries its client"), so a PC must keep working
 * with every app build at or above the oldest client it supports (server/relay/client-floor.ts). This builds the
 * hosted shell of a release tag in a worktree of its own, serves it as Cloudflare Pages would (pages-static.ts) with
 * the app's contract set on the page (lib/appShell.ts), and opens this checkout's PC through the Bun relay: it pairs,
 * attaches a terminal, types, and reads the output back in the page and in herdr's own pane.
 *
 * The tag is by default the oldest client a store build carries (server/relay/store-app-versions.json) at or above the
 * floor; while no store build carries one, the latest release at or below this checkout's version, which the first store
 * build to carry the client will hold. A checkout without the tag (CI's shallow one) fetches it from the public repository.
 * The browser lane runs it (scripts/ci-browser.sh).
 *
 *   bun scripts/relay-client-skew-regression.ts [<tag>]
 *   RELAY_CLIENT_SHELL_DIR=<dist-shell> bun scripts/relay-client-skew-regression.ts    a shell built already
 *
 * UI_EVIDENCE_DIR=<dir> keeps the screenshots and the report there.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { startBunRelay } from "../relay/bun.ts";
import { paneRead, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { MIN_SUPPORTED_CLIENT_VERSION } from "../server/relay/client-floor.ts";
import { RelayService } from "../server/relay/service.ts";
import { decodeOffer, encodeOffer } from "../shared/relay-offer.ts";
import { compareVersions, parseVersion } from "../src/lib/relay/skew.ts";
import { chromePath } from "./chrome-path.ts";
import { servePagesSite } from "./pages-static.ts";
import { relayBrowserSocket } from "./relay-browser-bridge.ts";
import { shownRow } from "./shown-rows.ts";

const repo = join(import.meta.dir, "..");
const RELAY = "wss://relay.test";

interface StoreBuild { readonly client: string | null }

async function defaultTag(): Promise<{ tag: string; why: string }> {
  const stores = JSON.parse(readFileSync(join(repo, "server/relay/store-app-versions.json"), "utf8")) as Record<string, readonly StoreBuild[]>;
  const floor = parseVersion(MIN_SUPPORTED_CLIENT_VERSION)!;
  const supported = Object.values(stores).flat().flatMap((build) => build.client === null || compareVersions(parseVersion(build.client)!, floor) < 0 ? [] : [build.client]);
  const oldest = [...supported].sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!))[0];
  if (oldest !== undefined) return { tag: `v${oldest}`, why: "the oldest client a store build carries that the floor still supports" };
  const own = parseVersion((JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version)!;
  const latest = (await releaseTags()).flatMap((tag) => {
    const version = parseVersion(tag.slice(1));
    return version !== null && compareVersions(version, own) <= 0 ? [{ tag, version }] : [];
  }).sort((a, b) => compareVersions(b.version, a.version))[0];
  if (latest === undefined) throw new Error(`no release tag at or below ${own.join(".")} here or at ${PUBLIC_REPO}`);
  return { tag: latest.tag, why: "no store build carries a client the floor supports: the latest release at or below this checkout's version" };
}

/** A shallow checkout (CI's, a merge gate's clone) holds no tags: the public repository lists and gives them. */
const PUBLIC_REPO = "https://github.com/devswha/ovis.git";
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

async function releaseTags(): Promise<string[]> {
  const local = (await $`git tag -l ${"v*"}`.cwd(repo).quiet().text()).split("\n").filter((tag) => RELEASE_TAG.test(tag));
  if (local.length > 0) return local;
  const listed = await $`git ls-remote --tags --refs ${PUBLIC_REPO} ${"refs/tags/v*"}`.cwd(repo).quiet().text();
  return listed.split("\n").map((line) => line.split("\t")[1]?.replace("refs/tags/", "") ?? "").filter((tag) => RELEASE_TAG.test(tag));
}

async function haveTag(tag: string): Promise<void> {
  if ((await $`git rev-parse -q --verify ${`refs/tags/${tag}^{commit}`}`.cwd(repo).quiet().nothrow()).exitCode === 0) return;
  await $`git fetch --no-tags --depth=1 ${PUBLIC_REPO} ${`+refs/tags/${tag}:refs/tags/${tag}`}`.cwd(repo).quiet();
}

async function shellOf(tag: string, root: string): Promise<{ dir: string; done: () => Promise<void> }> {
  const tree = join(root, "tree");
  await haveTag(tag);
  await $`git worktree add --detach ${tree} ${tag}`.cwd(repo).quiet();
  const done = async (): Promise<void> => { await $`git worktree remove --force ${tree}`.cwd(repo).quiet().nothrow(); };
  try {
    await $`bun install --frozen-lockfile`.cwd(tree).quiet();
    await $`bun run build:shell`.cwd(tree).quiet();
    return { dir: join(tree, "dist-shell"), done };
  } catch (error) { await done(); throw error; }
}

async function smoke(shellDir: string, label: string): Promise<string[]> {
  const report: string[] = [];
  const note = (line: string): void => { report.push(line); console.log(line); };
  const evidence = process.env["UI_EVIDENCE_DIR"] || null;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const shellVersion = (() => { try { return (JSON.parse(readFileSync(join(shellDir, "build.json"), "utf8")) as { revision?: string }).revision ?? "?"; } catch { return "?"; } })();
  const root = mkdtempSync(join(tmpdir(), "ovis-relay-client-skew-"));
  const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
  const relayAddress = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
  const site = servePagesSite(shellDir, 0);
  const origin = `http://127.0.0.1:${site.port}`;
  const stateDir = mkdtempSync(join(root, "state-"));
  const dir = mkdtempSync(join(root, "files-"));
  let synced = Promise.withResolvers<void>();
  const service = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayAddress(url));
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
    return socket;
  } });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, relay: service, accountOpensAll: false });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
  let browser: Browser | undefined;
  const workspaces: string[] = [];
  let page: Page | undefined;
  try {
    synced = Promise.withResolvers<void>();
    assert.equal((await post("/start")).status, 200, "the PC's relay started");
    await Promise.race([synced.promise, Bun.sleep(30_000).then(() => { throw new Error("the PC did not sync with the relay within 30 s"); })]);
    const offered = await post("/offer");
    const offer = decodeOffer((JSON.parse(await offered.text()) as { url: string }).url);
    assert.ok(offer, "the PC gave an offer");
    note(`client ${label} (build ${shellVersion.slice(0, 12)}) from ${shellDir} at ${origin}; this checkout's PC at ${base}, floor ${MIN_SUPPORTED_CLIENT_VERSION}; relay ws://127.0.0.1:${relay.port} as ${RELAY}`);

    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => relayBrowserSocket(ws, () => relayAddress(ws.url())));
    await context.addInitScript(() => {
      Object.defineProperty(window, "__ovisAppShell", { value: { bundled: true, platform: "android", appVersion: "0.0.0", build: 1 } });
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}") as object }));
    });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.error("page error", error.stack));

    const workspace = await workspaceCreate({ cwd: dir, label: "relay-client-skew" });
    workspaces.push(workspace.workspace.workspace_id);
    const pane = workspace.root_pane.pane_id;
    await page.goto(encodeOffer({ ...offer, name: "Skew PC" }, origin));
    await page.locator('main[data-relay-state="confirm"]').waitFor();
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.locator(".app").waitFor();
    assert.ok(app.context.services.devices.list(null).some((device) => device.via_relay), "the PC enrolled the phone via the relay");
    note("paired through the relay: confirm -> Pair -> the app");

    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace.workspace.workspace_id)}] .workspace-select`).first().click();
    const stack = page.locator(`.terminal-stack[data-pane-owner=${JSON.stringify(pane)}]`);
    await stack.locator(".xterm-screen").waitFor({ state: "attached" });
    const text = (): Promise<string> => page!.evaluate((rows) => [...document.querySelectorAll(rows)].map((row) => (row.textContent ?? "").replaceAll(" ", " ")).join("\n"), shownRow(`.terminal-stack[data-pane-owner="${pane}"]`));
    const until = async (what: string, check: () => Promise<boolean>): Promise<void> => {
      for (const deadline = Date.now() + 30_000; !(await check());) {
        if (Date.now() > deadline) throw new Error(`${what}: not within 30 s`);
        await Bun.sleep(100);
      }
    };
    await until("the pane's terminal attached and drew its prompt", async () => (await text()).trim() !== "");
    await stack.locator(".xterm-screen").click();
    await page.keyboard.type("echo skew-ok");
    await page.keyboard.press("Enter");
    await until("skew-ok in the terminal", async () => /^skew-ok\s*$/m.test(await text()));
    assert.match((await paneRead({ paneId: pane })).text, /^skew-ok\s*$/m, "herdr's own pane printed it");
    if (evidence) await page.screenshot({ path: join(evidence, "client-skew-terminal.png") });
    note(`terminal: pane ${pane} attached, typed "echo skew-ok" + Enter -> skew-ok in the page and in herdr's pane.read`);
  } catch (error) {
    if (evidence && page) await page.screenshot({ path: join(evidence, "client-skew-failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    site.stop(true);
    await service.shutdown();
    app.stop();
    await relay.stop();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
  if (evidence) writeFileSync(join(evidence, "client-skew-report.txt"), `${report.join("\n")}\n`);
  return report;
}

const given = process.env["RELAY_CLIENT_SHELL_DIR"];
if (given) {
  if (!existsSync(join(given, "index.html"))) throw new Error(`${given} holds no built shell`);
  await smoke(given, given);
} else {
  const chosen = process.argv[2] ? { tag: process.argv[2], why: "named" } : await defaultTag();
  console.log(`client from ${chosen.tag} (${chosen.why})`);
  const root = mkdtempSync(join(tmpdir(), "ovis-relay-client-skew-tree-"));
  const shell = await shellOf(chosen.tag, root);
  try { await smoke(shell.dir, chosen.tag); }
  finally { await shell.done(); rmSync(root, { recursive: true, force: true }); }
}
console.log("PASS relay client skew");
