import Capacitor
import Foundation
import ObjectiveC
import OvisHomeCore
import UIKit
import WebKit

/// The shell inside the app (docs/native-app.md, The shell inside the app): a build made with OVIS_APP_SHELL=bundled
/// carries the hosted app's files (app/bundled-shell, app/scripts/bundled-shell.ts, copied in by carry-shell.sh) and
/// answers `capacitor://<the hosted origin's host>/…` from them, as the hosted app's host answers the same paths
/// (ShellRoute, ShellAnswer), with the policy that host sends as a response header: the shell's on every answer, the
/// render host's own on `/s/<id>/~render`.
///
/// Capacitor registers one handler for the app's scheme, sends no header but the type, and has no setting for either
/// (its view controller's loadView is final, and the package is a built framework, so a patch does not reach it). So
/// this stands in front of that handler's one entry point: a request for the shell's host is answered here, one for
/// the app's own pages (`capacitor://localhost`) goes on to Capacitor only for a path of those pages
/// (Home.ownPagePath: Capacitor would answer that host with any file of the app, the carried shell's among them, and
/// with any file of the phone), and any other host on the scheme gets nothing. Where that cannot be put in place, or
/// the build's shell or its policies are missing, nothing is the shell (`origin` nil) and no page gets what a shell
/// page may ask: the shell is never served without its policy. Each web view is checked before it loads anything
/// (`verify`).
enum ShellHost {
    /// What the build carries (app/scripts/bundled-shell.ts packShell, app/ios/carry-shell.sh): `shell/`, the files,
    /// its two documents under names no other host answers as a page (ShellRoute.pageFile, renderFile), and
    /// `shell-policy.json`, the two policies of that copy's own `_headers`. A folder of its own, beside the app's own
    /// pages and not within them.
    private static let carried = Bundle.main.url(forResource: "bundled-shell", withExtension: nil)
    private static let folder = carried?.appendingPathComponent("shell", isDirectory: true).resolvingSymlinksInPath()
    private static let policies = ShellRoute.policies(carried.flatMap { try? Data(contentsOf: $0.appendingPathComponent("shell-policy.json")) })

    /// The implementation this put in place of Capacitor's `webView(_:start:)`, for `verify`.
    private static var wrapper: IMP?

    /// A web view of this app was found without this in front of its handler (`verify`): from then on nothing is the
    /// shell, in this process.
    private(set) static var failed = false

