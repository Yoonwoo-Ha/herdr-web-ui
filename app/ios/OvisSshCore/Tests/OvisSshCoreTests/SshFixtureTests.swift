import Foundation
import NIOCore
import NIOSSH
import XCTest
@testable import OvisSshCore

/// SshConnection against a real sshd, as Android's SshFixtureTest: skipped unless OVIS_SSH_FIXTURE names one
/// (`host:port:user:/path/to/private-key:http-port`, an HTTP server on that machine's loopback at http-port; a
/// throwaway one: `sshd -D -f <config>` as yourself, with its own host key and authorized_keys file).
final class SshFixtureTests: XCTestCase {
    private struct Fixture {
        let host: String, port: Int, user: String, key: NIOSSHPrivateKey, httpPort: Int
    }

    private func fixture() throws -> Fixture {
        guard let spec = ProcessInfo.processInfo.environment["OVIS_SSH_FIXTURE"] else { throw XCTSkip("OVIS_SSH_FIXTURE is not set") }
        let parts = spec.split(separator: ":").map(String.init)
        guard parts.count == 5, let port = Int(parts[1]), let httpPort = Int(parts[4]) else { throw XCTSkip("OVIS_SSH_FIXTURE is host:port:user:key:http-port") }
        let key = try SshKeys.read(try String(contentsOfFile: parts[3], encoding: .utf8), passphrase: "").key
        return Fixture(host: parts[0], port: port, user: parts[2], key: key, httpPort: httpPort)
    }

