/**
 * Each PC is its own app under `/s/<server_id>/`: one PushSubscription per service worker scope and VAPID key, so a
 * second PC sharing a scope would take the first one's alerts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { REGIONAL_APPS } from "../shared/relay-regions.ts";
import { accountServiceOrigin, DEFAULT_ACCOUNT_SERVICE, IMMUTABLE_CACHE, pagePolicy, REVALIDATE, shellContentSecurityPolicy } from "../shared/web-policy.ts";

export const SHELL_MODE = "shell";
export const SHELL_OUT_DIR = "dist-shell";

export const SHELL_META = '<meta name="ovis-shell" content="relay" />';

const MANIFEST_LINK = /<link rel="manifest" href="\/manifest\.webmanifest(\?[^"]*)?"/;

export function accountMetas(env: Record<string, string | undefined>): string[] {
  const origin = accountServiceOrigin(env["OVIS_ACCOUNT_SERVICE_URL"] ?? DEFAULT_ACCOUNT_SERVICE);
  if (origin === null) return [];
  const providers = (env["OVIS_ACCOUNT_PROVIDERS"] ?? "").split(",").map((name) => name.trim()).filter((name) => name === "github" || name === "google" || name === "apple");
  return [`<meta name="ovis-account-service" content="${origin}" />`, ...(providers.length > 0 ? [`<meta name="ovis-account-providers" content="${providers.join(",")}" />`] : [])];
}

export function shellIndexHtml(html: string, env: Record<string, string | undefined> = {}): string {
  if (!MANIFEST_LINK.test(html)) throw new Error("index.html must link /manifest.webmanifest for the shell to make it relative");
  const linked = html.replace(MANIFEST_LINK, (_, query: string | undefined) => `<link rel="manifest" href="manifest.webmanifest${query ?? ""}"`);
  const head = /<head>\n?/.exec(linked);
  if (head === null) throw new Error("index.html must hold a <head>");
  const at = head.index + head[0].length;
  return `${linked.slice(0, at)}${[SHELL_META, ...accountMetas(env)].map((meta) => `    ${meta}\n`).join("")}${linked.slice(at)}`;
}

export function shellManifest(manifest: string): string {
  return `${JSON.stringify({ ...JSON.parse(manifest) as Record<string, unknown>, id: "./", start_url: "./", scope: "./" }, null, 2)}\n`;
}

export const APP_ID = "sh.ovis.app";

/**
 * The certificates an Android app that may open `https://app.ovis.sh/s/` links is signed with:
 * Google Play's app signing key (Play Console, App integrity), which signs every copy Play
 * installs, and the upload key (the certificate in a bundle built for upload), which signs a
 * release build installed by hand.
 */
export const ANDROID_APP_FINGERPRINTS = [
  "7A:F3:97:1A:B8:7A:22:3B:A4:6D:58:13:89:ED:7A:EB:A9:31:3F:97:E5:A1:03:87:63:74:BE:CB:54:1C:1D:63",
  "BD:49:0B:C8:3D:3F:22:C8:55:9E:57:60:C4:7D:71:63:7D:34:22:92:95:82:C9:B4:05:E3:E6:79:AD:8E:29:C6",
];

const APPLE_TEAM_ID = "5987KT43TJ";
export const IOS_APP_ID = `${APPLE_TEAM_ID}.${APP_ID}`;

/**
 * The files that let the phone apps open a PC's page on app.ovis.sh (a pairing link tapped in a
 * message, or the camera reading the PC's QR code) instead of the browser: Android checks
 * `assetlinks.json` for the app's `autoVerify` link (app/android/app/src/main/AndroidManifest.xml),
 * iOS `apple-app-site-association` for an app whose Associated Domains name this host. Only a PC's
 * scope, `/s/`, is the app's: the front page stays the hosted shell's.
 */
export function appLinkFiles(): Record<string, string> {
  return {
    ".well-known/assetlinks.json": `${JSON.stringify([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: ANDROID_APP_FINGERPRINTS },
    }], null, 2)}\n`,
    ".well-known/apple-app-site-association": `${JSON.stringify({ applinks: { details: [{ appIDs: [IOS_APP_ID], components: [{ "/": "/s/*" }] }] } }, null, 2)}\n`,
  };
}

export const RENDER_PATH = "/s/:id/~render";

/** Pages `_redirects`: the first matching rule wins, so the files come before the scope's catch-all. */
export function shellRedirects(): string {
  return [
    "# Each PC's app lives under its own scope, /s/<server_id>/ (scripts/shell-build.ts)",
    "/s/:id /s/:id/ 301",
    "/s/:id/manifest.webmanifest /manifest.webmanifest 200",
    "/s/:id/sw.js /sw.js 200",
    `${RENDER_PATH} /render.html 200`,
    "/s/* /index.html 200",
    "",
  ].join("\n");
}

