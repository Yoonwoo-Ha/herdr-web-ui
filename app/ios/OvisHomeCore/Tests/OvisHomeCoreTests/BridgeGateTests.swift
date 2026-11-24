import XCTest
@testable import OvisHomeCore

/// What the app does with a message a page posts to its bridge, in a build that loads the shell from the network
/// (`hosted`) and in one that serves it itself (`inApp`).
final class BridgeGateTests: XCTestCase {
    private let hosted = URL(string: "https://app.ovis.sh"), inApp = URL(string: "capacitor://app.ovis.sh")
    private typealias Frame = (main: Bool, scheme: String, host: String, port: Int)
    private let ownPage: Frame = (true, "capacitor", "localhost", 0)
    private let hostedShell: Frame = (true, "https", "app.ovis.sh", 0)
    private let inAppShell: Frame = (true, "capacitor", "app.ovis.sh", 0)
    private let pcPage: Frame = (true, "https", "desk.tail1e211e.ts.net", 0)

    private func decide(_ frame: Frame, _ plugin: String, _ method: String?, type: String? = "message", callback: Bool = true, shell: URL?) -> BridgeGate.Decision {
        BridgeGate.decide(mainFrame: frame.main, scheme: frame.scheme, host: frame.host, port: frame.port, plugins: [plugin], type: type, method: method, callback: callback, shell: shell)
    }

    func testNoFrameInsideAPageReachesAnyPluginInEitherBuild() {
        for shell in [hosted, inApp] {
            for frame: Frame in [(false, "https", "app.ovis.sh", 0), (false, "capacitor", "app.ovis.sh", 0), (false, "capacitor", "localhost", 0),
                                 (false, "http", "localhost", 5173), (false, "https", "desk.tail1e211e.ts.net", 0), (false, "", "", 0)] {
                for (plugin, method) in [("HerdrShell", "open"), ("HerdrShell", "forget"), ("HerdrShell", "disconnect"), ("HerdrShell", "openSshSetup"), ("HerdrShell", "getState"),
                                         ("OvisPush", "subscribe"), ("OvisAuth", "authenticate"), ("OvisSsh", "add"), ("OvisSsh", "list"), ("OvisDirect", "open"),
                                         ("CapacitorBarcodeScanner", "scanBarcode"), ("SystemBars", "setStyle")] {
                    XCTAssertEqual(decide(frame, plugin, method, shell: shell), .drop, "\(frame) \(plugin).\(method)")
                }
            }
        }
    }

    func testOvisDirectAnswersTheShellAloneWhereverTheShellIs() {
        for method in BridgeGate.directMethods.sorted() {
            XCTAssertEqual(decide(hostedShell, "OvisDirect", method, shell: hosted), .init(pass: true, approve: true, record: false), method)
            XCTAssertEqual(decide(inAppShell, "OvisDirect", method, shell: inApp), .init(pass: true, approve: true, record: false), method)
        }
        // its listener methods go on without an approval of their own
        XCTAssertEqual(decide(inAppShell, "OvisDirect", "addListener", shell: inApp), .init(pass: true, approve: false, record: false))
        XCTAssertEqual(decide(inAppShell, "OvisDirect", "open", callback: false, shell: inApp), .init(pass: true, approve: false, record: false))
        // the hosted app from the network is no shell where the app serves its own, and the other way round
        XCTAssertEqual(decide(hostedShell, "OvisDirect", "open", shell: inApp), .drop)
        XCTAssertEqual(decide(inAppShell, "OvisDirect", "open", shell: hosted), .drop)
        for shell in [hosted, inApp] {
            XCTAssertEqual(decide(ownPage, "OvisDirect", "open", shell: shell), .drop)
            XCTAssertEqual(decide(pcPage, "OvisDirect", "features", shell: shell), .drop)
            XCTAssertEqual(decide((true, "capacitor", "APP.ovis.sh", 0), "OvisDirect", "open", shell: shell), .drop)
            XCTAssertEqual(decide((true, "capacitor", "app.ovis.sh", 8443), "OvisDirect", "open", shell: shell), .drop)
        }
        XCTAssertEqual(decide(hostedShell, "OvisDirect", "open", shell: nil), .drop)
    }

