package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
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
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Back's races on the hosted app's Add a PC (owner #30): two presses faster than the step they start, and a press
 * while Add a PC is still loading, before its history entry exists. Keys are injected as key events (Instrumentation),
 * as a person's press arrives. A freshly launched page still leaves the app on Back (BackToPageTest's case is the step).
 */
@RunWith(AndroidJUnit4.class)
public class BackRacesTest {
    private static final long WAIT_MS = 30_000;
    /** how long a step back must hold still to count as one: a second step would have landed well within it */
    private static final long SETTLE_MS = 1_500;

    private static String url(ActivityScenario<MainActivity> scenario) {
        AtomicReference<String> seen = new AtomicReference<>();
        scenario.onActivity((activity) -> seen.set(activity.getBridge().getWebView().getUrl()));
        return seen.get();
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

    /** The address once it matches, bounded: the WebView says nothing a test can wait on for a navigation. */
    private static String awaitUrl(ActivityScenario<MainActivity> scenario, String what, Predicate<String> wanted) {
        long deadline = SystemClock.uptimeMillis() + WAIT_MS;
        String last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            last = url(scenario);
            if (last != null && wanted.test(last)) return last;
            SystemClock.sleep(100);
        }
        throw new AssertionError("the WebView never got to " + what + " (last at " + last + ", the app's failure: " + PCStore.failureKind + " " + PCStore.failure + ")");
    }

    /** That the app stays in front on `expected` for SETTLE_MS: the absence of a second step can only be watched for a while. */
    private static void holds(ActivityScenario<MainActivity> scenario, String expected) {
        long until = SystemClock.uptimeMillis() + SETTLE_MS;
        while (SystemClock.uptimeMillis() < until) {
            assertEquals("the app is still in front", Lifecycle.State.RESUMED, scenario.getState());
            assertEquals("one step back, no more", expected, url(scenario));
            SystemClock.sleep(100);
        }
    }

    private static void go(ActivityScenario<MainActivity> scenario, String address) {
        scenario.onActivity((activity) -> activity.getBridge().getWebView().evaluateJavascript("location.assign('" + address + "')", null));
    }

    @Test
    public void twoFastPressesOnAddAPcStepBackOnce() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        PCStore.choosing = false;
        PCStore.setCurrent(instrumentation.getTargetContext(), null);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            awaitUrl(scenario, "its first page, loaded", (address) -> address.startsWith("http") && loaded(scenario));
            // the page Add a PC is opened from, with an older page behind it: a second step would land there
            go(scenario, "/ovis-sheep.svg");
            String page = awaitUrl(scenario, "the page Add a PC is opened from", (address) -> address.endsWith("/ovis-sheep.svg") && loaded(scenario));
            go(scenario, "/ovis-logo.png#add");
            awaitUrl(scenario, "Add a PC (#add)", (address) -> address.endsWith("#add") && loaded(scenario));

            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);

            awaitUrl(scenario, "a page behind Add a PC", (address) -> !address.endsWith("#add"));
            holds(scenario, page);
        }
    }

    /**
     * A PC page served here, whose Add a PC answers only when released: a Back while it loads must stay on the PC page,
     * where v3 found nothing behind the PC's first page and left the app.
     */
    @Test
    public void backWhileAddAPcLoadsStaysOnThePcPage() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        CountDownLatch asked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try (ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))) {
            Thread serving = new Thread(() -> serve(server, asked, release));
            serving.setDaemon(true);
            serving.start();
            String origin = "http://127.0.0.1:" + server.getLocalPort();
            PCStore.choosing = false;
            PCStore.open(context, origin, null);
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                String page = awaitUrl(scenario, "the PC page, loaded", (address) -> address.startsWith(origin) && !address.contains("#add") && loaded(scenario));
                go(scenario, "/slow#add");
                assertTrue("the PC was asked for Add a PC", asked.await(WAIT_MS, TimeUnit.MILLISECONDS));

                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                instrumentation.waitForIdleSync();
                assertEquals("the app is still in front after Back", Lifecycle.State.RESUMED, scenario.getState());

                // the answer arriving now must not open Add a PC: the Back cancelled it
                release.countDown();
                holds(scenario, page);
                assertNotEquals(origin + "/slow#add", url(scenario));
            } finally {
                release.countDown();
                PCStore.setCurrent(context, null);
                PCStore.forget(context, origin);
            }
        }
    }

    /** A PC page freshly opened, nothing behind it: Back leaves the app, as it always did (v4 must not keep it). */
    @Test
    public void backOnAFreshPcPageStillLeavesTheApp() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        CountDownLatch never = new CountDownLatch(1);
        try (ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))) {
            Thread serving = new Thread(() -> serve(server, never, never));
            serving.setDaemon(true);
            serving.start();
            String origin = "http://127.0.0.1:" + server.getLocalPort();
            PCStore.choosing = false;
            PCStore.open(context, origin, null);
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                awaitUrl(scenario, "the PC page, loaded", (address) -> address.startsWith(origin) && loaded(scenario));

                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
                instrumentation.waitForIdleSync();

                long deadline = SystemClock.uptimeMillis() + WAIT_MS;
                while (scenario.getState() == Lifecycle.State.RESUMED && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
                assertNotEquals("Back on a freshly opened PC page leaves the app", Lifecycle.State.RESUMED, scenario.getState());
            } finally {
                PCStore.setCurrent(context, null);
                PCStore.forget(context, origin);
            }
        }
    }

    /**
     * Answers `/slow` once `release` is counted down (bounded), `/api/health` as Ovis does (the app keeps only a PC that
     * answers so, PCStore.answersAsServer), and any other path at once, with a page of its own.
     */
    private static void serve(ServerSocket server, CountDownLatch asked, CountDownLatch release) {
        while (!server.isClosed()) {
            try (Socket socket = server.accept()) {
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                String request = in.readLine();
                String header = in.readLine();
                while (header != null && !header.isEmpty()) header = in.readLine();
                if (request != null && request.startsWith("GET /slow")) {
                    asked.countDown();
                    release.await(WAIT_MS, TimeUnit.MILLISECONDS);
                }
                boolean health = request != null && request.startsWith("GET /api/health");
                byte[] body = (health ? "{\"ok\":true,\"auth\":{}}" : "<!doctype html><title>pc</title><p>pc").getBytes(StandardCharsets.UTF_8);
                OutputStream out = socket.getOutputStream();
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + (health ? "application/json" : "text/html") + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.write(body);
                out.flush();
            } catch (IOException | InterruptedException e) {
                if (server.isClosed()) return;
            }
        }
    }
}
