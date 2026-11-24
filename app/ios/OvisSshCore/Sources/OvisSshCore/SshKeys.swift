import CommonCrypto
import CryptoKit
import Foundation
import NIOSSH

/// Private keys pasted into the app, and the phone's own key's line. Read here: OpenSSH's own format (what
/// `ssh-keygen` writes since 7.8), ed25519 or ECDSA, with or without a passphrase (bcrypt_pbkdf, aes-ctr), and
/// PEM ECDSA keys (`BEGIN EC PRIVATE KEY`). SwiftNIO SSH signs with no RSA key, so an RSA key is
/// `key-unsupported` on the iPhone (the Android app takes it). Each way a paste can fail has the kind
/// Android's SshKeys.java gives it, so the screens say the same.
public enum SshKeys {
    public struct Read {
        public let key: NIOSSHPrivateKey
        /// "ed25519" or "ecdsa"
        public let type: String
        /// the curve's size of an ECDSA key, 256 for ed25519
        public let bits: Int
        public let encrypted: Bool

        public func publicLine(_ comment: String) throws -> String { try SshKeys.publicLine(key.publicKey, comment: comment) }

        /// What the key is, for the screens: "ed25519", "ecdsa 256".
        public var label: String { type == "ed25519" ? "ed25519" : "\(type) \(bits)" }
    }

    /// What a paste looks like without its passphrase: nil when it is a key this reads, else why not.
    public static func precheck(_ text: String) -> SshFailure? {
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.isEmpty { return SshFailure("key-missing", "No private key was pasted") }
        if key.hasPrefix("PuTTY-User-Key-File") { return SshFailure("key-format", "A PuTTY key", command: "puttygen key.ppk -O private-openssh -o key") }
        if key.contains("BEGIN PRIVATE KEY") || key.contains("BEGIN ENCRYPTED PRIVATE KEY") {
            return SshFailure("key-format", "A PKCS#8 key", command: "ssh-keygen -p -f key")
        }
        if (key.hasPrefix("ssh-") || key.hasPrefix("ecdsa-") || key.hasPrefix("sk-")) && !key.contains("PRIVATE KEY") {
            return SshFailure("key-public", "A public key, not the private one")
        }
        if key.contains("BEGIN DSA PRIVATE KEY") { return SshFailure("key-unsupported", "DSA keys are no longer accepted by OpenSSH") }
        if key.contains("BEGIN RSA PRIVATE KEY") { return SshFailure("key-unsupported", "RSA keys work in the Android app; on the iPhone use an ed25519 or ECDSA key") }
        if pemBody(key, "OPENSSH PRIVATE KEY") != nil || pemBody(key, "EC PRIVATE KEY") != nil { return nil }
        return SshFailure("key-not-a-key", "No -----BEGIN … PRIVATE KEY----- block")
    }

    /// Whether a paste that passes precheck needs a passphrase.
    public static func encrypted(_ text: String) -> Bool {
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.contains("Proc-Type: 4,ENCRYPTED") { return true }
        guard let body = pemBody(key, "OPENSSH PRIVATE KEY"), var reader = OpenSshReader(body) else { return false }
        return (try? reader.cipher()).map { $0 != "none" } ?? false
    }

    /// The key in `text`, opened with `passphrase` ("" for none). Slow for one with a passphrase (bcrypt): never on the main thread.
    public static func read(_ text: String, passphrase: String) throws -> Read {
        if let early = precheck(text) { throw early }
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let body = pemBody(key, "OPENSSH PRIVATE KEY") { return try readOpenSsh(body, passphrase: passphrase) }
        if key.contains("Proc-Type: 4,ENCRYPTED") {
            if passphrase.isEmpty { throw SshFailure("key-needs-passphrase", "The key is protected by a passphrase") }
            throw SshFailure("key-format", "An encrypted PEM key", command: "ssh-keygen -p -f key")
        }
        return try readPemEc(key)
    }

