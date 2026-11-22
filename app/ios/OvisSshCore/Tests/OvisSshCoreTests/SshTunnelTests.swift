import Foundation
import NIOCore
import NIOPosix
import XCTest
@testable import OvisSshCore

/// A stand-in for the PC's Ovis on this machine's loopback: it keeps each request head it gets and answers with
/// `answer`, or closes without a word when `answer` is nil.
final class FakePc: @unchecked Sendable {
    let heads = Holder<[String]>()
    let answer = Holder<String>()
    private(set) var port = 0
    private var channel: Channel?

    func start() async throws {
        answer.value = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
        heads.value = []
        let bound = try await ServerBootstrap(group: SshConnection.group)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .bind(host: "127.0.0.1", port: 0) { child in
                child.eventLoop.makeCompletedFuture { try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: child) }
            }
        channel = bound.channel
        port = bound.channel.localAddress?.port ?? 0
        Task {
            try? await bound.executeThenClose { inbound in
                for try await client in inbound {
                    Task {
                        try? await client.executeThenClose { input, output in
                            var iterator = input.makeAsyncIterator()
                            var rest = ByteBuffer()
                            guard let head = try await SshTunnel.readHead(&iterator, rest: &rest) else { return }
                            self.heads.value = (self.heads.value ?? []) + [String(decoding: head, as: UTF8.self)]
                            if let answer = self.answer.value { try await output.write(ByteBuffer(string: answer)) }
                        }
                    }
                }
            }
        }
    }

    func stop() { channel?.close(promise: nil) }
}

final class FakeLink: SshTunnelLink, @unchecked Sendable {
    let pcPort: Holder<Int>
    let opens = Holder<Int>()
    let refuseOpens = Holder<Int>()
    let relocations = Holder<Int>()
    let answers = Holder<Bool>()
    let closed = Holder<Bool>()
    let ended = Holder<Bool>()

    init(pcPort: Int) {
        self.pcPort = Holder()
        self.pcPort.value = pcPort
        answers.value = true
    }

    func open() async throws -> NIOAsyncChannel<ByteBuffer, ByteBuffer> {
        opens.value = (opens.value ?? 0) + 1
        if let refuse = refuseOpens.value, refuse > 0 {
            refuseOpens.value = refuse - 1
            throw SshFailure("unreachable", "refused")
        }
        return try await ClientBootstrap(group: SshConnection.group)
            .channelOption(ChannelOptions.allowRemoteHalfClosure, value: true)
            .connect(host: "127.0.0.1", port: pcPort.value ?? 0) { channel in
                channel.eventLoop.makeCompletedFuture { try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: channel) }
            }
    }

    func relocate() async throws { relocations.value = (relocations.value ?? 0) + 1 }
    func alive() async -> Bool { answers.value ?? false }
    func close() { closed.value = true }
    var isOpen: Bool { ended.value != true && closed.value != true }
}

final class SshTunnelTests: XCTestCase {
    private var pc = FakePc()
    private let now = Holder<TimeInterval>()
    private let dials = Holder<Int>()
    private let failures = Holder<[String]>()
    private let links = Holder<[FakeLink]>()
    private let dialFailure = Holder<SshFailure>()
    private var tunnel: SshTunnel!
    private var port = 0
    private let gate = SshPcs.newGate()

    override func setUp() async throws {
        try await pc.start()
        now.value = 1000
        dials.value = 0
        failures.value = []
        links.value = []
        port = try await Self.freePort()
        tunnel = makeTunnel()
        try await tunnel.listen()
    }

    override func tearDown() async throws {
        await tunnel.close()
        pc.stop()
    }

    private func makeTunnel(dialer: SshTunnel.Dialer? = nil, dialJoined: (@Sendable (Int) -> Void)? = nil) -> SshTunnel {
        let pcPort = pc.port
        let dials = self.dials, links = self.links, dialFailure = self.dialFailure, failures = self.failures, now = self.now
        return SshTunnel(gate: gate, port: port, dialer: dialer ?? {
            dials.value = (dials.value ?? 0) + 1
            if let failure = dialFailure.value { throw failure }
            let link = FakeLink(pcPort: pcPort)
            links.value = (links.value ?? []) + [link]
            return link
        }, clock: { now.value ?? 0 }, dialJoined: dialJoined, listener: { failures.value = (failures.value ?? []) + [$0.kind] })
    }

    static func freePort() async throws -> Int {
        let channel = try await ServerBootstrap(group: SshConnection.group).bind(host: "127.0.0.1", port: 0).get()
        let port = channel.localAddress?.port ?? 0
        try await channel.close()
        return port
    }

