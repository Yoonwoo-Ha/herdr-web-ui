import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagePolicy } from "../server/file-view.ts";
import { shellContentSecurityPolicy } from "../server/static.ts";
import { REGIONAL_APPS } from "../shared/relay-regions.ts";
import { applyHeaders, loadPagesSite, pagesResponse, parseHeaders, parseRedirects, pathPattern, redirectFor } from "./pages-static.ts";
import { RENDER_DOCUMENT, RENDER_PATH, shellFiles, shellHeaders, shellRedirects } from "./shell-build.ts";

const ID = "ab".repeat(16);

describe("Pages path patterns", () => {
  it("match a splat greedily and a placeholder for one segment", () => {
    expect(pathPattern("/s/*").test(`/s/${ID}/deep/er`)).toBe(true);
    expect(pathPattern("/s/*").test("/other")).toBe(false);
    expect(pathPattern("/s/:id/sw.js").exec(`/s/${ID}/sw.js`)?.groups).toEqual({ id: ID });
    expect(pathPattern("/s/:id/sw.js").test(`/s/${ID}/x/sw.js`)).toBe(false);
    expect(pathPattern("/s/:id/~render").test(`/s/${ID}/~render`)).toBe(true);
  });
});

describe("the shell's Pages files, as Pages reads them", () => {
  const redirects = parseRedirects(shellRedirects());
  const headers = parseHeaders(shellHeaders());

  it("rewrite a PC's manifest, its worker and the render host, and send a slashless scope to its slash", () => {
    // Pages ignores the scope's catch-all, a splat rewritten to /index.html, which its html handling would loop on:
    // its single-page-app fallback answers those paths with index.html instead (the loopback server's tests below)
    expect(redirectFor(redirects, `/s/${ID}/`)).toBeNull();
    expect(redirectFor(redirects, `/s/${ID}/anything/else`)).toBeNull();
    expect(redirectFor(redirects, `/s/${ID}/manifest.webmanifest`)).toEqual({ to: "/manifest.webmanifest", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/sw.js`)).toEqual({ to: "/sw.js", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}/~render`)).toEqual({ to: "/render", status: 200 });
    expect(redirectFor(redirects, `/s/${ID}`)).toEqual({ to: `/s/${ID}/`, status: 301 });
    expect(redirectFor(redirects, "/")).toBeNull();
    expect(redirectFor(redirects, "/assets/index-abc.js")).toBeNull();
  });

  it("give every page the shell policy and the render host the page policy alone", () => {
    expect(applyHeaders(headers, `/s/${ID}/`, new Headers()).get("content-security-policy")).toBe(shellContentSecurityPolicy(Object.values(REGIONAL_APPS)));
    expect(applyHeaders(headers, "/", new Headers()).get("content-security-policy")).toBe(shellContentSecurityPolicy(Object.values(REGIONAL_APPS)));
    expect(applyHeaders(headers, `/s/${ID}/~render`, new Headers()).get("content-security-policy")).toBe(pagePolicy(null));
    expect(applyHeaders(headers, "/assets/index-abc.js", new Headers()).get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of [`/s/${ID}/`, `/s/${ID}/sw.js`, "/sw.js", "/manifest.webmanifest", "/"]) expect(applyHeaders(headers, path, new Headers()).get("cache-control")).toBe("no-cache");
  });

  it("join a header two rules set, as Pages does, which is why the render host detaches first", () => {
    const rules = parseHeaders("/*\n  X-Test: one\n\n/page\n  X-Test: two\n\n/clean\n  ! X-Test\n  X-Test: three\n");
    expect(applyHeaders(rules, "/page", new Headers()).get("x-test")).toBe("one, two");
    expect(applyHeaders(rules, "/clean", new Headers()).get("x-test")).toBe("three");
  });
});

