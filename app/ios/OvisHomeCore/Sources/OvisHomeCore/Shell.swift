import Foundation

/// The shell served from inside the app (docs/native-app.md, The shell inside the app): a build made with
/// OVIS_APP_SHELL=bundled carries the hosted app's files and serves them itself at `capacitor://<the hosted origin's
/// host>`, never from the network. What is decided here is carried out by ShellHost.swift, PCStore and the plugins.
extension Home {
    /// The scheme of the pages the app serves itself: its own (`capacitor://localhost`) and, in such a build, the shell's.
    public static let appScheme = "capacitor"

    /// The host of the app's own pages (app/web), which is never the shell's.
    public static let bundledHost = "localhost"

    /// Where the shell's pages are: the hosted origin itself (`hosted`, the build's OvisAppOrigin), or, in a build
    /// that serves the shell from inside the app (`bundled`), that origin's host on the app's own scheme. Nil where
    /// nothing is the shell: no hosted origin, or one whose host is the app's own pages' or is no plain DNS name.
    public static func shellOrigin(hosted: URL?, bundled: Bool) -> URL? {
        guard bundled else { return hosted }
        guard let host = hosted?.host?.lowercased(), !host.isEmpty, host != bundledHost,
              host.utf8.allSatisfy({ plainHostByte($0) }) else { return nil }
        return URL(string: "\(appScheme)://\(host)")
    }