    func testOvisSshAnswersTheAppsOwnPagesAndHandsTheShellsAddOver() {
        for shell in [hosted, inApp] {
            for method in ["add", "setUp", "list", "phoneKey", "copy", "share", "rename", "forgetHostKey", "remove", "known"] {
                XCTAssertEqual(decide(ownPage, "OvisSsh", method, shell: shell), .init(pass: true, approve: false, record: true), method)
                XCTAssertEqual(decide(pcPage, "OvisSsh", method, shell: shell), .drop, method)
            }
            XCTAssertEqual(decide((true, "capacitor", "LOCALHOST", 0), "OvisSsh", "list", shell: shell), .drop)
            XCTAssertEqual(decide((true, "capacitor", "localhost", 8080), "OvisSsh", "list", shell: shell), .drop)
            XCTAssertEqual(decide((true, "https", "localhost", 0), "OvisSsh", "list", shell: shell), .drop)
        }
        XCTAssertEqual(decide(hostedShell, "OvisSsh", "add", shell: hosted), .init(pass: true, approve: false, record: true))
        XCTAssertEqual(decide(inAppShell, "OvisSsh", "add", shell: inApp), .init(pass: true, approve: false, record: true))
        XCTAssertEqual(decide(hostedShell, "OvisSsh", "list", shell: hosted), .drop)
        XCTAssertEqual(decide(inAppShell, "OvisSsh", "remove", shell: inApp), .drop)
        XCTAssertEqual(decide(inAppShell, "OvisSsh", "add", shell: hosted), .drop)
        // a message that names the plugin by either of the two names Capacitor reads
        XCTAssertEqual(BridgeGate.decide(mainFrame: true, scheme: "https", host: "desk.tail1e211e.ts.net", port: 0, plugins: ["HerdrShell", "OvisSsh"], type: "message", method: "list", callback: true, shell: hosted), .drop)
        XCTAssertEqual(BridgeGate.decide(mainFrame: true, scheme: "https", host: "desk.tail1e211e.ts.net", port: 0, plugins: ["OvisDirect", "HerdrShell"], type: "message", method: "open", callback: true, shell: hosted), .drop)
    }

    func testEveryOtherPluginAnswersAnyMainFrameAndTheCallsThatDecideByTheirPageKeepTheirSender() {
        for shell in [hosted, inApp] {
            for frame in [ownPage, hostedShell, inAppShell, pcPage] {
                for method in BridgeGate.shellMethodsBySender.sorted() {
                    XCTAssertEqual(decide(frame, "HerdrShell", method, shell: shell), .init(pass: true, approve: false, record: true), method)
                }
                for (plugin, method) in [("HerdrShell", "open"), ("HerdrShell", "chooseAnother"), ("HerdrShell", "retry"), ("OvisPush", "subscribe"), ("OvisAuth", "authenticate"), ("Console", "log")] {
                    XCTAssertEqual(decide(frame, plugin, method, shell: shell), .init(pass: true, approve: false, record: false), "\(plugin).\(method)")
                }
            }
        }
        XCTAssertEqual(decide(pcPage, "HerdrShell", "forget", callback: false, shell: hosted), .init(pass: true, approve: false, record: false))
    }

    func testAFramesOriginIsKeptAsTheAddressThePageGatesRead() {
        XCTAssertEqual(BridgeGate.sender(scheme: "capacitor", host: "localhost", port: 0)?.absoluteString, "capacitor://localhost")
        XCTAssertEqual(BridgeGate.sender(scheme: "https", host: "desk.tail1e211e.ts.net", port: 8443)?.absoluteString, "https://desk.tail1e211e.ts.net:8443")
        XCTAssertEqual(BridgeGate.sender(scheme: "http", host: "fd7a:115c:a1e0::1", port: 8080)?.absoluteString, "http://[fd7a:115c:a1e0::1]:8080")
        XCTAssertNil(BridgeGate.sender(scheme: "", host: "", port: 0))
        // the gates read it as they read a page's address
        XCTAssertTrue(Home.bundledPage(BridgeGate.sender(scheme: "capacitor", host: "localhost", port: 0)))
        XCTAssertFalse(Home.bundledPage(BridgeGate.sender(scheme: "capacitor", host: "app.ovis.sh", port: 0)))
        XCTAssertTrue(Home.ownPage(BridgeGate.sender(scheme: "capacitor", host: "app.ovis.sh", port: 0), appOrigin: inApp))
        XCTAssertEqual(Home.identifiedKey(BridgeGate.sender(scheme: "https", host: "desk.tail1e211e.ts.net", port: 0), current: "https://desk.tail1e211e.ts.net", appOrigin: inApp), "https://desk.tail1e211e.ts.net")
    }
}