    /// `key` as a line for authorized_keys, with `comment` (letters, digits and . _ : - only, which no shell quote breaks).
    public static func publicLine(_ key: NIOSSHPublicKey, comment: String) throws -> String {
        guard comment.range(of: "^[A-Za-z0-9._:-]*$", options: .regularExpression) != nil else {
            throw SshFailure("internal", "Unexpected characters in the key's comment")
        }
        let line = String(openSSHPublicKey: key)
        return comment.isEmpty ? line : line + " " + comment
    }

    /// The wire bytes of a public key (its line's Base64 field), as host keys are saved and fingerprinted.
    public static func wireBytes(_ key: NIOSSHPublicKey) -> Data {
        let parts = String(openSSHPublicKey: key).split(separator: " ")
        return parts.count > 1 ? Data(base64Encoded: String(parts[1])) ?? Data() : Data()
    }

    /// The algorithm name of a public key (its line's first field: `ssh-ed25519`, `ecdsa-sha2-nistp256`, …).
    public static func algorithm(_ key: NIOSSHPublicKey) -> String {
        String(String(openSSHPublicKey: key).split(separator: " ").first ?? "")
    }

    static func pemBody(_ text: String, _ label: String) -> Data? {
        guard let start = text.range(of: "-----BEGIN \(label)-----"),
              let end = text.range(of: "-----END \(label)-----", range: start.upperBound..<text.endIndex) else { return nil }
        let inner = text[start.upperBound..<end.lowerBound]
        let base64 = inner.split(whereSeparator: { $0.isNewline }).filter { !$0.contains(":") }.joined().filter { !$0.isWhitespace }
        return Data(base64Encoded: String(base64))
    }

    private static func readPemEc(_ text: String) throws -> Read {
        if let key = try? P256.Signing.PrivateKey(pemRepresentation: text) { return Read(key: NIOSSHPrivateKey(p256Key: key), type: "ecdsa", bits: 256, encrypted: false) }
        if let key = try? P384.Signing.PrivateKey(pemRepresentation: text) { return Read(key: NIOSSHPrivateKey(p384Key: key), type: "ecdsa", bits: 384, encrypted: false) }
        if let key = try? P521.Signing.PrivateKey(pemRepresentation: text) { return Read(key: NIOSSHPrivateKey(p521Key: key), type: "ecdsa", bits: 521, encrypted: false) }
        throw SshFailure("key-not-a-key", "The EC key could not be read")
    }

