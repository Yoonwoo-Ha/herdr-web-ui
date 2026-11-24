package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.webkit.WebView;
import android.widget.EditText;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * SSH asked for by a page (HerdrShell openSshSetup: the hosted app's Add a PC › SSH, or the app's own page): the setup
 * screen comes up over that page with the login filled in, and Back there returns to that same page as it was, in the
 * same activity, with nothing loaded again in between. The app's own page stands in for the asking page here: it may
 * ask as the hosted app may (SshPcs.setupOpener), and it needs no network.
 */
@RunWith(AndroidJUnit4.class)
public class SshSetupOverPageTest {
    private static final long WAIT_MS = 30_000;

    /** What the page's script answers, bounded. */
    private static String eval(ActivityScenario<MainActivity> scenario, String script) {
        BlockingQueue<String> answer = new LinkedBlockingQueue<>();
        scenario.onActivity((activity) -> activity.getBridge().getWebView().evaluateJavascript(script, answer::add));
        try {
            return answer.poll(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    private static String text(Activity activity, int id) {
        AtomicReference<String> seen = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> seen.set(((EditText) activity.findViewById(id)).getText().toString()));
        return seen.get();
    }

    @Test
    public void backFromTheSshSetupAPageAskedForReturnsToThatPage() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        PCStore.choosing = false;
        PCStore.setCurrent(context, null);
        PCStore.homeFailed = true;
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            long deadline = SystemClock.uptimeMillis() + WAIT_MS;
            while (!"\"complete\"".equals(eval(scenario, "document.readyState")) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
            // a mark only this document carries: a page loaded again would not have it
            eval(scenario, "window.asked = 'ssh'");
            AtomicReference<MainActivity> asking = new AtomicReference<>();
            AtomicReference<String> page = new AtomicReference<>();
            scenario.onActivity((activity) -> {
                asking.set(activity);
                WebView view = activity.getBridge().getWebView();
                page.set(view.getUrl());
            });

            Instrumentation.ActivityMonitor setupShown = instrumentation.addMonitor(SshSetupActivity.class.getName(), null, false);
            scenario.onActivity((activity) -> activity.openSshSetup("me@10.0.2.2:2222"));
            Activity setup = instrumentation.waitForMonitorWithTimeout(setupShown, WAIT_MS);
            assertNotNull("the SSH setup came up", setup);
            assertEquals("10.0.2.2", text(setup, R.id.ssh_host));
            assertEquals("me", text(setup, R.id.ssh_user));
            assertEquals("2222", text(setup, R.id.ssh_port));

            // Back as a person presses it; a first press may only close the keyboard
            for (int press = 0; press < 3 && !setup.isFinishing() && !setup.isDestroyed(); press++) {
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                instrumentation.waitForIdleSync();
            }
            deadline = SystemClock.uptimeMillis() + WAIT_MS;
            while (scenario.getState() != Lifecycle.State.RESUMED && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
            assertEquals("the page that asked is in front again", Lifecycle.State.RESUMED, scenario.getState());
            scenario.onActivity((activity) -> {
                assertSame("the same activity, not one opened again", asking.get(), activity);
                assertEquals("the same page", page.get(), activity.getBridge().getWebView().getUrl());
            });
            assertEquals("the same document, not loaded again", "\"ssh\"", eval(scenario, "window.asked"));
        }
    }
}