    /// Sends `request` to the tunnel as the WebView would, and reads the whole answer until the tunnel closes.
    private func send(_ headers: [String] = [], path: String = "/", cookie: Bool = true) async throws -> String {
        var lines = ["GET \(path) HTTP/1.1", "Host: 127.0.0.1:\(port)", "Connection: keep-alive"]
        if cookie { lines.append("Cookie: theme=dark; \(SshTunnel.cookieName(port: port))=\(gate); lang=ko") }
        lines += headers
        let request = lines.joined(separator: "\r\n") + "\r\n\r\n"
        let client = try await ClientBootstrap(group: SshConnection.group).connect(host: "127.0.0.1", port: port) { channel in
            channel.eventLoop.makeCompletedFuture { try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: channel) }
        }
        var answer = Data()
        try await client.executeThenClose { inbound, outbound in
            try await outbound.write(ByteBuffer(string: request))
            for try await bytes in inbound { answer.append(contentsOf: bytes.readableBytesView) }
        }
        return String(decoding: answer, as: UTF8.self)
    }

    func testWithoutTheGateNothingReachesThePc() async throws {
        let answer = try await send(cookie: false)
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 403"))
        let wrong = try await send(["Cookie: \(SshTunnel.cookieName(port: port))=\(String(repeating: "0", count: 64))"], cookie: false)
        XCTAssertTrue(wrong.hasPrefix("HTTP/1.1 403"))
        XCTAssertEqual(dials.value, 0)
        XCTAssertEqual(pc.heads.value?.count, 0)
    }

    func testARequestAnotherOriginsPageMakesNeverReachesThePc() async throws {
        for header in ["Origin: http://127.0.0.1:\(port + 1)", "Sec-Fetch-Site: same-site", "Sec-Fetch-Site: cross-site", "Origin: null"] {
            do {
                let answer = try await send([header])
                XCTAssertTrue(answer.hasPrefix("HTTP/1.1 403"), header)
            }
        }
        let own = try await send(["Origin: http://127.0.0.1:\(port)", "Sec-Fetch-Site: same-origin"])
        XCTAssertTrue(own.hasPrefix("HTTP/1.1 200"))
        XCTAssertEqual(pc.heads.value?.count, 1)
    }

    func testTheGatePassesTheRequestOnceAsItCameWithoutTheGateAndWithAConnectionOfItsOwn() async throws {
        let answer = try await send(path: "/api/health")
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
        XCTAssertTrue(answer.hasSuffix("ok"))
        let head = try XCTUnwrap(pc.heads.value?.first)
        XCTAssertTrue(head.hasPrefix("GET /api/health HTTP/1.1\r\n"))
        XCTAssertFalse(head.contains(gate))
        XCTAssertTrue(head.contains("Cookie: theme=dark; lang=ko"))
        XCTAssertTrue(head.contains("Connection: close"))
        XCTAssertFalse(head.contains("keep-alive"))
        XCTAssertEqual(pc.heads.value?.count, 1)
    }

    func testAnUpgradeKeepsItsConnectionHeader() {
        let head = Array("GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ovis_ssh_gate_1=x\r\n\r\n".utf8)
        let forwarded = String(decoding: SshTunnel.forwardHead(head), as: UTF8.self)
        XCTAssertEqual(forwarded, "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
    }

    func testNoSshPcsGateReachesAnyPc() {
        let head = Array("GET / HTTP/1.1\r\nCookie: ovis_ssh_gate_47321=other; theme=dark; ovis_ssh_gate_47320=mine\r\n\r\n".utf8)
        let forwarded = String(decoding: SshTunnel.forwardHead(head), as: UTF8.self)
        XCTAssertFalse(forwarded.contains("ovis_ssh_gate"))
        XCTAssertFalse(forwarded.contains("other"))
        XCTAssertTrue(forwarded.contains("theme=dark"))
    }

    func testARedirectToTheLoopbackAtAnotherPortIsRefused() async throws {
        pc.answer.value = "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8080/steal\r\nContent-Length: 0\r\n\r\n"
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 403"))
        }
        pc.answer.value = "HTTP/1.1 302 Found\r\nLocation: /login\r\nContent-Length: 0\r\n\r\n"
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 302"))
        }
    }

    func testNoConnectionIsMadeBeforeARequestNeedsIt() async throws {
        XCTAssertEqual(dials.value, 0)
        _ = try await send()
        _ = try await send()
        XCTAssertEqual(dials.value, 1)
    }

    func testAFailureAnswersTheBurstAtOnceThenIsTriedAgain() async throws {
        dialFailure.value = SshFailure("unreachable", "down")
        let first = try await send()
        XCTAssertTrue(first.hasPrefix("HTTP/1.1 503"))
        XCTAssertTrue(first.contains("X-Ovis-Ssh: unreachable"))
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 503"))
        }
        XCTAssertEqual(dials.value, 1)
        now.value = 1003
        dialFailure.value = nil
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
        }
        XCTAssertEqual(dials.value, 2)
        XCTAssertEqual(failures.value, ["unreachable", "unreachable"])
    }

    func testAStopIsNeverTriedAgain() async throws {
        dialFailure.value = SshFailure("auth", "refused")
        do {
            let answer = try await send()
            XCTAssertTrue(answer.contains("X-Ovis-Ssh: auth"))
        }
        now.value = 2000
        dialFailure.value = nil
        do {
            let answer = try await send()
            XCTAssertTrue(answer.contains("X-Ovis-Ssh: auth"))
        }
        XCTAssertEqual(dials.value, 1)
    }

    func testATailscaleCheckStopsUntilTryAgainAndOtherStopsStay() async throws {
        dialFailure.value = SshFailure("tailscale-check", "approve", command: "https://login.tailscale.com/a/x")
        let first = try await send()
        XCTAssertTrue(first.contains("X-Ovis-Ssh: tailscale-check"))
        now.value = 2000
        _ = try await send()
        XCTAssertEqual(dials.value, 1)
        dialFailure.value = nil
        await tunnel.resume()
        let again = try await send()
        XCTAssertTrue(again.hasPrefix("HTTP/1.1 200"))
        XCTAssertEqual(dials.value, 2)
        await tunnel.close()
        port = try await Self.freePort()
        tunnel = makeTunnel()
        try await tunnel.listen()
        dialFailure.value = SshFailure("auth", "refused")
        _ = try await send()
        await tunnel.resume()
        now.value = 3000
        _ = try await send()
        XCTAssertEqual(dials.value, 3)
    }

    func testAConnectionThatEndedIsMadeAgainOnTheNextRequestAskingNothing() async throws {
        _ = try await send()
        links.value?.first?.ended.value = true
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
        }
        XCTAssertEqual(dials.value, 2)
    }

    func testADropEndsTheConnectionAndTheNextRequestMakesAnother() async throws {
        _ = try await send()
        await tunnel.drop()
        XCTAssertEqual(links.value?.first?.closed.value, true)
        _ = try await send()
        XCTAssertEqual(dials.value, 2)
    }

    func testARequestThePcEndsBeforeAnsweringGets503AndIsNeverSentAgain() async throws {
        pc.answer.value = nil
        let answer = try await send()
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 503"))
        XCTAssertTrue(answer.contains("X-Ovis-Ssh: unreachable"))
        XCTAssertEqual(pc.heads.value?.count, 1)
    }

    func testAnOvisThatMovedIsLookedUpAgainOnce() async throws {
        _ = try await send()
        let link = try XCTUnwrap(links.value?.first)
        link.refuseOpens.value = 1
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
        }
        XCTAssertEqual(link.relocations.value, nil)
        link.refuseOpens.value = 2
        do {
            let answer = try await send()
            XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
        }
        XCTAssertEqual(link.relocations.value, 1)
    }

    func testWakingMakesANewConnectionOnlyForOneThatNoLongerAnswers() async throws {
        await tunnel.wake()
        XCTAssertEqual(dials.value, 0)
        _ = try await send()
        await tunnel.wake()
        XCTAssertEqual(dials.value, 1)
        links.value?.first?.answers.value = false
        await tunnel.wake()
        XCTAssertEqual(dials.value, 2)
        XCTAssertEqual(links.value?.first?.closed.value, true)
    }

    func testABurstWaitingOnOneDialDialsOnce() async throws {
        await tunnel.close()
        let (released, release) = AsyncStream<Void>.makeStream()
        let pcPort = pc.port, dials = self.dials
        port = try await Self.freePort()
        tunnel = makeTunnel(dialer: {
            dials.value = (dials.value ?? 0) + 1
            for await _ in released { break }
            return FakeLink(pcPort: pcPort)
        }, dialJoined: { waiting in if waiting == 3 { release.yield() } })
        try await tunnel.listen()
        async let a = send()
        async let b = send()
        async let c = send()
        let answers = try await [a, b, c]
        XCTAssertTrue(answers.allSatisfy { $0.hasPrefix("HTTP/1.1 200") })
        XCTAssertEqual(dials.value, 1)
    }

    func testTheAppReadsThePcsOvisOverTheTunnelWithoutAPage() async throws {
        pc.answer.value = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"pcs\":[1]}\r\n0\r\n\r\n"
        let body = try await tunnel.get("/api/machines/ssh-candidates")
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "{\"pcs\":[1]}")
        let head = try XCTUnwrap(pc.heads.value?.last)
        XCTAssertTrue(head.hasPrefix("GET /api/machines/ssh-candidates HTTP/1.1\r\n"))
        XCTAssertFalse(head.contains("ovis_ssh_gate"))
        pc.answer.value = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
        do {
            _ = try await tunnel.get("/api/machines")
            XCTFail("a 404 was read as an answer")
        } catch let failure as SshFailure {
            XCTAssertEqual(failure.kind, "internal")
        }
    }

    func testAPortAnotherListenerHoldsIsNeverLetThroughNorGivenAGate() async throws {
        let store = SshPcs(prefs: MemoryPrefs(), sealer: TestSealer())
        let tunnels = SshTunnels(store: store)
        let stranger = try await ServerBootstrap(group: SshConnection.group).bind(host: "127.0.0.1", port: 0).get()
        defer { stranger.close(promise: nil) }
        let taken = try XCTUnwrap(stranger.localAddress?.port)
        let free = try await Self.freePort()
        for (port, host) in [(taken, "taken"), (free, "free")] {
            var pc = SshPcs.Pc()
            pc.origin = "http://127.0.0.1:\(port)"
            pc.host = host
            pc.user = "me"
            try store.put(try store.withNewGate(pc))
        }
        let held = await tunnels.listenAll()
        XCTAssertEqual(held, [free])
        do {
            try await tunnels.open(try XCTUnwrap(store.get("http://127.0.0.1:\(taken)")))
            XCTFail("a port another listener holds was opened, and would have been given its gate")
        } catch {}
        await tunnels.closeFor("http://127.0.0.1:\(free)")
    }

    func testAClosedTunnelsPortIsFreeForTheNextAtOnce() async throws {
        await tunnel.close()
        tunnel = makeTunnel()
        try await tunnel.listen()
        let answer = try await send()
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
    }

    func testTwoListensAtOnceShareOneBind() async throws {
        await tunnel.close()
        port = try await Self.freePort()
        tunnel = makeTunnel()
        async let first: Void = tunnel.listen()
        async let second: Void = tunnel.listen()
        _ = try await (first, second)
        let listening = await tunnel.listening
        XCTAssertTrue(listening)
        let answer = try await send()
        XCTAssertTrue(answer.hasPrefix("HTTP/1.1 200"))
    }

    func testReadsTheRequestHeadAndLeavesTheBody() async throws {
        let stream = AsyncStream<ByteBuffer> { continuation in
            continuation.yield(ByteBuffer(string: "POST / HTTP/1.1\r\nContent-Le"))
            continuation.yield(ByteBuffer(string: "ngth: 4\r\n\r\nbody"))
            continuation.finish()
        }
        var iterator = stream.makeAsyncIterator()
        var rest = ByteBuffer()
        let head = try await SshTunnel.readHead(&iterator, rest: &rest)
        XCTAssertEqual(head.map { String(decoding: $0, as: UTF8.self) }, "POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\n")
        XCTAssertEqual(rest.getString(at: rest.readerIndex, length: rest.readableBytes), "body")
    }

    func testTheGateIsReadFromAnyCookieHeaderAndNothingElse() {
        let name = SshTunnel.cookieName(port: 47320)
        XCTAssertTrue(SshTunnel.carriesGate(Array("GET / HTTP/1.1\r\nCookie: a=b\r\ncookie: \(name)=g1\r\n\r\n".utf8), gate: "g1", cookie: name))
        XCTAssertFalse(SshTunnel.carriesGate(Array("GET /?\(name)=g1 HTTP/1.1\r\nX-Cookie: \(name)=g1\r\n\r\n".utf8), gate: "g1", cookie: name))
        XCTAssertFalse(SshTunnel.carriesGate(Array("GET / HTTP/1.1\r\nCookie: ovis_ssh_gate_47321=g1\r\n\r\n".utf8), gate: "g1", cookie: name))
        XCTAssertFalse(SshTunnel.carriesGate(Array("GET / HTTP/1.1\r\nCookie: \(name)=\r\n\r\n".utf8), gate: "", cookie: name))
    }
}
