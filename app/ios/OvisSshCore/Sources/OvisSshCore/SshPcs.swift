import CryptoKit
import Foundation
import NIOSSH

/// The PCs added over SSH and this phone's own SSH key: the key store, as Android's SshPcs.java. Each PC is
/// saved under its own loopback origin on this phone, `http://127.0.0.1:<port>` (iOS gives the loopback
/// interface 127.0.0.1 alone, so where Android takes 127.0.0.n each PC takes a port), where its SshTunnel
/// listens; this store keeps how to reach it: address, account, the host key confirmed when it was added, how
/// the app signs in, and the tunnel's gate.
///
/// Secrets never rest in the clear: this phone's ed25519 key, a pasted key and its passphrase, and each
/// tunnel's gate are sealed (`Sealer`; the app's is AES-GCM under a key in the Keychain, this device only,
/// never synced or backed up). A password is never stored. Plain Swift over two seams so SshPcsTests runs it.
public final class SshPcs {
    public static let firstPort = 47320
    public static let portCount = 300

    public protocol Prefs: AnyObject {
        func get(_ name: String) -> String?
        /// Writes every entry at once, a nil value removing its name; false when the write did not land.
        func put(_ values: [String: String?]) -> Bool
    }

    public protocol Sealer {
        func seal(_ plain: Data) throws -> String
        func open(_ sealed: String) throws -> Data
    }

    public struct Pc: Codable, Equatable {
        public var origin = ""
        public var host = ""
        public var port = 22
        public var user = ""
        public var hostKeyAlgorithm = ""
        public var hostKey = ""
        /// "phone-key", "imported" or "tailscale" (Tailscale SSH, no key)
        public var auth = "phone-key"
        /// sealed, "" unless auth is "imported"
        public var importedKey = ""
        /// sealed, "" when the key has none
        public var importedPassphrase = ""
        /// what the imported key is, for the screens: "ed25519", "ecdsa 256"; "" for the phone's key
        public var keyType = ""
        /// sealed: the tunnel's gate cookie value, made when the PC is saved and kept while it is
        public var gate = ""

        public init() {}

        public var label: String { user + "@" + host + (port == 22 ? "" : ":\(port)") }
        public var hasHostKey: Bool { !hostKey.isEmpty }
        public var localPort: Int { URLComponents(string: origin)?.port ?? 0 }

        enum CodingKeys: String, CodingKey {
            case origin, host, port, user, hostKeyAlgorithm, hostKey, auth, importedKey, importedPassphrase, keyType, gate
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            origin = (try? c.decode(String.self, forKey: .origin)) ?? ""
            host = (try? c.decode(String.self, forKey: .host)) ?? ""
            port = (try? c.decode(Int.self, forKey: .port)) ?? 22
            user = (try? c.decode(String.self, forKey: .user)) ?? ""
            hostKeyAlgorithm = (try? c.decode(String.self, forKey: .hostKeyAlgorithm)) ?? ""
            hostKey = (try? c.decode(String.self, forKey: .hostKey)) ?? ""
            auth = (try? c.decode(String.self, forKey: .auth)) ?? "phone-key"
            importedKey = (try? c.decode(String.self, forKey: .importedKey)) ?? ""
            importedPassphrase = (try? c.decode(String.self, forKey: .importedPassphrase)) ?? ""
            keyType = (try? c.decode(String.self, forKey: .keyType)) ?? ""
            gate = (try? c.decode(String.self, forKey: .gate)) ?? ""
        }
    }

    /// One lock for every store over the same preferences: the plugin, the setup screen and the tunnels share them.
    private static let lock = NSRecursiveLock()

    private let prefs: Prefs
    private let sealer: Sealer

    public init(prefs: Prefs, sealer: Sealer) {
        self.prefs = prefs
        self.sealer = sealer
    }

    private func all() -> [String: Pc] {
        guard let saved = prefs.get("pcs"), let data = saved.data(using: .utf8),
              let pcs = try? JSONDecoder().decode([String: Pc].self, from: data) else { return [:] }
        return pcs
    }

