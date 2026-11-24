import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { appShell, carried, indexAssets, packShell, provenanceOf, releaseTag, SHELL_ASSETS, shellPoliciesOf, shellSource, unpackRelease } from "../app/scripts/bundled-shell.ts";
import { writeNativeOrigin } from "../app/scripts/hosted-origin.ts";
import { FILES_CACHE as CLIENT_FILES_CACHE } from "../src/lib/shellMode.ts";
import { RENDER_PATH, SHELL_META, shellHeaders, shellPolicies } from "./shell-build.ts";

describe("where a build takes the shell from", () => {
  it("carries it for the production origin and loads it from the network for a preview's, unless told", () => {
    expect(appShell(undefined, null)).toBe("bundled");
    expect(appShell("", null)).toBe("bundled");
    expect(appShell(undefined, "https://relay-0510.ovis-app.pages.dev")).toBe("hosted");
    expect(appShell("bundled", "https://relay-0510.ovis-app.pages.dev")).toBe("bundled");
    expect(appShell("hosted", null)).toBe("hosted");
    for (const text of ["Bundled", "network", "1"]) expect(() => appShell(text, null)).toThrow("OVIS_APP_SHELL must be bundled or hosted");
  });

  it("is written for Android alone, and only when it is hosted", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-shell-origin-"));
    try {
      mkdirSync(join(dir, "android/app"), { recursive: true });
      mkdirSync(join(dir, "ios"), { recursive: true });
      const android = join(dir, "android/app/hosted-origin.properties");
      const ios = join(dir, "ios/hosted-origin.generated.xcconfig");
      writeNativeOrigin(dir, null, "hosted", "hosted");
      expect(readFileSync(android, "utf8")).toBe("appShell=hosted\n");
      expect(existsSync(ios)).toBe(false);
      writeNativeOrigin(dir, "https://relay-0510.ovis-app.pages.dev", "bundled", "hosted");
      expect(readFileSync(android, "utf8")).toBe("appOrigin=https://relay-0510.ovis-app.pages.dev\nappHome=bundled\nappShell=hosted\n");
      expect(readFileSync(ios, "utf8")).toBe("OVIS_APP_ORIGIN = https:/$()/relay-0510.ovis-app.pages.dev\nOVIS_APP_HOME = bundled\n");
      writeNativeOrigin(dir, null, "hosted", "bundled");
      expect(existsSync(android)).toBe(false);
      expect(existsSync(ios)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the shell's policies in the app", () => {
  it("are read back from the copy's _headers as shell-build.ts writes them, so the two cannot drift", () => {
    expect(shellPoliciesOf(shellHeaders())).toEqual(shellPolicies());
    expect(shellPolicies().render).toContain("sandbox allow-scripts");
    expect(shellPolicies().page).not.toBe(shellPolicies().render);
  });

  it("refuse a _headers without them in their places", () => {
    const headers = shellHeaders();
    expect(() => shellPoliciesOf(headers.replace(/^\/\*$/m, "/elsewhere"))).toThrow("no one Content-Security-Policy for /*");
    expect(() => shellPoliciesOf(headers.replace("  ! Content-Security-Policy\n", ""))).toThrow(`gives ${RENDER_PATH} no policy of its own`);
    expect(() => shellPoliciesOf("")).toThrow();
  });
});

describe("packing a dist-shell into the app", () => {
  function distShell(): string {
    const from = mkdtempSync(join(tmpdir(), "app-shell-dist-"));
    const files: Record<string, string> = {
      "index.html": `<!doctype html><html><head>\n    ${SHELL_META}\n<script type="module" src="/assets/index-0123456789.js"></script></head></html>`,
      "render.html": "<!doctype html>",
      "manifest.webmanifest": "{}",
      "sw.js": "// worker",
      "build.json": JSON.stringify({ revision: "abc123", dirty: false }),
      "_headers": shellHeaders(),
      "_redirects": "/s/* /index.html 200\n",
      "assets/index-0123456789.js": "export {};",
      "assets/index-0123456789.js.gz": "gz",
      "assets/index-0123456789.css.br": "br",
      ".well-known/assetlinks.json": "[]",
      "icons/icon-192.png": "png",
    };
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(from, name)), { recursive: true });
      writeFileSync(join(from, name), content);
    }
    return from;
  }

  it("carries what the app serves, leaves the web host's own files and the precompressed copies, and writes the policies beside it", () => {
    const from = distShell();
    const assets = mkdtempSync(join(tmpdir(), "app-shell-assets-"));
    try {
      writeFileSync(join(assets, "stale-left-over"), "from an earlier run");
      const packed = packShell(from, assets, { source: "checkout" }, { floor: 0 });
      expect(existsSync(join(assets, "stale-left-over"))).toBe(false);
      expect(JSON.parse(readFileSync(join(assets, "shell-provenance.json"), "utf8"))).toEqual({ source: "checkout", revision: "abc123", dirty: false });
      const shell = readdirSync(join(assets, "shell"), { recursive: true, encoding: "utf8" }).filter((file) => statSync(join(assets, "shell", file)).isFile()).map((file) => file.split(sep).join("/")).sort();
      expect(shell).toEqual(["assets/index-0123456789.js", "build.json", "icons/icon-192.png", "index.html", "manifest.webmanifest", "render.html", "sw.js"]);
      expect(packed.files).toBe(7);
      expect(JSON.parse(readFileSync(join(assets, "shell-policy.json"), "utf8"))).toEqual(shellPolicies());
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(assets, { recursive: true, force: true });
    }
  });

  it("leaves out sidecars and Pages' files by name", () => {
    for (const path of ["a.js.gz", "assets/b.css.br", "_headers", "_redirects", ".well-known", ".well-known/assetlinks.json"]) expect(carried(path)).toBe(false);
    for (const path of ["index.html", "assets/a.js", "assets/_headers.js", "s/_redirects", "well-known.txt"]) expect(carried(path)).toBe(true);
  });

  it("fails loudly, carrying nothing, over its size budget or for anything but a dist-shell", () => {
    const from = distShell();
    const assets = join(mkdtempSync(join(tmpdir(), "app-shell-assets-")), "bundled-shell");
    try {
      const checkout = { source: "checkout" } as const;
      expect(() => packShell(from, assets, checkout, { budget: 64, floor: 0 })).toThrow(/over its 0 MB budget \(SHELL_BUDGET_BYTES; it was 31 MB on 2026-11-24\)\. Largest: /);
      expect(() => packShell(from, assets, checkout, { floor: 1024 * 1024 })).toThrow(/under its 1 MB floor \(SHELL_FLOOR_BYTES/);
      expect(() => packShell(from, assets, checkout)).toThrow(/under its 14 MB floor/);
      expect(existsSync(assets)).toBe(false);
      rmSync(join(from, "assets/index-0123456789.js"));
      expect(() => packShell(from, assets, checkout, { floor: 0 })).toThrow("is missing files its index.html starts with (assets/index-0123456789.js): a partial copy would open blank");
      writeFileSync(join(from, "index.html"), "<!doctype html><html><head></head></html>");
      expect(() => packShell(from, assets, checkout, { floor: 0 })).toThrow(`is not the shell's: it lacks ${SHELL_META}`);
      rmSync(join(from, "_headers"));
      expect(() => packShell(from, assets, checkout, { floor: 0 })).toThrow("is not a dist-shell: it holds no _headers");
      expect(existsSync(assets)).toBe(false);
    } finally {
      rmSync(from, { recursive: true, force: true });
      rmSync(dirname(assets), { recursive: true, force: true });
    }
  });
});

describe("a release's shell", () => {
  it("is named by its archive, its SHA-256 and its tag together, a folder, or neither for this checkout's", () => {
    const sum = "a".repeat(64);
    expect(shellSource({})).toEqual({ kind: "checkout" });
    expect(shellSource({ OVIS_APP_SHELL_DIR: "/x" })).toEqual({ kind: "folder", dir: "/x" });
    expect(shellSource({ OVIS_APP_SHELL_ARCHIVE: "/a.tar.gz", OVIS_APP_SHELL_SHA256: sum.toUpperCase(), OVIS_APP_SHELL_TAG: "v0.5.10" })).toEqual({ kind: "release", archive: "/a.tar.gz", sha256: sum, tag: "v0.5.10" });
    expect(() => shellSource({ OVIS_APP_SHELL_ARCHIVE: "/a.tar.gz", OVIS_APP_SHELL_DIR: "/x", OVIS_APP_SHELL_SHA256: sum, OVIS_APP_SHELL_TAG: "v1.0.0" })).toThrow("name two shells");
    expect(() => shellSource({ OVIS_APP_SHELL_ARCHIVE: "/a.tar.gz", OVIS_APP_SHELL_TAG: "v1.0.0" })).toThrow("together");
    expect(() => shellSource({ OVIS_APP_SHELL_SHA256: sum })).toThrow("together");
    expect(() => shellSource({ OVIS_APP_SHELL_ARCHIVE: "/a.tar.gz", OVIS_APP_SHELL_SHA256: sum })).toThrow("OVIS_APP_SHELL_TAG must be the release's tag");
    expect(provenanceOf({ kind: "release", archive: "/a", sha256: sum, tag: "v1.2.3" })).toEqual({ source: "release", tag: "v1.2.3", sha256: sum });
    expect(provenanceOf({ kind: "folder", dir: "/x" })).toEqual({ source: "folder" });
    for (const tag of ["v0.5.10", "v0.6.0-beta.2"]) expect(releaseTag(tag)).toBe(tag);
    for (const tag of [undefined, "0.5.10", "main", "v1", "v1.2.3 ; x"]) expect(() => releaseTag(tag)).toThrow();
  });

  it("is unpacked only when its SHA-256 is the release's, and only as plain files and folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-shell-release-"));
    try {
      const content = join(dir, "content");
      mkdirSync(join(content, "assets"), { recursive: true });
      writeFileSync(join(content, "index.html"), "shell");
      writeFileSync(join(content, "assets", "a.js"), "1");
      const archive = join(dir, "dist-shell.tar.gz");
      expect(Bun.spawnSync(["tar", "-czf", archive, "-C", content, "."]).exitCode).toBe(0);
      const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
      expect(() => unpackRelease(archive, "0".repeat(64), join(dir, "wrong"))).toThrow(`not the release's ${"0".repeat(64)}`);
      expect(existsSync(join(dir, "wrong"))).toBe(false);
      expect(() => unpackRelease(archive, "short", join(dir, "short"))).toThrow("must be the archive's SHA-256");
      unpackRelease(archive, sum, join(dir, "out"));
      expect(readFileSync(join(dir, "out", "assets", "a.js"), "utf8")).toBe("1");
      // a link in it could point the copy at any file of the machine that builds the app
      expect(Bun.spawnSync(["ln", "-s", "/etc/hostname", join(content, "assets", "link.js")]).exitCode).toBe(0);
      const linked = join(dir, "linked.tar.gz");
      expect(Bun.spawnSync(["tar", "-czf", linked, "-C", content, "."]).exitCode).toBe(0);
      expect(() => unpackRelease(linked, createHash("sha256").update(readFileSync(linked)).digest("hex"), join(dir, "linked"))).toThrow("holds something other than files and folders");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the files its page starts with, each once", () => {
    expect(indexAssets('<script type="module" crossorigin src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/b.js"><link rel="stylesheet" href="/assets/c.css"><link rel="icon" href="/favicon.png"><script src="/assets/index-a.js"></script>')).toEqual(["assets/index-a.js", "assets/b.js", "assets/c.css"]);
  });
});

