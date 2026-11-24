import XCTest
@testable import OvisHomeCore

/// What the review of the shell inside the app asked for, each as the decision it comes down to.
final class ReviewTests: XCTestCase {
    private let hosted = URL(string: "https://app.ovis.sh"), shell = URL(string: "capacitor://app.ovis.sh")
    private let id = "0123456789abcdef0123456789abcdef"

    // MARK: the app's own host answers only its own pages

    func testTheAppsOwnHostAnswersItsOwnPages() {
        for path in ["", "/", "/index.html", "/error.html", "/shell.js", "/connect.js", "/pretendard.css", "/demo/index.html", "/demo/assets/index-Ab3_x9.js",
                     "/demo/assets/PretendardVariable.subset.92-abc.woff2", "/ovis%20sheep.svg", "/demo/"] {
            XCTAssertTrue(Home.ownPagePath(path), path)
        }
    }

    func testTheAppsOwnHostNeverReachesOutOfItsFolderNorReadsThePhonesFiles() {
        for path in ["/..%2Fbundled-shell%2Fshell%2Frender.html", "/../bundled-shell/shell/render.html", "/%2e%2e/bundled-shell/shell/render.html",
                     "/%2E%2E%2Fbundled-shell/shell/index.html", "/demo/../../bundled-shell/shell/render.html", "/demo/%2e%2e/%2e%2e/Info.plist",
                     "/..%5Cbundled-shell", "/..\\bundled-shell", "/%252e%252e/bundled-shell/shell/render.html", "/%252E%252E%252Fx", "/./index.html", "/demo/./index.html",
                     "/a%2Fb", "/a%5Cb", "/a%00b", "/a\u{0}b", "relative.html", "/..",
                     "/_capacitor_file_/etc/hosts", "/_capacitor_file_/private/var/mobile/Containers/Data/Application/x/Library/Preferences/sh.ovis.app.plist",
                     "/_capacitor_content_/x", "/_capacitor_http_interceptor_?u=https%3A%2F%2Fexample.com", "/_capacitor_https_interceptor_/x", "/_Capacitor_File_/etc/hosts",
                     "/%5Fcapacitor_file_/etc/hosts"] {
            XCTAssertFalse(Home.ownPagePath(path), path)
        }
    }

    // MARK: the app's copy of the shell's documents

    func testTheShellsTwoDocumentsAreNamedSoThatNoOtherHostAnswersThemAsAPage() {
        XCTAssertEqual(ShellRoute.pageFile, "index.shellpage")
        XCTAssertEqual(ShellRoute.renderFile, "render.shellpage")
        // by a name of their own the shell's host answers them with nothing either
        for path in ["/index.shellpage", "/render.shellpage", "/assets/x.SHELLPAGE", "/render.html"] {
            XCTAssertEqual(ShellRoute.route(path), .missing, path)
        }
        // and under a PC's scope the name is a path like any other: the page
        XCTAssertEqual(ShellRoute.route("/s/\(id)/render.shellpage"), .page)
        // typed as bytes, never as a page, by anything that goes by the name
        XCTAssertEqual(ShellRoute.contentType(ShellRoute.renderFile), "application/octet-stream")
    }

