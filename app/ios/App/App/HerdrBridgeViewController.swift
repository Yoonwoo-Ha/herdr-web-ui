import UIKit
import WebKit
import Capacitor

/// The PCs this app knows, kept in UserDefaults. The WebView's cookies (a paired device's
/// sign-in) live in WebKit's own store, not here.
enum PCStore {
    private static let defaults = UserDefaults.standard

    /// Origins opened before, the latest first.
    static var saved: [String] {
        get { defaults.stringArray(forKey: "herdr.saved") ?? [] }
        set { defaults.set(newValue, forKey: "herdr.saved") }
    }

    /// The PC the app opens at launch, an origin; nil shows the connect screen.
    static var current: String? {
        get { defaults.string(forKey: "herdr.current") }
        set { defaults.set(newValue, forKey: "herdr.current") }
    }

    /// The PC opened last, even after "Change PC", for the pages that name it.
    static var last: String? {
        get { defaults.string(forKey: "herdr.last") }
        set { defaults.set(newValue, forKey: "herdr.last") }
    }

    /// The address to open instead of the bare origin until a PC page loads: a pairing link keeps
    /// its `?pair=` code through Try again. In memory only, as it can hold that code.
    static var pendingStart: String?

    /// Why the last load failed, for the error page.
    static var failure: String?

    static func remember(_ origin: String) {
        saved = [origin] + saved.filter { $0 != origin }
    }

    static func forget(_ origin: String) {
        saved = saved.filter { $0 != origin }
        if current == origin { current = nil }
        if last == origin { last = nil }
    }

    /// `scheme://host[:port]` of an http or https URL, or nil.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        return url.port.map { "\(scheme)://\(shownHost):\($0)" } ?? "\(scheme)://\(shownHost)"
    }
}

/// Capacitor's view controller with the chosen PC as the WebView's first page. Reaching the PC
/// by navigating from the bundled connect page instead would cost every launch about 1.5 s
/// (docs/native-app.md, Spike results), so opening a PC builds a new one of these.
class HerdrBridgeViewController: CAPBridgeViewController {
    private var failureProxy: NavigationFailureProxy?

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let origin = PCStore.current, let host = URL(string: origin)?.host {
            // what server.url sets; the pairing link until a PC page has loaded, the origin after it
            descriptor.serverURL = PCStore.pendingStart ?? origin + "/"
            // the whole PC is the app: its own links stay in the WebView, others go to Safari
            descriptor.allowedNavigationHostnames = descriptor.allowedNavigationHostnames + [host]
        }
        return descriptor
    }

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // a PC on a plain http address (a tailnet or LAN IP) is opened as typed: with the system's
        // https-first try, every load of one waited about 2 s before it started
        configuration.upgradeKnownHostsToHTTPS = false
        if #available(iOS 18.2, *) {
            configuration.defaultWebpagePreferences.preferredHTTPSNavigationPolicy = .keepAsRequested
        }
        return configuration
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HerdrShellPlugin())
    }

    override func viewDidLoad() {
        // before super, which starts the first load
        if let webView = webView, PCStore.current != nil {
            let proxy = NavigationFailureProxy(inner: webView.navigationDelegate) { [weak self] webView, error in
                self?.showFailure(in: webView, error: error)
            }
            failureProxy = proxy
            webView.navigationDelegate = proxy
        }
        super.viewDidLoad()
    }

    private func showFailure(in webView: WKWebView, error: Error) {
        guard let local = bridge?.config.localURL else { return }
        PCStore.failure = error.localizedDescription
        webView.load(URLRequest(url: local.appendingPathComponent("error.html")))
    }

    /// Replaces the app's view controller, so the next page (a PC, or the connect screen) is a
    /// first load.
    static func reopen() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = (scene?.delegate as? SceneDelegate)?.window else { return }
        if let old = window.rootViewController as? HerdrBridgeViewController {
            // the PC's page would otherwise live on unseen, its connections to the PC open: the
            // bridge's message handler keeps the old web view alive
            // without its delegate, Capacitor's policy would hand about:blank to Safari
            old.webView?.navigationDelegate = nil
            old.webView?.stopLoading()
            old.webView?.load(URLRequest(url: URL(string: "about:blank")!))
            (old.bridge as? CapacitorBridge)?.webViewDelegationHandler.cleanUp()
        }
        window.rootViewController = HerdrBridgeViewController()
    }
}

/// Passes every navigation callback to Capacitor's own delegate and reports a main-frame load
/// that failed, such as a PC that is off. A load cancelled on purpose (a link handed to Safari,
/// a new navigation) is not a failure.
final class NavigationFailureProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    private let onFailure: (WKWebView, Error) -> Void

    init(inner: WKNavigationDelegate?, onFailure: @escaping (WKWebView, Error) -> Void) {
        self.inner = inner
        self.onFailure = onFailure
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner?.responds(to: aSelector) == true ? inner : nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inner?.webView?(webView, didFinish: navigation)
        // the PC's page is up: a pairing link has done its work
        if let scheme = webView.url?.scheme, scheme == "http" || scheme == "https" { PCStore.pendingStart = nil }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        inner?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        let nsError = error as NSError
        let cancelled = nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        // WebKit's "frame load interrupted" (102) and "plug-in handled load" (204)
        let handedOff = nsError.domain == "WebKitErrorDomain" && (nsError.code == 102 || nsError.code == 204)
        if !cancelled && !handedOff { onFailure(webView, error) }
    }
}
