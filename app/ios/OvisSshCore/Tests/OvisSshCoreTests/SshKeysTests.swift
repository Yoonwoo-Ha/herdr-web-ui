import Foundation
import NIOSSH
import XCTest
@testable import OvisSshCore

/// Android's SshKeysTest, over the same keys made by ssh-keygen: what the iPhone reads, and the kind of each refusal.
final class SshKeysTests: XCTestCase {
    private let passphrase = "test-only-passphrase"

    private func publicLine(_ name: String) throws -> String {
        let parts = try TestKeys.text("\(name).pub").split(separator: " ")
        return parts[0] + " " + parts[1]
    }

    func testReadsTheOpenSshAndPemKeysOpenSshAcceptsThatSwiftNioSshSignsWith() throws {
        let ed25519 = try SshKeys.read(try TestKeys.text("ed25519"), passphrase: "")
        XCTAssertEqual(ed25519.label, "ed25519")
        XCTAssertFalse(ed25519.encrypted)
        XCTAssertEqual(try ed25519.publicLine(""), try publicLine("ed25519"))

        let ecdsa = try SshKeys.read(try TestKeys.text("ecdsa"), passphrase: "")
        XCTAssertEqual(ecdsa.label, "ecdsa 256")
        XCTAssertEqual(try ecdsa.publicLine(""), try publicLine("ecdsa"))
    }

    func testOpensAKeyWithItsPassphraseThroughBcryptPbkdf() throws {
        let read = try SshKeys.read(try TestKeys.text("ed25519-pass"), passphrase: passphrase)
        XCTAssertTrue(read.encrypted)
        XCTAssertEqual(try read.publicLine(""), try publicLine("ed25519-pass"))
    }

    func testReadsAKeyPastedWithSpaceAroundIt() throws {
        let read = try SshKeys.read("\n  " + (try TestKeys.text("ed25519")) + "\n\n", passphrase: "")
        XCTAssertEqual(try read.publicLine(""), try publicLine("ed25519"))
    }

    func testAsksForThePassphraseOfAnEncryptedKeyBeforeTryingIt() throws {
        let text = try TestKeys.text("ed25519-pass")
        XCTAssertNil(SshKeys.precheck(text))
        XCTAssertTrue(SshKeys.encrypted(text))
        XCTAssertFalse(SshKeys.encrypted(try TestKeys.text("ed25519")))
        XCTAssertThrowsError(try SshKeys.read(text, passphrase: "")) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-needs-passphrase") }
    }

    func testTellsAWrongPassphraseApartFromAKeyItCannotRead() throws {
        XCTAssertThrowsError(try SshKeys.read(try TestKeys.text("ed25519-pass"), passphrase: "not-it")) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-wrong-passphrase") }
        XCTAssertThrowsError(try SshKeys.read("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", passphrase: "")) {
            XCTAssertEqual(($0 as? SshFailure)?.kind, "key-not-a-key")
        }
    }

    func testRsaKeysAreToldToBeAndroidOnlyOnTheIphone() throws {
        XCTAssertEqual(SshKeys.precheck(try TestKeys.text("rsa-pem"))?.kind, "key-unsupported")
        XCTAssertThrowsError(try SshKeys.read(try TestKeys.text("rsa-pass"), passphrase: passphrase)) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-unsupported") }
    }

    func testSendsAPkcs8KeyToSshKeygenToConvert() throws {
        let failure = SshKeys.precheck(try TestKeys.text("rsa-pkcs8"))
        XCTAssertEqual(failure?.kind, "key-format")
        XCTAssertEqual(failure?.command, "ssh-keygen -p -f key")
    }

    func testNamesWhatWasPastedInsteadOfAPrivateKey() throws {
        XCTAssertEqual(SshKeys.precheck("")?.kind, "key-missing")
        XCTAssertEqual(SshKeys.precheck(try TestKeys.text("ed25519.pub"))?.kind, "key-public")
        XCTAssertEqual(SshKeys.precheck("PuTTY-User-Key-File-3: ssh-ed25519")?.kind, "key-format")
        XCTAssertEqual(SshKeys.precheck("hello")?.kind, "key-not-a-key")
        XCTAssertEqual(SshKeys.precheck("-----BEGIN DSA PRIVATE KEY-----\nAA\n-----END DSA PRIVATE KEY-----")?.kind, "key-unsupported")
    }

    func testKeyLineCommentsAreLimitedToWhatAShellQuoteCannotBreak() throws {
        let key = NIOSSHPrivateKey(ed25519Key: .init()).publicKey
        XCTAssertTrue(try SshKeys.publicLine(key, comment: "ovis-phone:iPhone").hasSuffix(" ovis-phone:iPhone"))
        XCTAssertThrowsError(try SshKeys.publicLine(key, comment: "x'; rm -rf ~"))
        XCTAssertEqual(SshPcs.phoneComment("iPhone 18 Pro's"), "ovis-phone:iPhone-18-Pro-s")
        XCTAssertEqual(SshPcs.phoneComment(""), "ovis-phone:phone")
    }

    func testBcryptPbkdfMatchesTheReferenceVector() {
        // OpenBSD's regress/lib/libutil/bcrypt_pbkdf test vector: "password", salt "salt", 4 rounds, 32 bytes
        let derived = BcryptPbkdf.derive(password: Data("password".utf8), salt: Data("salt".utf8), rounds: 4, length: 32)
        XCTAssertEqual(derived?.map { String(format: "%02x", $0) }.joined(), "5bbf0cc293587f1c3635555c27796598d47e579071bf427e9d8fbe842aba34d9")
    }
}
