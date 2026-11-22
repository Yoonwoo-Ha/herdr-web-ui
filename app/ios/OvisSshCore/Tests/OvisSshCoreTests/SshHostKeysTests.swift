import Foundation
import XCTest
@testable import OvisSshCore

/// Android's SshHostKeysTest, over the same test-only keys.
final class SshHostKeysTests: XCTestCase {
    func testOnlyTheConfirmedKeyOfTheConfirmedTypeLetsAConnectionOn() {
        let key = Data([1, 2, 3, 4])
        let saved = SshHostKeys.encode(key)
        XCTAssertEqual(SshHostKeys.judge(expectedAlgorithm: "ssh-ed25519", expectedKey: saved, algorithm: "ssh-ed25519", key: key), .same)
        XCTAssertEqual(SshHostKeys.judge(expectedAlgorithm: "ssh-ed25519", expectedKey: saved, algorithm: "ecdsa-sha2-nistp256", key: key), .changed)
        XCTAssertEqual(SshHostKeys.judge(expectedAlgorithm: "ssh-ed25519", expectedKey: saved, algorithm: "ssh-ed25519", key: Data([1, 2, 3, 5])), .changed)
    }

    func testNoSavedKeyIsUnknownNeverTrusted() {
        XCTAssertEqual(SshHostKeys.judge(expectedAlgorithm: "", expectedKey: "", algorithm: "ssh-ed25519", key: Data([1])), .unknown)
    }

    func testASavedKeyThatCannotBeReadFailsClosed() {
        XCTAssertEqual(SshHostKeys.judge(expectedAlgorithm: "ssh-ed25519", expectedKey: "not base64!", algorithm: "ssh-ed25519", key: Data([1])), .changed)
        XCTAssertEqual(SshHostKeys.fingerprint(saved: "not base64!"), "")
        XCTAssertEqual(SshHostKeys.fingerprint(saved: ""), "")
    }

    func testFingerprintsAreTheOnesSshKeygenPrints() throws {
        for name in ["ed25519", "ecdsa", "rsa-pem"] {
            let line = try TestKeys.text("\(name).pub")
            let blob = try XCTUnwrap(Data(base64Encoded: String(line.split(separator: " ")[1])))
            let expected = try TestKeys.text("\(name).fingerprint").trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertEqual(SshHostKeys.fingerprint(blob), expected, name)
        }
    }

    func testReadsTailscaleSshsCheckLinkAndNothingElse() {
        XCTAssertEqual(SshConnection.checkLink("# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l130ea4b830eaf8\n"), "https://login.tailscale.com/a/l130ea4b830eaf8")
        XCTAssertEqual(SshConnection.checkLink("visit: https://login.tailscale.com/a/abc123."), "https://login.tailscale.com/a/abc123")
        XCTAssertNil(SshConnection.checkLink("visit: https://login.tailscale.com.evil.example/a/abc"))
        XCTAssertNil(SshConnection.checkLink("Welcome to the box"))
    }

    func testOnlyTheHostKeyAndKeyFailuresStopReconnecting() {
        for kind in ["host-key-changed", "host-key-unknown", "auth", "key-unreadable", "key-lost"] { XCTAssertTrue(SshFailure(kind, "").stops, kind) }
        for kind in ["unreachable", "timeout", "no-ovis", "not-started", "internal", "cancelled"] { XCTAssertFalse(SshFailure(kind, "").stops, kind) }
    }
}

/// The Android app's test-only SSH keys (app/android/app/src/test/resources/ssh-test-keys), read where they are.
enum TestKeys {
    static let folder = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("android/app/src/test/resources/ssh-test-keys")

    static func text(_ name: String) throws -> String {
        try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)
    }
}
