import XCTest
@testable import OvisHomeCore

/// On the app's own scheme a host is compared as it is written and has no port: WebKit keeps `capacitor://APP.ovis.sh`
/// apart from `capacitor://app.ovis.sh` (another origin, with storage of its own), so the app must not trust the one
/// for the other.
final class ExactHostTests: XCTestCase {
    private let hosted = URL(string: "https://app.ovis.sh"), shell = URL(string: "capacitor://app.ovis.sh")
    private let id = "0123456789abcdef0123456789abcdef"

    func testTheAppsOwnPagesAreAtLocalhostAsWrittenWithNoPort() {
        XCTAssertTrue(Home.bundledPage(URL(string: "capacitor://localhost/index.html")))
        XCTAssertTrue(Home.bundledPage(URL(string: "CAPACITOR://localhost")))
        for page in ["capacitor://LOCALHOST/error.html", "capacitor://Localhost/", "capacitor://localhost:1/", "capacitor://localhost:0/", "capacitor://localhost./"] {
            XCTAssertFalse(Home.bundledPage(URL(string: page)), page)
        }
    }

    func testTheShellIsAtItsHostAsWrittenWithNoPort() {
        XCTAssertTrue(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "APP.ovis.sh", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh.", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh", port: 443, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "Capacitor", host: "app.ovis.sh", port: 0, shell: shell))
        XCTAssertTrue(Home.sameOrigin(URL(string: "capacitor://app.ovis.sh/s/\(id)/"), shell))
        for page in ["capacitor://APP.ovis.sh/", "capacitor://App.Ovis.Sh/s/\(id)/", "capacitor://app.ovis.sh:443/", "capacitor://app.ovis.sh./"] {
            XCTAssertFalse(Home.sameOrigin(URL(string: page), shell), page)
            XCTAssertFalse(Home.ownPage(URL(string: page), appOrigin: shell), page)
            XCTAssertNil(Home.relayScope(URL(string: page.hasSuffix("/s/\(id)/") ? page : page + "s/\(id)/"), appOrigin: shell), page)
        }
        XCTAssertNil(Home.homeStart("capacitor://APP.ovis.sh/#pcs", appOrigin: shell))
        XCTAssertEqual(Home.shellForm("capacitor://APP.ovis.sh/#pcs", hosted: hosted, shell: shell), "capacitor://APP.ovis.sh/#pcs")
        // a web origin is one whatever its host's case, as a browser reads it
        XCTAssertTrue(Home.sameOrigin(URL(string: "https://APP.ovis.sh:443/"), hosted))
        XCTAssertTrue(Home.shellFrame(scheme: "https", host: "app.ovis.sh", port: 0, shell: hosted))
    }
}