describe("the loopback Pages server", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("serves the rewritten file under the requested address with that address's headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-static-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(dir, "sw.js"), "// worker");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    writeFileSync(join(dir, "assets", "a.js"), "1");
    writeFileSync(join(dir, "_redirects"), shellRedirects());
    writeFileSync(join(dir, "_headers"), shellHeaders());
    const site = loadPagesSite(dir);
    const get = (path: string) => pagesResponse(site, new Request(`http://pages.test${path}`));
    const scope = await get(`/s/${ID}/`);
    expect(scope.status).toBe(200);
    expect(await scope.text()).toContain("shell");
    expect(scope.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(scope.headers.get("content-security-policy")).toBe(shellContentSecurityPolicy(Object.values(REGIONAL_APPS)));
    expect(scope.headers.get("cache-control")).toBe("no-cache");
    const worker = await get(`/s/${ID}/sw.js`);
    expect(await worker.text()).toBe("// worker");
    expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const slashless = await get(`/s/${ID}`);
    expect(slashless.status).toBe(301);
    expect(slashless.headers.get("location")).toBe(`/s/${ID}/`);
    // no render.html here, and no 404.html: Pages answers what it lacks with the page, as a single-page app
    expect(await (await get(`/s/${ID}/~render`)).text()).toContain("shell");
    expect(await (await get("/_headers")).text()).not.toContain("Cache-Control");
    expect((await get("/assets/a.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const fallback = await get("/assets/missing.js");
    expect([fallback.status, fallback.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
  });

  /** The built shell's own Pages files, with `index.html` standing in for the client's page. */
  function shellSite(files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pages-static-"));
    dirs.push(dir);
    const manifest = readFileSync(join(import.meta.dir, "..", "public", "manifest.webmanifest"), "utf8");
    for (const [name, content] of Object.entries({ ...shellFiles(manifest), "index.html": "<!doctype html><title>shell</title>", ...files })) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const site = loadPagesSite(dir);
    return (path: string) => pagesResponse(site, new Request(`https://app.ovis.sh${path}`));
  }

  it("answers a PC's render host with render.html at that address and the page policy alone", async () => {
    const get = shellSite();
    const render = await get(`/s/${ID}/~render`);
    expect(render.status).toBe(200);
    expect(await render.text()).toContain('type: "ovis-render-ready"');
    expect(render.headers.get("content-security-policy")).toBe(pagePolicy(null));
    // render.html at its own address never runs under the shell's policy either
    expect((await get("/render")).headers.get("content-security-policy")).toBe(pagePolicy(null));
  });

  it("answers a rewrite to an .html file as Pages does, with its 308 to the address without .html: the render host's old rule", async () => {
    const ownBlock = `${RENDER_DOCUMENT}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${pagePolicy(null)}\n\n`;
    expect(shellHeaders()).toContain(ownBlock);
    const get = shellSite({
      _redirects: shellRedirects().replace(`${RENDER_PATH} ${RENDER_DOCUMENT} 200`, `${RENDER_PATH} /render.html 200`),
      _headers: shellHeaders().replace(ownBlock, ""),
    });
    const render = await get(`/s/${ID}/~render`);
    expect([render.status, render.headers.get("location")]).toEqual([308, "/render"]);
    // what app.ovis.sh served from 2026-11-01: the page under the shell's policy, which refuses its inline script
    const followed = await get("/render");
    expect([followed.status, followed.headers.get("content-security-policy")]).toEqual([200, shellContentSecurityPolicy(Object.values(REGIONAL_APPS))]);
  });

  it("follows Pages' html handling for the shell's own files", async () => {
    const get = shellSite();
    // a path that decodes to leading slashes never leads off the site: Pages strips them from its own redirects
    const redirected: [string, string][] = [
      ["/index.html", "/"], ["/render.html", "/render"], ["/render.html?x=1", "/render?x=1"],
      ["/%2Frender.html", "/render"], ["/%2Frender.html?x=1", "/render?x=1"], ["/%2F%2Frender.html", "/render"],
    ];
    for (const [path, location] of redirected) {
      const answer = await get(path);
      expect([answer.status, answer.headers.get("location")]).toEqual([308, location]);
    }
    const scope = await get(`/s/${ID}/deep/path`);
    expect([scope.status, await scope.text()]).toEqual([200, "<!doctype html><title>shell</title>"]);
    expect((await get("/")).status).toBe(200);
  });

  it("answers a hashed file the shell's deployment lacks with a 404 no browser keeps, never the page under the assets' caching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-static-"));
    dirs.push(dir);
    const manifest = readFileSync(join(import.meta.dir, "..", "public", "manifest.webmanifest"), "utf8");
    for (const [name, content] of Object.entries({ ...shellFiles(manifest), "index.html": "<!doctype html><title>shell</title>", "assets/shell-a.css": ".a{}" })) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const site = loadPagesSite(dir);
    const get = (path: string) => pagesResponse(site, new Request(`https://app.ovis.sh${path}`));
    for (const path of ["/assets/shell-gone.css", "/assets/index-gone.js"]) {
      const missing = await get(path);
      expect([missing.status, missing.headers.get("cache-control")]).toEqual([404, "no-store"]);
    }
    const present = await get("/assets/shell-a.css");
    expect([present.status, present.headers.get("content-type"), present.headers.get("cache-control")]).toEqual([200, "text/css; charset=utf-8", "public, max-age=31536000, immutable"]);
    // outside /assets/ a missing path is still the page, as the shell's front page has always been answered
    const page = await get("/pair");
    expect([page.status, page.headers.get("cache-control")]).toEqual([200, null]);
  });
});
