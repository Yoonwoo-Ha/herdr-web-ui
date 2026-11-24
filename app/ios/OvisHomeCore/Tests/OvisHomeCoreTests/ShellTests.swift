import XCTest
@testable import OvisHomeCore

final class ShellTests: XCTestCase {
    private let hosted = URL(string: "https://app.ovis.sh"), shell = URL(string: "capacitor://app.ovis.sh")
    private let id = "0123456789abcdef0123456789abcdef"

    func testTheShellIsTheHostedOriginUnlessTheBuildServesItFromInsideTheApp() {
        XCTAssertEqual(Home.shellOrigin(hosted: hosted, bundled: false), hosted)
        XCTAssertEqual(Home.shellOrigin(hosted: hosted, bundled: true)?.absoluteString, "capacitor://app.ovis.sh")
        XCTAssertEqual(Home.shellOrigin(hosted: URL(string: "https://Relay-0510.ovis-app.pages.dev"), bundled: true)?.absoluteString, "capacitor://relay-0510.ovis-app.pages.dev")
        // the host alone: the app's scheme has no port
        XCTAssertEqual(Home.shellOrigin(hosted: URL(string: "https://shell.example.ts.net:8443"), bundled: true)?.absoluteString, "capacitor://shell.example.ts.net")
        XCTAssertNil(Home.shellOrigin(hosted: nil, bundled: true))
        XCTAssertNil(Home.shellOrigin(hosted: nil, bundled: false))
        // never the host of the app's own pages, which would make them the shell
        XCTAssertNil(Home.shellOrigin(hosted: URL(string: "https://localhost"), bundled: true))
        XCTAssertNil(Home.shellOrigin(hosted: URL(string: "https://[::1]"), bundled: true))
    }

    func testTheAppsOwnPagesAreToldFromTheShellByTheirHost() {
        XCTAssertTrue(Home.bundledPage(URL(string: "capacitor://localhost/index.html")))
        XCTAssertTrue(Home.bundledPage(URL(string: "capacitor://localhost/demo/index.html")))
        for page in ["capacitor://app.ovis.sh/", "capacitor://app.ovis.sh/index.html", "capacitor://app.ovis.sh/s/\(id)/", "capacitor://localhost.evil.example/",
                     "capacitor://localhost:1/", "https://localhost/", "http://localhost/index.html", "https://app.ovis.sh/"] {
            XCTAssertFalse(Home.bundledPage(URL(string: page)), page)
        }
        XCTAssertFalse(Home.bundledPage(nil))
    }

