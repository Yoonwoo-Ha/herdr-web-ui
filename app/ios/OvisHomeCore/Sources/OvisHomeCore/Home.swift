import Foundation

/// Which screen the app opens, and what the hosted Connect a PC screen ("home") does while it is up: the decisions
/// alone, so HerdrBridgeViewController only carries them out (HomeTests; Home.java is the Android twin). Home is the
/// hosted app's front page opened as the web view's first page without being the current PC; the app's own bundled
/// page stands in for it when it cannot load.
public enum Home {
    /// What a view controller opens as its first page.
    public enum Screen {
        /// The current PC, at its own address.
        case pc
        /// The hosted Connect a PC screen.
        case home
        /// The app's own Connect a PC page (index.html): the fallback, what only it can take, or a build's first screen.
        case bundled
        /// The bundled demo.
        case demo
    }

    /// Where a view controller that opened home is.
    public enum Phase {
        /// Home has not shown yet: its cover is up.
        case loading
        case shown
        /// Home was given up on: the view controller is on its way out to the bundled page, and nothing moves it again.
        case fallback
        /// A relay PC's page came up in it: the hosted app is the current PC, and the rules of a PC's page decide.
        case pc
        /// The app is going elsewhere (a PC picked, Try again, another screen): what the page still does counts for nothing.
        case left
    }

    public enum Event: CaseIterable {
        /// Home's page is up (its client drew).
        case loaded
        /// A main-frame load failed, or answered with an HTTP error.
        case failed
        /// Home took too long (timedOut).
        case timedOut
        /// The web view went to a relay PC's page (relayPc).
        case relayPc
        /// The app was told to open something else, and this page is on its way out.
        case left
        /// The page's web content process died (iOS takes them from an app in the background too).
        case died
    }

    /// What the web view's navigation delegate reports about a main-frame load (`event(for:)`).
    public enum Signal {
        /// The load failed before a page came (didFailProvisionalNavigation); `onPurpose`: cancelled or handed off.
        case provisionalFailed(onPurpose: Bool)
        /// A page that had committed broke off (didFail), whenever in the screen's life that is.
        case failed(onPurpose: Bool)
        /// The document answered with an HTTP error.
        case httpError
        /// The address being opened led to another origin (a network's sign-in page).
        case redirectedElsewhere
        /// webViewWebContentProcessDidTerminate.
        case processDied
    }

    public enum Action {
        case none
        case liftCover
        /// The bundled page instead, marked as the fallback for this process.
        case fallBack
        /// The hosted app becomes the current PC, which ends choosing.
        case keepHosted
        /// Home once more from the start, with its cover and its clock.
        case retry
    }

    /// Where the way back leads: the page's own back control on iOS, the phone's Back on Android.
    public enum Back {
        /// A step back in the page's own history.
        case page
        /// The PC the screen was opened from to choose another.
        case current
        /// Home again.
        case home
        /// Out of the demo, to the screen it was opened over.
        case demoExit
        /// Nowhere (on Android the system's Back, which leaves the app).
        case leave
    }

    /// How long home may take to answer before the bundled page stands in.
    public static let loadSeconds: TimeInterval = 8

    /// How long a page that answered may take to come up, as long as a PC gets to answer.
    public static let answerSeconds: TimeInterval = 20

    /// The screen a view controller starts on. `hosted`: the build's first screen is the hosted one (OVIS_APP_HOME);
    /// `pc`: a PC is to open (none while the person chooses another); `demo`: the demo was asked for (HerdrShell
    /// openDemo); `asked`: something waits that only the bundled page takes (an SSH setup, an SSH PC whose address
    /// another app holds); `failed`: home did not load in this process and was not tried again since.
    public static func screen(hosted: Bool, pc: Bool, demo: Bool, asked: Bool, failed: Bool) -> Screen {
        if asked && !pc { return .bundled }
        if demo { return .demo }
        if pc { return .pc }
        return hosted && !failed ? .home : .bundled
    }

    /// `retried`: a web content process already died under this attempt at home (`died`), so the next death falls back.
    public static func on(_ phase: Phase, _ event: Event, retried: Bool = false) -> Action {
        if phase == .fallback || phase == .pc || phase == .left { return .none }
        switch event {
        case .loaded: return phase == .loading ? .liftCover : .none
        case .failed: return .fallBack
        case .timedOut: return phase == .loading ? .fallBack : .none
        case .relayPc: return .keepHosted
        case .left: return .none
        case .died: return retried ? .fallBack : .retry
        }
    }

    public static func after(_ phase: Phase, _ event: Event, retried: Bool = false) -> Phase {
        if event == .left, phase == .loading || phase == .shown { return .left }
        switch on(phase, event, retried: retried) {
        case .liftCover: return .shown
        case .fallBack: return .fallback
        case .keepHosted: return .pc
        case .retry: return .left
        case .none: return phase
        }
    }

