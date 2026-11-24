package sh.ovis.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The hosted shell this build carries (BuildConfig.SHELL_BUNDLED; docs/native-app.md, "The bundled shell"), answered
 * at the hosted origin itself (BuildConfig.APP_ORIGIN), with no network: a person who updates from a build that loaded
 * the shell from there keeps that origin's storage, its sign-in, keys and pairings among it.
 *
 * <p>Only where the WebView's requests to that origin are answered changes. The activity opens it as it always did
 * (server.url, the bridge's origin rules, error.html on the app's own origin), so every plugin's and page's gate that
 * keys on them decides as in a build that loads the shell from the network. This class does what Pages' `_redirects`
 * and `_headers` do for app.ovis.sh (scripts/shell-build.ts): a PC's scope is the shell, its render host
 * render.html, the shell's policies on every answer. Every request to that origin is answered here, never by
 * Capacitor's local server, which takes the network for it. Two answers are the app's own: a worker script that
 * retires any worker the network's copy registered (`sw.js`), and the boot page that clears them before the first
 * page of a bundled start runs (`BOOT_PATH`, needsBoot).
 */
final class BundledShell {
    /** Where the shell is in the app's assets (app/scripts/bundled-shell.ts SHELL_ASSETS). */
    static final String DIR = "shell";
    static final String POLICY = "shell-policy.json";

    /** The page a bundled start opens first while a worker of the network's copy may be left (needsBoot): outside every PC's scope, which no worker controls. */
    static final String BOOT_PATH = "/_ovis/boot";

    /** The cache the client keeps its own files in (FILES_CACHE in src/lib/shellMode.ts, which a test holds this to): kept, as no worker serves from it. */
    static final String FILES_CACHE = "ovis-files-v1";

    private static final Pattern SCOPE_FILE = Pattern.compile("/s/[^/]+/(manifest\\.webmanifest|sw\\.js|~render)");

    static final String BOOT_HTML =
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Ovis</title>" +
        "<script src=\"" + BOOT_PATH + ".js\"></script></head><body></body></html>\n";

    /**
     * Unregisters every worker on the origin and deletes the caches they served from (once more when that fails or takes
     * over three seconds), then goes on, in place of this page, to the address its fragment names, on this origin
     * only. `OvisBoot` hears that it was done, so the next start goes straight to its page. A clean-up that failed twice
     * never goes on to a PC's page (`/s/`), which a worker it left could answer: the front page instead, which no worker
     * controls, and the next start tries again.
     */
    static final String BOOT_JS =
        "(() => {\n" +
        "  let target = new URL(\"/\", location.origin);\n" +
        "  try {\n" +
        "    const asked = new URL(decodeURIComponent(location.hash.slice(1)), location.origin);\n" +
        "    if (asked.origin === location.origin) target = asked;\n" +
        "  } catch {}\n" +
        "  const clean = async () => {\n" +
        "    const workers = \"serviceWorker\" in navigator ? await navigator.serviceWorker.getRegistrations() : [];\n" +
        "    if ((await Promise.all(workers.map((worker) => worker.unregister()))).includes(false)) return false;\n" +
        "    if (typeof caches !== \"undefined\") for (const name of await caches.keys()) if (name !== \"" + FILES_CACHE + "\") await caches.delete(name);\n" +
        "    return true;\n" +
        "  };\n" +
        "  const attempt = () => Promise.race([clean(), new Promise((done) => setTimeout(() => done(false), 3000))]).catch(() => false);\n" +
        "  attempt().then((cleaned) => cleaned === true || attempt()).then((cleaned) => {\n" +
        "    if (cleaned === true) {\n" +
        "      if (window.OvisBoot) OvisBoot.postMessage(\"cleaned\");\n" +
        "      location.replace(target.href);\n" +
        "    } else {\n" +
        "      location.replace(target.pathname.startsWith(\"/s/\") ? new URL(\"/\", location.origin).href : target.href);\n" +
        "    }\n" +
        "  });\n" +
        "})();\n";

    /**
     * What every `sw.js` on the origin answers (the shell registers none in this app: window.__ovisAppShell): a worker
     * that, once the browser checks a worker the network's copy registered for an update, takes its place and removes
     * itself with its caches, with no fetch handler meanwhile. So a worker the boot page missed, or one that copy
     * registers again while it runs once, goes on its next check instead of serving that copy for 24 hours.
     */
    static final String RETIRING_WORKER =
        "// The Ovis app carries its own shell: a worker registered here retires\n" +
        "self.addEventListener(\"install\", () => self.skipWaiting());\n" +
        "self.addEventListener(\"activate\", (event) => event.waitUntil(self.registration.unregister()\n" +
        "  .then(() => caches.keys())\n" +
        "  .then((names) => Promise.all(names.filter((name) => name !== \"" + FILES_CACHE + "\").map((name) => caches.delete(name))))));\n";

