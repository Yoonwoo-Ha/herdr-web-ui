import XCTest
@testable import OvisHomeCore

/// What the review threads on the shell inside the app came down to, each as its decision.
final class ThreadTests: XCTestCase {
    func testARenderPolicyThatLeavesAPageItsOriginIsNoPolicy() {
        let page = "default-src 'self'"
        let read = { (render: String) in ShellRoute.policies(try? JSONSerialization.data(withJSONObject: ["page": page, "render": render])) }
        // what the build writes today
        XCTAssertEqual(read("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data:")?.render.hasPrefix("sandbox allow-scripts;"), true)
        XCTAssertNotNil(read("default-src 'none'; sandbox"))
        XCTAssertNotNil(read("sandbox allow-scripts allow-forms; default-src 'none'"))
        // a sandbox that gives the origin back takes nothing away: the rendered page would be the shell's origin
        for render in ["sandbox allow-scripts allow-same-origin; default-src 'none'", "sandbox allow-same-origin", "default-src 'none'; SANDBOX Allow-Same-Origin allow-scripts",
                       "sandbox  allow-scripts\tallow-same-origin", "sandbox allow-scripts; sandbox allow-same-origin"] {
            XCTAssertNil(read(render), render)
        }
        // (a browser reads the first sandbox directive alone; one that gives the origin back anywhere is refused all the same)
        XCTAssertNil(read("default-src 'none'; frame-ancestors 'self'"))
        // the word elsewhere is no token of the sandbox
        XCTAssertNotNil(read("sandbox allow-scripts; report-uri /allow-same-origin"))
    }

    func testAWebViewWhoseHandlerIsNotTheOneCheckedLoadsNothingAndNoLaterOneIsRefusedForIt() {
        // a build that serves no shell has nothing to check
        XCTAssertEqual(Home.handlerCheck(serving: false, failed: false, capacitors: false, wrapped: false).load, true)
        XCTAssertEqual(Home.handlerCheck(serving: false, failed: false, capacitors: false, wrapped: false).failed, false)
        // the handler Capacitor registered, with this app's entry point in front
        XCTAssertEqual(Home.handlerCheck(serving: true, failed: false, capacitors: true, wrapped: true).load, true)
        XCTAssertEqual(Home.handlerCheck(serving: true, failed: false, capacitors: true, wrapped: true).failed, false)
        // another class, or another entry point: this web view loads nothing, and nothing is the shell from then on
        for (capacitors, wrapped) in [(false, true), (true, false), (false, false)] {
            let found = Home.handlerCheck(serving: true, failed: false, capacitors: capacitors, wrapped: wrapped)
            XCTAssertEqual(found.load, false)
            XCTAssertEqual(found.failed, true)
        }
        // after that the app's own page and a PC at its own address open in web views that are not checked again:
        // nothing is the shell any more, so there is nothing a handler could answer without its policy, and the
        // screen that stands in is not refused in its turn (which would build web views without end)
        for (capacitors, wrapped) in [(false, false), (true, true), (false, true)] {
            let later = Home.handlerCheck(serving: true, failed: true, capacitors: capacitors, wrapped: wrapped)
            XCTAssertEqual(later.load, true)
            XCTAssertEqual(later.failed, true)
        }
    }

    func testTheAppsOwnPageSaysTheShellDidNotOpenWheneverTheBuildsShellIsNotServed() {
        // a build that loads the shell from the network never says it
        XCTAssertFalse(Home.shellStuck(carries: false, serving: false, attempt: false))
        // a build that carries the shell and serves it: only after an attempt that did not draw
        XCTAssertFalse(Home.shellStuck(carries: true, serving: true, attempt: false))
        XCTAssertTrue(Home.shellStuck(carries: true, serving: true, attempt: true))
        // a build that carries it and cannot serve it (its files or policies missing, its handler refused): from the start
        XCTAssertTrue(Home.shellStuck(carries: true, serving: false, attempt: false))
    }
}
