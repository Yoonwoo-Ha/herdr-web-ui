import Foundation

/// What the app does with one message a page posts to its bridge (DirectCallGate in OvisDirectPlugin.swift stands in
/// front of Capacitor's handler and carries this out): the decision alone, by what a page cannot choose, the frame
/// the message came from and that frame's origin as WebKit reports it.
public enum BridgeGate {
    public struct Decision: Equatable {
        /// The message goes on to Capacitor; false: it is dropped, and the page's call never settles.
        public let pass: Bool
        /// The call is one of OvisDirect's own, which acts only on a call approved here.
        public let approve: Bool
        /// The call's plugin decides by the page that sent it: the sender's origin is kept for it (`sender`), so it
        /// reads the page that asked, not the address the web view is on its way to.
        public let record: Bool

        public static let drop = Decision(pass: false, approve: false, record: false)
    }

    /// OvisDirect's own methods, each of which takes its approval.
    public static let directMethods: Set<String> = ["open", "send", "close", "ack", "features"]

    /// HerdrShell's methods that decide by the page asking.
    public static let shellMethodsBySender: Set<String> = ["getState", "forget", "openSshSetup", "disconnect", "identify"]

    /// `mainFrame`, `scheme`, `host`, `port` (0 for the scheme's own): the frame the message came from. `plugins`: the
    /// plugin the message names, by either of the two names Capacitor reads one from. `type`, `method`, `callback`:
    /// the message's own. `shell`: where the shell's pages are in this build (Home.shellOrigin).
    ///
    /// - No message from a frame inside a page goes on, in any build: a page drawn in a frame (a dev server's page in
    ///   the web panel, a file's page with its scripts on, the render host) is not the page the app opened, and
    ///   Capacitor would let it call every plugin. Capacitor puts its own script in the main frame alone.
    /// - OvisSsh (an SSH PC's keys, host keys and setup) answers the app's own pages; one call of the shell's goes
    ///   on, `add`, which there only hands over to the setup sheet.
    /// - OvisDirect, its listener methods included, answers the shell alone.
    public static func decide(mainFrame: Bool, scheme: String, host: String, port: Int, plugins: Set<String>, type: String?, method: String?, callback: Bool, shell: URL?) -> Decision {
        guard mainFrame else { return .drop }
        let own = scheme == Home.appScheme && host == Home.bundledHost && port == 0
        let fromShell = Home.shellFrame(scheme: scheme, host: host, port: port, shell: shell)
        let call = type == "message" && callback
        if plugins.contains("OvisSsh") {
            guard own || (fromShell && method == "add") else { return .drop }
            return Decision(pass: true, approve: false, record: call)
        }
        if plugins.contains("OvisDirect") {
            guard fromShell else { return .drop }
            return Decision(pass: true, approve: call && method.map(directMethods.contains) == true, record: false)
        }
        return Decision(pass: true, approve: false, record: call && plugins.contains("HerdrShell") && method.map(shellMethodsBySender.contains) == true)
    }

    /// A frame's origin as an address the page gates read (Home.bundledPage, Home.ownPage, SshPcs.setupOpener), or nil
    /// for a frame with none (a sandboxed one): `scheme://host[:port]`, an IPv6 host in brackets.
    public static func sender(scheme: String, host: String, port: Int) -> URL? {
        guard !scheme.isEmpty, !host.isEmpty, port >= 0 else { return nil }
        return URL(string: "\(scheme)://\(host.contains(":") ? "[\(host)]" : host)\(port == 0 ? "" : ":\(port)")")
    }
}