    /** How a request is answered. */
    static final class Route {
        enum Kind {
            /** An asset of the shell (`asset`), else `fallback`. */
            FILE,
            /** `body`, written here. */
            BODY,
            /** No body. */
            STATUS
        }

        final Kind kind;
        final int status;
        final String asset;
        final Route fallback;
        final String body;
        final String type;
        /** The render host's policy (Pages' `/s/:id/~render` block) rather than the shell's. */
        final boolean render;

        private Route(Kind kind, int status, String asset, Route fallback, String body, String type, boolean render) {
            this.kind = kind;
            this.status = status;
            this.asset = asset;
            this.fallback = fallback;
            this.body = body;
            this.type = type;
            this.render = render;
        }

        static Route file(String asset, Route fallback) {
            return new Route(Kind.FILE, 200, asset, fallback, null, type(asset), false);
        }

        static Route body(String body, String type) {
            return new Route(Kind.BODY, 200, null, null, body, type, false);
        }

        static Route status(int status) {
            return new Route(Kind.STATUS, status, null, null, null, "text/plain", false);
        }

        static final Route INDEX = file("index.html", null);
        static final Route RENDER = new Route(Kind.FILE, 200, "render.html", null, null, "text/html", true);
        static final Route WORKER = body(RETIRING_WORKER, "text/javascript");
    }

    /**
     * How the shell's host answers `method` for `path` (as the request carries it, percent-encoded), as Pages answers
     * app.ovis.sh (scripts/shell-build.ts shellRedirects): a PC's manifest, worker and render host under its scope, the
     * shell for anything else there, a file of the shell where there is one, a 404 for a hashed asset there is not,
     * and the shell for any other address. Two exceptions: Pages sends `/s/<id>` to `/s/<id>/` (an answer here cannot
     * redirect, so it is the shell there too, which reads its PC from either), and every `sw.js` retires
     * (RETIRING_WORKER). Capacitor's own paths (`/_capacitor_file_/`, `/_capacitor_content_/`, its HTTP interceptor)
     * are a 404 there: the client asks for none of them, and its local server would read a file or the network.
     * Nothing but GET and HEAD: the shell's host takes no other.
     */
    static Route route(String method, String path) {
        if (!"GET".equals(method) && !"HEAD".equals(method)) return Route.status(405);
        if (path == null || path.isEmpty()) path = "/";
        if (path.startsWith("/_capacitor_")) return Route.status(404);
        if (PCStore.cleanPath(path) == null || !path.startsWith("/")) return Route.status(404);
        if (path.equals(BOOT_PATH)) return Route.body(BOOT_HTML, "text/html");
        if (path.equals(BOOT_PATH + ".js")) return Route.body(BOOT_JS, "text/javascript");
        Matcher scoped = SCOPE_FILE.matcher(path);
        if (scoped.matches()) {
            String file = scoped.group(1);
            if (file.equals("sw.js")) return Route.WORKER;
            if (file.equals("~render")) return Route.RENDER;
            return Route.file("manifest.webmanifest", Route.status(404));
        }
        if (path.equals("/sw.js")) return Route.WORKER;
        if (path.startsWith("/s/") || path.equals("/")) return Route.INDEX;
        String asset = PCStore.percentDecoded(path.substring(1));
        if (asset == null || asset.isEmpty()) return Route.status(404);
        return Route.file(asset, path.startsWith("/assets/") ? Route.status(404) : Route.INDEX);
    }

    /** What is sent for a route: status, type, headers and either a body or an asset to stream. */
    static final class Answer {
        final int status;
        final String type;
        final Map<String, String> headers;
        /** The shell's file to stream, or null. */
        final String asset;
        /** The body when no asset is streamed (empty for a HEAD and a bare status). */
        final byte[] body;

        Answer(int status, String type, Map<String, String> headers, String asset, byte[] body) {
            this.status = status;
            this.type = type;
            this.headers = headers;
            this.asset = asset;
            this.body = body;
        }
    }