    private static func plainHostByte(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
            || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "-")
    }

    /// Whether `url` is one of the app's own bundled pages (app/web: the connect page, the error page, the demo), by
    /// its scheme and host, which a page cannot choose: the shell a build serves from inside the app is on the same
    /// scheme at another host, and is not one. Only these pages manage SSH PCs. The host as it is written, with no
    /// port: another spelling is another origin to WebKit.
    public static func bundledPage(_ url: URL?) -> Bool {
        url?.scheme?.lowercased() == appScheme && url?.host == bundledHost && url?.port == nil
    }

    /// Whether a frame's origin, as WebKit reports it (`scheme`, `host`, and `port`, 0 for the scheme's own), is the
    /// shell's at `shell` (shellOrigin): the hosted app over https, or its copy inside the app on the app's own
    /// scheme, at its host as written and with no port. Plain http is never the shell.
    public static func shellFrame(scheme: String, host: String, port: Int, shell: URL?) -> Bool {
        guard let shell, let shellScheme = shell.scheme?.lowercased(), let shellHost = shell.host, !shellHost.isEmpty, scheme == shellScheme else { return false }
        if shellScheme == appScheme { return host == shellHost && port == 0 && shell.port == nil && shellHost != bundledHost }
        return shellScheme == "https" && host.lowercased() == shellHost.lowercased() && (port == 0 ? 443 : port) == (shell.port ?? 443)
    }

    /// Whether the app's own pages' host (`capacitor://localhost`) answers the path `path` (percent-encoded, as a
    /// request's URL carries it) in a build that carries the shell. Capacitor answers that host with the file at its
    /// pages' folder plus the path once decoded, and with any file of the phone under `/_capacitor_file_`: so
    /// `..%2Fbundled-shell%2F…` would hand a page the shell's render host with no policy, on the origin of the app's
    /// own pages. Refused: a `.` or `..` segment once decoded (and one still encoded after that), an encoded `/` or
    /// `\`, a `\`, a NUL, and every `/_capacitor_…` path, none of which the app's own pages use.
    public static func ownPagePath(_ path: String) -> Bool {
        guard path.isEmpty || path.hasPrefix("/"), !path.contains("\\"), !path.utf8.contains(0) else { return false }
        let lower = path.lowercased()
        if lower.contains("%2f") || lower.contains("%5c") || lower.contains("%00") { return false }
        guard let decoded = path.removingPercentEncoding, !decoded.contains("\\"), !decoded.utf8.contains(0) else { return false }
        let twice = decoded.lowercased()
        if twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c") { return false }
        if decoded.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) { return false }
        return !twice.hasPrefix("/_capacitor_")
    }

    /// Whether `url` is a web address (http or https, any port) at the hosted origin's host, however that host is
    /// written: any case, a trailing dot, percent-escapes. In a build that serves the shell itself no such address is
    /// a PC and none loads in the app's web view: behind it is the network's copy of the shell, with the keys the
    /// update set aside.
    public static func hostedHost(_ url: URL?, hosted: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let wanted = hosted?.host.map(plainHost), !wanted.isEmpty, let host = url.host.map(plainHost) else { return false }
        return host == wanted
    }

    private static func plainHost(_ host: String) -> String {
        var name = (host.removingPercentEncoding ?? host).lowercased()
        while name.hasSuffix(".") { name.removeLast() }
        return name
    }

    /// The key of the origin a page at `url` belongs to, as the app saves and opens a PC by it, or nil for an address
    /// that is no PC's: `scheme://host[:port]` of an http or https URL, the host in lowercase as WebKit reports it.
    /// In a build that serves the shell itself (`bundled`) also the shell's origin (`shell`) for a page of it, at its
    /// host as written and with no port, and of no other host on the app's scheme (the app's own pages are never a
    /// PC); and there no web address at the hosted origin's host (`hosted`) is one, so nothing opens the network's copy
    /// of the shell.
    public static func pcOrigin(_ url: URL, hosted: URL?, shell: URL?, bundled: Bool) -> String? {
        if url.scheme?.lowercased() == appScheme {
            guard bundled, let shell, shell.scheme?.lowercased() == appScheme, sameOrigin(url, shell), let host = shell.host, host != bundledHost else { return nil }
            return "\(appScheme)://\(host)"
        }
        if bundled, hostedHost(url, hosted: hosted) { return nil }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(shownHost):\($0)" } ?? "\(scheme)://\(shownHost)"
    }

    /// What a web view's check of what answers the app's scheme in it comes to (ShellHost.verify, before the web view
    /// loads anything): whether it may `load`, and whether the shell is `failed` from then on. `serving`: the build
    /// serves the shell itself; `failed`: an earlier web view failed this check; `capacitors`: the handler is
    /// Capacitor's own class and no other; `wrapped`: that class's entry point is the one ShellHost put there.
    /// A web view that fails loads nothing, and nothing is the shell after it. The ones that follow are not refused in
    /// their turn: with no shell there is nothing a handler could answer without its policy, and they are what
    /// stands in, the app's own page and a PC at its own address, as in a build that carries no shell. (Refusing
    /// them too would build one web view after another and never reach that page.)
    public static func handlerCheck(serving: Bool, failed: Bool, capacitors: Bool, wrapped: Bool) -> (load: Bool, failed: Bool) {
        guard serving, !failed else { return (true, failed) }
        return capacitors && wrapped ? (true, false) : (false, true)
    }

    /// Whether the app's own page says "Ovis's own screens did not open here" (getState `stuck`). `carries`: the build
    /// is one that carries the shell; `serving`: it serves it now (its files and policies are there, and no web view
    /// failed handlerCheck); `attempt`: home did not draw and the person asked for the app's own page instead, until
    /// the shell draws again. A build that carries a shell it cannot serve says so from the start.
    public static func shellStuck(carries: Bool, serving: Bool, attempt: Bool) -> Bool {
        carries && (!serving || attempt)
    }

    /// Whether the cover over home in a build that serves the shell itself offers the app's own page ("Open the
    /// connect page"): home has not drawn `elapsed` seconds in (time in front). Nothing is loaded from the network in
    /// its place, and no clock gives up on it by itself (timedOut), so a shell that never draws (a start-up error on
    /// an old iOS, files missing from the app) still leaves a way to a PC.
    public static func ownPageOffer(elapsed: TimeInterval) -> Bool {
        elapsed >= loadSeconds
    }

    /// `text` (an address a page, a link or a QR code gave) as this build opens it: an address on the hosted origin
    /// (`hosted`) becomes the same page of the shell inside the app (`shell`), path, query and fragment kept, so a
    /// pairing link or a sign-in made for https://app.ovis.sh never loads from the network. Anything else, and
    /// everything in a build whose shell is the hosted origin, is as it was.
    public static func shellForm(_ text: String, hosted: URL?, shell: URL?) -> String {
        moved(text, from: hosted, to: shell)
    }

    /// The other way round, for the app's own pages (app/web), which name the shell by the hosted origin on both
    /// platforms: a key the app saved on the shell inside the app, as an address on the hosted origin.
    public static func hostedForm(_ text: String, hosted: URL?, shell: URL?) -> String {
        moved(text, from: shell, to: hosted)
    }

    private static func moved(_ text: String, from: URL?, to: URL?) -> String {
        guard let from, let to, !sameOrigin(from, to), let url = URL(string: text), sameOrigin(url, from),
              let parts = URLComponents(string: text), let origin = originText(to) else { return text }
        return origin + parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "") + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
    }

    private static func originText(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        return "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)\(url.port.map { ":\($0)" } ?? "")"
    }

    /// The address to load instead of `url`, which a page of the shell inside the app is going to in the main frame,
    /// or nil to let it go: the hosted origin's twin of a page (a link written for https://app.ovis.sh) is that page
    /// inside the app, and a PC's scope named without its slash gets it, as the hosted app's host redirects it
    /// (scripts/shell-build.ts shellRedirects), so what the page names relative to itself stays within the scope.
    public static func shellNavigation(_ url: URL, hosted: URL?, shell: URL?) -> URL? {
        guard let shell, !sameOrigin(hosted, shell) else { return nil }
        let text = shellForm(url.absoluteString, hosted: hosted, shell: shell)
        guard let moved = URL(string: text), sameOrigin(moved, shell), var parts = URLComponents(string: text) else { return nil }
        let segments = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        if segments.count == 3, segments[0].isEmpty, segments[1] == "s", !segments[2].isEmpty { parts.percentEncodedPath += "/" }
        guard let next = parts.url, next.absoluteString != url.absoluteString else { return nil }
        return next
    }

    /// Whether `url` is a render host's address on the shell inside the app (`/s/<id>/~render` at `shell`), which is
    /// only ever a frame of a shell page: the web view never goes there itself. (Asked for as the web view's own page
    /// it is answered with nothing too, ShellAnswer.)
    public static func renderHostAddress(_ url: URL?, shell: URL?) -> Bool {
        guard let url, let shell, shell.scheme?.lowercased() == appScheme, sameOrigin(url, shell) else { return false }
        return ShellRoute.route(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? "") == .render
    }

    /// The script the app runs at the start of every main-frame document in a build that serves the shell itself:
    /// on a page of the shell (`shell`) it sets `window.__ovisAppShell = { bundled: true, platform: "ios", appVersion,
    /// build }`, the client's word that its copy is the app's (no service worker, no reload for a newer copy, the
    /// "Update the app" screen). On any other page it sets nothing: a PC's own page is that PC's copy, and the app's
    /// own pages and the demo are not the shell. The object grants nothing; what a page may ask is decided by where it
    /// was loaded from. Nil where nothing is the shell inside the app.
    public static func appShellScript(shell: URL?, version: String, build: Int) -> String? {
        guard let shell, shell.scheme?.lowercased() == appScheme, let host = shell.host?.lowercased(), !host.isEmpty, host != bundledHost,
              let data = try? JSONSerialization.data(withJSONObject: ["bundled": true, "platform": "ios", "appVersion": version, "build": build], options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8),
              let at = try? JSONSerialization.data(withJSONObject: [host], options: []), let hosts = String(data: at, encoding: .utf8) else { return nil }
        // JSON is not all JavaScript: U+2028 and U+2029 end a line there
        let literal = value.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "(() => { if (location.protocol !== \"\(appScheme):\" || location.host !== \(hosts)[0]) return; "
            + "Object.defineProperty(window, \"__ovisAppShell\", { value: Object.freeze(\(literal)), enumerable: true }); })();"
    }

    /// What the app keeps of the PCs it saved once its shell moved inside the app: `saved`, `names`, `ids`, `current`
    /// and `last` without what was tied to the hosted origin (`hosted`), which no longer opens: the hosted app itself
    /// and every relay PC's scope there, whose sign-in and pairing keys are the hosted origin's own storage, and any
    /// other web address at that host (hostedHost). A PC opened at its own address (a Tailscale or home network
    /// address, any other, an SSH PC's on this phone) keeps its page, its cookie and its place. `dead`: what was taken
    /// out, in its order, for the caller to set aside.
    public static func withoutHosted(saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, hosted: URL?)
        -> (saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, dead: [String]) {
        without(saved: saved, names: names, ids: ids, current: current, last: last) { hostedHost(URL(string: $0), hosted: hosted) }
    }

    /// The other way round, in a build that loads the shell from the network (a test build installed over one that
    /// served it itself): without the entries on the app's own scheme, whose pages such a build does not have.
    public static func withoutInApp(saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?)
        -> (saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, dead: [String]) {
        without(saved: saved, names: names, ids: ids, current: current, last: last) { URL(string: $0)?.scheme?.lowercased() == appScheme }
    }

    private static func without(saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, tied: (String) -> Bool)
        -> (saved: [String], names: [String: String], ids: [String: String], current: String?, last: String?, dead: [String]) {
        var dead = saved.filter(tied)
        for key in [current, last].compactMap({ $0 }) where tied(key) && !dead.contains(key) { dead.append(key) }
        return (saved.filter { !tied($0) }, names.filter { !tied($0.key) }, ids.filter { !tied($0.key) },
                current.flatMap { tied($0) ? nil : $0 }, last.flatMap { tied($0) ? nil : $0 }, dead)
    }

    /// The saved PCs with what an earlier build of the other kind set aside put back, for a build that can open it
    /// again: after the ones this build saved since, each once; a name or a relay ID kept since stays.
    public static func restored(saved: [String], names: [String: String], ids: [String: String], aside: [String], asideNames: [String: String], asideIds: [String: String])
        -> (saved: [String], names: [String: String], ids: [String: String]) {
        var back = saved
        for key in aside where !back.contains(key) { back.append(key) }
        return (back, names.merging(asideNames.filter { aside.contains($0.key) }) { kept, _ in kept }, ids.merging(asideIds.filter { aside.contains($0.key) }) { kept, _ in kept })
    }

    /// The words of the screen an update to a build with the shell inside the app shows once, to a phone that had
    /// signed in or paired a PC on the hosted origin: what happened and what to do. `languages`: the phone's, the
    /// first decides (Korean, Japanese, Chinese, else English). `kept`: PCs opened at their own address are still
    /// there, which one more line says. `alerts`: one of the PCs set aside sends this phone alerts, which the app
    /// cannot stop from here (they are encrypted for the phone's one key, whichever pairing they are for): one more
    /// line says where they stop.
    public static func movedNotice(languages: [String], kept: Bool, alerts: Bool = false) -> (title: String, body: String, button: String) {
        let first = languages.first?.lowercased() ?? ""
        let words: (title: String, reset: String, pair: String, kept: String, alerts: String, button: String)
        if first.hasPrefix("ko") {
            words = ("다시 로그인하면 PC가 돌아와요", "이번 업데이트로 이 휴대폰이 로그아웃되고, 페어링한 PC가 초기화됐어요.",
                     "계정 없이 QR 코드나 링크로 페어링한 PC는 다시 페어링해야 해요.", "주소, Tailscale, SSH로 여는 PC는 그대로 있어요.",
                     "예전 알림이 계속 오거나 두 번 올 수 있어요. PC의 설정 → 기기와 PC에서 이 휴대폰의 예전 항목을 지우면 멈춰요.", "다시 로그인")
        } else if first.hasPrefix("ja") {
            words = ("もう一度サインインすると PC が戻ります", "今回のアップデートで、このスマートフォンはサインアウトされ、ペアリングした PC がリセットされました。",
                     "アカウントなしで QR コードやリンクからペアリングした PC は、もう一度ペアリングが必要です。", "アドレス、Tailscale、SSH で開く PC はそのまま残っています。",
                     "以前の通知が届き続けたり、2 回届いたりすることがあります。PC の設定 → デバイスと PC でこのスマートフォンの古い項目を削除すると止まります。", "もう一度サインイン")
        } else if first.hasPrefix("zh") {
            words = ("重新登录即可找回你的电脑", "这次更新让这部手机退出了登录，并重置了已配对的电脑。",
                     "未使用账号、通过二维码或链接配对的电脑需要重新配对。", "通过地址、Tailscale 或 SSH 打开的电脑仍然保留。",
                     "更新前的通知可能仍会收到，或收到两次。在电脑的设置 → 设备和电脑中移除这部手机的旧条目即可停止。", "重新登录")
        } else {
            words = ("Sign in again to get your PCs back", "This update signed this phone out and reset the PCs paired on it.",
                     "A PC paired without an account, by a QR code or a link, needs pairing again.", "The PCs you open by an address, Tailscale or SSH are still here.",
                     "Alerts from before the update may keep coming, or come twice. They stop once you remove this phone's old entry on the PC, in Settings → Devices and PCs.", "Sign in again")
        }
        return (words.title, ([words.reset, words.pair] + (kept ? [words.kept] : []) + (alerts ? [words.alerts] : [])).joined(separator: "\n\n"), words.button)
    }
}