    func testOnlyAFrameOfTheShellsOriginIsTheShells() {
        XCTAssertTrue(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh", port: 0, shell: shell))
        // in a build that serves the shell itself, the hosted app from the network is a page like any other
        XCTAssertFalse(Home.shellFrame(scheme: "https", host: "app.ovis.sh", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "localhost", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh.evil.example", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh", port: 8443, shell: shell))
        // a sandboxed frame (the render host) has no origin: WebKit gives it an empty one
        XCTAssertFalse(Home.shellFrame(scheme: "", host: "", port: 0, shell: shell))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "localhost", port: 0, shell: URL(string: "capacitor://localhost")))
        // a hosted build, as before
        XCTAssertTrue(Home.shellFrame(scheme: "https", host: "app.ovis.sh", port: 0, shell: hosted))
        XCTAssertTrue(Home.shellFrame(scheme: "https", host: "app.ovis.sh", port: 443, shell: hosted))
        XCTAssertTrue(Home.shellFrame(scheme: "https", host: "shell.example.ts.net", port: 8443, shell: URL(string: "https://shell.example.ts.net:8443")))
        XCTAssertFalse(Home.shellFrame(scheme: "https", host: "shell.example.ts.net", port: 0, shell: URL(string: "https://shell.example.ts.net:8443")))
        XCTAssertFalse(Home.shellFrame(scheme: "http", host: "app.ovis.sh", port: 0, shell: hosted))
        XCTAssertFalse(Home.shellFrame(scheme: "http", host: "127.0.0.1", port: 18596, shell: URL(string: "http://127.0.0.1:18596")))
        XCTAssertFalse(Home.shellFrame(scheme: "capacitor", host: "app.ovis.sh", port: 0, shell: hosted))
        XCTAssertFalse(Home.shellFrame(scheme: "https", host: "app.ovis.sh", port: 0, shell: nil))
    }

    func testAnAddressOnTheHostedOriginOpensAsThatPageInsideTheApp() {
        let offer = "https://app.ovis.sh/s/\(id)/#offer=eyJ2IjoxfQ"
        XCTAssertEqual(Home.shellForm(offer, hosted: hosted, shell: shell), "capacitor://app.ovis.sh/s/\(id)/#offer=eyJ2IjoxfQ")
        XCTAssertEqual(Home.shellForm("https://app.ovis.sh/#sign-in=github", hosted: hosted, shell: shell), "capacitor://app.ovis.sh/#sign-in=github")
        XCTAssertEqual(Home.shellForm("https://APP.ovis.sh:443/s/\(id)/?pane=w1%3Ap1#x", hosted: hosted, shell: shell), "capacitor://app.ovis.sh/s/\(id)/?pane=w1%3Ap1#x")
        XCTAssertEqual(Home.shellForm("https://app.ovis.sh", hosted: hosted, shell: shell), "capacitor://app.ovis.sh")
        XCTAssertEqual(Home.shellForm("https://app.ovis.sh/s/\(id)/", hosted: hosted, shell: shell), "capacitor://app.ovis.sh/s/\(id)/")
        // already there, a PC's own address, another origin, nothing readable: as they are
        for other in ["capacitor://app.ovis.sh/s/\(id)/", "https://desk.tail1e211e.ts.net/?pair=CODE", "http://127.0.0.1:47320/", "http://app.ovis.sh/", "https://app.ovis.sh:8443/",
                      "https://app.ovis.sh.evil.example/", "https://demo/", "capacitor://localhost/index.html", "not an address", ""] {
            XCTAssertEqual(Home.shellForm(other, hosted: hosted, shell: shell), other, other)
        }
        // a build whose shell is the hosted origin changes nothing
        XCTAssertEqual(Home.shellForm(offer, hosted: hosted, shell: hosted), offer)
        XCTAssertEqual(Home.shellForm(offer, hosted: hosted, shell: nil), offer)
        XCTAssertEqual(Home.shellForm(offer, hosted: nil, shell: shell), offer)
    }

    func testTheAppsOwnPagesReadASavedKeyOnTheHostedOrigin() {
        XCTAssertEqual(Home.hostedForm("capacitor://app.ovis.sh/s/\(id)/", hosted: hosted, shell: shell), "https://app.ovis.sh/s/\(id)/")
        XCTAssertEqual(Home.hostedForm("capacitor://app.ovis.sh", hosted: hosted, shell: shell), "https://app.ovis.sh")
        for other in ["https://desk.tail1e211e.ts.net", "http://127.0.0.1:47320", "capacitor://localhost/index.html", "https://app.ovis.sh/s/\(id)/"] {
            XCTAssertEqual(Home.hostedForm(other, hosted: hosted, shell: shell), other, other)
        }
        // each undoes the other for a key of the shell
        let key = "capacitor://app.ovis.sh/s/\(id)/"
        XCTAssertEqual(Home.shellForm(Home.hostedForm(key, hosted: hosted, shell: shell), hosted: hosted, shell: shell), key)
        XCTAssertEqual(Home.hostedForm(key, hosted: hosted, shell: hosted), key)
    }

    func testALinkToTheHostedAppFromAShellPageStaysInsideTheApp() {
        let go = { (text: String) in Home.shellNavigation(URL(string: text)!, hosted: self.hosted, shell: self.shell)?.absoluteString }
        XCTAssertEqual(go("https://app.ovis.sh/s/\(id)/#offer=abc"), "capacitor://app.ovis.sh/s/\(id)/#offer=abc")
        XCTAssertEqual(go("https://app.ovis.sh/"), "capacitor://app.ovis.sh/")
        // a PC's scope without its slash gets it, the fragment kept, as the hosted app's host redirects it
        XCTAssertEqual(go("capacitor://app.ovis.sh/s/\(id)#offer=abc"), "capacitor://app.ovis.sh/s/\(id)/#offer=abc")
        XCTAssertEqual(go("https://app.ovis.sh/s/\(id)?x=1"), "capacitor://app.ovis.sh/s/\(id)/?x=1")
        // what is already where it belongs goes on as it is
        for page in ["capacitor://app.ovis.sh/", "capacitor://app.ovis.sh/#pcs", "capacitor://app.ovis.sh/s/\(id)/", "capacitor://app.ovis.sh/s/\(id)/~render",
                     "capacitor://app.ovis.sh/assets/index-abc.js", "capacitor://localhost/error.html", "https://desk.tail1e211e.ts.net/", "https://example.com/s/\(id)", "about:blank"] {
            XCTAssertNil(go(page), page)
        }
        // a hosted build has nothing to move
        XCTAssertNil(Home.shellNavigation(URL(string: "https://app.ovis.sh/s/\(id)")!, hosted: hosted, shell: hosted))
        XCTAssertNil(Home.shellNavigation(URL(string: "https://app.ovis.sh/")!, hosted: hosted, shell: nil))
    }

    func testTheAppTellsOnlyAShellPageThatItsCopyIsTheApps() throws {
        let script = try XCTUnwrap(Home.appShellScript(shell: shell, version: "1.0.3", build: 12))
        XCTAssertTrue(script.contains(#"{"appVersion":"1.0.3","build":12,"bundled":true,"platform":"ios"}"#), script)
        // only where the page is the shell's, by what a page cannot choose
        XCTAssertTrue(script.contains(#"location.protocol !== "capacitor:" || location.host !== ["app.ovis.sh"][0]"#), script)
        XCTAssertTrue(script.contains("__ovisAppShell"))
        // a version can hold nothing that ends the object or the script
        let odd = try XCTUnwrap(Home.appShellScript(shell: shell, version: "1.0\"});alert(1);//</script>\u{2028}", build: 1))
        XCTAssertTrue(odd.contains(#""appVersion":"1.0\"});alert(1);\/\/<\/script>\u2028","build":1"#), odd)
        XCTAssertFalse(odd.contains("\u{2028}"))
        // a build that loads the shell from the network says nothing
        XCTAssertNil(Home.appShellScript(shell: hosted, version: "1.0.3", build: 12))
        XCTAssertNil(Home.appShellScript(shell: nil, version: "1.0.3", build: 12))
        XCTAssertNil(Home.appShellScript(shell: URL(string: "capacitor://localhost"), version: "1.0.3", build: 12))
    }

    func testHomeInsideTheAppWaitsOnNoClock() {
        XCTAssertFalse(Home.timedOut(elapsed: 8, answered: false, inApp: true))
        XCTAssertFalse(Home.timedOut(elapsed: 3600, answered: true, inApp: true))
        XCTAssertTrue(Home.timedOut(elapsed: 8, answered: false, inApp: false))
    }

    func testOnlyWhatWasTiedToTheHostedOriginIsSetAside() {
        let relay = "https://app.ovis.sh/s/\(id)/", other = "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/"
        let tailscale = "https://desk.tail1e211e.ts.net", lan = "http://192.168.0.12:8765", ssh = "http://127.0.0.1:47320"
        let kept = Home.withoutHosted(saved: [relay, tailscale, "https://app.ovis.sh", ssh, other, lan],
                                      names: [relay: "Desk", tailscale: "desk", "https://app.ovis.sh": "Ovis", ssh: "box"],
                                      ids: [tailscale: id, relay: id], current: "https://app.ovis.sh", last: relay, hosted: hosted)
        XCTAssertEqual(kept.saved, [tailscale, ssh, lan])
        XCTAssertEqual(kept.names, [tailscale: "desk", ssh: "box"])
        XCTAssertEqual(kept.ids, [tailscale: id])
        XCTAssertNil(kept.current)
        XCTAssertNil(kept.last)
        XCTAssertEqual(kept.dead, [relay, "https://app.ovis.sh", other])
        // a PC at its own address that is current stays the one to open
        let own = Home.withoutHosted(saved: [tailscale, relay], names: [:], ids: [:], current: tailscale, last: tailscale, hosted: hosted)
        XCTAssertEqual(own.current, tailscale)
        XCTAssertEqual(own.last, tailscale)
        XCTAssertEqual(own.dead, [relay])
        // a current PC on the hosted origin that was never saved is set aside too
        let unsaved = Home.withoutHosted(saved: [tailscale], names: [:], ids: [:], current: relay, last: nil, hosted: hosted)
        XCTAssertEqual(unsaved.dead, [relay])
        XCTAssertNil(unsaved.current)
        // nothing on the hosted origin, nothing to say: what the shell inside the app saved since is not the hosted origin's
        let fresh = Home.withoutHosted(saved: [tailscale, "capacitor://app.ovis.sh/s/\(id)/"], names: [:], ids: [:], current: "capacitor://app.ovis.sh", last: nil, hosted: hosted)
        XCTAssertEqual(fresh.dead, [])
        XCTAssertEqual(fresh.saved, [tailscale, "capacitor://app.ovis.sh/s/\(id)/"])
        XCTAssertEqual(fresh.current, "capacitor://app.ovis.sh")
        // another build's hosted origin is not this one's
        XCTAssertEqual(Home.withoutHosted(saved: [relay], names: [:], ids: [:], current: nil, last: nil, hosted: URL(string: "https://relay-0510.ovis-app.pages.dev")).dead, [])
    }

    func testTheNoticeSaysWhatHappenedInThePhonesLanguage() {
        let english = Home.movedNotice(languages: ["en-US", "ko-KR"], kept: false)
        XCTAssertEqual(english.title, "Sign in again to get your PCs back")
        XCTAssertEqual(english.button, "Sign in again")
        XCTAssertTrue(english.body.contains("needs pairing again"))
        XCTAssertFalse(english.body.contains("still here"))
        XCTAssertTrue(Home.movedNotice(languages: ["en-GB"], kept: true).body.contains("still here"))
        XCTAssertEqual(Home.movedNotice(languages: ["ko-KR", "en-US"], kept: false).button, "다시 로그인")
        XCTAssertEqual(Home.movedNotice(languages: ["ja-JP"], kept: false).button, "もう一度サインイン")
        XCTAssertEqual(Home.movedNotice(languages: ["zh-Hans-CN"], kept: false).button, "重新登录")
        XCTAssertEqual(Home.movedNotice(languages: ["zh-Hant-TW"], kept: false).button, "重新登录")
        // any other language, and none, read English
        XCTAssertEqual(Home.movedNotice(languages: ["fr-FR", "ko-KR"], kept: false).title, english.title)
        XCTAssertEqual(Home.movedNotice(languages: [], kept: false).title, english.title)
        for language in ["en", "ko", "ja", "zh"] {
            let short = Home.movedNotice(languages: [language], kept: false), long = Home.movedNotice(languages: [language], kept: true)
            XCTAssertEqual(short.body.components(separatedBy: "\n\n").count, 2, language)
            XCTAssertEqual(long.body.components(separatedBy: "\n\n").count, 3, language)
            XCTAssertFalse(short.title.isEmpty || short.button.isEmpty, language)
        }
    }

    func testEveryPcsScopeIsTheOnePage() {
        for path in ["", "/", "/index.html", "/s/\(id)/", "/s/\(id)", "/s/\(id)/index.html", "/s/\(id)/anything/deeper", "/s/not-an-id/"] {
            XCTAssertEqual(ShellRoute.route(path), .page, path)
        }
    }

    func testTheRenderHostIsItsOwnFileNeverThePage() {
        XCTAssertEqual(ShellRoute.route("/s/\(id)/~render"), .render)
        // only at a PC's own render path: its file by any other address would get the shell's policy
        for path in ["/render.html", "/~render", "/s/~render", "/s/\(id)/~render/", "/s/\(id)/x/~render"] {
            XCTAssertNotEqual(ShellRoute.route(path), .render, path)
        }
        XCTAssertEqual(ShellRoute.route("/render.html"), .missing)
        XCTAssertEqual(ShellRoute.route("/s/\(id)/~render/"), .missing)
    }

    func testAFileIsServedByItsPathAndAMissingAssetIsNeverThePage() {
        XCTAssertEqual(ShellRoute.route("/assets/index-Ab3_x9-Zq1.js"), .file("assets/index-Ab3_x9-Zq1.js", orPage: false))
        XCTAssertEqual(ShellRoute.route("/assets/"), .file("assets", orPage: false))
        XCTAssertEqual(ShellRoute.route("/manifest.webmanifest"), .file("manifest.webmanifest", orPage: true))
        XCTAssertEqual(ShellRoute.route("/s/\(id)/manifest.webmanifest"), .file("manifest.webmanifest", orPage: false))
        XCTAssertEqual(ShellRoute.route("/icons/icon-192.png"), .file("icons/icon-192.png", orPage: true))
        // a path the folder has no file for is the page, as the hosted app's host answers it
        XCTAssertEqual(ShellRoute.route("/somewhere"), .file("somewhere", orPage: true))
        XCTAssertEqual(ShellRoute.route("/somewhere/"), .page)
    }

    func testWhatTheHostKeepsToItselfAndWhatWouldNotLoadAsWrittenIsMissing() {
        for path in ["/sw.js", "/s/\(id)/sw.js", "/_headers", "/_redirects", "/.well-known/assetlinks.json", "/s", "/s/",
                     "/assets/../index.html", "/s/\(id)/../../etc/passwd", "/./index.html", "/assets//x.js", "//evil.example/x",
                     "/assets/%2e%2e/x", "/assets/a%2Fb.js", "/assets\\x.js", "/_capacitor_file_/etc/passwd", "/_capacitor_http_interceptor_",
                     "/a b", "/a?b", "/a#b", "assets/x.js", "/assets/x.js\u{0}"] {
            XCTAssertEqual(ShellRoute.route(path), .missing, path)
        }
    }

    func testEachFileGoesOutUnderItsOwnType() {
        XCTAssertEqual(ShellRoute.contentType("index.html"), "text/html; charset=utf-8")
        XCTAssertEqual(ShellRoute.contentType("assets/index-abc.js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(ShellRoute.contentType("assets/index-abc.CSS"), "text/css; charset=utf-8")
        XCTAssertEqual(ShellRoute.contentType("assets/ghostty-vt-abc.wasm"), "application/wasm")
        XCTAssertEqual(ShellRoute.contentType("manifest.webmanifest"), "application/manifest+json")
        XCTAssertEqual(ShellRoute.contentType("assets/pretendard.subset.92-abc.woff2"), "font/woff2")
        XCTAssertEqual(ShellRoute.contentType("icons/icon.svg"), "image/svg+xml")
        XCTAssertEqual(ShellRoute.contentType("assets/unknown.bin"), "application/octet-stream")
        XCTAssertEqual(ShellRoute.contentType("LICENSE"), "application/octet-stream")
        XCTAssertEqual(ShellRoute.contentType("folder.js/file"), "application/octet-stream")
    }

    func testAShellWithoutBothPoliciesIsNotServed() {
        let both = Data(#"{"page":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'","render":"sandbox allow-scripts; default-src 'none'"}"#.utf8)
        XCTAssertEqual(ShellRoute.policies(both)?.shell, "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'")
        XCTAssertEqual(ShellRoute.policies(both)?.render, "sandbox allow-scripts; default-src 'none'")
        for broken in [#"{"page":"default-src 'self'"}"#, #"{"page":"","render":"sandbox"}"#, #"{"page":"default-src 'self'","render":" "}"#,
                       // the render host's policy is the one that takes a rendered page's origin away
                       #"{"page":"default-src 'self'","render":"default-src 'none'"}"#,
                       #"{"page":"default-src 'self'","render":"default-src 'none'; report-uri /sandbox"}"#,
                       // nothing that would start another header
                       #"{"page":"default-src 'self'\r\nX-Evil: 1","render":"sandbox allow-scripts"}"#,
                       #"["default-src 'self'","sandbox"]"#, "not json", ""] {
            XCTAssertNil(ShellRoute.policies(Data(broken.utf8)), broken)
        }
        XCTAssertNil(ShellRoute.policies(nil))
    }
}
