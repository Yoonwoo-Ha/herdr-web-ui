import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appName, CONTENT_SECURITY_POLICY, contentSecurityPolicy, manifestBody, relateManifest, renameManifest, renameShell, requestOrigin } from "./static.ts";

// The sources Vite builds from: public/ is copied into dist/ as it is, and the meta survives the build.
const root = join(import.meta.dir, "..");
const manifest = readFileSync(join(root, "public", "manifest.webmanifest"), "utf8");
const shell = readFileSync(join(root, "index.html"), "utf8");

describe("HERDR_WEB_APP_NAME", () => {
  const previous = process.env["HERDR_WEB_APP_NAME"];
  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_WEB_APP_NAME"]; else process.env["HERDR_WEB_APP_NAME"] = previous;
  });

  it("is off when unset or blank", () => {
    delete process.env["HERDR_WEB_APP_NAME"];
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "   ";
    expect(appName()).toBeNull();
    process.env["HERDR_WEB_APP_NAME"] = "  work laptop ";
    expect(appName()).toBe("work laptop");
  });

  it("renames the manifest and keeps everything else, the id included", () => {
    const renamed = JSON.parse(renameManifest(manifest, "laptop")) as Record<string, unknown>;
    const original = JSON.parse(manifest) as Record<string, unknown>;
    expect(renamed).toEqual({ ...original, name: "laptop", short_name: "laptop" });
    expect(renamed["id"]).toBe("/");
  });

  it("relates the manifest to its own absolute id and keeps everything else", () => {
    const related = JSON.parse(relateManifest(manifest, "http://127.0.0.1:7317")) as Record<string, unknown>;
    const original = JSON.parse(manifest) as Record<string, unknown>;
    expect(related).toEqual({ ...original, related_applications: [{ platform: "webapp", id: "http://127.0.0.1:7317/" }] });
    expect(original["related_applications"]).toBeUndefined();
  });

  it("relates the manifest after the rename, and without one", () => {
    delete process.env["HERDR_WEB_APP_NAME"];
    const plain = JSON.parse(manifestBody(manifest, "https://pc.example")) as Record<string, unknown>;
    expect(plain["name"]).toBe((JSON.parse(manifest) as Record<string, unknown>)["name"]);
    expect(plain["related_applications"]).toEqual([{ platform: "webapp", id: "https://pc.example/" }]);
    process.env["HERDR_WEB_APP_NAME"] = "laptop";
    const named = JSON.parse(manifestBody(manifest, "https://pc.example")) as Record<string, unknown>;
    expect(named).toMatchObject({ name: "laptop", short_name: "laptop", id: "/" });
    expect(named["related_applications"]).toEqual([{ platform: "webapp", id: "https://pc.example/" }]);
  });

  it("takes the origin from the Host header and the proxy's scheme", () => {
    expect(requestOrigin(new Request("http://127.0.0.1:7317/manifest.webmanifest"))).toBe("http://127.0.0.1:7317");
    expect(requestOrigin(new Request("http://127.0.0.1:7317/x", { headers: { host: "pc.tailnet.ts.net", "x-forwarded-proto": "https" } })))
      .toBe("https://pc.tailnet.ts.net");
    expect(requestOrigin(new Request("http://127.0.0.1:7317/x", { headers: { "x-forwarded-proto": "wss" } }))).toBe("http://127.0.0.1:7317");
  });

  it("renames the iOS home-screen title in the shell and nothing else", () => {
    const renamed = renameShell(shell, "laptop");
    expect(renamed).toContain('<meta name="apple-mobile-web-app-title" content="laptop" />');
    expect(renamed.replace("content=\"laptop\"", "content=\"herdr\"")).toBe(shell);
  });

  it("frames the other ports of the request's own host and no other host", () => {
    expect(contentSecurityPolicy("http://100.123.228.51:7317")).toContain("frame-src 'self' http://100.123.228.51:* https://100.123.228.51:*;");
    expect(contentSecurityPolicy("https://pc.tailnet.ts.net")).toContain("frame-src 'self' http://pc.tailnet.ts.net:* https://pc.tailnet.ts.net:*;");
    expect(contentSecurityPolicy("http://[::1]:7317")).toContain("frame-src 'self' http://[::1]:* https://[::1]:*;");
    expect(contentSecurityPolicy("http://100.123.228.51:7317").replace(/ http:\/\/\S+ https:\/\/\S+;/, ";")).toBe(CONTENT_SECURITY_POLICY);
  });

  it("keeps frame-src to itself without an origin or with a host that is no host name", () => {
    expect(contentSecurityPolicy()).toBe(CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicy("not a url")).toBe(CONTENT_SECURITY_POLICY);
    expect(contentSecurityPolicy("http://a_b;script-src *")).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'self';");
  });

  it("fetches the manifest with the page's cookies, so a sign-in proxy lets it through", () => {
    expect(shell).toMatch(/<link rel="manifest" href="[^"]+" crossorigin="use-credentials" \/>/);
  });

  it("escapes the name in the shell", () => {
    const renamed = renameShell(shell, `a"b<c>&$1 $&`);
    expect(renamed).toContain('content="a&quot;b&lt;c&gt;&amp;$1 $&amp;"');
  });
});
