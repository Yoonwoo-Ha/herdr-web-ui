package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import sh.ovis.app.BundledShell.Route;

public class BundledShellTest {
    private static final String ID = "0123456789abcdef0123456789abcdef";

    private static Route get(String path) {
        return BundledShell.route("GET", path);
    }

    @Test
    public void aPcsScopeIsTheShellAsPagesAnswersIt() {
        for (String path : new String[] { "/", "", "/s/" + ID + "/", "/s/" + ID + "/files/deep/page", "/s/" + ID + "/favicon.png" }) {
            assertSame(path, Route.INDEX, get(path));
        }
        // Pages sends /s/<id> to /s/<id>/; an answer here cannot redirect, and the shell reads its PC from either
        assertSame(Route.INDEX, get("/s/" + ID));
    }

    @Test
    public void aPcsRenderHostIsRenderHtmlWithItsOwnPolicyNotTheShell() {
        Route render = get("/s/" + ID + "/~render");
        assertEquals(Route.Kind.FILE, render.kind);
        assertEquals("render.html", render.asset);
        assertEquals("text/html", render.type);
        assertTrue(render.render);
        assertNull("a render host that is missing is never the shell in its place", render.fallback);
        // only that exact address, as Pages' rule takes it
        assertSame(Route.INDEX, get("/s/" + ID + "/~render/"));
        assertFalse(get("/s/" + ID + "/").render);
    }

    @Test
    public void aPcsManifestIsTheShellsAndEveryWorkerRetires() {
        Route manifest = get("/s/" + ID + "/manifest.webmanifest");
        assertEquals("manifest.webmanifest", manifest.asset);
        assertEquals("application/manifest+json", manifest.type);
        assertEquals(404, manifest.fallback.status);
        for (String path : new String[] { "/s/" + ID + "/sw.js", "/sw.js" }) {
            Route worker = get(path);
            assertEquals(Route.Kind.BODY, worker.kind);
            assertEquals(BundledShell.RETIRING_WORKER, worker.body);
            assertEquals("text/javascript", worker.type);
        }
    }

    @Test
    public void aFileIsTheShellsAndAMissingHashedAssetIsA404NotThePage() {
        Route script = get("/assets/index-0123456789.js");
        assertEquals("assets/index-0123456789.js", script.asset);
        assertEquals("text/javascript", script.type);
        assertEquals(Route.Kind.STATUS, script.fallback.kind);
        assertEquals(404, script.fallback.status);
        // anything else missing is the shell, as Pages answers an address it has no file for
        Route other = get("/no-such-page");
        assertEquals("no-such-page", other.asset);
        assertSame(Route.INDEX, other.fallback);
        assertEquals("favicon.png", get("/favicon.png").asset);
        assertEquals("icons/icon 1.png", get("/icons/icon%201.png").asset);
    }

    @Test
    public void anAddressABrowserWouldNotLoadAsWrittenIsRefused() {
        for (String path : new String[] { "/%2e%2e/public/index.html", "/assets/..%2findex.html", "/assets/%2E%2E/x", "/a\\b", "/s/" + ID + "/../x", "/%zz" }) {
            Route route = get(path);
            assertEquals(path, Route.Kind.STATUS, route.kind);
            assertEquals(path, 404, route.status);
        }
    }

    @Test
    public void onlyGetAndHeadAreAnswered() {
        assertEquals(405, BundledShell.route("POST", "/").status);
        assertEquals(405, BundledShell.route("OPTIONS", "/s/" + ID + "/").status);
        assertSame(Route.INDEX, BundledShell.route("HEAD", "/"));
    }

    @Test
    public void capacitorsOwnPathsAreA404OnTheShellsOrigin() {
        // its local server would read the phone's files, or the network: the client asks for none of them
        for (String path : new String[] { "/_capacitor_file_/data/user/0/x", "/_capacitor_content_/x", "/_capacitor_http_interceptor_?u=https://x" }) {
            assertEquals(path, 404, get(path).status);
        }
    }

    @Test
    public void theBootPageAndItsScriptAreTheAppsOwnOutsideEveryScope() {
        Route page = get(BundledShell.BOOT_PATH);
        assertEquals(Route.Kind.BODY, page.kind);
        assertEquals(BundledShell.BOOT_HTML, page.body);
        assertEquals("text/html", page.type);
        assertTrue(page.body.contains("<script src=\"/_ovis/boot.js\"></script>"));
        Route script = get(BundledShell.BOOT_PATH + ".js");
        assertEquals(BundledShell.BOOT_JS, script.body);
        assertEquals("text/javascript", script.type);
        assertFalse(BundledShell.BOOT_PATH.startsWith("/s/"));
    }