    /// Where the shell's pages are in a build that serves them itself, once this stands in front of Capacitor's
    /// handler; nil in a build that loads the shell from the network, and in one that cannot serve its own.
    static let origin: URL? = {
        guard (Bundle.main.object(forInfoDictionaryKey: "OvisAppShell") as? String) == "bundled",
              let origin = Home.shellOrigin(hosted: PCStore.appOrigin, bundled: true), policies != nil, let folder,
              FileManager.default.fileExists(atPath: folder.appendingPathComponent(ShellRoute.pageFile).path),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent(ShellRoute.renderFile).path) else { return nil }
        let handler: AnyClass = WebViewAssetHandler.self
        guard let stock = class_getInstanceMethod(handler, #selector(WebViewAssetHandler.webView(_:start:))),
              let own = class_getInstanceMethod(handler, #selector(WebViewAssetHandler.ovisWebView(_:start:))) else { return nil }
        wrapper = method_getImplementation(own)
        method_exchangeImplementations(stock, own)
        return origin
    }()

    /// Whether this build carries the shell (OvisAppShell `bundled`) and is not serving it: its files or policies
    /// are missing from the app, the exchange could not be made, or a web view failed `verify`. The app's own page
    /// then says the app's own screens did not open, from the first start on (Home.shellStuck).
    static var unavailable: Bool { PCStore.shellBundled && (origin == nil || failed) }

    /// Whether `webView`, before it loads anything, may load (Home.handlerCheck): in a build that serves the shell,
    /// what answers the app's scheme in it is Capacitor's own class and no other (a subclass would bring its own
    /// entry point), and that class's entry point is the one put there above. A web view that is not so loads
    /// nothing and marks the shell as not served for the rest of this process (`failed`): a Capacitor that answers
    /// the scheme another way would hand out the shell's files with no policy. The web views after it load, as there
    /// is no shell left for them to answer: the app's own page, which says what happened, or a PC's own.
    static func verify(_ webView: WKWebView?) -> Bool {
        let selector = #selector(WebViewAssetHandler.webView(_:start:))
        let handler = origin == nil || failed ? nil : webView?.configuration.urlSchemeHandler(forURLScheme: Home.appScheme) as? NSObject
        let check = Home.handlerCheck(serving: origin != nil, failed: failed,
                                      capacitors: handler.map { object_getClass($0) === WebViewAssetHandler.self } ?? false,
                                      wrapped: wrapper != nil && class_getMethodImplementation(WebViewAssetHandler.self, selector) == wrapper)
        failed = check.failed
        return check.load
    }

    /// Whether `url` is the shell's to answer: its host as written, with no port.
    fileprivate static func serves(_ url: URL) -> Bool {
        guard !failed, let shell = origin?.host else { return false }
        return url.host == shell && url.port == nil
    }

    /// Answers a request for the shell's host, start to finish before it returns, so the task cannot have been
    /// stopped in between (a task answered after it stopped raises).
    fileprivate static func answer(_ task: WKURLSchemeTask) {
        guard let url = task.request.url, let policies, let folder else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        let answer = ShellAnswer.make(path: URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? "", method: task.request.httpMethod,
                                      // the page the web view shows itself, not a frame's or a file a page asked for
                                      mainDocument: task.request.mainDocumentURL == url, folder: folder, policies: policies)
        // a file that is there and cannot be read fails the request: an answer of its length with nothing in it would
        // be taken for the file
        var body = Data(answer.text.utf8)
        if task.request.httpMethod?.uppercased() == "HEAD" {
            body = Data()
        } else if let file = answer.file {
            do { body = try Data(contentsOf: file, options: .mappedIfSafe) } catch {
                task.didFailWithError(error)
                return
            }
        }
        send(task, url, status: answer.status, headers: answer.headers, body: body)
    }

    /// The answer to a path the app's own host does not have (Home.ownPagePath): nothing, under a policy that lets
    /// what little it holds do nothing.
    fileprivate static func refuse(_ task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let body = Data("Not found".utf8)
        send(task, url, status: 404, headers: ["Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.count), "Cache-Control": "no-cache",
                                              "Content-Security-Policy": "sandbox; default-src 'none'"], body: body)
    }

    private static func send(_ task: WKURLSchemeTask, _ url: URL, status: Int, headers: [String: String], body: Data) {
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }
}

extension WebViewAssetHandler {
    /// Capacitor's `webView(_:start:)` once ShellHost.origin has put this in its place; the call to itself below is
    /// then Capacitor's own. Hosts are compared as they are written, with no port: another spelling is another origin.
    @objc fileprivate func ovisWebView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        if url.host == Home.bundledHost, url.port == nil {
            if Home.ownPagePath(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? "/..") {
                ovisWebView(webView, start: task)
            } else {
                ShellHost.refuse(task)
            }
        } else if ShellHost.serves(url) {
            ShellHost.answer(task)
        } else {
            task.didFailWithError(URLError(.unsupportedURL))
        }
    }
}

/// Shown once after the update to a build with the shell inside the app, to a phone that had signed in or paired a
/// PC on the hosted origin (PCStore.settleShell): the shell's pages are on another origin now, so that sign-in and
/// those pairings are out of its reach. It says so, and that signing in again brings the account's PCs back; its one
/// button opens the shell's own first screen, where the sign-in is.
final class ShellMovedViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = HerdrBridgeViewController.pageColor
        let words = Home.movedNotice(languages: Locale.preferredLanguages, kept: !PCStore.saved.isEmpty, alerts: PCStore.moveAlerts)

        let title = UILabel()
        title.text = words.title
        title.font = .preferredFont(forTextStyle: .title2)
        title.textColor = HerdrBridgeViewController.strongColor
        let body = UILabel()
        body.text = words.body
        body.font = .preferredFont(forTextStyle: .body)
        body.textColor = HerdrBridgeViewController.textColor
        for label in [title, body] {
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
            label.textAlignment = .natural
        }
        var look = UIButton.Configuration.filled()
        look.title = words.button
        look.baseBackgroundColor = HerdrBridgeViewController.accentColor
        look.baseForegroundColor = .white
        look.buttonSize = .large
        let button = UIButton(configuration: look, primaryAction: UIAction { _ in
            PCStore.moveNotice = false
            // the shell's first screen, where the sign-in is, over a PC that is still current
            PCStore.homeAttempt("#pcs")
            HerdrBridgeViewController.reopen()
        })
        button.accessibilityIdentifier = "shell-moved-continue"

        let stack = UIStackView(arrangedSubviews: [title, body, button])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 16
        stack.setCustomSpacing(24, after: body)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        scroll.addSubview(stack)
        view.addSubview(scroll)
        let content = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
        let fill = content.heightAnchor.constraint(equalTo: frame.heightAnchor)
        fill.priority = .defaultLow
        // the width of a phone's screen, and no wider than a column reads well on an iPad
        let wide = stack.widthAnchor.constraint(equalTo: frame.widthAnchor, constant: -48)
        wide.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: frame.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: frame.heightAnchor),
            fill,
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            stack.widthAnchor.constraint(lessThanOrEqualTo: frame.widthAnchor, constant: -48),
            wide
        ])
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }
}