    private static func readOpenSsh(_ body: Data, passphrase: String) throws -> Read {
        guard var reader = OpenSshReader(body) else { throw SshFailure("key-not-a-key", "Not an OpenSSH key") }
        let cipher = try reader.cipher()
        let kdf = try reader.string()
        let kdfOptions = try reader.string()
        guard try reader.uint32() == 1 else { throw SshFailure("key-unsupported", "Only one key per file is read") }
        _ = try reader.string()
        var secret = try reader.string()
        let encrypted = cipher != "none"
        if encrypted {
            if passphrase.isEmpty { throw SshFailure("key-needs-passphrase", "The key is protected by a passphrase") }
            guard kdf == Data("bcrypt".utf8), let keyLength = ["aes256-ctr": 32, "aes192-ctr": 24, "aes128-ctr": 16][cipher] else {
                throw SshFailure("key-unsupported", "Unsupported encryption: \(cipher)")
            }
            var options = OpenSshReader(raw: kdfOptions)
            let salt = try options.string()
            let rounds = Int(try options.uint32())
            guard rounds >= 1, rounds <= 4096,
                  let derived = BcryptPbkdf.derive(password: Data(passphrase.utf8), salt: salt, rounds: rounds, length: keyLength + 16) else {
                throw SshFailure("key-not-a-key", "Unreadable key options")
            }
            guard let plain = aesCtr(secret, key: derived.prefix(keyLength), iv: derived.suffix(16)) else { throw SshFailure("internal", "AES-CTR failed") }
            secret = plain
        }
        var inner = OpenSshReader(raw: secret)
        guard let check1 = try? inner.uint32(), let check2 = try? inner.uint32(), check1 == check2 else {
            if encrypted { throw SshFailure("key-wrong-passphrase", "The passphrase does not open this key") }
            throw SshFailure("key-not-a-key", "The key's check words differ")
        }
        let type = String(decoding: try inner.string(), as: UTF8.self)
        switch type {
        case "ssh-ed25519":
            _ = try inner.string()
            let pair = try inner.string()
            guard pair.count == 64, let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: pair.prefix(32)) else {
                throw SshFailure("key-not-a-key", "A damaged ed25519 key")
            }
            return Read(key: NIOSSHPrivateKey(ed25519Key: key), type: "ed25519", bits: 256, encrypted: encrypted)
        case "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521":
            _ = try inner.string()
            _ = try inner.string()
            var scalar = try inner.string()
            while scalar.first == 0 && scalar.count > 1 { scalar = scalar.dropFirst() }
            func padded(_ size: Int) -> Data { Data(repeating: 0, count: max(0, size - scalar.count)) + scalar }
            do {
                switch type {
                case "ecdsa-sha2-nistp256": return Read(key: NIOSSHPrivateKey(p256Key: try P256.Signing.PrivateKey(rawRepresentation: padded(32))), type: "ecdsa", bits: 256, encrypted: encrypted)
                case "ecdsa-sha2-nistp384": return Read(key: NIOSSHPrivateKey(p384Key: try P384.Signing.PrivateKey(rawRepresentation: padded(48))), type: "ecdsa", bits: 384, encrypted: encrypted)
                default: return Read(key: NIOSSHPrivateKey(p521Key: try P521.Signing.PrivateKey(rawRepresentation: padded(66))), type: "ecdsa", bits: 521, encrypted: encrypted)
                }
            } catch {
                throw SshFailure("key-not-a-key", "A damaged ECDSA key")
            }
        case "ssh-rsa":
            throw SshFailure("key-unsupported", "RSA keys work in the Android app; on the iPhone use an ed25519 or ECDSA key")
        default:
            throw SshFailure("key-unsupported", "unknown key type \(type)")
        }
    }

    private static func aesCtr(_ data: Data, key: Data, iv: Data) -> Data? {
        var cryptor: CCCryptorRef?
        let created = key.withUnsafeBytes { keyBytes in
            iv.withUnsafeBytes { ivBytes in
                CCCryptorCreateWithMode(CCOperation(kCCDecrypt), CCMode(kCCModeCTR), CCAlgorithm(kCCAlgorithmAES), CCPadding(ccNoPadding),
                                        ivBytes.baseAddress, keyBytes.baseAddress, key.count, nil, 0, 0, CCModeOptions(kCCModeOptionCTR_BE), &cryptor)
            }
        }
        guard created == kCCSuccess, let cryptor else { return nil }
        defer { CCCryptorRelease(cryptor) }
        var out = Data(count: data.count)
        var moved = 0
        let status = out.withUnsafeMutableBytes { outBytes in
            data.withUnsafeBytes { inBytes in
                CCCryptorUpdate(cryptor, inBytes.baseAddress, data.count, outBytes.baseAddress, data.count, &moved)
            }
        }
        return status == kCCSuccess && moved == data.count ? out : nil
    }
}

/// The fields of an OpenSSH private key (PROTOCOL.key): length-prefixed strings and big-endian words.
struct OpenSshReader {
    private let bytes: [UInt8]
    private var at = 0

    init?(_ body: Data) {
        let magic = Array("openssh-key-v1".utf8) + [0]
        guard body.count > magic.count, Array(body.prefix(magic.count)) == magic else { return nil }
        bytes = [UInt8](body)
        at = magic.count
    }

    init(raw: Data) { bytes = [UInt8](raw) }

    mutating func uint32() throws -> UInt32 {
        guard bytes.count - at >= 4 else { throw SshFailure("key-not-a-key", "The key ends early") }
        let value = bytes[at..<at + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        at += 4
        return value
    }

    mutating func string() throws -> Data {
        let length = Int(try uint32())
        guard length <= bytes.count - at else { throw SshFailure("key-not-a-key", "The key ends early") }
        defer { at += length }
        return Data(bytes[at..<at + length])
    }

    mutating func cipher() throws -> String { String(decoding: try string(), as: UTF8.self) }
}
