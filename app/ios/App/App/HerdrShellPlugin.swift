import Foundation
import Capacitor
import OvisHomeCore
import OvisSshCore
import WebKit

@objc(HerdrShellPlugin)
public class HerdrShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HerdrShellPlugin"
    public let jsName = "HerdrShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chooseAnother", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backToCurrent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goHome", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openDemo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSshSetup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "identify", returnType: CAPPluginReturnPromise)
    ]

    /// The view controller whose page asks.
    private var shown: HerdrBridgeViewController? { bridge?.viewController as? HerdrBridgeViewController }

    /// Writes what opens next and opens it, on the main thread in one turn: nothing the page still does (a relay PC's
    /// page landing in the hosted screen) can be written over it in between, as the view controller that goes is
    /// told first (HerdrBridgeViewController.reopen).
    private static func go(_ write: @escaping () -> Void) {
        DispatchQueue.main.async {
            write()
            HerdrBridgeViewController.reopen()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        // on the main thread, as the web view's address and what the view controller shows are read there
        DispatchQueue.main.async { self.answerState(call) }
    }

    private func answerState(_ call: CAPPluginCall) {
        // the page that asked, as the gate in front of the bridge saw it (DirectCallGate.sender): during a load the
        // web view's own address is already the next page's
        let page = DirectCallGate.sender(call.callbackId)
        // the relay ID each saved PC's own page said it has, for My PCs to list a PC saved by several ways once: only to
        // the app's own pages, never to a PC's page, which has this bridge too
        let ids = Home.shownIds(page, appOrigin: PCStore.shellOrigin, ids: PCStore.ids) ?? [:]
        // the app's own pages (app/web) name the shell by the hosted origin on both platforms: where this build serves
        // the shell itself, they read its keys as addresses there (Home.hostedForm), which open and forget take back
        let own = Home.bundledPage(page)
        let named = { (key: String) in own ? Home.hostedForm(key, hosted: PCStore.appOrigin, shell: PCStore.shellOrigin) : key }
        let keyed = { (by: [String: String]) in Dictionary(by.map { (named($0.key), $0.value) }) { first, _ in first } }
        call.resolve([
            "ids": keyed(ids),
            "saved": PCStore.saved.map(named),
            "names": keyed(PCStore.names),
            "current": PCStore.current.map(named) ?? "",
            "last": PCStore.last.map(named) ?? "",
            "choosing": PCStore.choosing && PCStore.current != nil,
            // the page asking is the hosted Connect a PC screen, opened without being the current PC (Home)
            "home": shown?.atHome ?? false,
            // the page asking is the app's own, standing in for the hosted screen that did not load: Try again is goHome
            "fallback": shown?.fallback ?? false,
            // where the page's own way back leads: "current" (backToCurrent), "home" (goHome) or nowhere
            "back": shown?.backWay ?? "",
            // the app's own page was asked for to manage an SSH PC (Change PC where one did not open): it opens on SSH
            "manage": shown?.manages ?? false,
            // the shell inside the app did not open: the app's own page says so instead of "no internet"
            "stuck": PCStore.shellStuck,
            "name": PCStore.last.flatMap { PCStore.names[$0] } ?? "",
            "failure": PCStore.failure ?? "",
            "kind": PCStore.failureKind ?? "",
            "command": PCStore.failureCommand ?? "",
            // the shell's origin as this page reads the keys above: a failure of the shell itself is no PC's (error.html)
            "app": (own ? PCStore.appOrigin : PCStore.shellOrigin)?.absoluteString ?? ""
        ])
    }

    /// `url`: an http or https address; the address itself (a pairing link's code or a relay pairing
    /// offer's fragment included) is the first page.
    @objc func open(_ call: CAPPluginCall) {
        // an address on the hosted origin (a pairing link, a sign-in, a saved relay PC as the app's own page names
        // it) is that page of the shell inside the app, where this build serves it: never the network's copy
        let asked = call.getString("url").map(PCStore.shellForm)
        // the word "demo" as the hosted screen's address field sends it: the bundled demo, as on the app's own page.
        // Only there: anywhere else that address is a PC's, as it always was
        if Home.opensDemo(asked, atHome: shown?.atHome ?? false) {
            openDemo(call)
            return
        }
        // the hosted app's front page (a sign-in from the app's own page, its saved row): an attempt at the hosted
        // screen, which makes nothing the current PC before it loaded
        if PCStore.homeHosted, let start = Home.homeStart(asked, appOrigin: PCStore.shellOrigin) {
            call.resolve()
            Self.go { PCStore.homeAttempt(start) }
            return
        }
        guard let text = asked, let url = URL(string: text), let origin = PCStore.origin(of: url) else {
            call.reject("That is not an http or https address.")
            return
        }
        if SshPcs.otherLoopbackPort(text, sshPorts: OvisSsh.tunnels.ports()) {
            call.reject("That address on this phone is kept for PCs added over SSH. Open the PC from Your PCs.")
            return
        }
        var key = origin
        if let scope = call.getString("scope").map(PCStore.shellForm) {
            guard let scopeKey = PCStore.scopeKey(scope, for: url) else {
                call.reject("That relay link is not within its PC's scope.")
                return
            }
            key = scopeKey
        }
        let name = call.getString("name").flatMap { $0.isEmpty ? nil : String($0.prefix(64)) }
        call.resolve()
        Self.go {
            if let name { PCStore.names[key] = name }
            PCStore.open(key, start: text)
        }
    }

    /// A PC's own page says which PC it is: `server_id`, its relay ID as its own /api/health gave it to that page, and
    /// `name`. Kept only for the saved PC the app shows when the page loaded now is on that PC's own address
    /// (Home.identifiedKey), so a page speaks for its own PC alone, never for another saved one; My PCs then lists that
    /// PC once with the relay row of the same ID.
    @objc func identify(_ call: CAPPluginCall) {
        let serverId = call.getString("server_id"), name = call.getString("name"), page = DirectCallGate.sender(call.callbackId)
        // on the main thread, as open and keepHosted write the names there: no write between this read and this one
        DispatchQueue.main.async {
            guard let key = Home.identifiedKey(page, current: PCStore.current, appOrigin: PCStore.shellOrigin) else {
                call.reject("Only a saved PC's own page says which PC it is.")
                return
            }
            let kept = Home.identified(ids: PCStore.ids, names: PCStore.names, key: key, serverId: serverId, name: name)
            PCStore.ids = kept.ids
            PCStore.names = kept.names
            call.resolve()
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        // an SSH PC forgotten takes its sealed key and host key with it (OvisSshPlugin): only the app's own pages may,
        // which the shell a build serves on the same scheme is not (Home.bundledPage)
        let key = call.getString("url").map(PCStore.shellForm)
        if let key, OvisSsh.pc(key) != nil, !Home.bundledPage(DirectCallGate.sender(call.callbackId)) {
            call.reject("Only the app's own pages manage SSH PCs.")
            return
        }
        if let key { PCStore.forget(key) }
        call.resolve()
    }

    /// From the hosted app (Add a PC's SSH) or the app's own page: the SSH setup sheet over that page, with `target` (an
    /// SSH login, user@host[:port], or empty) filled in (OvisSshPlugin.presentSetup). Nothing is added here, and the page
    /// is given no OvisSsh: the person adds the PC on the sheet, and its Cancel returns to the page as it was.
    @objc func openSshSetup(_ call: CAPPluginCall) {
        // only the connect screen and the hosted app (Add a PC's SSH): a PC's own page may not drop the person off it
        // to stage a login of its choosing
        // the page that asked (DirectCallGate.sender), not the one the app last chose nor the one the web view is on its way to
        guard SshPcs.setupOpener(DirectCallGate.sender(call.callbackId), appOrigin: PCStore.shellOrigin) else {
            call.reject("Only the app's own pages open the SSH setup.")
            return
        }
        let target = call.getString("target") ?? ""
        guard target.count <= 300 else {
            call.reject("That is not an SSH login.")
            return
        }
        guard OvisSsh.supported else {
            call.reject("SSH needs iOS 16.4 or later.")
            return
        }
        call.resolve()
        OvisSshPlugin.presentSetup(target, over: bridge?.viewController)
    }

    /// Change PC. In the demo the app opened (openDemo) it leaves the demo alone, and the PC it was opened over stays
    /// current. From the error page of an SSH PC that did not open, the app's own page comes, whose Manage mends it.
    @objc func disconnect(_ call: CAPPluginCall) {
        let unopened = Home.bundledPage(DirectCallGate.sender(call.callbackId)) && shown?.showsPc == true
        call.resolve()
        Self.go {
            if PCStore.demo { PCStore.demo = false } else { PCStore.leave(unopened: unopened) }
        }
    }

    /// A PC page's Connect a PC: the connect screen, the current PC kept until another opens (PCStore.choosing).
    @objc func chooseAnother(_ call: CAPPluginCall) {
        call.resolve()
        Self.go {
            PCStore.choosing = true
            PCStore.demo = false
        }
    }

    /// The connect screen's way back to the PC it was opened from to choose another way.
    @objc func backToCurrent(_ call: CAPPluginCall) {
        call.resolve()
        Self.go {
            PCStore.choosing = false
            PCStore.demo = false
        }
    }

    /// The hosted Connect a PC screen again: Try again on the app's own page standing in for it (getState's `fallback`),
    /// and that page's way back to it (`back` is "home").
    @objc func goHome(_ call: CAPPluginCall) {
        call.resolve()
        Self.go { PCStore.goHome() }
    }

    /// The bundled demo, which only the app can open: a page of another origin cannot reach the app's own files. Its
    /// own Change PC (disconnect) leaves it, for the screen it was opened over.
    @objc func openDemo(_ call: CAPPluginCall) {
        call.resolve()
        Self.go { PCStore.demo = true }
    }

    /// Where the shell is inside the app, no web address at the hosted origin's host loads in the main frame of any
    /// of the app's web views, the ones no PC opened included (the app's own page, the demo): Capacitor asks each
    /// plugin before it lets a page go anywhere. Behind such an address is the network's copy of the shell.
    @objc override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard PCStore.shellBundled, navigationAction.targetFrame?.isMainFrame == true,
              Home.hostedHost(navigationAction.request.url, hosted: PCStore.appOrigin) else { return nil }
        return true
    }

    @objc func retry(_ call: CAPPluginCall) {
        PCStore.failure = nil
        PCStore.redirects = 0
        call.resolve()
        let ssh = OvisSsh.pc(PCStore.shown)
        Task { @MainActor in
            // a Tailscale check the person has just approved: the PC's tunnel signs in again
            if let ssh { await OvisSsh.tunnels.resume(ssh.origin) }
            HerdrBridgeViewController.reopen()
        }
    }
}
