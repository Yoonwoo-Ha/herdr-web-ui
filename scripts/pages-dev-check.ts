/**
 * The built shell as Cloudflare Pages itself serves it: `wrangler pages dev` (the deploy jobs' pinned wrangler,
 * .github/deploy-tools) on a dist-shell, asked for each of the shell's routes. A PC's render host must answer at its own
 * address with a 200 and the render policy alone, the policy that lets render.html's inline script run in its sandbox:
 * from 2026-11-01 Pages answered it with a 308 to /render under the shell's policy, so no page drew on app.ovis.sh,
 * while scripts/pages-static.ts, which the browser scripts serve the shell with, answered as the rules read. Every
 * other route must answer as pages-static.ts does, which keeps that loopback server honest.
 *
 * Usage: `bun run build:shell && bun scripts/pages-dev-check.ts [dist-shell]`. It installs the pinned wrangler
 * into a folder of its own (network once), or takes WRANGLER=<path to a wrangler binary>, and keeps wrangler's
 * config and logs in that folder too.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagePolicy } from "../shared/web-policy.ts";
import { loadPagesSite, pagesResponse } from "./pages-static.ts";

const repo = join(import.meta.dir, "..");
const dist = process.argv[2] ?? join(repo, "dist-shell");
if (!existsSync(join(dist, "render.html")) || !existsSync(join(dist, "_redirects"))) {
  throw new Error(`${dist} is not a built shell: run \`bun run build:shell\` first`);
}
const ID = "feedc0de".repeat(4);

const work = mkdtempSync(join(tmpdir(), "pages-dev-"));
let server: ReturnType<typeof Bun.spawn> | null = null;
try {
  let wrangler = process.env["WRANGLER"];
  if (!wrangler) {
    const tools = join(work, "deploy-tools");
    cpSync(join(repo, ".github/deploy-tools"), tools, { recursive: true });
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], { cwd: tools, stdout: "ignore", stderr: "pipe" });
    if (install.exitCode !== 0) throw new Error(`the pinned wrangler did not install:\n${install.stderr.toString()}`);
    wrangler = join(tools, "node_modules/.bin/wrangler");
  }
  const site = join(work, "site");
  cpSync(dist, site, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  // a fixed date the pinned wrangler's runtime supports; the asset handling it picks is Pages' own
  server = Bun.spawn([wrangler, "pages", "dev", site, "--ip", "127.0.0.1", "--port", String(port), "--compatibility-date", "2026-10-01"], {
    cwd: work,
    env: { ...process.env, XDG_CONFIG_HOME: join(work, "config"), WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${origin}/build.json`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`wrangler pages dev did not answer on ${origin} within 60 s`);
    await Bun.sleep(250);
  }

  const index = /src="(\/assets\/index-[^"]+\.js)"/.exec(readFileSync(join(dist, "index.html"), "utf8"))?.[1];
  assert.ok(index, "the built index.html names its script");
  const paths = [
    "/", "/index.html", "/build.json", "/sw.js", "/manifest.webmanifest", "/render", "/render.html", "/%2Frender.html", "/%2Frender.html?x=1",
    "/%2F%2Frender.html", "/%5Crender.html", index, "/assets/index-gone0000.js",
    "/.well-known/assetlinks.json", `/s/${ID}`, `/s/${ID}/`, `/s/${ID}/deep/path`, `/s/${ID}/sw.js`,
    `/s/${ID}/manifest.webmanifest`, `/s/${ID}/~render`,
  ];
  const loopback = loadPagesSite(dist);
  // what decides a route: where it leads, its policy, its caching (Pages' own default where no rule sets one) and its
  // bytes. Content types differ in spelling only (application/ and text/javascript)
  const shape = async (response: Response) => ({
    status: response.status,
    location: response.headers.get("location"),
    policy: response.headers.get("content-security-policy"),
    cache: response.headers.get("cache-control") ?? "public, max-age=0, must-revalidate",
    body: response.status === 200 ? Bun.hash(await response.arrayBuffer()).toString(16) : "",
  });
  const differ: string[] = [];
  for (const path of paths) {
    const pages = await shape(await fetch(`${origin}${path}`, { redirect: "manual" }));
    const ours = await shape(await pagesResponse(loopback, new Request(`https://app.ovis.sh${path}`)));
    const same = JSON.stringify(pages) === JSON.stringify(ours);
    console.log(`${same ? "same  " : "DIFFER"} ${path.padEnd(48)} pages dev: ${pages.status}${pages.location ? ` -> ${pages.location}` : ""}`);
    if (!same) differ.push(`${path}\n  pages dev:      ${JSON.stringify(pages)}\n  pages-static.ts: ${JSON.stringify(ours)}`);
  }

  const render = await fetch(`${origin}/s/${ID}/~render`, { redirect: "manual" });
  assert.equal(render.status, 200, `the render host answers itself, not a ${render.status} to ${render.headers.get("location")}`);
  assert.match(render.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(await render.text(), readFileSync(join(dist, "render.html"), "utf8"), "the render host is render.html");
  const policy = render.headers.get("content-security-policy") ?? "";
  assert.equal(policy, pagePolicy(null), "the render host has the render policy alone, no shell policy beside it");
  const scripts = /(?:^|;)\s*script-src ([^;]*)/.exec(policy)?.[1] ?? "";
  assert.ok(scripts.split(/\s+/).includes("'unsafe-inline'") && !/'(?:nonce|sha256|sha384|sha512)-/.test(scripts), "render.html's inline script may run (no hash or nonce cancels 'unsafe-inline')");
  assert.ok(/(?:^|;)\s*sandbox allow-scripts(?:;|$)/.test(policy), "it runs in a sandbox with no origin");
  const followed = await fetch(`${origin}/s/${ID}/~render`);
  assert.equal([followed.status, new URL(followed.url).pathname].join(" "), `200 /s/${ID}/~render`, "following redirects lands on the render host itself");
  assert.deepEqual(differ, [], `pages-static.ts answers otherwise than Pages:\n${differ.join("\n")}`);
  console.log("PASS the built shell's routes as Pages serves them; the render host answers itself with its own policy");
} finally {
  server?.kill();
  await server?.exited;
  rmSync(work, { recursive: true, force: true });
}
