package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import sh.ovis.app.Home.Action;
import sh.ovis.app.Home.Back;
import sh.ovis.app.Home.Event;
import sh.ovis.app.Home.Phase;
import sh.ovis.app.Home.Screen;

public class HomeTest {
    private static final boolean HOSTED = true, BUNDLED_BUILD = false;

    @Test
    public void aSavedPcOpensDirectlyWhateverElseHolds() {
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, false, false));
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, false, true));
        // an SSH PC's failure left over from an earlier open is no reason to keep another PC from opening
        assertEquals(Screen.PC, Home.screen(HOSTED, true, false, true, false));
        assertEquals(Screen.PC, Home.screen(BUNDLED_BUILD, true, false, false, false));
    }

    @Test
    public void withNoPcToOpenTheHostedScreenIsHome() {
        // first launch, after Forget or disconnect, and choosing another PC (the caller passes no PC while choosing)
        assertEquals(Screen.HOME, Home.screen(HOSTED, false, false, false, false));
    }

    @Test
    public void theBundledPageStandsInOnceHomeFailedUntilItIsTriedAgain() {
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, false, true));
    }

    @Test
    public void theBundledPageTakesWhatOnlyItCanTake() {
        // an SSH setup a page asked for, a pairing link parked for it, an SSH PC it has to say could not open
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, true, false));
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, false, true, true));
    }

    @Test
    public void theDemoAskedForOpensOverAnythingElse() {
        assertEquals(Screen.DEMO, Home.screen(HOSTED, false, true, false, false));
        assertEquals(Screen.DEMO, Home.screen(HOSTED, true, true, false, false));
        assertEquals(Screen.DEMO, Home.screen(HOSTED, false, true, false, true));
        assertEquals(Screen.DEMO, Home.screen(BUNDLED_BUILD, false, true, false, false));
    }

    @Test
    public void whatOnlyTheBundledPageCanTakeComesBeforeTheDemo() {
        // a pairing link that arrives while the demo is up waits for the connect screen, as it does over a PC's page
        assertEquals(Screen.BUNDLED, Home.screen(HOSTED, false, true, true, false));
    }

    @Test
    public void aBuildWithTheBundledFirstScreenNeverOpensHome() {
        for (boolean asked : new boolean[] { false, true }) {
            for (boolean failed : new boolean[] { false, true }) {
                assertEquals(Screen.BUNDLED, Home.screen(BUNDLED_BUILD, false, false, asked, failed));
            }
        }
    }

    @Test
    public void homeThatLoadsLiftsItsCoverOnce() {
        assertEquals(Action.LIFT_COVER, Home.on(Phase.LOADING, Event.LOADED));
        assertEquals(Phase.SHOWN, Home.after(Phase.LOADING, Event.LOADED));
        assertEquals(Action.NONE, Home.on(Phase.SHOWN, Event.LOADED));
        assertEquals(Phase.SHOWN, Home.after(Phase.SHOWN, Event.LOADED));
    }

    @Test
    public void homeThatFailsOrTakesTooLongGivesWayToTheBundledPage() {
        assertEquals(Action.FALL_BACK, Home.on(Phase.LOADING, Event.FAILED));
        assertEquals(Action.FALL_BACK, Home.on(Phase.LOADING, Event.TIMED_OUT));
        assertEquals(Phase.FALLBACK, Home.after(Phase.LOADING, Event.FAILED));
        assertEquals(Phase.FALLBACK, Home.after(Phase.LOADING, Event.TIMED_OUT));
    }

    @Test
    public void aPageOfHomeThatFailsLaterGivesWayTooButTheClockNoLongerCounts() {
        // a PC's row pressed with the network gone: the page left behind is no screen to stay on
        assertEquals(Action.FALL_BACK, Home.on(Phase.SHOWN, Event.FAILED));
        assertEquals(Phase.FALLBACK, Home.after(Phase.SHOWN, Event.FAILED));
        assertEquals(Action.NONE, Home.on(Phase.SHOWN, Event.TIMED_OUT));
        assertEquals(Phase.SHOWN, Home.after(Phase.SHOWN, Event.TIMED_OUT));
    }

    @Test
    public void nothingThatComesAfterTheFallbackMovesThePersonAgain() {
        // a load that still finishes, fails once more or runs into the clock: the bundled page is up, with what was typed
        for (Event event : Event.values()) {
            assertEquals(event.name(), Action.NONE, Home.on(Phase.FALLBACK, event));
            assertEquals(event.name(), Phase.FALLBACK, Home.after(Phase.FALLBACK, event));
        }
    }

    @Test
    public void arrivingAtARelayPcMakesTheHostedAppThePc() {
        for (Phase phase : new Phase[] { Phase.LOADING, Phase.SHOWN }) {
            assertEquals(phase.name(), Action.KEEP_HOSTED, Home.on(phase, Event.RELAY_PC));
            assertEquals(phase.name(), Phase.PC, Home.after(phase, Event.RELAY_PC));
        }
    }

    @Test
    public void onceTheAppLeavesHomeNothingOfItCountsAnyMore() {
        // a PC picked, a notification tapped, Try again: the page still up has a moment before it goes, in which a
        // relay PC's page landing must not make the hosted app the PC over the one just written
        for (Phase phase : new Phase[] { Phase.LOADING, Phase.SHOWN }) {
            assertEquals(phase.name(), Action.NONE, Home.on(phase, Event.LEFT));
            assertEquals(phase.name(), Phase.LEFT, Home.after(phase, Event.LEFT));
        }
        for (Event event : Event.values()) {
            assertEquals(event.name(), Action.NONE, Home.on(Phase.LEFT, event));
            assertEquals(event.name(), Phase.LEFT, Home.after(Phase.LEFT, event));
        }
        // a relay PC already up in it is that PC's page, which leaves as any PC's does
        assertEquals(Phase.PC, Home.after(Phase.PC, Event.LEFT));
        assertEquals(Phase.FALLBACK, Home.after(Phase.FALLBACK, Event.LEFT));
    }

    @Test
    public void onceARelayPcIsUpThePcsOwnRulesDecide() {
        for (Event event : Event.values()) {
            assertEquals(event.name(), Action.NONE, Home.on(Phase.PC, event));
            assertEquals(event.name(), Phase.PC, Home.after(Phase.PC, event));
        }
    }

    @Test
    public void theClockRunsOutAtEightSecondsWithNoAnswer() {
        assertEquals(false, Home.timedOut(7999, false));
        assertEquals(true, Home.timedOut(8000, false));
    }

    @Test
    public void aPageThatAnsweredGetsAsLongAsAPcDoesToAnswer() {
        // the hosted page is on its way over a slow link: cut off at eight seconds, its script would never finish arriving
        assertEquals(false, Home.timedOut(8000, true));
        assertEquals(false, Home.timedOut(PCStore.ANSWER_SECONDS * 1000L - 1, true));
        assertEquals(true, Home.timedOut(PCStore.ANSWER_SECONDS * 1000L, true));
    }

    @Test
    public void backGoesThroughThePagesOwnHistoryFirstAtHome() {
        assertEquals(Back.PAGE, Home.back(Screen.HOME, HOSTED, false, true, true, true));
        assertEquals(Back.PAGE, Home.back(Screen.HOME, HOSTED, false, false, false, true));
        assertEquals(Back.PAGE, Home.back(Screen.PC, HOSTED, false, false, false, true));
        assertEquals(Back.PAGE, Home.back(Screen.DEMO, HOSTED, false, false, false, true));
    }

    @Test
    public void backAtHomeWithNothingBehindReturnsToThePcItWasOpenedFrom() {
        assertEquals(Back.CURRENT, Home.back(Screen.HOME, HOSTED, false, true, true, false));
        // no PC to go back to: the system's Back, which leaves the app
        assertEquals(Back.LEAVE, Home.back(Screen.HOME, HOSTED, false, false, false, false));
    }

    @Test
    public void backOnTheBundledPageWhileChoosingReturnsToThePcAtOnceAsBefore() {
        for (boolean hosted : new boolean[] { HOSTED, BUNDLED_BUILD }) {
            for (boolean failed : new boolean[] { false, true }) {
                for (boolean pageHasBack : new boolean[] { false, true }) {
                    assertEquals(Back.CURRENT, Home.back(Screen.BUNDLED, hosted, failed, true, true, pageHasBack));
                }
            }
        }
    }

    @Test
    public void backOnTheFallbackLeavesTheAppRatherThanTryHomeAgain() {
        assertEquals(Back.LEAVE, Home.back(Screen.BUNDLED, HOSTED, true, false, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, HOSTED, true, false, false, true));
    }

    @Test
    public void backOnTheBundledPageHomeHandedOverToReturnsHome() {
        // the SSH setup or a pairing link took the person off home: Back is the way back to it
        assertEquals(Back.HOME, Home.back(Screen.BUNDLED, HOSTED, false, false, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, HOSTED, false, false, false, true));
    }

    @Test
    public void backOnTheBundledFirstScreenLeavesTheAppAsBefore() {
        assertEquals(Back.LEAVE, Home.back(Screen.BUNDLED, BUNDLED_BUILD, false, false, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, BUNDLED_BUILD, false, false, false, true));
    }

    @Test
    public void backFromTheDemoLeavesTheDemoForTheScreenItWasOpenedOver() {
        // the demo is the web view's first page, with nothing behind it: whatever opens without it, home, the fallback
        // or a build's own first screen, with the current PC and choosing as they were
        assertEquals(Back.DEMO_EXIT, Home.back(Screen.DEMO, HOSTED, false, false, false, false));
        assertEquals(Back.DEMO_EXIT, Home.back(Screen.DEMO, HOSTED, false, true, true, false));
        assertEquals(Back.DEMO_EXIT, Home.back(Screen.DEMO, HOSTED, true, true, true, false));
        assertEquals(Back.DEMO_EXIT, Home.back(Screen.DEMO, BUNDLED_BUILD, false, false, false, false));
    }

    @Test
    public void backOnTheBundledPageOpenedOverAPcReturnsToThatPc() {
        // a pairing link from outside the app that the page refused, or an SSH setup cancelled, with a PC still current
        // and nobody choosing: the next screen is that PC, so that is where the way back says it leads
        assertEquals(Back.CURRENT, Home.back(Screen.BUNDLED, HOSTED, false, true, false, false));
        assertEquals(Back.CURRENT, Home.back(Screen.BUNDLED, HOSTED, true, true, false, false));
        assertEquals(Back.PAGE, Home.back(Screen.BUNDLED, HOSTED, false, true, false, true));
        // a build with the bundled first screen had no such control, and Back left the app
        assertEquals(Back.LEAVE, Home.back(Screen.BUNDLED, BUNDLED_BUILD, false, true, false, false));
    }

    @Test
    public void backOnAPcWithNothingBehindLeavesTheApp() {
        assertEquals(Back.LEAVE, Home.back(Screen.PC, HOSTED, false, false, false, false));
        assertEquals(Back.LEAVE, Home.back(Screen.PC, HOSTED, false, true, true, false));
    }

    private static final String APP = "https://app.ovis.sh";
    private static final String ID = "0123456789abcdef0123456789abcdef";

    @Test
    public void aRelayPcsPageIsAnyPageWithinAScopeOfTheHostedApp() {
        for (String page : new String[] {
            APP + "/s/" + ID + "/",
            APP + "/s/" + ID,
            APP + "/s/" + ID + "/#offer=eyJ2IjoxfQ",
            APP + "/s/" + ID + "/?pane=w1%3Ap1",
            APP + "/s/" + ID + "/index.html",
            "https://APP.ovis.sh:443/s/" + ID + "/",
        }) assertTrue(page, Home.relayPc(page, APP));
    }

    @Test
    public void theHostedAppsOwnPagesAndOtherOriginsAreNoRelayPc() {
        for (String page : new String[] {
            APP + "/",
            APP + "/#pcs",
            APP + "/#add",
            APP + "/s/",
            APP + "/s/not-a-pc/",
            APP + "/s/" + ID + "0/",
            APP + "/sx/" + ID + "/",
            APP + "/x/s/" + ID + "/",
            APP + "/s/" + ID + "/../" + ID + "/",
            APP + "/s/" + ID + "/%2e%2e/x",
            APP + "/s/" + ID.toUpperCase(java.util.Locale.ROOT) + "/",
            "http://app.ovis.sh/s/" + ID + "/",
            "https://app.ovis.sh:8443/s/" + ID + "/",
            "https://app.ovis.sh.evil.example/s/" + ID + "/",
            "https://localhost/s/" + ID + "/",
            "about:blank",
            "",
        }) assertFalse(page, Home.relayPc(page, APP));
        assertFalse(Home.relayPc(null, APP));
        assertFalse(Home.relayPc(APP + "/s/" + ID + "/", null));
        // a build for another hosted origin takes that origin and not the store's
        String preview = "https://relay-0510.ovis-app.pages.dev";
        assertTrue(Home.relayPc(preview + "/s/" + ID + "/", preview));
        assertFalse(Home.relayPc(APP + "/s/" + ID + "/", preview));
        // the origin as a browser compares it: scheme, host and port, the scheme's own port the same as none
        String local = "http://127.0.0.1:18596";
        assertTrue(Home.relayPc(local + "/s/" + ID + "/", local));
        assertFalse(Home.relayPc("http://127.0.0.1/s/" + ID + "/", local));
        assertFalse(Home.relayPc("https://127.0.0.1:18596/s/" + ID + "/", local));
    }

    @Test
    public void theAddressDemoTypedIntoTheHostedScreenIsTheBundledDemo() {
        // the hosted screen reads a bare word as an https name: what "demo" becomes there, and nothing else
        for (String typed : new String[] { "https://demo", "https://demo/", "https://DEMO/" }) assertTrue(typed, Home.demoAddress(typed));
        for (String other : new String[] {
            "http://demo/", "https://demo:7317/", "https://demo/x", "https://demo/?pair=123456", "https://demo/#offer=x",
            "https://demo.example.com/", "https://my-demo/", "https://demo.ts.net/", "demo", "", "https://",
        }) assertFalse(other, Home.demoAddress(other));
        assertFalse(Home.demoAddress(null));
    }

    @Test
    public void homeIsUpOnlyOnceTheHostedShellDrewItsOwnScreen() {
        // drawn(shell, root, boot, children, loading): the hosted app's page says what it is (<meta name="ovis-shell">,
        // which the released front page and the next both carry) and its root holds what it rendered
        assertTrue(Home.drawn(true, true, false, 1, false));
        assertTrue(Home.drawn(true, true, false, 3, false));
        // index.html's own loading spinner, before the client ran
        assertFalse(Home.drawn(true, true, true, 1, false));
        // an empty answer, or a maintenance page of the same origin: a 200 that is not the hosted app
        assertFalse(Home.drawn(false, false, false, 0, false));
        assertFalse(Home.drawn(false, true, false, 2, false));
        // the shell's page with nothing in its root (its script failed to run)
        assertFalse(Home.drawn(true, true, false, 0, false));
        assertFalse(Home.drawn(true, false, false, 0, false));
        assertFalse(Home.drawn(true, true, false, 1, true));
    }

    @Test
    public void theHostedAppsFrontPageOpensAsHomeWithItsFragmentKept() {
        // homeStart(url, appOrigin): what the app's own page opens for a sign-in or the saved Ovis row
        assertEquals("#sign-in=github", Home.homeStart(APP + "/#sign-in=github", APP));
        assertEquals("#sign-in=google", Home.homeStart("https://APP.ovis.sh:443/#sign-in=google", APP));
        assertEquals("#pcs", Home.homeStart(APP + "/#pcs", APP));
        assertEquals("#pcs", Home.homeStart(APP + "/", APP));
        assertEquals("#pcs", Home.homeStart(APP, APP));
        String preview = "https://relay-0510.ovis-app.pages.dev";
        assertEquals("#sign-in=apple", Home.homeStart(preview + "/#sign-in=apple", preview));
    }

    @Test
    public void aPcsPageAPairingLinkOrAnotherOriginIsNoHomeAttempt() {
        for (String other : new String[] {
            APP + "/s/" + ID + "/",
            APP + "/s/" + ID + "/#offer=eyJ2IjoxfQ",
            APP + "/s/" + ID + "/#sign-in=github",
            APP + "/#offer=eyJ2IjoxfQ",
            APP + "/#add",
            APP + "/#sign-in=GitHub",
            APP + "/#sign-in=",
            APP + "/#sign-in=github&x=1",
            APP + "/?pair=123456",
            APP + "/?x=1#pcs",
            APP + "/index.html",
            "http://app.ovis.sh/#pcs",
            "https://app.ovis.sh:8443/#pcs",
            "https://pc.tail1234.ts.net/#pcs",
            "http://100.64.0.1:7317/",
            "not an address",
            "",
        }) assertEquals(other, null, Home.homeStart(other, APP));
        assertEquals(null, Home.homeStart(null, APP));
        assertEquals(null, Home.homeStart(APP + "/#pcs", null));
    }

    @Test
    public void aRelayPcsScopeIsWhatItIsRememberedBy() {
        String scope = APP + "/s/" + ID + "/";
        assertEquals(scope, Home.relayScope(APP + "/s/" + ID + "/", APP));
        assertEquals(scope, Home.relayScope(APP + "/s/" + ID, APP));
        assertEquals(scope, Home.relayScope("https://APP.ovis.sh:443/s/" + ID + "/?pane=w1%3Ap1#x", APP));
        assertEquals(scope, Home.relayScope(APP + "/s/" + ID + "/index.html", APP));
        assertEquals(null, Home.relayScope(APP + "/", APP));
        assertEquals(null, Home.relayScope(APP + "/s/" + ID + "/../" + ID + "/", APP));
        assertEquals(null, Home.relayScope("https://other.example/s/" + ID + "/", APP));
    }

    @Test
    public void aPcIsOnScreenOnlyWhereItsOwnPageIs() {
        // pcShown(screen, phase): whose push subscription a page may read, and where an SSH tunnel's failure may show
        assertTrue(Home.pcShown(Screen.PC, null));
        assertTrue(Home.pcShown(Screen.HOME, Phase.PC));
        for (Phase phase : new Phase[] { Phase.LOADING, Phase.SHOWN, Phase.FALLBACK, Phase.LEFT }) assertFalse(phase.name(), Home.pcShown(Screen.HOME, phase));
        assertFalse(Home.pcShown(Screen.BUNDLED, null));
        assertFalse(Home.pcShown(Screen.DEMO, null));
    }

    @Test
    public void onlyTimeInFrontCountsAgainstHome() {
        Home.Clock clock = new Home.Clock(1_000);
        assertEquals(0, clock.tick(1_000));
        for (long now = 2_000; now <= 8_000; now += 1_000) assertEquals(now - 1_000, clock.tick(now));
        assertEquals(7_400, clock.tick(8_400));
        // away for a minute: none of it counts, and the look that follows the return adds only what passed since
        clock.resumed(68_400);
        assertEquals(7_400, clock.tick(68_400));
        assertEquals(7_900, clock.tick(68_900));
        assertFalse(Home.timedOut(clock.tick(68_950), false));
        assertTrue(Home.timedOut(clock.tick(69_000), false));
    }

    @Test
    public void nothingCountsWhileTheAppIsAwayEvenIfItsTimerStillRuns() {
        Home.Clock clock = new Home.Clock(0);
        for (long now = 1_000; now <= 5_000; now += 1_000) clock.tick(now);
        clock.away(5_000);
        assertEquals(5_000, clock.tick(5_500));
        assertEquals(5_000, clock.tick(20_000));
        assertFalse(Home.timedOut(clock.tick(35_000), false));
        clock.resumed(35_000);
        assertEquals(5_500, clock.tick(35_500));
        for (long now = 36_000; now <= 37_500; now += 500) clock.tick(now);
        assertFalse(Home.timedOut(clock.tick(37_900), false));
        assertTrue(Home.timedOut(clock.tick(38_000), false));
    }

    @Test
    public void aLookThatComesLateWithoutAReturnCountsAsOneLookAtMost() {
        // the timer held up, with no word that the app was away: a second at most, never the whole gap
        Home.Clock clock = new Home.Clock(0);
        assertEquals(1_000, clock.tick(1_000));
        assertEquals(2_000, clock.tick(31_000));
        assertEquals(2_500, clock.tick(31_500));
    }

    @Test
    public void whatOnlyTheBundledPageTakesIsHeldInMemoryUntilHomeIsAskedForAgain() {
        PCStore.goHome();
        assertFalse(PCStore.bundledAsked());
        PCStore.link = APP + "/s/" + ID + "/#offer=x";
        assertTrue(PCStore.bundledAsked());
        PCStore.link = null;
        // Change PC where an SSH PC did not open: Manage lives on the app's own page
        PCStore.manage = true;
        assertTrue(PCStore.bundledAsked());
        PCStore.manage = false;
        PCStore.fail("127.0.0.2:47317: taken", "ssh-port");
        assertTrue(PCStore.bundledAsked());
        // another failure of an SSH PC is the error page's to say, not a reason to keep the app's own page up
        PCStore.fail("auth: refused", "ssh-auth");
        assertFalse(PCStore.bundledAsked());
        PCStore.fail("127.0.0.2:47317: taken", "ssh-port");
        PCStore.manage = true;
        PCStore.homeFailed = true;
        PCStore.demo = true;
        PCStore.homeStart = "#sign-in=github";
        PCStore.goHome();
        assertFalse(PCStore.bundledAsked());
        assertFalse(PCStore.homeFailed);
        assertFalse(PCStore.demo);
        assertEquals(null, PCStore.homeStart);
        assertEquals(null, PCStore.failureKind);
    }

    @Test
    public void whatThePageSaysOfItselfIsReadStrictly() {
        assertTrue(Home.drawn("{\"shell\":true,\"root\":true,\"boot\":false,\"children\":2,\"loading\":false}"));
        assertFalse(Home.drawn("{\"shell\":true,\"root\":true,\"boot\":true,\"children\":1,\"loading\":false}"));
        assertFalse(Home.drawn("{\"shell\":false,\"root\":false,\"boot\":false,\"children\":0,\"loading\":false}"));
        assertFalse(Home.drawn("{\"shell\":true,\"root\":true}"));
        assertFalse(Home.drawn("true"));
        assertFalse(Home.drawn(""));
        assertFalse(Home.drawn((String) null));
    }

    @Test
    public void theWordDemoIsTheDemoOnlyOnHome() {
        assertTrue(Home.opensDemo("https://demo/", true));
        // a bundled build, or a PC's page: that address is a PC's, as it always was
        assertFalse(Home.opensDemo("https://demo/", false));
        assertFalse(Home.opensDemo("https://demo.example.com/", true));
    }
}
