package sh.ovis.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which screen the app starts an activity on, and what the hosted Connect a PC screen ("home") does while it is up:
 * the decisions alone, so MainActivity only carries them out (HomeTest; Home.swift is the iOS twin). Home is the hosted
 * app's front page opened as the WebView's first page without being the current PC; the app's own bundled page stands
 * in for it when it cannot load.
 */
final class Home {
    /** What an activity opens as its first page. */
    enum Screen {
        /** The current PC, at its own address. */
        PC,
        /** The hosted Connect a PC screen. */
        HOME,
        /** The app's own Connect a PC page (index.html): the fallback, what only it can take, or a build's first screen. */
        BUNDLED,
        /** The bundled demo. */
        DEMO
    }

    /** Where an activity that opened home is. */
    enum Phase {
        /** Home has not shown yet: its cover is up. */
        LOADING,
        SHOWN,
        /** Home was given up on: the activity is on its way out to the bundled page, and nothing moves it again. */
        FALLBACK,
        /** A relay PC's page came up in it: the hosted app is the current PC, and the rules of a PC's page decide. */
        PC,
        /** The app is going elsewhere (a PC picked, a notification tapped, Try again): what the page still does counts for nothing. */
        LEFT
    }

    enum Event {
        /** Home's page is up (its client drew). */
        LOADED,
        /** A main-frame load failed, or answered with an HTTP error. */
        FAILED,
        /** Home took too long (timedOut). */
        TIMED_OUT,
        /** The WebView went to a relay PC's page (relayPc). */
        RELAY_PC,
        /** The app was told to open something else, and this page is on its way out. */
        LEFT
    }

    enum Action {
        NONE,
        LIFT_COVER,
        /** The bundled page instead, marked as the fallback for this process. */
        FALL_BACK,
        /** The hosted app becomes the current PC, which ends choosing. */
        KEEP_HOSTED
    }

    /** What the phone's Back does. */
    enum Back {
        /** A step back in the page's own history. */
        PAGE,
        /** The PC the screen was opened from to choose another. */
        CURRENT,
        /** Home again. */
        HOME,
        /** Out of the demo, to the screen it was opened over. */
        DEMO_EXIT,
        /** The system's Back: it leaves the app. */
        LEAVE
    }

    /** How long home may take to answer before the bundled page stands in. */
    static final long LOAD_MS = 8000;

    private Home() {}

    /**
     * The screen an activity starts on. `hosted`: the build's first screen is the hosted one (OVIS_APP_HOME); `pc`: a
     * PC is to open (none while the person chooses another); `demo`: the demo was asked for (HerdrShell openDemo);
     * `asked`: something waits that only the bundled page takes (an SSH setup, a pairing link, an SSH PC whose address
     * another app holds); `failed`: home did not load in this process and was not tried again since.
     */
    static Screen screen(boolean hosted, boolean pc, boolean demo, boolean asked, boolean failed) {
        if (asked && !pc) return Screen.BUNDLED;
        if (demo) return Screen.DEMO;
        if (pc) return Screen.PC;
        return hosted && !failed ? Screen.HOME : Screen.BUNDLED;
    }

    static Action on(Phase phase, Event event) {
        if (phase == Phase.FALLBACK || phase == Phase.PC || phase == Phase.LEFT) return Action.NONE;
        switch (event) {
            case LOADED: return phase == Phase.LOADING ? Action.LIFT_COVER : Action.NONE;
            case FAILED: return Action.FALL_BACK;
            case TIMED_OUT: return phase == Phase.LOADING ? Action.FALL_BACK : Action.NONE;
            case RELAY_PC: return Action.KEEP_HOSTED;
            default: return Action.NONE;
        }
    }

    static Phase after(Phase phase, Event event) {
        if (event == Event.LEFT && (phase == Phase.LOADING || phase == Phase.SHOWN)) return Phase.LEFT;
        switch (on(phase, event)) {
            case LIFT_COVER: return Phase.SHOWN;
            case FALL_BACK: return Phase.FALLBACK;
            case KEEP_HOSTED: return Phase.PC;
            default: return phase;
        }
    }

    /**
     * Whether home took too long, `elapsedMs` after it started (time the app spent in front): LOAD_MS with no answer,
     * and as long as a PC gets to answer (PCStore.ANSWER_SECONDS) once its page is on its way, which a slow link needs.
     */
    static boolean timedOut(long elapsedMs, boolean answered) {
        return elapsedMs >= (answered ? PCStore.ANSWER_SECONDS * 1000L : LOAD_MS);
    }

    /**
     * What Back does on `screen`. `failed` as for screen(); `current`: a PC is current; `choosing`: the screen is up
     * to choose another PC, with that one still current; `pageHasBack`: the page has a step of its own to take first.
     * The bundled page while choosing goes back to the PC at once, as it always did.
     */
    static Back back(Screen screen, boolean hosted, boolean failed, boolean current, boolean choosing, boolean pageHasBack) {
        if (screen == Screen.BUNDLED && choosing) return Back.CURRENT;
        if (pageHasBack) return Back.PAGE;
        switch (screen) {
            case HOME: return choosing ? Back.CURRENT : Back.LEAVE;
            case DEMO: return Back.DEMO_EXIT;
            case BUNDLED:
                if (!hosted) return Back.LEAVE;
                // opened over a PC that nobody left (a pairing link the page refused): that PC is what opens next
                if (current) return Back.CURRENT;
                // home handed over to this page (an SSH setup, a pairing link): the fallback never goes back by itself
                return failed ? Back.LEAVE : Back.HOME;
            default: return Back.LEAVE;
        }
    }

