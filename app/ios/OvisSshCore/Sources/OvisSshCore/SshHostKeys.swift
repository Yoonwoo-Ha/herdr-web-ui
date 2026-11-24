import CryptoKit
import Foundation

/// The host-key rule of Android's SshHostKeys.java: a PC's host key is confirmed once by the person (its
/// SHA-256 fingerprint, as `ssh-keygen -lf` prints it) and saved with its algorithm. SAME (that algorithm,
/// those bytes) is the only verdict that lets a connection go on; no saved key is UNKNOWN, which never signs
/// in on its own; anything else, a saved key that cannot be read included, is CHANGED and fails closed.
public enum SshHostKeys {
    public enum Verdict: Equatable { case same, unknown, changed }

    public static func judge(expectedAlgorithm: String, expectedKey: String, algorithm: String, key: Data) -> Verdict {
        if expectedKey.isEmpty { return .unknown }
        guard let expected = Data(base64Encoded: expectedKey) else { return .changed }
        return algorithm == expectedAlgorithm && constantTimeEqual(expected, key) ? .same : .changed
    }

    /// How a host key is saved: its wire bytes in Base64.
    public static func encode(_ key: Data) -> String { key.base64EncodedString() }

    /// `SHA256:<unpadded Base64>`, as `ssh-keygen -lf` and OpenSSH's own prompt print it.
    public static func fingerprint(_ key: Data) -> String {
        "SHA256:" + Data(SHA256.hash(data: key)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }

    /// The fingerprint of a saved key, or "" when none is saved or it cannot be read.
    public static func fingerprint(saved: String) -> String {
        guard !saved.isEmpty, let key = Data(base64Encoded: saved) else { return "" }
        return fingerprint(key)
    }

    static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for (x, y) in zip(a, b) { difference |= x ^ y }
        return difference == 0
    }
}