    /// The event a report of the navigation delegate stands for, nil for a load cancelled on purpose (a new
    /// navigation, a link handed to Safari), which is no failure.
    public static func event(for signal: Signal) -> Event? {
        switch signal {
        case .provisionalFailed(let onPurpose), .failed(let onPurpose): return onPurpose ? nil : .failed
        case .httpError, .redirectedElsewhere: return .failed
        case .processDied: return .died
        }
    }

    /// Whether the hosted app's own screen is up, from what its page says: `shell`, it names itself the hosted app
    /// (`<meta name="ovis-shell">`, which the released front page and the next both carry); `root`, `boot`,
    /// `children`, its root is there, without index.html's loading spinner, holding what the client rendered;
    /// `loading`, the document is still arriving. An empty 200 or another page of that origin (a maintenance page) is
    /// not home, so the cover stays and the clock goes on.
    public static func drawn(shell: Bool, root: Bool, boot: Bool, children: Int, loading: Bool) -> Bool {
        shell && root && !boot && children > 0 && !loading
    }

    /// `drawn` from the JSON the page's facts come back as (HerdrBridgeViewController's homeScript); anything
    /// unreadable is not home.
    public static func drawn(page: String?) -> Bool {
        guard let data = page?.data(using: .utf8), let facts = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let shell = facts["shell"] as? Bool, let root = facts["root"] as? Bool, let boot = facts["boot"] as? Bool,
              let children = facts["children"] as? Int, let loading = facts["loading"] as? Bool else { return false }
        return drawn(shell: shell, root: root, boot: boot, children: children, loading: loading)
    }

    /// Whether a PC's own page is what is on screen: a PC opened as one, or a relay PC's page that came up in home.
    public static func pcShown(screen: Screen, phase: Phase?) -> Bool {
        phase.map { $0 == .pc } ?? (screen == .pc)
    }

    /// How long home has waited with the app in front, in seconds on any one clock: each look (`tick`) adds the time
    /// since the look before, a second at most; nothing is added between leaving the front (`away`) and coming back
    /// (`resumed`), whether or not looks go on meanwhile (iOS lets an app run on for a while behind another).
    public struct Clock {
        private var waited: TimeInterval = 0
        private var seenAt: TimeInterval
        private var isAway = false

        public init(now: TimeInterval) {
            seenAt = now
        }

        @discardableResult
        public mutating func tick(now: TimeInterval) -> TimeInterval {
            if !isAway { waited += max(0, min(now - seenAt, 1)) }
            seenAt = now
            return waited
        }

        public mutating func away(now: TimeInterval) {
            tick(now: now)
            isAway = true
        }

        public mutating func resumed(now: TimeInterval) {
            isAway = false
            seenAt = now
        }
    }

    /// Whether home took too long, `elapsed` seconds after it started (time the app spent in front): `loadSeconds`
    /// with no answer, and `answerSeconds` once its page is on its way, which a slow link needs.
    public static func timedOut(elapsed: TimeInterval, answered: Bool) -> Bool {
        elapsed >= (answered ? answerSeconds : loadSeconds)
    }

    /// Where the way back leads on `screen`. `failed` as for `screen`; `current`: a PC is current; `choosing`: the
    /// screen is up to choose another PC, with that one still current; `pageHasBack`: the page has a step of its own to
    /// take first. The bundled page while choosing goes back to the PC at once, as it always did.
    public static func back(screen: Screen, hosted: Bool, failed: Bool, current: Bool, choosing: Bool, pageHasBack: Bool) -> Back {
        if screen == .bundled && choosing { return .current }
        if pageHasBack { return .page }
        switch screen {
        case .home: return choosing ? .current : .leave
        case .demo: return .demoExit
        case .bundled:
            if !hosted { return .leave }
            // opened over a PC that nobody left (an SSH setup cancelled): that PC is what opens next
            if current { return .current }
            // home handed over to this page (an SSH setup): the fallback never goes back by itself
            return failed ? .leave : .home
        case .pc: return .leave
        }
    }