    /**
     * Whether the hosted app's own screen is up, from what its page says: `shell`, it names itself the hosted app
     * (`<meta name="ovis-shell">`, which the released front page and the next both carry); `root`, `boot`, `children`,
     * its root is there, without index.html's loading spinner, holding what the client rendered; `loading`, the
     * document is still arriving. An empty 200 or another page of that origin (a maintenance page) is not home, so the
     * cover stays and the clock goes on.
     */
    static boolean drawn(boolean shell, boolean root, boolean boot, int children, boolean loading) {
        return shell && root && !boot && children > 0 && !loading;
    }

    /** `drawn` from the JSON the page's facts come back as (MainActivity's HOME_SCRIPT); anything unreadable is not home. */
    static boolean drawn(String page) {
        Object facts;
        try {
            facts = PCStore.json(page == null ? "" : page);
        } catch (IllegalArgumentException unreadable) {
            return false;
        }
        if (!(facts instanceof java.util.Map)) return false;
        java.util.Map<?, ?> said = (java.util.Map<?, ?>) facts;
        Object shell = said.get("shell"), root = said.get("root"), boot = said.get("boot"), children = said.get("children"), loading = said.get("loading");
        if (!(shell instanceof Boolean && root instanceof Boolean && boot instanceof Boolean && children instanceof java.math.BigInteger && loading instanceof Boolean)) return false;
        java.math.BigInteger count = (java.math.BigInteger) children;
        return drawn((Boolean) shell, (Boolean) root, (Boolean) boot, count.signum() > 0 ? 1 : 0, (Boolean) loading);
    }

    private static final Pattern HOME_SIGN_IN = Pattern.compile("sign-in=[a-z]{1,32}");

    /**
     * The fragment home starts at when `url` is the hosted app's front page at `appOrigin`, as the app's own page opens
     * it for a sign-in (`#sign-in=<provider>`) or its saved row (`#pcs`, which a bare address means too); null for
     * anything else, which opens as a PC does. Such an open is an attempt at home: nothing is made the current PC by it.
     */
    static String homeStart(String url, String appOrigin) {
        if (url == null || appOrigin == null || !PCStore.sameOrigin(url, appOrigin)) return null;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException notAnAddress) {
            return null;
        }
        String path = uri.getRawPath();
        if (!(path == null || path.isEmpty() || path.equals("/")) || uri.getRawQuery() != null) return null;
        String fragment = uri.getRawFragment();
        if (fragment == null || fragment.isEmpty() || fragment.equals("pcs")) return "#pcs";
        return HOME_SIGN_IN.matcher(fragment).matches() ? "#" + fragment : null;
    }

    /** Whether a PC's own page is what is on screen: a PC opened as one, or a relay PC's page that came up in home. */
    static boolean pcShown(Screen screen, Phase phase) {
        return phase == null ? screen == Screen.PC : phase == Phase.PC;
    }

    /**
     * How long home has waited with the app in front, in milliseconds on any one clock: each look (tick) adds the
     * time since the look before, a second at most; nothing is added between leaving the front (away) and coming
     * back (resumed), whether or not looks go on meanwhile.
     */
    static final class Clock {
        private long waited;
        private long seenAt;
        private boolean away;

        Clock(long now) {
            seenAt = now;
        }

        long tick(long now) {
            if (!away) waited += Math.max(0, Math.min(now - seenAt, 1000));
            seenAt = now;
            return waited;
        }

        void away(long now) {
            tick(now);
            away = true;
        }

        void resumed(long now) {
            away = false;
            seenAt = now;
        }
    }

    private static final Pattern RELAY_PC = Pattern.compile("/s/([0-9a-f]{32})(/.*)?");

    /** Whether `url` is a page of a relay PC on the hosted app at `appOrigin`: within `/s/<server_id>/`, as a browser loads it. */
    static boolean relayPc(String url, String appOrigin) {
        return relayScope(url, appOrigin) != null;
    }

    /** The scope of the relay PC whose page `url` is (`<appOrigin>/s/<server_id>/`, the key such a PC is saved by), or null. */
    static String relayScope(String url, String appOrigin) {
        if (url == null || appOrigin == null || !PCStore.sameOrigin(url, appOrigin)) return null;
        String path;
        try {
            path = new URI(url).getRawPath();
        } catch (URISyntaxException notAnAddress) {
            return null;
        }
        if (path == null || PCStore.cleanPath(path) == null) return null;
        Matcher scope = RELAY_PC.matcher(path);
        return scope.matches() ? appOrigin + "/s/" + scope.group(1) + "/" : null;
    }

    /**
     * Whether `url` is what the word "demo" becomes in the hosted screen's address field (`https://demo/`): the bundled
     * demo, as that word opens it on the bundled page. No PC answers there: a one-word name has no certificate.
     */
    static boolean demoAddress(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            String path = uri.getRawPath();
            return "https".equalsIgnoreCase(uri.getScheme()) && "demo".equalsIgnoreCase(uri.getHost()) && uri.getPort() == -1
                && (path == null || path.isEmpty() || path.equals("/")) && uri.getRawQuery() == null && uri.getRawFragment() == null;
        } catch (URISyntaxException notAnAddress) {
            return false;
        }
    }

    /**
     * Whether an open of `url` is the demo: the word "demo" as an address, on home alone. Anywhere else that address is
     * a PC's, as it always was.
     */
    static boolean opensDemo(String url, boolean atHome) {
        return atHome && demoAddress(url);
    }
}