/// What the app answers a request to the shell inside the app with (ShellHost.swift), as the hosted app's host
/// answers the same path (scripts/shell-build.ts: shellRedirects, shellHeaders): the one page under every PC's scope,
/// the render host and the manifest there, a file by its own path, and nothing where the host has no file to give.
public enum ShellRoute: Equatable {
    /// The shell's page (`pageFile`), with the shell's policy.
    case page
    /// The render host's document (`renderFile`, at `/s/<id>/~render`), with the render host's own policy and never
    /// the shell's.
    case render
    /// The file at this path within the shell's folder, with the shell's policy; `orPage`: the page where the folder
    /// has no such file, as the hosted app's host answers a path it lacks (a single-page app), never under `assets/`.
    case file(String, orPage: Bool)
    case missing

    /// What the app's copy names the shell's two documents, its index.html and render.html (app/ios/carry-shell.sh
    /// renames them as it copies the shell in): by an extension no host answers as a page. Capacitor answers the app's
    /// own host with any file its folder reaches, typed by its extension, so under their own names a way past
    /// `ownPagePath`, or a start where this app's handler is not in front of Capacitor's, would hand out the render
    /// host as a page of the app's own pages' origin with no policy. As they are, Capacitor has only bytes to give.
    public static let documentExtension = "shellpage"
    public static let pageFile = "index.\(documentExtension)"
    public static let renderFile = "render.\(documentExtension)"