/** Pages joins a header set twice with a comma, so the shell's policy is detached on the render host's path. */
export function shellHeaders(): string {
  return [
    "# Derived from the PC server's policy: server/static.ts shellContentSecurityPolicy(Object.values(REGIONAL_APPS)) (scripts/shell-build.ts)",
    "/*",
    `  Content-Security-Policy: ${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}`,
    "",
    `${RENDER_PATH}`,
    "  ! Content-Security-Policy",
    `  Content-Security-Policy: ${pagePolicy(null)}`,
    "",
    "/assets/*",
    `  Cache-Control: ${IMMUTABLE_CACHE}`,
    "",
    // the app links' files (appLinkFiles): apple-app-site-association has no extension
    "/.well-known/*",
    "  Content-Type: application/json",
    "",
    ...["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/s/*"].flatMap((path) => [path, `  Cache-Control: ${REVALIDATE}`, ""]),
  ].join("\n");
}

export function shellCaddyfile(site: string, root = "/opt/ovis-shell/current"): string {
  if (!/^[a-z0-9.-]+$/.test(site) || !/^\/[\w./-]+$/.test(root)) throw new Error("not a site address or a folder");
  const scope = "^/s/[0-9a-f]{32}";
  return [
    `${site} {`,
    `\troot * ${root}`,
    `\t@bare path_regexp bare ^/s/([0-9a-f]{32})$`,
    `\tredir @bare /s/{re.bare.1}/ 301`,
    `\t@render path_regexp render ${scope}/~render$`,
    `\t@notrender not path_regexp ${scope}/~render$`,
    `\t@manifest path_regexp manifest ${scope}/manifest\\.webmanifest$`,
    `\t@worker path_regexp worker ${scope}/sw\\.js$`,
    `\t@revalidate path / /index.html /sw.js /manifest.webmanifest /s/*`,
    `\t@hidden path /_headers /_redirects`,
    `\theader @notrender Content-Security-Policy "${shellContentSecurityPolicy(Object.values(REGIONAL_APPS))}"`,
    `\theader @render Content-Security-Policy "${pagePolicy(null)}"`,
    `\theader /assets/* Cache-Control "${IMMUTABLE_CACHE}"`,
    `\theader @revalidate Cache-Control "${REVALIDATE}"`,
    `\theader /build.json Access-Control-Allow-Origin "*"`,
    `\trespond @hidden 404`,
    `\thandle @render {\n\t\trewrite * /render.html\n\t}`,
    `\thandle @manifest {\n\t\trewrite * /manifest.webmanifest\n\t}`,
    `\thandle @worker {\n\t\trewrite * /sw.js\n\t}`,
    `\thandle_path /s/* {\n\t\trewrite * /index.html\n\t}`,
    // relay/shell-mirror.ts drops the precompressed copies, which Pages never serves as files
    `\tencode zstd gzip`,
    `\tfile_server`,
    "}",
    "",
  ].join("\n");
}

export function shellFiles(manifest: string): Record<string, string> {
  return {
    "render.html": `<!doctype html><html><head><meta charset="utf-8"><title>Ovis</title></head><body><script>
function render(event) {
  if (event.source !== parent || event.data?.type !== "ovis-render" || typeof event.data.html !== "string") return;
  removeEventListener("message", render);
  if (event.data.scripts !== true) {
    // The page's scripts are off until the person asks for them: it is drawn in a frame of its own that runs
    // none. That frame keeps this document's policy, so the page's styles, pictures and fonts draw as they do
    // with scripts.
    const page = document.createElement("iframe");
    page.setAttribute("sandbox", "");
    page.srcdoc = event.data.html;
    page.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
    document.body.replaceChildren(page);
    return;
  }
  document.open();
  document.write(event.data.html);
  document.close();
}
addEventListener("message", render);
parent.postMessage({ type: "ovis-render-ready" }, "*");
</script></body></html>`,
    "manifest.webmanifest": shellManifest(manifest),
    _redirects: shellRedirects(),
    _headers: shellHeaders(),
    ...appLinkFiles(),
  };
}

export function shellBuild(): Plugin {
  let manifest = "";
  return {
    name: "shell-build",
    apply: "build",
    configResolved(config) {
      const path = join(config.root, "public", "manifest.webmanifest");
      if (!existsSync(path)) throw new Error("public/manifest.webmanifest is missing: the shell derives its manifest from it");
      manifest = readFileSync(path, "utf8");
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => shellIndexHtml(html, process.env),
    },
    // after Vite copied public/ (the app's manifest among it), which these replace or join
    writeBundle(options) {
      if (!options.dir) throw new Error("the shell build has no output directory");
      mkdirSync(options.dir, { recursive: true });
      for (const [name, content] of Object.entries(shellFiles(manifest))) {
        mkdirSync(dirname(join(options.dir, name)), { recursive: true });
        writeFileSync(join(options.dir, name), content);
      }
    },
  };
}
