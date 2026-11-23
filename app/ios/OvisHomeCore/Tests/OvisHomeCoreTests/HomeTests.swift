import XCTest
@testable import OvisHomeCore

final class HomeTests: XCTestCase {
    private let hosted = true, bundledBuild = false

    func testTheErrorPageHearsThatThisPhoneIsOfflineOnlyFromTheSystem() {
        XCTAssertEqual(Home.failureKind(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet), "offline")
        for code in [NSURLErrorCannotFindHost, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorSecureConnectionFailed] {
            XCTAssertNil(Home.failureKind(domain: NSURLErrorDomain, code: code), "\(code)")
        }
        XCTAssertNil(Home.failureKind(domain: "WebKitErrorDomain", code: NSURLErrorNotConnectedToInternet))
    }

    func testASavedPcOpensDirectlyWhateverElseHolds() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: false, failed: false), .pc)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: false, failed: true), .pc)
        // an SSH PC's failure left over from an earlier open is no reason to keep another PC from opening
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: false, asked: true, failed: false), .pc)
        XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: true, demo: false, asked: false, failed: false), .pc)
    }

    func testWithNoPcToOpenTheHostedScreenIsHome() {
        // first launch, after Forget or disconnect, and choosing another PC (the caller passes no PC while choosing)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: false, failed: false), .home)
    }

    func testTheBundledPageStandsInOnceHomeFailedUntilItIsTriedAgain() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: false, failed: true), .bundled)
    }

    func testTheBundledPageTakesWhatOnlyItCanTake() {
        // an SSH setup a page asked for, an SSH PC it has to say could not open
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: true, failed: false), .bundled)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: false, asked: true, failed: true), .bundled)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: true, failed: false), .bundled)
    }

    func testTheDemoAskedForOpensOverAnythingElse() {
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: false, failed: false), .demo)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: true, demo: true, asked: false, failed: false), .demo)
        XCTAssertEqual(Home.screen(hosted: hosted, pc: false, demo: true, asked: false, failed: true), .demo)
        XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: false, demo: true, asked: false, failed: false), .demo)
    }

    func testABuildWithTheBundledFirstScreenNeverOpensHome() {
        for asked in [false, true] {
            for failed in [false, true] {
                XCTAssertEqual(Home.screen(hosted: bundledBuild, pc: false, demo: false, asked: asked, failed: failed), .bundled)
            }
        }
    }

    func testHomeThatLoadsLiftsItsCoverOnce() {
        XCTAssertEqual(Home.on(.loading, .loaded), .liftCover)
        XCTAssertEqual(Home.after(.loading, .loaded), .shown)
        XCTAssertEqual(Home.on(.shown, .loaded), .none)
        XCTAssertEqual(Home.after(.shown, .loaded), .shown)
    }

    func testHomeThatFailsOrTakesTooLongGivesWayToTheBundledPage() {
        XCTAssertEqual(Home.on(.loading, .failed), .fallBack)
        XCTAssertEqual(Home.on(.loading, .timedOut), .fallBack)
        XCTAssertEqual(Home.after(.loading, .failed), .fallback)
        XCTAssertEqual(Home.after(.loading, .timedOut), .fallback)
    }

    func testAPageOfHomeThatFailsLaterGivesWayTooButTheClockNoLongerCounts() {
        // a PC's row pressed with the network gone: the page left behind is no screen to stay on
        XCTAssertEqual(Home.on(.shown, .failed), .fallBack)
        XCTAssertEqual(Home.after(.shown, .failed), .fallback)
        XCTAssertEqual(Home.on(.shown, .timedOut), .none)
        XCTAssertEqual(Home.after(.shown, .timedOut), .shown)
    }

    func testNothingThatComesAfterTheFallbackMovesThePersonAgain() {
        // a load that still finishes, fails once more or runs into the clock: the bundled page is up, with what was typed
        for event in Home.Event.allCases {
            XCTAssertEqual(Home.on(.fallback, event), .none, "\(event)")
            XCTAssertEqual(Home.after(.fallback, event), .fallback, "\(event)")
        }
    }

    func testArrivingAtARelayPcMakesTheHostedAppThePc() {
        for phase in [Home.Phase.loading, .shown] {
            XCTAssertEqual(Home.on(phase, .relayPc), .keepHosted, "\(phase)")
            XCTAssertEqual(Home.after(phase, .relayPc), .pc, "\(phase)")
        }
    }

    func testOnceTheAppLeavesHomeNothingOfItCountsAnyMore() {
        // a PC picked, Try again, another screen: the page still up has a moment before it goes, in which a relay PC's
        // page landing must not make the hosted app the PC over the one just written
        for phase in [Home.Phase.loading, .shown] {
            XCTAssertEqual(Home.on(phase, .left), .none, "\(phase)")
            XCTAssertEqual(Home.after(phase, .left), .left, "\(phase)")
        }
        for event in Home.Event.allCases {
            XCTAssertEqual(Home.on(.left, event), .none, "\(event)")
            XCTAssertEqual(Home.after(.left, event), .left, "\(event)")
        }
        XCTAssertEqual(Home.after(.pc, .left), .pc)
        XCTAssertEqual(Home.after(.fallback, .left), .fallback)
    }

    func testAWebContentProcessThatDiedGetsOneFreshTimedAttemptThenTheFallback() {
        // WebKit reloads a dead page by itself, with nothing timing it: home starts over, cover and clock, once
        for phase in [Home.Phase.loading, .shown] {
            XCTAssertEqual(Home.on(phase, .died), .retry, "\(phase)")
            XCTAssertEqual(Home.after(phase, .died), .left, "\(phase)")
            // it died again before home came up: the app's own page, so this cannot go round
            XCTAssertEqual(Home.on(phase, .died, retried: true), .fallBack, "\(phase)")
            XCTAssertEqual(Home.after(phase, .died, retried: true), .fallback, "\(phase)")
        }
        // a relay PC's page is a PC's: Capacitor's own reload, as for any PC
        XCTAssertEqual(Home.on(.pc, .died), .none)
        XCTAssertEqual(Home.on(.fallback, .died), .none)
    }

    func testWhatTheWebViewReportsBecomesTheEventHomeActsOn() {
        // event(for:): the navigation delegate's callbacks, as HerdrBridgeViewController hands them over
        XCTAssertEqual(Home.event(for: .provisionalFailed(onPurpose: false)), .failed)
        XCTAssertEqual(Home.event(for: .failed(onPurpose: false)), .failed)
        XCTAssertEqual(Home.event(for: .httpError), .failed)
        XCTAssertEqual(Home.event(for: .redirectedElsewhere), .failed)
        XCTAssertEqual(Home.event(for: .processDied), .died)
        // a load cancelled on purpose (a new navigation, a link handed to Safari) is no failure
        XCTAssertNil(Home.event(for: .provisionalFailed(onPurpose: true)))
        XCTAssertNil(Home.event(for: .failed(onPurpose: true)))
    }

    func testADocumentThatBreaksOffAfterHomeWasUpStillGivesWay() {
        // home finished, then another page of it committed and its connection broke (WebKit's didFail): the first
        // page having finished long ago is no reason to keep half a page on screen
        let event = Home.event(for: .failed(onPurpose: false))
        XCTAssertEqual(event.map { Home.on(.shown, $0) }, .fallBack)
        XCTAssertEqual(event.map { Home.after(.shown, $0) }, .fallback)
        XCTAssertEqual(event.map { Home.on(.loading, $0) }, .fallBack)
        // once a relay PC's page is up, the PC's own error page says it
        XCTAssertEqual(event.map { Home.on(.pc, $0) }, Home.Action.none)
    }

    func testOnceARelayPcIsUpThePcsOwnRulesDecide() {
        for event in Home.Event.allCases {
            XCTAssertEqual(Home.on(.pc, event), .none, "\(event)")
            XCTAssertEqual(Home.after(.pc, event), .pc, "\(event)")
        }
    }

    func testTheClockRunsOutAtEightSecondsWithNoAnswer() {
        XCTAssertFalse(Home.timedOut(elapsed: 7.999, answered: false))
        XCTAssertTrue(Home.timedOut(elapsed: 8, answered: false))
    }

    func testAPageThatAnsweredGetsAsLongAsAPcDoesToAnswer() {
        // the hosted page is on its way over a slow link: cut off at eight seconds, its script would never finish arriving
        XCTAssertFalse(Home.timedOut(elapsed: 8, answered: true))
        XCTAssertFalse(Home.timedOut(elapsed: Home.answerSeconds - 0.001, answered: true))
        XCTAssertTrue(Home.timedOut(elapsed: Home.answerSeconds, answered: true))
        XCTAssertEqual(Home.answerSeconds, 20)
    }

    func testBackGoesThroughThePagesOwnHistoryFirstAtHome() {
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, current: true, choosing: true, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: true), .page)
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackAtHomeWithNothingBehindReturnsToThePcItWasOpenedFrom() {
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, current: true, choosing: true, pageHasBack: false), .current)
        // no PC to go back to: nowhere (on Android the system's Back, which leaves the app)
        XCTAssertEqual(Home.back(screen: .home, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: false), .leave)
    }

    func testBackOnTheBundledPageWhileChoosingReturnsToThePcAtOnceAsBefore() {
        for build in [hosted, bundledBuild] {
            for failed in [false, true] {
                for pageHasBack in [false, true] {
                    XCTAssertEqual(Home.back(screen: .bundled, hosted: build, failed: failed, current: true, choosing: true, pageHasBack: pageHasBack), .current)
                }
            }
        }
    }

    func testBackOnTheFallbackLeadsNowhereRatherThanTryHomeAgain() {
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: true, current: false, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: true, current: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackOnTheBundledPageHomeHandedOverToReturnsHome() {
        // the SSH setup took the person off home: this is the way back to it
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: false), .home)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackOnTheBundledFirstScreenLeadsNowhereAsBefore() {
        XCTAssertEqual(Home.back(screen: .bundled, hosted: bundledBuild, failed: false, current: false, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: bundledBuild, failed: false, current: false, choosing: false, pageHasBack: true), .page)
    }

    func testBackFromTheDemoLeavesTheDemoForTheScreenItWasOpenedOver() {
        // whatever opens without it, home, the fallback or a build's own first screen, with the current PC and
        // choosing as they were
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: false), .demoExit)
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: false, current: true, choosing: true, pageHasBack: false), .demoExit)
        XCTAssertEqual(Home.back(screen: .demo, hosted: hosted, failed: true, current: true, choosing: true, pageHasBack: false), .demoExit)
        XCTAssertEqual(Home.back(screen: .demo, hosted: bundledBuild, failed: false, current: false, choosing: false, pageHasBack: false), .demoExit)
    }

    func testBackOnTheBundledPageOpenedOverAPcReturnsToThatPc() {
        // an SSH setup cancelled with a PC still current and nobody choosing: the next screen is that PC, so that is
        // where the way back says it leads
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, current: true, choosing: false, pageHasBack: false), .current)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: true, current: true, choosing: false, pageHasBack: false), .current)
        XCTAssertEqual(Home.back(screen: .bundled, hosted: hosted, failed: false, current: true, choosing: false, pageHasBack: true), .page)
        // a build with the bundled first screen had no such control
        XCTAssertEqual(Home.back(screen: .bundled, hosted: bundledBuild, failed: false, current: true, choosing: false, pageHasBack: false), .leave)
    }

    func testBackOnAPcWithNothingBehindLeadsNowhere() {
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, current: false, choosing: false, pageHasBack: false), .leave)
        XCTAssertEqual(Home.back(screen: .pc, hosted: hosted, failed: false, current: true, choosing: true, pageHasBack: false), .leave)
    }

    private let app = URL(string: "https://app.ovis.sh")!
    private let id = "0123456789abcdef0123456789abcdef"

    func testARelayPcsPageIsAnyPageWithinAScopeOfTheHostedApp() {
        for page in [
            "https://app.ovis.sh/s/\(id)/",
            "https://app.ovis.sh/s/\(id)",
            "https://app.ovis.sh/s/\(id)/#offer=eyJ2IjoxfQ",
            "https://app.ovis.sh/s/\(id)/?pane=w1%3Ap1",
            "https://app.ovis.sh/s/\(id)/index.html",
            "https://APP.ovis.sh:443/s/\(id)/"
        ] {
            XCTAssertTrue(Home.relayPc(URL(string: page), appOrigin: app), page)
        }
    }

    func testTheHostedAppsOwnPagesAndOtherOriginsAreNoRelayPc() {
        for page in [
            "https://app.ovis.sh/",
            "https://app.ovis.sh/#pcs",
            "https://app.ovis.sh/#add",
            "https://app.ovis.sh/s/",
            "https://app.ovis.sh/s/not-a-pc/",
            "https://app.ovis.sh/s/\(id)0/",
            "https://app.ovis.sh/sx/\(id)/",
            "https://app.ovis.sh/x/s/\(id)/",
            "https://app.ovis.sh/s/\(id)/../\(id)/",
            "https://app.ovis.sh/s/\(id)/%2e%2e/x",
            "https://app.ovis.sh/s/\(id.uppercased())/",
            "http://app.ovis.sh/s/\(id)/",
            "https://app.ovis.sh:8443/s/\(id)/",
            "https://app.ovis.sh.evil.example/s/\(id)/",
            "capacitor://localhost/s/\(id)/",
            "about:blank"
        ] {
            XCTAssertFalse(Home.relayPc(URL(string: page), appOrigin: app), page)
        }
        XCTAssertFalse(Home.relayPc(nil, appOrigin: app))
        XCTAssertFalse(Home.relayPc(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: nil))
        // a build for another hosted origin takes that origin and not the store's
        let preview = URL(string: "https://relay-0510.ovis-app.pages.dev")!
        XCTAssertTrue(Home.relayPc(URL(string: "https://relay-0510.ovis-app.pages.dev/s/\(id)/"), appOrigin: preview))
        XCTAssertFalse(Home.relayPc(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: preview))
        // the origin as a browser compares it: scheme, host and port, the scheme's own port the same as none
        let local = URL(string: "http://127.0.0.1:18596")!
        XCTAssertTrue(Home.relayPc(URL(string: "http://127.0.0.1:18596/s/\(id)/"), appOrigin: local))
        XCTAssertFalse(Home.relayPc(URL(string: "http://127.0.0.1/s/\(id)/"), appOrigin: local))
        XCTAssertFalse(Home.relayPc(URL(string: "https://127.0.0.1:18596/s/\(id)/"), appOrigin: local))
    }

    func testTheAddressDemoTypedIntoTheHostedScreenIsTheBundledDemo() {
        // the hosted screen reads a bare word as an https name: what "demo" becomes there, and nothing else
        for typed in ["https://demo", "https://demo/", "https://DEMO/"] {
            XCTAssertTrue(Home.demoAddress(typed), typed)
        }
        for other in [
            "http://demo/", "https://demo:7317/", "https://demo/x", "https://demo/?pair=123456", "https://demo/#offer=x",
            "https://demo.example.com/", "https://my-demo/", "https://demo.ts.net/", "demo", "", "https://"
        ] {
            XCTAssertFalse(Home.demoAddress(other), other)
        }
        XCTAssertFalse(Home.demoAddress(nil))
    }

    func testHomeIsUpOnlyOnceTheHostedShellDrewItsOwnScreen() {
        // the hosted app's page says what it is (<meta name="ovis-shell">, which the released front page and the
        // next both carry) and its root holds what it rendered
        XCTAssertTrue(Home.drawn(shell: true, root: true, boot: false, children: 1, loading: false))
        XCTAssertTrue(Home.drawn(shell: true, root: true, boot: false, children: 3, loading: false))
        // index.html's own loading spinner, before the client ran
        XCTAssertFalse(Home.drawn(shell: true, root: true, boot: true, children: 1, loading: false))
        // an empty answer, or a maintenance page of the same origin: a 200 that is not the hosted app
        XCTAssertFalse(Home.drawn(shell: false, root: false, boot: false, children: 0, loading: false))
        XCTAssertFalse(Home.drawn(shell: false, root: true, boot: false, children: 2, loading: false))
        // the shell's page with nothing in its root (its script failed to run)
        XCTAssertFalse(Home.drawn(shell: true, root: true, boot: false, children: 0, loading: false))
        XCTAssertFalse(Home.drawn(shell: true, root: false, boot: false, children: 0, loading: false))
        XCTAssertFalse(Home.drawn(shell: true, root: true, boot: false, children: 1, loading: true))
    }

    func testWhatThePageSaysOfItselfIsReadStrictly() {
        // drawn(page:): the JSON the page's facts come back as; anything unreadable is not home
        XCTAssertTrue(Home.drawn(page: #"{"shell":true,"root":true,"boot":false,"children":2,"loading":false}"#))
        XCTAssertFalse(Home.drawn(page: #"{"shell":true,"root":true,"boot":true,"children":1,"loading":false}"#))
        XCTAssertFalse(Home.drawn(page: #"{"shell":false,"root":false,"boot":false,"children":0,"loading":false}"#))
        XCTAssertFalse(Home.drawn(page: #"{"shell":true,"root":true}"#))
        XCTAssertFalse(Home.drawn(page: "true"))
        XCTAssertFalse(Home.drawn(page: ""))
        XCTAssertFalse(Home.drawn(page: nil))
    }

    func testTheHostedAppsFrontPageOpensAsHomeWithItsFragmentKept() {
        XCTAssertEqual(Home.homeStart("https://app.ovis.sh/#sign-in=github", appOrigin: app), "#sign-in=github")
        XCTAssertEqual(Home.homeStart("https://APP.ovis.sh:443/#sign-in=google", appOrigin: app), "#sign-in=google")
        XCTAssertEqual(Home.homeStart("https://app.ovis.sh/#pcs", appOrigin: app), "#pcs")
        XCTAssertEqual(Home.homeStart("https://app.ovis.sh/", appOrigin: app), "#pcs")
        XCTAssertEqual(Home.homeStart("https://app.ovis.sh", appOrigin: app), "#pcs")
        let preview = URL(string: "https://relay-0510.ovis-app.pages.dev")!
        XCTAssertEqual(Home.homeStart("https://relay-0510.ovis-app.pages.dev/#sign-in=apple", appOrigin: preview), "#sign-in=apple")
    }

    func testAPcsPageAPairingLinkOrAnotherOriginIsNoHomeAttempt() {
        for other in [
            "https://app.ovis.sh/s/\(id)/",
            "https://app.ovis.sh/s/\(id)/#offer=eyJ2IjoxfQ",
            "https://app.ovis.sh/s/\(id)/#sign-in=github",
            "https://app.ovis.sh/#offer=eyJ2IjoxfQ",
            "https://app.ovis.sh/#add",
            "https://app.ovis.sh/#sign-in=GitHub",
            "https://app.ovis.sh/#sign-in=",
            "https://app.ovis.sh/#sign-in=github&x=1",
            "https://app.ovis.sh/?pair=123456",
            "https://app.ovis.sh/?x=1#pcs",
            "https://app.ovis.sh/index.html",
            "http://app.ovis.sh/#pcs",
            "https://app.ovis.sh:8443/#pcs",
            "https://pc.tail1234.ts.net/#pcs",
            "http://100.64.0.1:7317/",
            "not an address",
            ""
        ] {
            XCTAssertNil(Home.homeStart(other, appOrigin: app), other)
        }
        XCTAssertNil(Home.homeStart(nil, appOrigin: app))
        XCTAssertNil(Home.homeStart("https://app.ovis.sh/#pcs", appOrigin: nil))
    }

    func testARelayPcsScopeIsWhatItIsRememberedBy() {
        let scope = "https://app.ovis.sh/s/\(id)/"
        XCTAssertEqual(Home.relayScope(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: app), scope)
        XCTAssertEqual(Home.relayScope(URL(string: "https://app.ovis.sh/s/\(id)"), appOrigin: app), scope)
        XCTAssertEqual(Home.relayScope(URL(string: "https://APP.ovis.sh:443/s/\(id)/?pane=w1%3Ap1#x"), appOrigin: app), scope)
        XCTAssertEqual(Home.relayScope(URL(string: "https://app.ovis.sh/s/\(id)/index.html"), appOrigin: app), scope)
        XCTAssertNil(Home.relayScope(URL(string: "https://app.ovis.sh/"), appOrigin: app))
        XCTAssertNil(Home.relayScope(URL(string: "https://app.ovis.sh/s/\(id)/../\(id)/"), appOrigin: app))
        XCTAssertNil(Home.relayScope(URL(string: "https://other.example/s/\(id)/"), appOrigin: app))
        // a hosted origin on a port of its own keeps it
        let local = URL(string: "http://127.0.0.1:18596")!
        XCTAssertEqual(Home.relayScope(URL(string: "http://127.0.0.1:18596/s/\(id)/x"), appOrigin: local), "http://127.0.0.1:18596/s/\(id)/")
    }

    func testAPcIsOnScreenOnlyWhereItsOwnPageIs() {
        // whose push subscription a page may read, and where an SSH tunnel's failure may show
        XCTAssertTrue(Home.pcShown(screen: .pc, phase: nil))
        XCTAssertTrue(Home.pcShown(screen: .home, phase: .pc))
        for phase in [Home.Phase.loading, .shown, .fallback, .left] {
            XCTAssertFalse(Home.pcShown(screen: .home, phase: phase), "\(phase)")
        }
        XCTAssertFalse(Home.pcShown(screen: .bundled, phase: nil))
        XCTAssertFalse(Home.pcShown(screen: .demo, phase: nil))
    }

    func testOnlyTimeInFrontCountsAgainstHome() {
        var clock = Home.Clock(now: 1)
        XCTAssertEqual(clock.tick(now: 1), 0)
        var now = 1.2
        while now < 8.35 {
            _ = clock.tick(now: now)
            now += 0.2
        }
        XCTAssertEqual(clock.tick(now: 8.4), 7.4, accuracy: 0.001)
        // away for a minute: none of it counts, and the look that follows the return adds only what passed since
        clock.resumed(now: 68.4)
        XCTAssertEqual(clock.tick(now: 68.4), 7.4, accuracy: 0.001)
        XCTAssertEqual(clock.tick(now: 68.9), 7.9, accuracy: 0.001)
        XCTAssertFalse(Home.timedOut(elapsed: clock.tick(now: 68.95), answered: false))
        XCTAssertTrue(Home.timedOut(elapsed: clock.tick(now: 69.05), answered: false))
    }

    func testNothingCountsWhileTheAppIsAwayEvenIfItsTimerStillRuns() {
        // iOS lets an app run on for a while behind another: its looks go on, and none of them may count
        var clock = Home.Clock(now: 0)
        var now = 0.2
        while now < 4.95 {
            _ = clock.tick(now: now)
            now += 0.2
        }
        clock.away(now: 5)
        XCTAssertEqual(clock.tick(now: 5.2), 5, accuracy: 0.001)
        XCTAssertEqual(clock.tick(now: 20), 5, accuracy: 0.001)
        XCTAssertFalse(Home.timedOut(elapsed: clock.tick(now: 35), answered: false))
        clock.resumed(now: 35)
        XCTAssertEqual(clock.tick(now: 35.2), 5.2, accuracy: 0.001)
        now = 35.4
        while now < 37.85 {
            clock.tick(now: now)
            now += 0.2
        }
        XCTAssertFalse(Home.timedOut(elapsed: clock.tick(now: 37.9), answered: false))
        XCTAssertTrue(Home.timedOut(elapsed: clock.tick(now: 38.05), answered: false))
    }

    func testALookThatComesLateWithoutAReturnCountsAsOneLookAtMost() {
        // the timer held up, with no word that the app was away: a second at most, never the whole gap
        var clock = Home.Clock(now: 0)
        XCTAssertEqual(clock.tick(now: 1), 1, accuracy: 0.001)
        XCTAssertEqual(clock.tick(now: 31), 2, accuracy: 0.001)
        XCTAssertEqual(clock.tick(now: 31.5), 2.5, accuracy: 0.001)
    }

    func testTheWordDemoIsTheDemoOnlyOnHome() {
        XCTAssertTrue(Home.demoAddress("https://demo/"))
        // which screens take it is the caller's: asked through `opensDemo`
        XCTAssertTrue(Home.opensDemo("https://demo/", atHome: true))
        XCTAssertFalse(Home.opensDemo("https://demo/", atHome: false))
        XCTAssertFalse(Home.opensDemo("https://demo.example.com/", atHome: true))
    }

    func testTheAppsOwnPageThatNeverCameUpIsBuiltAgain() {
        // its files are in the app, so it is up in well under a second; a web view whose content process never ran it
        // (seen after the hosted screen was given up on a starved simulator) stays dark for good unless it is replaced
        XCTAssertFalse(Home.ownPageStalled(elapsed: 5.9, loaded: false, tries: 0))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 6, loaded: false, tries: 0))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 60, loaded: false, tries: 0))
        // a page that came up is never taken from under the person, however long ago
        XCTAssertFalse(Home.ownPageStalled(elapsed: 6, loaded: true, tries: 0))
        XCTAssertFalse(Home.ownPageStalled(elapsed: 3600, loaded: true, tries: 3))
    }

    func testEachRebuildOfTheAppsOwnPageGetsMoreRoom() {
        // a phone that is only slow gets its page on a later try, where a fixed limit would rebuild it for ever
        XCTAssertFalse(Home.ownPageStalled(elapsed: 11.9, loaded: false, tries: 1))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 12, loaded: false, tries: 1))
        XCTAssertFalse(Home.ownPageStalled(elapsed: 23.9, loaded: false, tries: 2))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 24, loaded: false, tries: 2))
        // and no more than 48 seconds between tries, however many there were
        XCTAssertFalse(Home.ownPageStalled(elapsed: 47.9, loaded: false, tries: 3))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 48, loaded: false, tries: 3))
        XCTAssertTrue(Home.ownPageStalled(elapsed: 48, loaded: false, tries: 40))
    }

    func testAPageSpeaksOnlyForTheSavedPcItIs() {
        let app = URL(string: "https://app.ovis.sh"), id = "0123456789abcdef0123456789abcdef"
        let mac = "https://macbookpro.tail1e211e.ts.net:17317"
        XCTAssertEqual(Home.identifiedKey(URL(string: mac + "/?pane=w1%3Ap1"), current: mac, appOrigin: app), mac)
        XCTAssertEqual(Home.identifiedKey(URL(string: "https://MACBOOKPRO.tail1e211e.ts.net:17317/"), current: mac, appOrigin: app), mac)
        XCTAssertEqual(Home.identifiedKey(URL(string: "http://127.0.0.1:47320/"), current: "http://127.0.0.1:47320", appOrigin: app), "http://127.0.0.1:47320")
        // a scheme's own port written out or not is one origin; another port is another
        XCTAssertEqual(Home.identifiedKey(URL(string: "https://pc.example/"), current: "https://pc.example:443", appOrigin: app), "https://pc.example:443")
        XCTAssertEqual(Home.identifiedKey(URL(string: "https://pc.example:443/"), current: "https://pc.example", appOrigin: app), "https://pc.example")
        XCTAssertEqual(Home.identifiedKey(URL(string: "http://pc/"), current: "http://pc:80", appOrigin: app), "http://pc:80")
        XCTAssertNil(Home.identifiedKey(URL(string: "https://pc.example:8443/"), current: "https://pc.example", appOrigin: app))
        // a page that went to another origin, another PC's, or none shown
        XCTAssertNil(Home.identifiedKey(URL(string: "https://evil.example/"), current: mac, appOrigin: app))
        XCTAssertNil(Home.identifiedKey(URL(string: "https://desk.tail1e211e.ts.net/"), current: mac, appOrigin: app))
        XCTAssertNil(Home.identifiedKey(URL(string: mac + "/"), current: nil, appOrigin: app))
        XCTAssertNil(Home.identifiedKey(nil, current: mac, appOrigin: app))
        // the hosted app and a relay PC's scope there: their path names them already
        XCTAssertNil(Home.identifiedKey(URL(string: "https://app.ovis.sh/"), current: "https://app.ovis.sh", appOrigin: app))
        XCTAssertNil(Home.identifiedKey(URL(string: "https://app.ovis.sh/s/\(id)/"), current: "https://app.ovis.sh/s/\(id)/", appOrigin: app))
    }

    func testWhatAPageSaysOfItselfIsKeptForItsOwnPcAlone() {
        let id = "0123456789abcdef0123456789abcdef", mac = "https://macbookpro.tail1e211e.ts.net:17317", nas = "http://192.168.0.5:7317"
        var kept = Home.identified(ids: [:], names: [nas: "home-nas"], key: mac, serverId: id, name: "hasang-uui-MacBookPro")
        kept = Home.identified(ids: kept.ids, names: kept.names, key: nas, serverId: "not-an-id", name: "nas-7")
        XCTAssertEqual(kept.ids, [mac: id])
        // a name the person or an open gave stays
        XCTAssertEqual(kept.names, [mac: "hasang-uui-MacBookPro", nas: "home-nas"])
        XCTAssertNil(Home.relayId("0123456789ABCDEF0123456789ABCDEF"))
        XCTAssertNil(Home.relayId(nil))
        // its health read names no relay ID now: the one kept goes, so the address no longer joins that PC's row
        kept = Home.identified(ids: kept.ids, names: kept.names, key: mac, serverId: "", name: nil)
        XCTAssertEqual(kept.ids, [:])
        XCTAssertEqual(kept.names[mac], "hasang-uui-MacBookPro")
    }

    func testANameIsCappedByWholeCharacters() {
        let letters = String(repeating: "a", count: 63)
        let pair = Home.identified(ids: [:], names: [:], key: "k", serverId: nil, name: letters + "\u{1F4BB}b")
        XCTAssertEqual(pair.names["k"], letters + "\u{1F4BB}")
        let combining = Home.identified(ids: [:], names: [:], key: "k", serverId: nil, name: letters + "e\u{0301}b")
        XCTAssertEqual(combining.names["k"], letters + "e\u{0301}")
    }

    func testOnlyTheAppsOwnPagesAreToldTheSavedPcsIds() {
        let app = URL(string: "https://app.ovis.sh"), id = "0123456789abcdef0123456789abcdef"
        XCTAssertTrue(Home.ownPage(URL(string: "capacitor://localhost/index.html"), appOrigin: app))
        XCTAssertTrue(Home.ownPage(URL(string: "https://app.ovis.sh/#pcs"), appOrigin: app))
        XCTAssertTrue(Home.ownPage(URL(string: "https://app.ovis.sh/s/\(id)/#add"), appOrigin: app))
        XCTAssertFalse(Home.ownPage(URL(string: "https://macbookpro.tail1e211e.ts.net:17317/"), appOrigin: app))
        XCTAssertFalse(Home.ownPage(nil, appOrigin: app))
        XCTAssertEqual(Home.shownIds(URL(string: "https://app.ovis.sh/#pcs"), appOrigin: app, ids: ["k": id]), ["k": id])
        XCTAssertNil(Home.shownIds(URL(string: "https://macbookpro.tail1e211e.ts.net:17317/"), appOrigin: app, ids: ["k": id]))
    }

    func testTheAppsOwnPageNeverLeavesADarkScreenWithNothingOnIt() {
        // normally the page is there before anything could be drawn over it: no cover flashes
        XCTAssertFalse(Home.ownPageCover(elapsed: 0, loaded: false, tries: 0))
        XCTAssertFalse(Home.ownPageCover(elapsed: 1.4, loaded: false, tries: 0))
        // slow: the cover says the app is opening, with Try again, where the web view shows nothing
        XCTAssertTrue(Home.ownPageCover(elapsed: 1.5, loaded: false, tries: 0))
        // built again: the cover stays from the first moment, so the screen is never empty in between
        XCTAssertTrue(Home.ownPageCover(elapsed: 0, loaded: false, tries: 1))
        XCTAssertFalse(Home.ownPageCover(elapsed: 1.5, loaded: true, tries: 0))
        XCTAssertFalse(Home.ownPageCover(elapsed: 0, loaded: true, tries: 2))
    }
}