    /// The route of a request's path as its URL carries it (percent-encoded). A path that would not load as written
    /// is missing: an escape, a `\\`, an empty, `.` or `..` segment, or a character no file of the shell has.
    public static func route(_ path: String) -> ShellRoute {
        if path.isEmpty || path == "/" { return .page }
        guard path.hasPrefix("/"), path.utf8.allSatisfy({ pathByte($0) }) else { return .missing }
        var segments = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // a folder named with its slash
        if segments.last == "" { segments.removeLast() }
        guard !segments.isEmpty, !segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return .missing }
        if segments[0] == "s" {
            // /s alone names no PC
            guard segments.count >= 2 else { return .missing }
            let rest = Array(segments.dropFirst(2))
            if rest == ["~render"] { return path.hasSuffix("/") ? .missing : .render }
            if rest == ["manifest.webmanifest"] { return .file("manifest.webmanifest", orPage: false) }
            // no service worker in the app: its web view has none
            if rest == ["sw.js"] { return .missing }
            return .page
        }
        if segments == ["index.html"] { return .page }
        // what the hosted app's host keeps to itself or serves for a browser alone: its rules, the worker, the app
        // links' files; and the two documents by their names in the app, the render host's under any path but a PC's
        // too, where it would get the shell's policy
        if segments[0].hasPrefix("_") || segments[0].hasPrefix(".") || segments == ["sw.js"] || segments == ["render.html"]
            || segments.last?.lowercased().hasSuffix("." + documentExtension) == true { return .missing }
        // a hashed file the folder lacks is missing, never the page under a script's or a stylesheet's address
        let asset = segments[0] == "assets"
        if path.hasSuffix("/"), !asset { return .page }
        return .file(segments.joined(separator: "/"), orPage: !asset)
    }

    private static func pathByte(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
            || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) || "/._~-@+".utf8.contains(byte)
    }

    /// The Content-Type of a file of the shell by its extension. A module script and a WebAssembly module load only
    /// under their own types.
    public static func contentType(_ name: String) -> String {
        let file = name.split(separator: "/").last ?? ""
        guard let dot = file.lastIndex(of: "."), dot != file.startIndex else { return "application/octet-stream" }
        return types[file[file.index(after: dot)...].lowercased()] ?? "application/octet-stream"
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "map": "application/json",
        "webmanifest": "application/manifest+json", "wasm": "application/wasm", "txt": "text/plain; charset=utf-8",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon",
        "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf",
        "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm"
    ]

    /// The two policies the hosted app's host sends, as the build read them from the carried copy's own `_headers`
    /// and wrote them beside it (shell-policy.json, app/scripts/bundled-shell.ts: `page` for every answer, `render`
    /// for the render host alone), or nil when either is missing, empty, or could start another header, or the render
    /// host's does not take a rendered page's origin away (`sandboxed`): a shell without its policies is not served.
    public static func policies(_ data: Data?) -> (shell: String, render: String)? {
        guard let data, let read = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let shell = read["page"] as? String, let render = read["render"] as? String,
              headerValue(shell), headerValue(render), sandboxed(render) else { return nil }
        return (shell, render)
    }

    /// Whether the policy `policy` takes its document's origin away: it has a `sandbox` directive, and none of them
    /// holds `allow-same-origin`, which would hand the origin back. The render host's answer is the shell's origin by
    /// its address, so a page drawn there under such a policy would read the shell's storage and call what the shell
    /// may; the frame's own sandbox is a second lock, not this one.
    public static func sandboxed(_ policy: String) -> Bool {
        let sandboxes = policy.split(separator: ";").map { $0.split(whereSeparator: { $0 == " " || $0 == "\t" }).map { $0.lowercased() } }.filter { $0.first == "sandbox" }
        return !sandboxes.isEmpty && !sandboxes.contains { $0.contains("allow-same-origin") }
    }

    private static func headerValue(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespaces).isEmpty && text.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value < 0x7f }
    }
}