    private func write(_ pcs: [String: Pc]) throws {
        let data = try JSONEncoder().encode(pcs)
        guard prefs.put(["pcs": String(decoding: data, as: UTF8.self)]) else { throw SshFailure("internal", "This phone could not save its SSH PCs") }
    }

    public func get(_ origin: String?) -> Pc? {
        guard let origin else { return nil }
        Self.lock.lock(); defer { Self.lock.unlock() }
        return all()[origin]
    }

    public func put(_ pc: Pc) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var pcs = all()
        pcs[pc.origin] = pc
        try write(pcs)
    }

    /// Forgets the PC, its sealed key, passphrase and gate with it.
    public func remove(_ origin: String) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var pcs = all()
        pcs[origin] = nil
        try write(pcs)
    }

    /// Forgets the PC's host key on purpose: nothing connects to it until the setup screen shows the key it has now and the person confirms it.
    public func forgetHostKey(_ origin: String) throws {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard var pc = get(origin) else { return }
        pc.hostKeyAlgorithm = ""
        pc.hostKey = ""
        try put(pc)
    }

    public func find(host: String, port: Int, user: String) -> Pc? {
        list().first { $0.host.caseInsensitiveCompare(host) == .orderedSame && $0.port == port && $0.user == user }
    }

    public func list() -> [Pc] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return all().values.sorted { $0.origin < $1.origin }
    }

    /// A loopback origin for a new PC: the next port after the last one handed out, so a PC added after another was
    /// removed never gets that one's address (its storage, drafts and service worker); only once every port was
    /// handed out does it come back round to the lowest free one.
    public func freeOrigin() throws -> String {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let pcs = all()
        let last = Int(prefs.get("lastLoopbackPort") ?? "") ?? Self.firstPort - 1
        for step in 1...Self.portCount {
            let port = Self.firstPort + (last - Self.firstPort + step + Self.portCount) % Self.portCount
            let origin = "http://127.0.0.1:\(port)"
            if pcs[origin] != nil { continue }
            guard prefs.put(["lastLoopbackPort": String(port)]) else { throw SshFailure("internal", "This phone could not save its SSH PCs") }
            return origin
        }
        throw SshFailure("internal", "No loopback port is left for another SSH PC")
    }

    /// Whether `url` is this phone's loopback (127.0.0.1 in any spelling a browser reads, `localhost` too) at a port
    /// no saved SSH PC listens on, while one does: cookies are not kept apart by port, so a request there would carry
    /// the SSH PCs' gates to whatever else listens on it. The app neither opens nor loads such an address.
    public static func otherLoopbackPort(_ url: String, sshPorts: Set<Int>) -> Bool {
        guard !sshPorts.isEmpty, let parts = URLComponents(string: url), let scheme = parts.scheme?.lowercased(),
              let host = parts.percentEncodedHost?.lowercased() else { return false }
        let address = host == "localhost" || host.hasSuffix(".localhost") ? 0x7f000001 : ipv4(host)
        guard address >= 0x7f000000 && address <= 0x7fffffff else { return false }
        return scheme != "http" || address != 0x7f000001 || !sshPorts.contains(parts.port ?? 80)
    }

    /// The IPv4 address a host names as a browser reads it (the WHATWG URL rules: percent-escapes, a trailing dot, one
    /// to four parts in decimal, octal or hex), or -1 for a host that is not one.
    public static func ipv4(_ host: String) -> Int64 {
        guard var text = host.removingPercentEncoding?.lowercased() else { return -1 }
        if text.hasSuffix(".") { text.removeLast() }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.count <= 4 else { return -1 }
        var numbers: [Int64] = []
        for var part in parts {
            var radix = 10
            if part.hasPrefix("0x") {
                radix = 16
                part = String(part.dropFirst(2))
            } else if part.count > 1 && part.hasPrefix("0") {
                radix = 8
                part = String(part.dropFirst())
            }
            if part.isEmpty {
                guard radix == 16 else { return -1 }
                numbers.append(0)
                continue
            }
            guard part.count <= 12, let number = Int64(part, radix: radix), number >= 0 else { return -1 }
            numbers.append(number)
        }
        var address: Int64 = 0
        for number in numbers.dropLast() {
            guard number <= 255 else { return -1 }
            address = address * 256 + number
        }
        let left = 5 - numbers.count
        guard let last = numbers.last, last < (Int64(1) << (8 * left)) else { return -1 }
        return (address << (8 * left)) + last
    }

    /// A page's SSH login (HerdrShell openSshSetup's target: user@host, user@host:port, ssh:// with them, as the hosted
    /// app's SSH tab and app/web/shell.js sshOrAddress read it) as the setup screen's user, host and port, or nil for
    /// anything else, which opens the screen empty.
    public static func login(_ target: String?) -> (user: String, host: String, port: Int)? {
        guard let target, let login = try? NSRegularExpression(pattern: #"^(?:ssh://)?([^\s@/:]+)@([^\s@/:\[\]]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?/?$"#) else { return nil }
        let text = target.trimmingCharacters(in: .whitespaces) as NSString
        guard let match = login.firstMatch(in: text as String, range: NSRange(location: 0, length: text.length)) else { return nil }
        let part = { (at: Int) -> String? in match.range(at: at).location == NSNotFound ? nil : text.substring(with: match.range(at: at)) }
        guard let user = part(1), let host = part(2) else { return nil }
        let port = part(3).flatMap(Int.init) ?? 22
        guard (1...65535).contains(port) else { return nil }
        return (user, host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), port)
    }

    /// OvisSsh add's user, host and port (the hosted front page of a release gives them apart) as the login openSshSetup
    /// takes, which `login` reads back: an IPv6 host in brackets, port 22 left out; "" without both a user and a host.
    public static func target(user: String?, host: String?, port: Int?) -> String {
        guard let user, let host else { return "" }
        let shown = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return "\(user)@\(shown)\(port.map { $0 == 22 ? "" : ":\($0)" } ?? "")"
    }

    /// Whether the page loaded at `url` may open the SSH setup (HerdrShell openSshSetup): the app's own bundled pages
    /// (`capacitor://localhost`) or the shell at `appOrigin`, never a PC's page. The shell is the hosted app (the
    /// build's, https://app.ovis.sh in a hosted build) or, in a build that serves it from inside the app, that host on
    /// the app's own scheme (`capacitor://app.ovis.sh`): no other host there, and with no port.
    public static func setupOpener(_ url: URL?, appOrigin: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased(), let host = url.host else { return false }
        // on the app's scheme a host is as it is written and has no port: another spelling is another origin to WebKit
        if scheme == "capacitor" {
            guard url.port == nil else { return false }
            return host == "localhost" || (appOrigin?.scheme?.lowercased() == "capacitor" && appOrigin?.port == nil && host == appOrigin?.host)
        }
        guard let appOrigin, appOrigin.scheme?.lowercased() == "https", let appHost = appOrigin.host?.lowercased() else { return false }
        return scheme == "https" && host.lowercased() == appHost && (url.port ?? 443) == (appOrigin.port ?? 443)
    }

    /// 256 random bits in hex: a tunnel's gate.
    public static func newGate() -> String {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.map { String(format: "%02x", $0) }.joined()
    }

    /// `pc` with a new gate, sealed.
    public func withNewGate(_ pc: Pc) throws -> Pc {
        var changed = pc
        changed.gate = try seal(Data(Self.newGate().utf8))
        return changed
    }

    /// The gate saved for `pc`, opened; nil when it has none this phone can open.
    public func gate(_ pc: Pc) -> String? {
        guard !pc.gate.isEmpty, let plain = try? sealer.open(pc.gate) else { return nil }
        return String(decoding: plain, as: UTF8.self)
    }

    private func seal(_ plain: Data) throws -> String {
        do { return try sealer.seal(plain) } catch { throw SshFailure("internal", "This phone could not seal a secret: \(error)") }
    }

    /// Seals a pasted key and its passphrase into `pc` (auth "imported").
    public func sealImported(_ pc: inout Pc, pem: String, passphrase: String, keyType: String) throws {
        pc.importedKey = try seal(Data(pem.utf8))
        pc.importedPassphrase = passphrase.isEmpty ? "" : try seal(Data(passphrase.utf8))
        pc.auth = "imported"
        pc.keyType = keyType
    }

    /// The pasted key saved for `pc`, opened: `key-unreadable` when this phone can no longer open it.
    public func importedKey(_ pc: Pc) throws -> NIOSSHPrivateKey {
        let pem: String, passphrase: String
        do {
            pem = String(decoding: try sealer.open(pc.importedKey), as: UTF8.self)
            passphrase = pc.importedPassphrase.isEmpty ? "" : String(decoding: try sealer.open(pc.importedPassphrase), as: UTF8.self)
        } catch {
            throw SshFailure("key-unreadable", String(describing: error))
        }
        return try SshKeys.read(pem, passphrase: passphrase).key
    }

    /// The key `pc` signs in with.
    public func signInKey(_ pc: Pc) throws -> NIOSSHPrivateKey {
        pc.auth == "imported" ? try importedKey(pc) : NIOSSHPrivateKey(ed25519Key: try phoneKey())
    }

    /// This phone's own ed25519 key, made on first use. Its private half is sealed; only the public key leaves the
    /// app. A key this phone can no longer open fails with `key-lost` (renewPhoneKey makes another).
    public func phoneKey() throws -> Curve25519.Signing.PrivateKey {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let sealed = prefs.get("phoneKeySeed"), pub = prefs.get("phoneKeyPublic")
        if sealed == nil && pub == nil { return try renewPhoneKey() }
        // half a key is a key lost, never a reason to make another one quietly
        guard let sealed, let pub else { throw SshFailure("key-lost", "Half of this phone's key is missing") }
        do {
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: try sealer.open(sealed))
            guard key.publicKey.rawRepresentation.base64EncodedString() == pub else { throw SshFailure("key-lost", "This phone's key does not match its public half") }
            return key
        } catch let failure as SshFailure {
            throw failure
        } catch {
            throw SshFailure("key-lost", String(describing: error))
        }
    }

    /// Replaces this phone's key with a new one: every PC that knew the old one has to be registered again.
    @discardableResult
    public func renewPhoneKey() throws -> Curve25519.Signing.PrivateKey {
        Self.lock.lock(); defer { Self.lock.unlock() }
        let made = Curve25519.Signing.PrivateKey()
        let values: [String: String?] = [
            "phoneKeySeed": try seal(made.rawRepresentation),
            "phoneKeyPublic": made.publicKey.rawRepresentation.base64EncodedString()
        ]
        guard prefs.put(values) else { throw SshFailure("internal", "This phone could not save its key") }
        return made
    }

    /// The comment on this phone's key line: `ovis-phone:<model>`, so it can be told apart in authorized_keys.
    public static func phoneComment(_ model: String) -> String {
        let name = model.isEmpty ? "phone" : String(model.map { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) ? $0 : "-" })
        return "ovis-phone:" + name
    }

    public func phoneKeyLine(model: String) throws -> String {
        try SshKeys.publicLine(NIOSSHPrivateKey(ed25519Key: try phoneKey()).publicKey, comment: Self.phoneComment(model))
    }

    /// Whether another saved PC may sign in with this phone's key to the same account: the same user on the same
    /// host name (any port), or on a machine that shows the same host key. When in doubt the key stays there.
    public static func sharedAccount(_ pcs: [Pc], _ pc: Pc) -> Bool {
        pcs.contains { other in
            other.origin != pc.origin && other.auth == "phone-key" && other.user == pc.user
                && (other.host.caseInsensitiveCompare(pc.host) == .orderedSame || (pc.hasHostKey && pc.hostKey == other.hostKey))
        }
    }
}
