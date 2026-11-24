import XCTest
@testable import OvisHomeCore

/// What a page may ask of the app in a build that serves the shell from inside the app, at `capacitor://<the hosted
/// origin's host>`: each gate answers the shell's pages as it answers the hosted app's in a hosted build, and no page
/// more than there.
final class BundledShellGateTests: XCTestCase {
    private let hosted = URL(string: "https://app.ovis.sh"), shell = URL(string: "capacitor://app.ovis.sh")
    private let id = "0123456789abcdef0123456789abcdef"

    func testARelayPcsPageOnTheBundledShellIsSavedByItsScopeThere() {
        XCTAssertEqual(Home.relayScope(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), appOrigin: shell), "capacitor://app.ovis.sh/s/\(id)/")
        XCTAssertEqual(Home.relayScope(URL(string: "capacitor://app.ovis.sh/s/\(id)/x?pane=w1#y"), appOrigin: shell), "capacitor://app.ovis.sh/s/\(id)/")
        XCTAssertTrue(Home.relayPc(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), appOrigin: shell))
        // the render host is within its PC's scope, as on the hosted app
        XCTAssertTrue(Home.relayPc(URL(string: "capacitor://app.ovis.sh/s/\(id)/~render"), appOrigin: shell))
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://app.ovis.sh/#pcs"), appOrigin: shell))
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://app.ovis.sh/s/\(id)/../\(id)/"), appOrigin: shell))
        // the app's own pages and another host on the scheme are never the shell
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://localhost/s/\(id)/"), appOrigin: shell))
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://app.ovis.sh.evil.example/s/\(id)/"), appOrigin: shell))
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://app.ovis.sh:8443/s/\(id)/"), appOrigin: shell))
        // the hosted app loaded from the network is not the bundled shell, nor the other way round
        XCTAssertFalse(Home.relayPc(URL(string: "https://app.ovis.sh/s/\(id)/"), appOrigin: shell))
        XCTAssertFalse(Home.relayPc(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), appOrigin: hosted))
    }

    func testTheBundledShellsFrontPageIsAnAttemptAtHomeAsTheHostedOneIs() {
        XCTAssertEqual(Home.homeStart("capacitor://app.ovis.sh/#sign-in=github", appOrigin: shell), "#sign-in=github")
        XCTAssertEqual(Home.homeStart("capacitor://app.ovis.sh/#pcs", appOrigin: shell), "#pcs")
        XCTAssertEqual(Home.homeStart("capacitor://app.ovis.sh", appOrigin: shell), "#pcs")
        XCTAssertNil(Home.homeStart("capacitor://app.ovis.sh/s/\(id)/", appOrigin: shell))
        XCTAssertNil(Home.homeStart("capacitor://localhost/#pcs", appOrigin: shell))
        XCTAssertNil(Home.homeStart("https://app.ovis.sh/#pcs", appOrigin: shell))
    }

    func testOnlyTheAppsOwnPagesAndTheShellAreToldTheSavedPcsIds() {
        XCTAssertTrue(Home.ownPage(URL(string: "capacitor://localhost/index.html"), appOrigin: shell))
        XCTAssertTrue(Home.ownPage(URL(string: "capacitor://app.ovis.sh/#pcs"), appOrigin: shell))
        XCTAssertTrue(Home.ownPage(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), appOrigin: shell))
        XCTAssertFalse(Home.ownPage(URL(string: "https://desk.tail1e211e.ts.net/"), appOrigin: shell))
        // the scheme alone makes no page the app's: only its two hosts
        XCTAssertFalse(Home.ownPage(URL(string: "capacitor://other.example/"), appOrigin: shell))
        XCTAssertFalse(Home.ownPage(URL(string: "capacitor://app.ovis.sh/#pcs"), appOrigin: hosted))
        XCTAssertFalse(Home.ownPage(URL(string: "capacitor://app.ovis.sh/#pcs"), appOrigin: nil))
        XCTAssertNil(Home.shownIds(URL(string: "capacitor://other.example/"), appOrigin: shell, ids: ["k": id]))
    }

    func testNeitherTheShellNorARelayPcsScopeThereSaysWhichSavedPcItIs() {
        XCTAssertNil(Home.identifiedKey(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), current: "capacitor://app.ovis.sh", appOrigin: shell))
        XCTAssertNil(Home.identifiedKey(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), current: "capacitor://app.ovis.sh/s/\(id)/", appOrigin: shell))
        XCTAssertNil(Home.identifiedKey(URL(string: "capacitor://app.ovis.sh/"), current: "https://desk.tail1e211e.ts.net", appOrigin: shell))
        XCTAssertEqual(Home.identifiedKey(URL(string: "https://desk.tail1e211e.ts.net/"), current: "https://desk.tail1e211e.ts.net", appOrigin: shell), "https://desk.tail1e211e.ts.net")
    }
}
