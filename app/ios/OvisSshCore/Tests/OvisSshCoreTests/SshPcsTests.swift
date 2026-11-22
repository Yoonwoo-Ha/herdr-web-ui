import CryptoKit
import Foundation
import XCTest
@testable import OvisSshCore

final class MemoryPrefs: SshPcs.Prefs {
    var values: [String: String] = [:]
    var failWrites = false

    func get(_ name: String) -> String? { values[name] }

    func put(_ changes: [String: String?]) -> Bool {
        if failWrites { return false }
        for (name, value) in changes { values[name] = value }
        return true
    }
}

/// Seals with AES-GCM under a key of its own, as the app's Keychain sealer does; a new `key` stands for one the phone lost.
final class TestSealer: SshPcs.Sealer {
    var key = SymmetricKey(size: .bits256)

    func seal(_ plain: Data) throws -> String { try AES.GCM.seal(plain, using: key).combined!.base64EncodedString() }

    func open(_ sealed: String) throws -> Data {
        guard let data = Data(base64Encoded: sealed) else { throw SshFailure("internal", "damaged") }
        return try AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: key)
    }
}

/// Android's SshPcsTest: the store, its sealed secrets and the loopback addresses it hands out.
final class SshPcsTests: XCTestCase {
    private var prefs = MemoryPrefs()
    private var sealer = TestSealer()
    private lazy var store = SshPcs(prefs: prefs, sealer: sealer)

    private func pc(_ origin: String, host: String = "box", user: String = "me") -> SshPcs.Pc {
        var pc = SshPcs.Pc()
        pc.origin = origin
        pc.host = host
        pc.user = user
        return pc
    }

    func testThePhoneKeyIsMadeOnceAndItsPrivateHalfNeverRestsInTheClear() throws {
        let first = try store.phoneKey()
        XCTAssertEqual(try store.phoneKey().rawRepresentation, first.rawRepresentation)
        let all = prefs.values.values.joined(separator: " ")
        XCTAssertFalse(all.contains(first.rawRepresentation.base64EncodedString()))
        XCTAssertTrue(try store.phoneKeyLine(model: "iPhone").hasPrefix("ssh-ed25519 "))
        XCTAssertTrue(try store.phoneKeyLine(model: "iPhone").hasSuffix(" ovis-phone:iPhone"))
    }

    func testAKeyThatCanNoLongerBeOpenedIsLostUntilANewKeyIsMade() throws {
        let first = try store.phoneKey()
        sealer.key = SymmetricKey(size: .bits256)
        XCTAssertThrowsError(try store.phoneKey()) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-lost") }
        let renewed = try store.renewPhoneKey()
        XCTAssertNotEqual(renewed.rawRepresentation, first.rawRepresentation)
        XCTAssertEqual(try store.phoneKey().rawRepresentation, renewed.rawRepresentation)
    }

    func testHalfAPhoneKeyIsLostNotQuietlyReplaced() throws {
        _ = try store.phoneKey()
        prefs.values["phoneKeyPublic"] = nil
        XCTAssertThrowsError(try store.phoneKey()) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-lost") }
    }

    func testAWriteThatDidNotLandIsAFailureNotASave() {
        prefs.failWrites = true
        XCTAssertThrowsError(try store.put(pc("http://127.0.0.1:47320")))
        XCTAssertThrowsError(try store.phoneKey())
    }

    func testKeepsFindsAndRemovesPcsByTheirOrigin() throws {
        try store.put(pc("http://127.0.0.1:47320"))
        try store.put(pc("http://127.0.0.1:47321", host: "other"))
        XCTAssertEqual(store.get("http://127.0.0.1:47320")?.host, "box")
        XCTAssertEqual(store.find(host: "BOX", port: 22, user: "me")?.origin, "http://127.0.0.1:47320")
        try store.remove("http://127.0.0.1:47320")
        XCTAssertNil(store.get("http://127.0.0.1:47320"))
        XCTAssertEqual(store.list().count, 1)
    }

    func testForgettingAHostKeyKeepsEverythingElse() throws {
        var saved = pc("http://127.0.0.1:47320")
        saved.hostKeyAlgorithm = "ssh-ed25519"
        saved.hostKey = "AAAA"
        try store.put(saved)
        try store.forgetHostKey(saved.origin)
        let after = try XCTUnwrap(store.get(saved.origin))
        XCTAssertFalse(after.hasHostKey)
        XCTAssertEqual(after.hostKeyAlgorithm, "")
        XCTAssertEqual(after.host, "box")
    }

    func testEachPcGetsALoopbackPortOfItsOwnNeverOneARemovedPcHad() throws {
        let first = try store.freeOrigin()
        XCTAssertEqual(first, "http://127.0.0.1:47320")
        try store.put(pc(first))
        let second = try store.freeOrigin()
        XCTAssertEqual(second, "http://127.0.0.1:47321")
        try store.remove(first)
        XCTAssertEqual(try store.freeOrigin(), "http://127.0.0.1:47322")
        prefs.values["lastLoopbackPort"] = String(SshPcs.firstPort + SshPcs.portCount - 1)
        XCTAssertEqual(try store.freeOrigin(), first)
    }