    @Test
    public void typesAreByExtension() {
        assertEquals("text/javascript", BundledShell.type("assets/a.mjs"));
        assertEquals("text/css", BundledShell.type("assets/a.css"));
        assertEquals("application/wasm", BundledShell.type("assets/ghostty-vt.wasm"));
        assertEquals("font/woff2", BundledShell.type("assets/PretendardVariable.subset.0.WOFF2"));
        assertEquals("image/svg+xml", BundledShell.type("store-badges/app-store-en.svg"));
        assertEquals("application/json", BundledShell.type("build.json"));
        assertEquals("text/markdown", BundledShell.type("THIRD_PARTY_NOTICES.md"));
        assertEquals("application/octet-stream", BundledShell.type("no-such-page"));
        assertEquals("application/octet-stream", BundledShell.type("a.b/c"));
    }

    @Test
    public void theContractNamesThisAppsVersion() {
        assertEquals(
            "if (window === window.top) window.__ovisAppShell = Object.freeze({ bundled: true, platform: \"android\", appVersion: \"1.0.7\", build: 15 });",
            BundledShell.contractScript("1.0.7", 15)
        );
        // a version name is data, never script
        assertTrue(BundledShell.contractScript("1\"); alert(1); (\"", 1).contains("appVersion: \"1\\\"); alert(1); (\\\"\""));
    }

    @Test
    public void theBootPageCarriesItsNextAddressInItsFragmentAsTheScriptReadsItBack() throws Exception {
        String start = "/s/" + ID + "/#offer=a+b/c%20d&é";
        String boot = BundledShell.bootStart(start);
        assertTrue(boot.startsWith(BundledShell.BOOT_PATH + "#"));
        String fragment = boot.substring(boot.indexOf('#') + 1);
        assertTrue("only unreserved characters stay as they are", fragment.matches("[A-Za-z0-9._~%-]*"));
        assertEquals(start, URLDecoder.decode(fragment, StandardCharsets.UTF_8.name()));
        assertEquals(BundledShell.BOOT_PATH + "#%2F%23pcs", BundledShell.bootStart("/#pcs"));
    }

    @Test
    public void theBootPageIsThatAddressOnTheHostedOriginAlone() {
        String app = "https://app.ovis.sh";
        assertTrue(BundledShell.isBoot("https://app.ovis.sh/_ovis/boot#%2F", app));
        assertTrue(BundledShell.isBoot("https://app.ovis.sh:443/_ovis/boot", app));
        assertFalse(BundledShell.isBoot("https://app.ovis.sh/_ovis/boot.js", app));
        assertFalse(BundledShell.isBoot("https://app.ovis.sh/s/" + ID + "/_ovis/boot", app));
        assertFalse(BundledShell.isBoot("https://localhost/_ovis/boot", app));
        assertFalse(BundledShell.isBoot(null, app));
    }

    private static final String PAGE = "default-src 'self'; script-src 'self'", RENDER = "sandbox allow-scripts; default-src 'none'";

    @Test
    public void theShellsOriginIsReadFromTheRequestsPartsSoAUrlJavaCannotParseStaysOnIt() {
        String app = "https://app.ovis.sh";
        // what android.net.Uri reads from URLs WebView keeps raw (`|^{}` and a backtick in a query, `[]` in a path):
        // java.net.URI refuses each, and a decision made with it called them another origin, which reached the network
        for (String raw : new String[] { "https://app.ovis.sh/x?a=|b", "https://app.ovis.sh/x?a=^{}`", "https://app.ovis.sh/[x]" }) {
            assertFalse(raw, PCStore.sameOrigin(raw, app));
        }
        assertTrue(BundledShell.onOrigin("https", "app.ovis.sh", -1, app));
        assertTrue(BundledShell.onOrigin("HTTPS", "App.Ovis.SH", 443, app));
        assertFalse(BundledShell.onOrigin("http", "app.ovis.sh", -1, app));
        assertFalse(BundledShell.onOrigin("https", "app.ovis.sh", 8443, app));
        assertFalse(BundledShell.onOrigin("https", "app.ovis.sh.evil.example", -1, app));
        assertFalse(BundledShell.onOrigin("https", "evil.example", -1, app));
        assertFalse(BundledShell.onOrigin(null, "app.ovis.sh", -1, app));
        assertFalse(BundledShell.onOrigin("https", null, -1, app));
        // a test build's origin with a port of its own
        assertTrue(BundledShell.onOrigin("https", "shell.example.ts.net", 8443, "https://shell.example.ts.net:8443"));
        assertFalse(BundledShell.onOrigin("https", "shell.example.ts.net", -1, "https://shell.example.ts.net:8443"));
        // a PC at an IPv6 address, which one reader brackets and another does not
        assertTrue(BundledShell.onOrigin("http", "[fd7a:115c:a1e0::1]", 8080, "http://[fd7a:115c:a1e0::1]:8080"));
        assertTrue(BundledShell.onOrigin("http", "fd7a:115c:a1e0::1", 8080, "http://[fd7a:115c:a1e0::1]:8080"));
    }