/// The app's answer to one request for the shell inside the app (ShellHost.swift sends it): status, headers and the
/// file whose bytes are the body. Every answer carries a policy, the render host's its own and never the shell's.
public struct ShellAnswer {
    public let status: Int
    public let headers: [String: String]
    /// The file the body is read from; nil where `text` is the body.
    public let file: URL?
    public let text: String

    /// `path`: the request's path as its URL carries it; `method`: GET or HEAD, anything else is refused;
    /// `mainDocument`: the request is for the page the web view shows itself, not for a frame or a file of a page;
    /// `folder`: the carried shell's files; `policies`: that copy's own (ShellRoute.policies).
    public static func make(path: String, method: String?, mainDocument: Bool, folder: URL, policies: (shell: String, render: String)) -> ShellAnswer {
        let verb = method?.uppercased() ?? "GET"
        guard verb == "GET" || verb == "HEAD" else { return plain(405, "Method not allowed", policies.shell) }
        let root = folder.resolvingSymlinksInPath()
        let name: String, type: String, policy: String
        switch ShellRoute.route(path) {
        case .page:
            (name, type, policy) = (ShellRoute.pageFile, html, policies.shell)
        case .render:
            // drawn only in a frame a page of the shell made (its sandbox takes the frame's origin away): as the page
            // the web view shows itself it would take whatever opened it for its parent
            if mainDocument { return plain(404, "Not found", policies.shell) }
            (name, type, policy) = (ShellRoute.renderFile, html, policies.render)
        case .file(let file, let orPage):
            if regular(file, in: root) != nil || !orPage { (name, type, policy) = (file, ShellRoute.contentType(file), policies.shell) }
            else { (name, type, policy) = (ShellRoute.pageFile, html, policies.shell) }
        case .missing:
            return plain(404, "Not found", policies.shell)
        }
        guard let file = regular(name, in: root), let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize else { return plain(404, "Not found", policies.shell) }
        return ShellAnswer(status: 200, headers: headers(type: type, length: size, policy: policy), file: file, text: "")
    }

    private static let html = "text/html; charset=utf-8"

    private static func plain(_ status: Int, _ text: String, _ policy: String) -> ShellAnswer {
        ShellAnswer(status: status, headers: headers(type: "text/plain; charset=utf-8", length: text.utf8.count, policy: policy), file: nil, text: text)
    }

    private static func headers(type: String, length: Int, policy: String) -> [String: String] {
        // as Capacitor answers its own files: they are the app's, read again at each load
        ["Content-Type": type, "Content-Length": String(length), "Cache-Control": "no-cache", "Content-Security-Policy": policy]
    }

    /// The file `name` names within `root`, or nil: a regular file there and nowhere else.
    private static func regular(_ name: String, in root: URL) -> URL? {
        let file = root.appendingPathComponent(name).resolvingSymlinksInPath()
        var isFolder: ObjCBool = false
        guard file.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isFolder), !isFolder.boolValue else { return nil }
        return file
    }
}