    func testAPastedKeyItsPassphraseAndTheGateAreSealedAndOpenOnlyWithTheVault() throws {
        var saved = pc("http://127.0.0.1:47320")
        let pem = try TestKeys.text("ed25519-pass")
        try store.sealImported(&saved, pem: pem, passphrase: "test-only-passphrase", keyType: "ed25519")
        saved = try store.withNewGate(saved)
        try store.put(saved)
        let all = prefs.values.values.joined(separator: " ")
        XCTAssertFalse(all.contains("OPENSSH"))
        XCTAssertFalse(all.contains("test-only-passphrase"))
        let gate = try XCTUnwrap(store.gate(saved))
        XCTAssertFalse(all.contains(gate))
        _ = try store.importedKey(try XCTUnwrap(store.get(saved.origin)))
        sealer.key = SymmetricKey(size: .bits256)
        XCTAssertThrowsError(try store.importedKey(saved)) { XCTAssertEqual(($0 as? SshFailure)?.kind, "key-unreadable") }
        XCTAssertNil(store.gate(saved))
    }

    func testADamagedListStartsEmptyAndTakesNewPcs() throws {
        prefs.values["pcs"] = "{not json"
        XCTAssertTrue(store.list().isEmpty)
        try store.put(pc("http://127.0.0.1:47320"))
        XCTAssertEqual(store.list().count, 1)
    }

    func testOnlyTheAppsOwnPagesAndTheHostedAppOpenTheSshSetup() {
        XCTAssertTrue(SshPcs.setupOpener(URL(string: "capacitor://localhost/index.html")))
        XCTAssertTrue(SshPcs.setupOpener(URL(string: "https://app.ovis.sh/#pcs")))
        for page in ["https://app.ovis.sh.evil.example/", "http://app.ovis.sh/", "https://app.ovis.sh:8443/", "http://127.0.0.1:47320/", "https://desk.tail1e211e.ts.net/", "capacitor://other/"] {
            XCTAssertFalse(SshPcs.setupOpener(URL(string: page)), page)
        }
        XCTAssertFalse(SshPcs.setupOpener(nil))
    }

    func testGatesAreLongAndUnguessable() {
        let gates = Set((0..<50).map { _ in SshPcs.newGate() })
        XCTAssertEqual(gates.count, 50)
        XCTAssertTrue(gates.allSatisfy { $0.count == 64 && $0.allSatisfy(\.isHexDigit) })
    }

    func testTheRemoteKeyIsKeptWhileAnotherPcMaySignInToTheSameAccountWithIt() {
        var a = pc("http://127.0.0.1:47320"), b = pc("http://127.0.0.1:47321", host: "BOX")
        XCTAssertTrue(SshPcs.sharedAccount([a, b], a))
        b.host = "elsewhere"
        XCTAssertFalse(SshPcs.sharedAccount([a, b], a))
        a.hostKey = "SAME"
        b.hostKey = "SAME"
        XCTAssertTrue(SshPcs.sharedAccount([a, b], a))
        b.user = "someone"
        XCTAssertFalse(SshPcs.sharedAccount([a, b], a))
    }

    func testAPcReadsBackAsItWasSaved() throws {
        var saved = pc("http://127.0.0.1:47320")
        saved.port = 2222
        saved.hostKeyAlgorithm = "ssh-ed25519"
        saved.hostKey = "AAAA"
        try store.put(saved)
        XCTAssertEqual(store.get(saved.origin), saved)
        XCTAssertEqual(saved.label, "me@box:2222")
        XCTAssertEqual(saved.localPort, 47320)
    }

    func testTheLoopbackAtAPortNoSshPcListensOnIsNeitherOpenedNorLoaded() {
        let ports: Set<Int> = [47320]
        XCTAssertFalse(SshPcs.otherLoopbackPort("http://127.0.0.1:47320/x", sshPorts: ports))
        for url in ["http://127.0.0.1:8080/", "http://127.1:8080/", "http://2130706433:9/", "http://0x7f.0.0.1:47321/", "https://127.0.0.1:47320/",
                    "http://localhost:47321/", "http://127.0.0.2:47320/", "http://%31%32%37.0.0.1:1/"] {
            XCTAssertTrue(SshPcs.otherLoopbackPort(url, sshPorts: ports), url)
        }
        XCTAssertFalse(SshPcs.otherLoopbackPort("http://192.168.0.2:8080/", sshPorts: ports))
        XCTAssertFalse(SshPcs.otherLoopbackPort("http://127.0.0.1:8080/", sshPorts: []))
    }
}