    @Test
    public void everyAnswerCarriesThePolicyNosniffAndNoCacheAndTheRenderHostItsOwnPolicyAlone() {
        for (String path : new String[] { "/", "/s/" + ID + "/", "/s/" + ID + "/sw.js", "/sw.js", "/assets/a.js", "/assets/gone.js", "/no-such-page", "/_capacitor_file_/x", BundledShell.BOOT_PATH, "/%2e%2e/x", "/s/" + ID + "/~render" }) {
            BundledShell.Answer answer = BundledShell.plan(get(path), false, PAGE, RENDER, (file) -> !file.equals("assets/gone.js"));
            assertEquals(path, path.endsWith("~render") ? RENDER : PAGE, answer.headers.get("Content-Security-Policy"));
            assertEquals(path, "nosniff", answer.headers.get("X-Content-Type-Options"));
            assertEquals(path, "no-cache", answer.headers.get("Cache-Control"));
        }
        BundledShell.Answer refused = BundledShell.plan(BundledShell.route("POST", "/"), false, PAGE, RENDER, (file) -> true);
        assertEquals(405, refused.status);
        assertEquals(PAGE, refused.headers.get("Content-Security-Policy"));
    }

    @Test
    public void aMissingFileIsItsFallbackAndAHeadHasNoBody() {
        BundledShell.Answer gone = BundledShell.plan(get("/assets/gone.js"), false, PAGE, RENDER, (file) -> false);
        assertEquals(404, gone.status);
        assertNull(gone.asset);
        BundledShell.Answer page = BundledShell.plan(get("/no-such-page"), false, PAGE, RENDER, (file) -> file.equals("index.html"));
        assertEquals("index.html", page.asset);
        assertEquals("text/html", page.type);
        // no index page in the copy: a 404, never the network
        assertEquals(404, BundledShell.plan(get("/"), false, PAGE, RENDER, (file) -> false).status);
        assertEquals(404, BundledShell.plan(get("/s/" + ID + "/~render"), false, PAGE, RENDER, (file) -> false).status);
        BundledShell.Answer head = BundledShell.plan(get("/"), true, PAGE, RENDER, (file) -> true);
        assertEquals(200, head.status);
        assertNull(head.asset);
        assertEquals(0, head.body.length);
        BundledShell.Answer worker = BundledShell.plan(get("/sw.js"), true, PAGE, RENDER, (file) -> true);
        assertEquals(0, worker.body.length);
        assertEquals(BundledShell.RETIRING_WORKER, new String(BundledShell.plan(get("/sw.js"), false, PAGE, RENDER, (file) -> true).body, StandardCharsets.UTF_8));
    }

    @Test
    public void theCarriedPoliciesAreReadOnlyWhenBothAreThere() {
        assertNull(BundledShell.policiesOf(null));
        assertNull(BundledShell.policiesOf(""));
        assertNull(BundledShell.policiesOf("not json"));
        assertNull(BundledShell.policiesOf("{}"));
        assertNull(BundledShell.policiesOf("{\"page\":\"\",\"render\":\"sandbox allow-scripts\"}"));
        assertNull(BundledShell.policiesOf("{\"page\":\"default-src 'self'\",\"render\":\"\"}"));
        assertNull(BundledShell.policiesOf("{\"page\":1,\"render\":\"sandbox allow-scripts\"}"));
        // a render policy without its sandbox would run a drawn page on the shell's origin
        assertNull(BundledShell.policiesOf("{\"page\":\"default-src 'self'\",\"render\":\"default-src 'none'\"}"));
        String[] read = BundledShell.policiesOf("{\"page\":\"" + PAGE + "\",\"render\":\"" + RENDER + "\"}");
        assertEquals(PAGE, read[0]);
        assertEquals(RENDER, read[1]);
    }

    @Test
    public void aShellThatCannotBeServedSaysWhyInTheErrorPagesWords() {
        assertTrue(BundledShell.missingReason(false, false).contains("Android System WebView"));
        assertTrue(BundledShell.missingReason(false, true).contains("Android System WebView"));
        assertTrue(BundledShell.missingReason(true, false).contains("Reinstall"));
        assertFalse(BundledShell.missingReason(true, true).isEmpty());
    }
}
