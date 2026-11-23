package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Context;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.webkit.WebView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * The system Back key on a page the app's WebView went to, as a relay PC's More opens the hosted app's Add a PC: a new
 * document at `#add`, reached by location.assign. Back must step back to the page behind it, never leave the app
 * (Android 15 and 16 both left it before). The key is injected as a key event (Instrumentation), as a person's press
 * arrives, so it takes the system's own path to the activity's back handling, not a call into it.
 */
@RunWith(AndroidJUnit4.class)
public class BackToPageTest {
    private static final long WAIT_MS = 30_000;

    private static String url(ActivityScenario<MainActivity> scenario) {
        AtomicReference<String> seen = new AtomicReference<>();
        scenario.onActivity((activity) -> {
            WebView view = activity.getBridge() == null ? null : activity.getBridge().getWebView();
            seen.set(view == null ? null : view.getUrl());
        });
        return seen.get();
    }

    /** The address once it matches, bounded: the WebView says nothing a test can wait on for a navigation. */
    private static String awaitUrl(ActivityScenario<MainActivity> scenario, String what, Predicate<String> wanted) {
        long deadline = SystemClock.uptimeMillis() + WAIT_MS;
        String last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            last = url(scenario);
            if (last != null && wanted.test(last)) return last;
            SystemClock.sleep(100);
        }
        throw new AssertionError("the WebView never got to " + what + " (last at " + last + ")");
    }

    /** Whether the page has finished loading: a navigation made before that replaces its entry rather than adding one. */
    private static boolean loaded(ActivityScenario<MainActivity> scenario) {
        BlockingQueue<String> state = new LinkedBlockingQueue<>();
        scenario.onActivity((activity) -> activity.getBridge().getWebView().evaluateJavascript("document.readyState", state::add));
        try {
            return "\"complete\"".equals(state.poll(5, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Test
    public void backOnAddAPcGoesBackToThePageBehindItAndStaysInTheApp() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        // the app's own first page: no PC chosen, nothing being chosen, and its own page in place of the hosted screen
        PCStore.choosing = false;
        PCStore.setCurrent(context, null);
        PCStore.homeFailed = true;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            String first = awaitUrl(scenario, "its first page, loaded", (address) -> address.startsWith("http") && !address.contains("#add") && loaded(scenario));
            scenario.onActivity((activity) -> activity.getBridge().getWebView().evaluateJavascript("location.assign('/ovis-sheep.svg#add')", null));
            String add = awaitUrl(scenario, "Add a PC (#add)", (address) -> address.endsWith("#add"));
            // a document with no script of its own, so nothing but the app's Back moves the history
            assertTrue(add, add.contains("/ovis-sheep.svg"));

            AtomicReference<Boolean> behind = new AtomicReference<>();
            AtomicReference<String> entries = new AtomicReference<>();
            scenario.onActivity((activity) -> {
                WebView view = activity.getBridge().getWebView();
                android.webkit.WebBackForwardList list = view.copyBackForwardList();
                // the list, not canGoBack: Chromium may mark a page left by script skippable for Back, the case at hand
                behind.set(list.getCurrentIndex() > 0);
                StringBuilder all = new StringBuilder();
                for (int i = 0; i < list.getSize(); i++) all.append(i == list.getCurrentIndex() ? " >" : " ").append(list.getItemAtIndex(i).getUrl());
                entries.set(all.toString());
            });
            assertTrue("the WebView has the page behind Add a PC:" + entries.get(), behind.get());
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            instrumentation.waitForIdleSync();
            assertEquals("the app is still in front after Back", Lifecycle.State.RESUMED, scenario.getState());

            String back = awaitUrl(scenario, "the page behind Add a PC", (address) -> !address.endsWith("#add"));
            assertEquals("Back returns to the page behind Add a PC", first, back);
            assertNotNull(url(scenario));
        }
    }
}