    private func confirmed(_ f: Fixture) async throws -> SshConnection.HostKeyCheck {
        let first = SshConnection.HostKeyCheck()
        do {
            try await SshConnection.readHostKey(host: f.host, port: f.port, check: first)
            XCTFail("an unconfirmed host key let the connection on")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "host-key-unknown")
        }
        let seen = try XCTUnwrap(first.seenKey)
        return SshConnection.HostKeyCheck(expectedAlgorithm: first.seenAlgorithm, expectedKey: SshHostKeys.encode(seen))
    }

    func testSignsInRunsCommandsAndReachesTheMachinesLoopbackOverAConfirmedHostKey() async throws {
        let f = try fixture()
        let check = try await confirmed(f)
        let connection = try await SshConnection.open(host: f.host, port: f.port, check: check, user: f.user, key: f.key)
        defer { connection.close() }
        let echoed = try await connection.run("echo hi; echo ignored >&2", timeout: 10)
        XCTAssertEqual(echoed, "hi\n")
        do {
            try await connection.run("exit 3", timeout: 10, mustSucceed: true)
            XCTFail("a failed command passed")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "internal")
        }
        let lines = Holder<[String]>()
        try await connection.run("printf 'one\\ntwo\\n'", timeout: 10) { lines.value = (lines.value ?? []) + [$0] }
        XCTAssertEqual(lines.value, ["one", "two"])
        let alive = await connection.alive()
        XCTAssertTrue(alive)

        let channel = try await connection.openDirect(port: f.httpPort)
        var answer = Data()
        try await channel.executeThenClose { inbound, outbound in
            try await outbound.write(ByteBuffer(string: "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"))
            for try await bytes in inbound { answer.append(contentsOf: bytes.readableBytesView) }
        }
        XCTAssertTrue(String(decoding: answer, as: UTF8.self).hasPrefix("HTTP/1."))
    }

    /// A connection whose PC stops answering without a word (its sshd stopped here, as a suspended app or a lost NAT
    /// entry looks from the phone) is found dead within the check's deadline, not when TCP gives up.
    func testAConnectionThatStopsAnsweringIsFoundDeadInTime() async throws {
        let f = try fixture()
        let connection = try await SshConnection.open(host: f.host, port: f.port, check: try await confirmed(f), user: f.user, key: f.key)
        defer { connection.close() }
        let session = try await connection.run("echo $PPID", timeout: 10).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertNotNil(Int(session))
        kill(pid_t(Int32(session)!), SIGSTOP)
        defer { kill(pid_t(Int32(session)!), SIGCONT) }
        let started = Date()
        let alive = await connection.alive(seconds: 2)
        XCTAssertFalse(alive)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertFalse(connection.isActive)
    }

    func testAnotherHostKeyFailsClosedAndAnotherKeyIsRefused() async throws {
        let f = try fixture()
        let check = try await confirmed(f)
        let wrong = SshConnection.HostKeyCheck(expectedAlgorithm: check.expectedAlgorithm, expectedKey: SshHostKeys.encode(Data(repeating: 7, count: 51)))
        do {
            _ = try await SshConnection.open(host: f.host, port: f.port, check: wrong, user: f.user, key: f.key)
            XCTFail("another host key let the connection on")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "host-key-changed")
        }
        do {
            _ = try await SshConnection.open(host: f.host, port: f.port, check: check, user: f.user, key: NIOSSHPrivateKey(ed25519Key: .init()))
            XCTFail("an unknown key signed in")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "auth")
        }
    }

    /// The fixture's sshd shows a banner with a Tailscale check link (its Banner file) and takes no "none" sign-in.
    func testATailscaleCheckLinkReachesTheScreenAndANoneSignInRefusedIsAuth() async throws {
        let f = try fixture()
        let check = try await confirmed(f)
        do {
            _ = try await SshConnection.openTailscale(host: f.host, port: f.port, check: check, user: f.user, waitSeconds: 10) { banner in
                SshConnection.checkLink(banner).map { SshFailure("tailscale-check", "approve", command: $0) }
            }
            XCTFail("a sign-in with no key went on")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "tailscale-check")
            XCTAssertEqual(failure.command, "https://login.tailscale.com/a/fixture123")
        }
        let heard = Holder<[String]>()
        do {
            _ = try await SshConnection.openTailscale(host: f.host, port: f.port, check: check, user: f.user, waitSeconds: 10) { banner in
                heard.value = (heard.value ?? []) + [banner]
                return nil
            }
            XCTFail("a sign-in with no key went on")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "auth")
        }
        XCTAssertEqual(heard.value?.compactMap(SshConnection.checkLink), ["https://login.tailscale.com/a/fixture123"])
    }

    /// Against a real Tailscale SSH server, when OVIS_TAILSCALE_SSH names one (`host:user`, a PC of this Mac's tailnet
    /// running `tailscale up --ssh`): no key goes in, and either it signs in or it hands over its check link.
    func testARealTailscaleSshSignsInWithNoKeyOrHandsOverItsCheckLink() async throws {
        guard let spec = ProcessInfo.processInfo.environment["OVIS_TAILSCALE_SSH"] else { throw XCTSkip("OVIS_TAILSCALE_SSH is not set") }
        let parts = spec.split(separator: ":").map(String.init)
        let first = SshConnection.HostKeyCheck()
        _ = try? await SshConnection.readHostKey(host: parts[0], port: 22, check: first)
        let seen = try XCTUnwrap(first.seenKey)
        let check = SshConnection.HostKeyCheck(expectedAlgorithm: first.seenAlgorithm, expectedKey: SshHostKeys.encode(seen))
        do {
            let connection = try await SshConnection.openTailscale(host: parts[0], port: 22, check: check, user: parts[1], waitSeconds: 20) { banner in
                SshConnection.checkLink(banner).map { SshFailure("tailscale-check", "approve", command: $0) }
            }
            defer { connection.close() }
            let said = try await connection.run("echo tailscale-ssh-ok", timeout: 10)
            XCTAssertEqual(said, "tailscale-ssh-ok\n")
        } catch let failure as SshFailure where failure.kind == "tailscale-check" {
            XCTAssertNotNil(failure.command.flatMap(SshConnection.checkLink))
        }
    }

    func testNothingAnswersOnAClosedPort() async throws {
        let f = try fixture()
        do {
            _ = try await SshConnection.open(host: "127.0.0.1", port: 1, check: .init(), user: f.user, key: f.key)
            XCTFail("a closed port answered")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "unreachable")
        }
    }
}
