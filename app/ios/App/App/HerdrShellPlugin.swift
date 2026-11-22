import Foundation
import Capacitor
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
        CAPPluginMethod(name: "openSshSetup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeSshSetup", returnType: CAPPluginReturnPromise)
    ]

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve([
            "saved": PCStore.saved,
            "names": PCStore.names,
            "current": PCStore.current ?? "",
            "last": PCStore.last ?? "",
            "choosing": PCStore.choosing && PCStore.current != nil,
            "name": PCStore.last.flatMap { PCStore.names[$0] } ?? "",
            "failure": PCStore.failure ?? "",
            "kind": PCStore.failureKind ?? "",
            "command": PCStore.failureCommand ?? ""
        ])
    }

    /// `url`: an http or https address; the address itself (a pairing link's code or a relay pairing
    /// offer's fragment included) is the first page.
    @objc func open(_ call: CAPPluginCall) {
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
        if let name = call.getString("name"), !name.isEmpty { PCStore.names[key] = String(name.prefix(64)) }
        PCStore.current = key
        PCStore.last = key
        PCStore.choosing = false
        PCStore.pendingStart = text
        PCStore.failure = nil
        PCStore.redirects = 0
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
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
        guard SshPcs.setupOpener(bridge?.webView?.url) else {
            call.reject("Only the app's own pages open the SSH setup.")
            return
        }
        let target = call.getString("target") ?? ""
        guard target.count <= 300 else {
            call.reject("That is not an SSH login.")
            return
        }
        PCStore.sshSetup = target
        PCStore.current = nil
        PCStore.choosing = false
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
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

    @objc func disconnect(_ call: CAPPluginCall) {
        PCStore.current = nil
        PCStore.choosing = false
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
    }

    /// A PC page's Connect a PC: the connect screen, the current PC kept until another opens (PCStore.choosing).
    @objc func chooseAnother(_ call: CAPPluginCall) {
        PCStore.choosing = true
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
    }

    /// The connect screen's way back to the PC it was opened from to choose another way.
    @objc func backToCurrent(_ call: CAPPluginCall) {
        PCStore.choosing = false
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
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
