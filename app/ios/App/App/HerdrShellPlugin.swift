import Foundation
import Capacitor
import OvisHomeCore
import OvisSshCore

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
        CAPPluginMethod(name: "takeSshSetup", returnType: CAPPluginReturnPromise)
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
        call.resolve([
            "saved": PCStore.saved,
            "names": PCStore.names,
            "current": PCStore.current ?? "",
            "last": PCStore.last ?? "",
            "choosing": PCStore.choosing && PCStore.current != nil,
            // the page asking is the hosted Connect a PC screen, opened without being the current PC (Home)
            "home": shown?.atHome ?? false,
            // the page asking is the app's own, standing in for the hosted screen that did not load: Try again is goHome
            "fallback": shown?.fallback ?? false,
            // where the page's own way back leads: "current" (backToCurrent), "home" (goHome) or nowhere
            "back": shown?.backWay ?? "",
            // the app's own page was asked for to manage an SSH PC (Change PC where one did not open): it opens on SSH
            "manage": shown?.manages ?? false,
            "name": PCStore.last.flatMap { PCStore.names[$0] } ?? "",
            "failure": PCStore.failure ?? "",
            "kind": PCStore.failureKind ?? "",
            "command": PCStore.failureCommand ?? ""
        ])
    }

    /// `url`: an http or https address; the address itself (a pairing link's code or a relay pairing
    /// offer's fragment included) is the first page.
    @objc func open(_ call: CAPPluginCall) {
        // the word "demo" as the hosted screen's address field sends it: the bundled demo, as on the app's own page.
        // Only there: anywhere else that address is a PC's, as it always was
        if Home.opensDemo(call.getString("url"), atHome: shown?.atHome ?? false) {
            openDemo(call)
            return
        }
        // the hosted app's front page (a sign-in from the app's own page, its saved row): an attempt at the hosted
        // screen, which makes nothing the current PC before it loaded
        if PCStore.homeHosted, let start = Home.homeStart(call.getString("url"), appOrigin: PCStore.appOrigin) {
            call.resolve()
            Self.go { PCStore.homeAttempt(start) }
            return
        }
        guard let text = call.getString("url"), let url = URL(string: text), let origin = PCStore.origin(of: url) else {
            call.reject("That is not an http or https address.")
            return
        }
        if SshPcs.otherLoopbackPort(text, sshPorts: OvisSsh.tunnels.ports()) {
            call.reject("That address on this phone is kept for PCs added over SSH. Open the PC from Your PCs.")
            return
        }
        var key = origin
        if let scope = call.getString("scope") {
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

    @objc func forget(_ call: CAPPluginCall) {
        // an SSH PC forgotten takes its sealed key and host key with it (OvisSshPlugin): only the app's own pages may
        if let key = call.getString("url"), OvisSsh.pc(key) != nil, bridge?.webView?.url?.scheme != "capacitor" {
            call.reject("Only the app's own pages manage SSH PCs.")
            return
        }
        if let key = call.getString("url") { PCStore.forget(key) }
        call.resolve()
    }

    /// From any page of the app, a PC's (the hosted app's) included: the app's own connect screen, on Direct with
    /// `target` (an SSH login, user@host[:port], or empty) in its field. Nothing is added here, and no PC page is given
    /// OvisSsh: the connect screen, an app page, takes the login to the SSH setup screen, where the person adds the PC.
    @objc func openSshSetup(_ call: CAPPluginCall) {
        // only the connect screen and the hosted app (Add a PC's SSH): a PC's own page may not drop the person off it
        // to stage a login of its choosing
        // the page loaded now, not the one the app last chose: the web view may have gone elsewhere since
        guard SshPcs.setupOpener(bridge?.webView?.url, appOrigin: PCStore.appOrigin) else {
            call.reject("Only the app's own pages open the SSH setup.")
            return
        }
        let target = call.getString("target") ?? ""
        guard target.count <= 300 else {
            call.reject("That is not an SSH login.")
            return
        }
        call.resolve()
        Self.handOverSshSetup(target)
    }

    /// The app's own page on SSH with `target` (an SSH login, or empty) in its field, which takes it to the SSH setup
    /// screen. Asked while choosing another way, the PC it was opened from stays the one to go back to, as on the
    /// app's own page.
    static func handOverSshSetup(_ target: String) {
        go {
            PCStore.sshSetup = target
            if !(PCStore.choosing && PCStore.current != nil) {
                PCStore.current = nil
                PCStore.choosing = false
            }
            PCStore.demo = false
        }
    }

    /// The connect screen's alone: the SSH login a page asked it to open with (openSshSetup), taken once.
    @objc func takeSshSetup(_ call: CAPPluginCall) {
        var target: String?
        if bridge?.webView?.url?.scheme == "capacitor", PCStore.shown == nil {
            target = PCStore.sshSetup
            PCStore.sshSetup = nil
        }
        call.resolve(["asked": target != nil, "target": target ?? ""])
    }

    /// Change PC. In the demo the app opened (openDemo) it leaves the demo alone, and the PC it was opened over stays
    /// current. From the error page of an SSH PC that did not open, the app's own page comes, whose Manage mends it.
    @objc func disconnect(_ call: CAPPluginCall) {
        let unopened = bridge?.webView?.url?.scheme == "capacitor" && shown?.showsPc == true
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