    /**
     * The answer to `route` given which of the shell's files exist (`exists`, a path under DIR): a missing file is its
     * route's fallback (a 404 where it has none); every answer carries the shell's policy (`pagePolicy`), the render
     * host's `renderPolicy` alone in its place, with nosniff and no-cache; a HEAD has no body.
     */
    static Answer plan(Route route, boolean head, String pagePolicy, String renderPolicy, Predicate<String> exists) {
        Route answered = route;
        while (answered.kind == Route.Kind.FILE && !exists.test(answered.asset)) {
            answered = answered.fallback == null ? Route.status(404) : answered.fallback;
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", answered.render ? renderPolicy : pagePolicy);
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Cache-Control", "no-cache");
        String asset = answered.kind == Route.Kind.FILE && !head ? answered.asset : null;
        byte[] body = answered.kind == Route.Kind.BODY && !head ? answered.body.getBytes(StandardCharsets.UTF_8) : new byte[0];
        return new Answer(answered.status, answered.type, Collections.unmodifiableMap(headers), asset, body);
    }

    /** The Content-Type of the shell's file `name`, by its extension, as Pages names them. */
    static String type(String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 || name.lastIndexOf('/') > dot ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (extension) {
            case "html": return "text/html";
            case "js":
            case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json":
            case "map": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "ico": return "image/x-icon";
            case "woff2": return "font/woff2";
            case "woff": return "font/woff";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            case "md": return "text/markdown";
            case "txt": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    private static boolean text(String type) {
        return type.startsWith("text/") || type.endsWith("json") || type.equals("image/svg+xml");
    }

    /**
     * The script the bundled shell's pages get at document start, before their own, on its origin and in the main frame
     * alone: the contract the client reads (`window.__ovisAppShell`) to know it is the app's copy, with the app's version.
     */
    static String contractScript(String versionName, int versionCode) {
        return "if (window === window.top) window.__ovisAppShell = Object.freeze({ bundled: true, platform: \"android\", appVersion: " + JSONObject.quote(versionName) + ", build: " + versionCode + " });";
    }

    /** The boot page's address that goes on to `start` (a path on the origin, with its query and fragment). */
    static String bootStart(String start) {
        return BOOT_PATH + "#" + encoded(start == null ? "/" : start);
    }

    /** Whether `url` is the boot page on `appOrigin`. */
    static boolean isBoot(String url, String appOrigin) {
        if (url == null || !PCStore.sameOrigin(url, appOrigin)) return false;
        try {
            return BOOT_PATH.equals(new URI(url).getRawPath());
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
    }

    /** `text` with everything but an unreserved character percent-encoded (UTF-8), as decodeURIComponent reads it back. */
    static String encoded(String text) {
        StringBuilder out = new StringBuilder();
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            char c = (char) (b & 0xff);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') out.append(c);
            else out.append(String.format(Locale.ROOT, "%%%02X", b & 0xff));
        }
        return out.toString();
    }

    /**
     * The two policies `shell-policy.json` names, `{page, render}`, or null when it says anything else: missing, not
     * JSON, either one empty, a page policy without its default-src, a render policy without its sandbox. A copy
     * without them is no shell to serve.
     */
    static String[] policiesOf(String json) {
        if (json == null) return null;
        try {
            JSONObject policies = new JSONObject(json);
            Object page = policies.opt("page"), render = policies.opt("render");
            if (!(page instanceof String) || !(render instanceof String)) return null;
            String pagePolicy = ((String) page).trim(), renderPolicy = ((String) render).trim();
            if (!pagePolicy.contains("default-src") || !renderPolicy.startsWith("sandbox allow-scripts")) return null;
            return new String[] { pagePolicy, renderPolicy };
        } catch (JSONException unreadable) {
            return null;
        }
    }

    /**
     * What error.html says when a build that carries the shell cannot serve it (`supported`: the WebView has what it
     * needs, so the copy itself is missing or damaged), in English or Korean as the phone is.
     */
    static String missingReason(boolean supported, boolean korean) {
        if (!supported) {
            return korean
                ? "이 휴대폰의 Android System WebView가 너무 오래돼서 앱에 든 Ovis를 열 수 없어요. Google Play에서 Android System WebView를 업데이트한 뒤 다시 시도해 주세요."
                : "This phone's Android System WebView is too old for the Ovis the app carries. Update Android System WebView in Google Play, then try again.";
        }
        return korean
            ? "이 앱에 든 Ovis가 온전하지 않아요. Google Play에서 앱을 다시 설치해 주세요."
            : "The Ovis this app carries is incomplete. Reinstall the app from Google Play.";
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("ovis-bundled-shell", Context.MODE_PRIVATE);
    }

    /**
     * Whether a bundled start opens the boot page first: until a boot page cleared the origin's workers, and again
     * after the shell was loaded from the network (loadedFromNetwork), whose copy registers them.
     */
    static boolean needsBoot(Context context) {
        return !prefs(context).getBoolean("workers-cleared", false);
    }

    static void booted(Context context) {
        prefs(context).edit().putBoolean("workers-cleared", true).apply();
    }

    /** The shell came from the network at the hosted origin (a build with OVIS_APP_SHELL=hosted): its copy may register workers. */
    static void loadedFromNetwork(Context context) {
        if (!needsBoot(context)) prefs(context).edit().putBoolean("workers-cleared", false).apply();
    }

    /** Whether this WebView can take a page the app answers itself as the shell needs it: document-start scripts and message listeners. */
    static boolean supported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
    }

    /**
     * Whether a request to `scheme`, `host`, `port` (as android.net.Uri reads them, -1 for none) is on `origin`: the
     * scheme and host compared without case, a missing port as the scheme's own. Read from the request's parts, never by
     * parsing its whole URL again: a URL that java.net.URI refuses (WebView keeps `|^{}` and a backtick in a query and
     * `[]` in a path as they are) would otherwise count as another origin and reach the network.
     */
    static boolean onOrigin(String scheme, String host, int port, String origin) {
        URI app;
        try {
            app = new URI(origin);
        } catch (URISyntaxException notAnOrigin) {
            return false;
        }
        if (scheme == null || host == null || app.getScheme() == null || app.getHost() == null) return false;
        if (!scheme.equalsIgnoreCase(app.getScheme()) || !bare(host).equalsIgnoreCase(bare(app.getHost()))) return false;
        return defaultPort(scheme, port) == defaultPort(app.getScheme(), app.getPort());
    }

    /** An IPv6 address without the brackets one reader keeps and another drops. */
    private static String bare(String host) {
        return host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
    }

    private static int defaultPort(String scheme, int port) {
        if (port != -1) return port;
        return "https".equalsIgnoreCase(scheme) ? 443 : "http".equalsIgnoreCase(scheme) ? 80 : -1;
    }

    private final Context context;
    private final String appOrigin;
    private final String pagePolicy;
    private final String renderPolicy;
    private Set<String> files;

    private BundledShell(Context context, String appOrigin, String pagePolicy, String renderPolicy) {
        this.context = context.getApplicationContext();
        this.appOrigin = appOrigin;
        this.pagePolicy = pagePolicy;
        this.renderPolicy = renderPolicy;
    }

    /**
     * The shell this build carries, answered at `appOrigin`, or null where it cannot be: a WebView without document-start
     * scripts and message listeners, which the contract, Capacitor's bridge and the boot page need on a page this app
     * answers itself, or a copy without its index page or a readable shell-policy.json (policiesOf). The activity then
     * shows the app's own error page (missingReason), never the shell from the network.
     */
    static BundledShell at(Context context, String appOrigin) {
        if (!supported()) return null;
        try (InputStream index = context.getAssets().open(DIR + "/index.html"); InputStream policy = context.getAssets().open(POLICY)) {
            String[] policies = policiesOf(new String(readAll(policy), StandardCharsets.UTF_8));
            return policies == null ? null : new BundledShell(context, appOrigin, policies[0], policies[1]);
        } catch (IOException none) {
            return null;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
        return out.toByteArray();
    }

    /** The shell's files, listed once from the assets (`DIR`), as paths under it. */
    private synchronized Set<String> files() {
        if (files != null) return files;
        Set<String> found = new HashSet<>();
        list(DIR, "", found);
        files = found;
        return found;
    }

    private void list(String dir, String prefix, Set<String> found) {
        String[] names;
        try {
            names = context.getAssets().list(dir);
        } catch (IOException unreadable) {
            return;
        }
        if (names == null) return;
        for (String name : names) {
            String[] inside;
            try {
                inside = context.getAssets().list(dir + "/" + name);
            } catch (IOException unreadable) {
                inside = null;
            }
            if (inside != null && inside.length > 0) list(dir + "/" + name, prefix + name + "/", found);
            else found.add(prefix + name);
        }
    }

    /** Whether `request` is on the shell's origin, read from its parts (onOrigin): serve answers every such request itself. */
    boolean answers(WebResourceRequest request) {
        Uri url = request.getUrl();
        return onOrigin(url.getScheme(), url.getHost(), url.getPort(), appOrigin);
    }

    /**
     * What the WebView, or a worker's fetch, gets for `request`: on the shell's origin the shell's answer (route, plan),
     * whatever the path, never Capacitor's local server or the network; anything else from `local`, as before.
     */
    WebResourceResponse serve(WebResourceRequest request, Supplier<WebResourceResponse> local) {
        if (!answers(request)) return local.get();
        boolean head = "HEAD".equals(request.getMethod());
        Answer answer = plan(route(request.getMethod(), request.getUrl().getEncodedPath()), head, pagePolicy, renderPolicy, files()::contains);
        InputStream body = new ByteArrayInputStream(answer.body);
        if (answer.asset != null) {
            try {
                body = context.getAssets().open(DIR + "/" + answer.asset);
            } catch (IOException gone) {
                answer = plan(Route.status(404), head, pagePolicy, renderPolicy, files()::contains);
                body = new ByteArrayInputStream(answer.body);
            }
        }
        String reason = answer.status == 200 ? "OK" : answer.status == 404 ? "Not Found" : "Method Not Allowed";
        return new WebResourceResponse(answer.type, text(answer.type) ? "utf-8" : null, answer.status, reason, answer.headers, body);
    }
}