// The Android app that serves the carried shell (BundledShell.java, build.gradle)
const app = join(import.meta.dir, "../app");
const java = readFileSync(join(app, "android/app/src/main/java/sh/ovis/app/BundledShell.java"), "utf8");
const gradle = readFileSync(join(app, "android/app/build.gradle"), "utf8");

/** A `static final String` of BundledShell.java as Java reads it: its literals and the constants before it, joined. */
function javaString(name: string, known: Record<string, string> = {}): string {
  const start = java.indexOf(`static final String ${name} =`);
  if (start < 0) throw new Error(`BundledShell.java declares no ${name}`);
  let at = java.indexOf("=", start) + 1;
  let value = "";
  for (;;) {
    while (/\s|\+/.test(java[at]!)) at++;
    if (java[at] === ";") return value;
    if (java[at] === '"') {
      let end = at + 1;
      while (java[end] !== '"') end += java[end] === "\\" ? 2 : 1;
      value += JSON.parse(java.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    const identifier = /^[A-Z_]+/.exec(java.slice(at))?.[0];
    if (!identifier || !(identifier in known)) throw new Error(`${name} joins something this test does not know at: ${java.slice(at, at + 40)}`);
    value += known[identifier];
    at += identifier.length;
  }
}

const BOOT_PATH = javaString("BOOT_PATH");
const FILES_CACHE = javaString("FILES_CACHE");
const BOOT_JS = javaString("BOOT_JS", { BOOT_PATH, FILES_CACHE });
const RETIRING_WORKER = javaString("RETIRING_WORKER", { FILES_CACHE });

describe("the Android build", () => {
  it("is what the Android build reads, carried by default, and a hosted shell is never the store app", () => {
    expect(gradle).toContain('getProperty("appShell", "bundled") != "hosted"');
    expect(gradle).toContain('buildConfigField "boolean", "SHELL_BUNDLED", "${shellBundled}"');
    expect(gradle).toContain(`main.assets.srcDirs += ['../../${SHELL_ASSETS}']`);
    expect(gradle).toContain('(task.name ==~ /(assemble|bundle|install|package|sign)Release(Bundle)?/ && android.defaultConfig.applicationId == "sh.ovis.app")');
    // every app bundle, of any build type, and no other task: an .aab is what Google Play takes
    const bundles = /task\.name ==~ \/(.+?)\/ \|\|/.exec(gradle)?.[1];
    expect(bundles).toBe("bundle([A-Z][a-z]*)?|(package|sign)[A-Z][a-z]*Bundle");
    const appBundle = new RegExp(`^(?:${bundles})$`);
    for (const task of ["bundle", "bundleDebug", "bundleRelease", "bundlePreview", "packageDebugBundle", "signDebugBundle", "packageReleaseBundle", "signReleaseBundle"]) expect(appBundle.test(task)).toBe(true);
    for (const task of ["assembleDebug", "installDebug", "packageDebug", "bundleDebugResources", "bundleDebugClassesToRuntimeJar", "bundleReleaseClassesToCompileJar", "testDebugUnitTest"]) expect(appBundle.test(task)).toBe(false);
  });

  it("packages the store app only with a release's verified, whole shell, and only with readable policies", () => {
    expect(gradle).toContain('new File(shellAssets, "shell-provenance.json")');
    expect(gradle).toContain('provenance.source != "release"');
    expect(gradle).toContain("provenance.sha256 ==~ /[0-9a-f]{64}/");
    expect(gradle).toContain("lacks files its index.html starts with");
    expect(gradle).toContain('render.startsWith("sandbox allow-scripts")');
  });

  it("reads the folder packShell writes", () => {
    expect(javaString("DIR")).toBe("shell");
    expect(javaString("POLICY")).toBe("shell-policy.json");
  });
});

describe("the bundled shell's boot page", () => {
  async function boot(hash: string, { workers = [true, true], names = ["ovis-v4-sheep-abc", FILES_CACHE], hang = false, fail = false, failFirst = 0 } = {}) {
    const replaced: string[] = [];
    const posted: string[] = [];
    const deleted: string[] = [];
    const unregistered: number[] = [];
    const location = { hash, origin: "https://app.ovis.sh", replace: (to: string) => replaced.push(to) };
    const navigator = {
      serviceWorker: {
        getRegistrations: () => hang ? new Promise(() => {}) : fail || failFirst-- > 0 ? Promise.reject(new Error("no")) : Promise.resolve(workers.map((result, index) => ({ unregister: async () => { unregistered.push(index); return result; } }))),
      },
    };
    const caches = { keys: async () => names, delete: async (name: string) => { deleted.push(name); return true; } };
    const OvisBoot = { postMessage: (message: string) => posted.push(message) };
    // the three seconds pass at once for a clean-up that hangs, and never otherwise
    const timer = (done: () => void) => { if (hang) done(); };
    new Function("location", "navigator", "caches", "window", "OvisBoot", "setTimeout", BOOT_JS)(location, navigator, caches, { OvisBoot }, OvisBoot, timer);
    for (let turn = 0; turn < 200 && replaced.length === 0; turn++) await Promise.resolve();
    return { replaced, posted, deleted, unregistered };
  }

  const encoded = (text: string) => encodeURIComponent(text);

  it("unregisters every worker, deletes the caches they served from, says so, then goes on in its own place", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const run = await boot(`#${encoded(`/s/${id}/#offer=x`)}`);
    expect(run.unregistered).toEqual([0, 1]);
    expect(run.deleted).toEqual(["ovis-v4-sheep-abc"]);
    expect(run.posted).toEqual(["cleaned"]);
    expect(run.replaced).toEqual([`https://app.ovis.sh/s/${id}/#offer=x`]);
    expect((await boot(`#${encoded("/#pcs")}`)).replaced).toEqual(["https://app.ovis.sh/#pcs"]);
    expect((await boot("")).replaced).toEqual(["https://app.ovis.sh/"]);
  });

  it("goes on to its own origin alone", async () => {
    for (const target of ["https://evil.example/", "//evil.example/x", "/\\evil.example/", "javascript:alert(1)", "http://app.ovis.sh/"]) {
      expect((await boot(`#${encoded(target)}`)).replaced).toEqual(["https://app.ovis.sh/"]);
    }
    expect((await boot("#%E0%A4%A")).replaced).toEqual(["https://app.ovis.sh/"]);
    // a path that starts with two slashes, written out or left by a dot segment, stays a path on this origin: going on to
    // it as a path alone would be a protocol-relative address of another host
    for (const target of ["https://app.ovis.sh//evil.example/x", "/.//evil.example/x", "/s/..//evil.example/x"]) {
      const [went] = (await boot(`#${encoded(target)}`)).replaced;
      expect(new URL(went ?? "").origin).toBe("https://app.ovis.sh");
      expect(went).toBe("https://app.ovis.sh//evil.example/x");
    }
  });

  it("tries once more when the clean-up fails, and goes on as asked once that works", async () => {
    const second = await boot(`#${encoded("/s/abc/")}`, { failFirst: 1 });
    expect(second.posted).toEqual(["cleaned"]);
    expect(second.replaced).toEqual(["https://app.ovis.sh/s/abc/"]);
  });

  it("never goes on to a PC's page after two failed clean-ups, only to one no worker controls, and says nothing", async () => {
    for (const options of [{ workers: [true, false] }, { fail: true }, { hang: true }]) {
      const run = await boot(`#${encoded("/s/abc/#pane=x")}`, options);
      expect(run.posted).toEqual([]);
      expect(run.deleted).toEqual([]);
      expect(run.replaced).toEqual(["https://app.ovis.sh/"]);
      // home is in no worker's scope: it opens as asked
      expect((await boot(`#${encoded("/#pcs")}`, options)).replaced).toEqual(["https://app.ovis.sh/#pcs"]);
    }
  });

  it("lies outside every PC's scope, which a worker of the network's copy controls", () => {
    expect(BOOT_PATH).toBe("/_ovis/boot");
    expect(BOOT_PATH.startsWith("/s/")).toBe(false);
  });

  it("keeps the client's own cache, the one no worker serves from, by the client's one name for it", () => {
    // BundledShell.FILES_CACHE (which the boot page and the retiring worker keep) is the client's FILES_CACHE
    expect(FILES_CACHE).toBe(CLIENT_FILES_CACHE);
    expect(readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8")).toContain(`const FILES = "${CLIENT_FILES_CACHE}";`);
  });
});

describe("the worker every sw.js answers in the app", () => {
  it("takes the old worker's place at once and removes itself and its caches, serving nothing meanwhile", async () => {
    const listeners: Record<string, (event: unknown) => void> = {};
    const skipWaiting = mock(() => Promise.resolve());
    const unregister = mock(() => Promise.resolve(true));
    const deleted: string[] = [];
    const self = { addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; }, skipWaiting, registration: { unregister } };
    const caches = { keys: async () => ["ovis-v4-sheep-abc", FILES_CACHE, "ovis-v3"], delete: async (name: string) => { deleted.push(name); return true; } };
    new Function("self", "caches", RETIRING_WORKER)(self, caches);
    expect(Object.keys(listeners).sort()).toEqual(["activate", "install"]);
    listeners["install"]!({});
    expect(skipWaiting).toHaveBeenCalledTimes(1);
    let done: Promise<unknown> = Promise.resolve();
    listeners["activate"]!({ waitUntil: (work: Promise<unknown>) => { done = work; } });
    await done;
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(["ovis-v4-sheep-abc", "ovis-v3"]);
  });
});