    func testEachAnswerCarriesItsPolicyAndTheRenderHostOnlyItsOwn() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("shell-answer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("assets"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data("<page>".utf8).write(to: folder.appendingPathComponent(ShellRoute.pageFile))
        try Data("<render host>".utf8).write(to: folder.appendingPathComponent(ShellRoute.renderFile))
        try Data("{}".utf8).write(to: folder.appendingPathComponent("manifest.webmanifest"))
        try Data("export {}".utf8).write(to: folder.appendingPathComponent("assets/index-0123456789.js"))
        try Data("secret".utf8).write(to: folder.deletingLastPathComponent().appendingPathComponent("outside-\(folder.lastPathComponent).txt"))
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent().appendingPathComponent("outside-\(folder.lastPathComponent).txt")) }
        let policies = (shell: "default-src 'self'", render: "sandbox allow-scripts; default-src 'none'")
        let ask = { (path: String, main: Bool) in ShellAnswer.make(path: path, method: "GET", mainDocument: main, folder: folder, policies: policies) }

        for path in ["/", "/index.html", "/s/\(id)/", "/s/\(id)/anything", "/no/such/page"] {
            let page = ask(path, true)
            XCTAssertEqual(page.status, 200, path)
            XCTAssertEqual(page.file?.lastPathComponent, ShellRoute.pageFile, path)
            XCTAssertEqual(page.headers["Content-Type"], "text/html; charset=utf-8", path)
            XCTAssertEqual(page.headers["Content-Security-Policy"], policies.shell, path)
            XCTAssertEqual(page.headers["Content-Length"], "6", path)
        }
        // the render host, in a frame: its own file under its own policy, and not one word of the shell's
        let render = ask("/s/\(id)/~render", false)
        XCTAssertEqual(render.status, 200)
        XCTAssertEqual(render.file?.lastPathComponent, ShellRoute.renderFile)
        XCTAssertEqual(render.headers["Content-Type"], "text/html; charset=utf-8")
        XCTAssertEqual(render.headers["Content-Security-Policy"], policies.render)
        // as the page the web view shows itself it is nothing
        let top = ask("/s/\(id)/~render", true)
        XCTAssertEqual(top.status, 404)
        XCTAssertNil(top.file)
        XCTAssertEqual(top.headers["Content-Security-Policy"], policies.shell)

        let script = ask("/assets/index-0123456789.js", false)
        XCTAssertEqual(script.status, 200)
        XCTAssertEqual(script.headers["Content-Type"], "text/javascript; charset=utf-8")
        XCTAssertEqual(script.headers["Content-Security-Policy"], policies.shell)
        XCTAssertEqual(ask("/s/\(id)/manifest.webmanifest", false).headers["Content-Type"], "application/manifest+json")

        for path in ["/assets/nope.js", "/sw.js", "/s/\(id)/sw.js", "/render.html", "/render.shellpage", "/index.shellpage", "/_headers",
                     "/_capacitor_file_/etc/hosts", "/assets/../index.shellpage", "/assets/..%2F..%2Foutside-\(folder.lastPathComponent).txt", "/assets/"] {
            let missing = ask(path, false)
            XCTAssertEqual(missing.status, 404, path)
            XCTAssertNil(missing.file, path)
            XCTAssertEqual(missing.headers["Content-Security-Policy"], policies.shell, path)
            XCTAssertEqual(missing.headers["Content-Type"], "text/plain; charset=utf-8", path)
        }
        XCTAssertEqual(ShellAnswer.make(path: "/", method: "POST", mainDocument: true, folder: folder, policies: policies).status, 405)
        XCTAssertEqual(ShellAnswer.make(path: "/", method: "head", mainDocument: true, folder: folder, policies: policies).status, 200)
        // a folder without the page answers nothing, whatever is asked
        try FileManager.default.removeItem(at: folder.appendingPathComponent(ShellRoute.pageFile))
        XCTAssertEqual(ask("/", true).status, 404)
        XCTAssertEqual(ask("/s/\(id)/", true).status, 404)
    }

    func testTheWebViewNeverGoesToARenderHostItself() {
        XCTAssertTrue(Home.renderHostAddress(URL(string: "capacitor://app.ovis.sh/s/\(id)/~render"), shell: shell))
        XCTAssertTrue(Home.renderHostAddress(URL(string: "capacitor://app.ovis.sh/s/\(id)/~render?x=1#y"), shell: shell))
        for page in ["capacitor://app.ovis.sh/s/\(id)/", "capacitor://app.ovis.sh/", "capacitor://app.ovis.sh/s/\(id)/~render/", "capacitor://localhost/s/\(id)/~render",
                     "capacitor://APP.ovis.sh/s/\(id)/~render", "https://desk.tail1e211e.ts.net/s/\(id)/~render"] {
            XCTAssertFalse(Home.renderHostAddress(URL(string: page), shell: shell), page)
        }
        // a build that loads the shell from the network leaves its render host to that host
        XCTAssertFalse(Home.renderHostAddress(URL(string: "https://app.ovis.sh/s/\(id)/~render"), shell: hosted))
        XCTAssertFalse(Home.renderHostAddress(nil, shell: shell))
    }

    // MARK: the hosted origin never loads where the shell is inside the app

    func testNoWebAddressAtTheHostedHostIsAPcWhereTheShellIsInsideTheApp() {
        let origin = { (text: String, bundled: Bool) in Home.pcOrigin(URL(string: text)!, hosted: self.hosted, shell: bundled ? self.shell : self.hosted, bundled: bundled) }
        for text in ["https://app.ovis.sh/", "https://app.ovis.sh/s/\(id)/", "http://app.ovis.sh/", "https://app.ovis.sh:8443/", "http://app.ovis.sh:80/",
                     "https://APP.OVIS.SH/", "https://app.ovis.sh./", "http://App.Ovis.Sh.:8080/x", "https://user@app.ovis.sh/", "https://app%2Eovis.sh/"] {
            XCTAssertTrue(Home.hostedHost(URL(string: text), hosted: hosted), text)
            XCTAssertNil(origin(text, true), text)
        }
        // another host is a PC at its own address, as it always was
        for (text, key) in [("https://desk.tail1e211e.ts.net/", "https://desk.tail1e211e.ts.net"), ("http://192.168.0.12:8765/x", "http://192.168.0.12:8765"),
                            ("http://127.0.0.1:47320/", "http://127.0.0.1:47320"), ("https://app.ovis.sh.evil.example/", "https://app.ovis.sh.evil.example"),
                            ("https://notapp.ovis.sh/", "https://notapp.ovis.sh"), ("http://[fd7a:115c:a1e0::1]:8080/", "http://[fd7a:115c:a1e0::1]:8080")] {
            XCTAssertFalse(Home.hostedHost(URL(string: text), hosted: hosted), text)
            XCTAssertEqual(origin(text, true), key, text)
            XCTAssertEqual(origin(text, false), key, text)
        }
        // the shell inside the app, at its host as written
        XCTAssertEqual(origin("capacitor://app.ovis.sh/s/\(id)/", true), "capacitor://app.ovis.sh")
        for text in ["capacitor://APP.ovis.sh/", "capacitor://app.ovis.sh:443/", "capacitor://localhost/index.html", "capacitor://other.example/"] {
            XCTAssertNil(origin(text, true), text)
        }
        // a build that loads the shell from the network: the hosted origin is a PC's key as before, and nothing on the app's scheme is
        XCTAssertEqual(origin("https://app.ovis.sh/s/\(id)/", false), "https://app.ovis.sh")
        XCTAssertEqual(origin("https://APP.ovis.sh:8443/", false), "https://app.ovis.sh:8443")
        XCTAssertNil(origin("capacitor://app.ovis.sh/s/\(id)/", false))
        XCTAssertNil(origin("capacitor://localhost/index.html", false))
        XCTAssertFalse(Home.hostedHost(URL(string: "capacitor://app.ovis.sh/"), hosted: hosted))
        XCTAssertFalse(Home.hostedHost(URL(string: "https://app.ovis.sh/"), hosted: nil))
        XCTAssertFalse(Home.hostedHost(nil, hosted: hosted))
    }

    func testEveryWebEntryAtTheHostedHostIsSetAsideNotOnlyItsExactOrigin() {
        let kept = Home.withoutHosted(saved: ["http://app.ovis.sh", "https://app.ovis.sh:8443", "https://app.ovis.sh/s/\(id)/", "https://desk.tail1e211e.ts.net"],
                                      names: [:], ids: [:], current: "https://app.ovis.sh.", last: nil, hosted: hosted)
        XCTAssertEqual(kept.saved, ["https://desk.tail1e211e.ts.net"])
        XCTAssertEqual(kept.dead, ["http://app.ovis.sh", "https://app.ovis.sh:8443", "https://app.ovis.sh/s/\(id)/", "https://app.ovis.sh."])
        XCTAssertNil(kept.current)
    }

    // MARK: a shell that never draws leaves a way out

    func testHomeInsideTheAppOffersTheAppsOwnPageOnceItHasNotDrawnForAWhile() {
        XCTAssertFalse(Home.ownPageOffer(elapsed: 0))
        XCTAssertFalse(Home.ownPageOffer(elapsed: Home.loadSeconds - 0.01))
        XCTAssertTrue(Home.ownPageOffer(elapsed: Home.loadSeconds))
        XCTAssertTrue(Home.ownPageOffer(elapsed: 3600))
        // and still nothing gives up on it by itself: the person chooses
        XCTAssertFalse(Home.timedOut(elapsed: 3600, answered: false, inApp: true))
        // only time in front counts, as for the hosted screen's clock
        var clock = Home.Clock(now: 0)
        clock.away(now: 1)
        clock.resumed(now: 600)
        XCTAssertFalse(Home.ownPageOffer(elapsed: clock.tick(now: 600.5)))
    }

    // MARK: one build installed over the other kind

    func testABuildThatLoadsTheShellFromTheNetworkListsNothingOnTheAppsScheme() {
        let relay = "capacitor://app.ovis.sh/s/\(id)/", tailscale = "https://desk.tail1e211e.ts.net"
        let kept = Home.withoutInApp(saved: [relay, tailscale, "capacitor://app.ovis.sh"], names: [relay: "Desk", tailscale: "desk"], ids: [relay: id], current: "capacitor://app.ovis.sh", last: tailscale)
        XCTAssertEqual(kept.saved, [tailscale])
        XCTAssertEqual(kept.names, [tailscale: "desk"])
        XCTAssertEqual(kept.ids, [:])
        XCTAssertNil(kept.current)
        XCTAssertEqual(kept.last, tailscale)
        XCTAssertEqual(kept.dead, [relay, "capacitor://app.ovis.sh"])
        XCTAssertEqual(Home.withoutInApp(saved: [tailscale, "https://app.ovis.sh/s/\(id)/"], names: [:], ids: [:], current: nil, last: nil).dead, [])
    }

    func testWhatTheOtherKindOfBuildSetAsideComesBackWhereItOpensAgain() {
        let relay = "https://app.ovis.sh/s/\(id)/", tailscale = "https://desk.tail1e211e.ts.net"
        let back = Home.restored(saved: [tailscale], names: [tailscale: "desk"], ids: [:], aside: ["https://app.ovis.sh", relay, tailscale],
                                 asideNames: [relay: "Desk", tailscale: "an older name", "https://gone.example": "never set aside"], asideIds: [relay: id])
        XCTAssertEqual(back.saved, [tailscale, "https://app.ovis.sh", relay])
        XCTAssertEqual(back.names, [tailscale: "desk", relay: "Desk"])
        XCTAssertEqual(back.ids, [relay: id])
        let nothing = Home.restored(saved: [tailscale], names: [:], ids: [:], aside: [], asideNames: [:], asideIds: [:])
        XCTAssertEqual(nothing.saved, [tailscale])
    }

    // MARK: alerts from pairings the update set aside

    func testTheNoticeSaysWhereOldAlertsStopWhenASetAsidePcSendsThem() {
        for language in ["en", "ko", "ja", "zh"] {
            let plain = Home.movedNotice(languages: [language], kept: true), told = Home.movedNotice(languages: [language], kept: true, alerts: true)
            XCTAssertEqual(plain.body.components(separatedBy: "\n\n").count, 3, language)
            XCTAssertEqual(told.body.components(separatedBy: "\n\n").count, 4, language)
            XCTAssertTrue(told.body.hasPrefix(plain.body), language)
            XCTAssertEqual(Home.movedNotice(languages: [language], kept: false, alerts: true).body.components(separatedBy: "\n\n").count, 3, language)
        }
        XCTAssertTrue(Home.movedNotice(languages: ["en"], kept: false, alerts: true).body.contains("Settings → Devices and PCs"))
        XCTAssertTrue(Home.movedNotice(languages: ["ko"], kept: false, alerts: true).body.contains("설정 → 기기와 PC"))
    }
}