    /// The fragment home starts at when `text` is the hosted app's front page at `appOrigin`, as the app's own page
    /// opens it for a sign-in (`#sign-in=<provider>`) or its saved row (`#pcs`, which a bare address means too); nil
    /// for anything else, which opens as a PC does. Such an open is an attempt at home: nothing is made the current PC
    /// by it.
    public static func homeStart(_ text: String?, appOrigin: URL?) -> String? {
        guard let text, let url = URL(string: text), sameOrigin(url, appOrigin),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: true),
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/", parts.percentEncodedQuery == nil else { return nil }
        guard let fragment = parts.percentEncodedFragment, !fragment.isEmpty, fragment != "pcs" else { return "#pcs" }
        let provider = fragment.dropFirst("sign-in=".count)
        guard fragment.hasPrefix("sign-in="), (1...32).contains(provider.utf8.count),
              provider.utf8.allSatisfy({ (UInt8(ascii: "a")...UInt8(ascii: "z")).contains($0) }) else { return nil }
        return "#" + fragment
    }

    /// Whether `url` and `appOrigin` are one http or https origin: scheme, host and port, the scheme's own port the
    /// same as none.
    private static func sameOrigin(_ url: URL?, _ appOrigin: URL?) -> Bool {
        guard let url, let appOrigin, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              scheme == appOrigin.scheme?.lowercased(), let host = url.host?.lowercased(), host == appOrigin.host?.lowercased() else { return false }
        let standard = scheme == "https" ? 443 : 80
        return (url.port ?? standard) == (appOrigin.port ?? standard)
    }

    /// Whether `url` is a page of a relay PC on the hosted app at `appOrigin`: within `/s/<server_id>/`, as a browser
    /// loads it (no `.` or `..` segment, plain or percent-encoded, no encoded `/` and no `\`).
    public static func relayPc(_ url: URL?, appOrigin: URL?) -> Bool {
        relayScope(url, appOrigin: appOrigin) != nil
    }

    /// The scope of the relay PC whose page `url` is (`<appOrigin>/s/<server_id>/`, the key such a PC is saved by), or nil.
    public static func relayScope(_ url: URL?, appOrigin: URL?) -> String? {
        guard let url, let appOrigin, sameOrigin(url, appOrigin), let scheme = appOrigin.scheme?.lowercased(), let host = appOrigin.host?.lowercased(),
              let path = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath else { return nil }
        let lower = path.lowercased()
        if path.contains("\\") || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("%25") { return nil }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        // "", "s", the PC's id, then anything within it
        guard segments.count >= 3, segments[0].isEmpty, segments[1] == "s", !segments.contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        let id = segments[2]
        guard id.utf8.count == 32, id.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }) else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return "\(scheme)://\(shownHost)\(appOrigin.port.map { ":\($0)" } ?? "")/s/\(id)/"
    }

    /// The kind of a page's failure the error page tells apart by its words: "offline" when the system says this phone is
    /// not connected to the internet (NSURLErrorNotConnectedToInternet), so the page says so instead of blaming the PC;
    /// nil for any other, which the error page explains from the address.
    public static func failureKind(domain: String, code: Int) -> String? {
        domain == NSURLErrorDomain && code == NSURLErrorNotConnectedToInternet ? "offline" : nil
    }

    /// Whether `text` is what the word "demo" becomes in the hosted screen's address field (`https://demo/`): the
    /// bundled demo, as that word opens it on the bundled page. No PC answers there: a one-word name has no certificate.
    public static func demoAddress(_ text: String?) -> Bool {
        guard let text, let parts = URLComponents(string: text) else { return false }
        return parts.scheme?.lowercased() == "https" && parts.host?.lowercased() == "demo" && parts.port == nil
            && (parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/") && parts.query == nil && parts.fragment == nil
            && parts.user == nil && parts.password == nil
    }

    /// How long the app's own page may take to come up at first: its files are in the app.
    public static let ownPageSeconds: TimeInterval = 6

    /// Whether the app's own page (the fallback, or a build's first screen) has to be built again in a new web view:
    /// it has not come up `elapsed` seconds in (time in front). `tries`: how often it was built again already, each
    /// try getting twice the room of the one before, 48 seconds at most, so a phone that is only slow gets its page.
    /// The page that stands in when the hosted screen fails must never itself be a dark screen with no way on.
    public static func ownPageStalled(elapsed: TimeInterval, loaded: Bool, tries: Int) -> Bool {
        !loaded && elapsed >= min(ownPageSeconds * pow(2, Double(min(max(tries, 0), 3))), 48)
    }

    /// Whether a native cover ("Opening Ovis…", Try again) is over the app's own page: once it has not come up in a
    /// second and a half, and from the first moment of a web view built again, so the screen is never empty.
    public static func ownPageCover(elapsed: TimeInterval, loaded: Bool, tries: Int) -> Bool {
        !loaded && (tries > 0 || elapsed >= 1.5)
    }

    /// Whether an open of `text` is the demo: the word "demo" as an address, on home alone. Anywhere else that address
    /// is a PC's, as it always was.
    public static func opensDemo(_ text: String?, atHome: Bool) -> Bool {
        atHome && demoAddress(text)
    }
}
