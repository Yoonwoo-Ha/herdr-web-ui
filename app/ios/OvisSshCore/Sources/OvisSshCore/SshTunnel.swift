import Foundation
import NIOCore
import NIOPosix

/// One SSH connection made for a tunnel, to the PC's Ovis.
public protocol SshTunnelLink: AnyObject, Sendable {
    /// A new channel to the PC's Ovis; throws when the PC refuses it.
    func open() async throws -> NIOAsyncChannel<ByteBuffer, ByteBuffer>
    /// Looks up the PC's Ovis again (it may have restarted on another port).
    func relocate() async throws
    /// Whether the connection still answers, within a few seconds.
    func alive() async -> Bool
    func close()
    /// Whether the connection is still up (false once it ended, whoever ended it).
    var isOpen: Bool { get }
}

/// The WebView's way to one SSH PC, as Android's SshTunnel.java: a listener on the PC's loopback origin on this
/// phone, each of whose connections becomes an SSH direct-tcpip channel to the PC's own Ovis on its 127.0.0.1.
/// That Ovis sees a request from its own loopback, which it lets in as its own PC's: no token is typed or kept.
///
/// Every app on the phone can reach the phone's loopback, so a connection is passed on only when its first request
/// carries this tunnel's gate cookie (`ovis_ssh_gate_<port>`: cookies do not separate ports), which the app keeps
/// HttpOnly in the WebView's store, and comes from this PC's own page or none: a request another origin's page
/// makes (another SSH PC's on its own port is same-site, and would carry this cookie too) gets 403, as does
/// anything else, and nothing reaches the PC. The gate is taken out of the request before it goes on.
///
/// Lifetime rules (SshTunnelTests checks each): the SSH connection is made when a request needs it, once however
/// many wait, and made again on the next request after it ended, asking nothing; a request is passed on once, as
/// it came, with `Connection: close` (an upgrade excepted), and one the PC side ends before answering gets 503,
/// never silence: nothing typed is sent twice. A failure answers every request of the page's burst at once for
/// `retryAfter`, then is tried again; a stop (SshFailure.stops) is never tried again by this tunnel. `wake` checks
/// a connection that exists and makes a new one before the page asks when it no longer answers. A failed request
/// gets 503 with `X-Ovis-Ssh: <kind>`, and the listener hears every failure. `dialJoined` hears how many requests wait on a
/// dial as each one joins it (SshTunnelTests waits on it instead of on time).
public actor SshTunnel {
    public static let failureHeader = "X-Ovis-Ssh"
    public static let retryAfter: TimeInterval = 2
    static let headLimit = 64 * 1024

    public typealias Dialer = @Sendable () async throws -> SshTunnelLink

    public nonisolated let gate: String
    public nonisolated let port: Int
    public nonisolated var cookieName: String { Self.cookieName(port: port) }
    public nonisolated var origin: String { "http://127.0.0.1:\(port)" }
    private let dialer: Dialer
    private let clock: @Sendable () -> TimeInterval
    private let listener: @Sendable (SshFailure) -> Void
    private let sshPorts: @Sendable () -> Set<Int>
    private let dialJoined: (@Sendable (Int) -> Void)?
    private var dialWaiters = 0
    private var server: Channel?
    private var binding: Task<Void, Error>?
    private var link: SshTunnelLink?
    private var dialing: Task<SshTunnelLink, Error>?
    private var relocating: Task<Void, Error>?
    private var closed = false
    private var lastFailure: SshFailure?
    private var failedAt: TimeInterval = 0
    private var stopped: SshFailure?

    static let gatePrefix = "ovis_ssh_gate_"

    public static func cookieName(port: Int) -> String { gatePrefix + String(port) }

    public init(gate: String, port: Int, dialer: @escaping Dialer, clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                sshPorts: @escaping @Sendable () -> Set<Int> = { [] }, dialJoined: (@Sendable (Int) -> Void)? = nil,
                listener: @escaping @Sendable (SshFailure) -> Void) {
        self.gate = gate
        self.port = port
        self.dialer = dialer
        self.clock = clock
        self.sshPorts = sshPorts
        self.dialJoined = dialJoined
        self.listener = listener
    }

    /// Starts listening on 127.0.0.1 at `port` (again, after the app was in the background, whose sockets iOS may
    /// have taken); throws when another app holds the address.
    public func listen() async throws {
        if let server, server.isActive { return }
        // one bind at a time: a second caller (a wake while the PC opens) waits for it rather than binding again
        if let binding { return try await binding.value }
        let task = Task { try await self.bind() }
        binding = task
        defer { binding = nil }
        try await task.value
    }

    private func bind() async throws {
        let bound = try await ServerBootstrap(group: SshConnection.group)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .serverChannelOption(ChannelOptions.backlog, value: 64)
            .bind(host: "127.0.0.1", port: port) { child in
                child.eventLoop.makeCompletedFuture {
                    try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: child)
                }
            }
        server = bound.channel
        Task { [weak self] in
            try? await bound.executeThenClose { inbound in
                for try await client in inbound {
                    guard let self else { return }
                    Task { await self.serve(client) }
                }
            }
        }
    }

    /// Whether the listener is up.
    public var listening: Bool { server?.isActive ?? false }

    /// Stops listening and ends the SSH connection; returns once the listener has let go of its port, so another
    /// tunnel may bind it at once.
    public func close() async {
        closed = true
        let listener = server
        server = nil
        drop()
        try? await listener?.close()
    }

    /// Try again on the error page: a Tailscale check the person has now approved is tried again; every other stop stays.
    public func resume() {
        guard stopped?.kind == "tailscale-check" else { return }
        stopped = nil
        lastFailure = nil
    }

    /// Ends the SSH connection (a network change, the app in the background): the next request makes a new one.
    public func drop() {
        let was = link
        link = nil
        was?.close()
    }

    /// The app came back: a connection that no longer answers is dropped and made again before the page asks.
    public func wake() async {
        guard let now = link else { return }
        if await now.alive() { return }
        forget(now)
        _ = try? await ready()
    }

    private func forget(_ gone: SshTunnelLink) {
        if link === gone { link = nil }
        gone.close()
    }

    private func remember(_ failure: SshFailure) {
        lastFailure = failure
        failedAt = clock()
        if failure.stops { stopped = failure }
        listener(failure)
    }

    func ready() async throws -> SshTunnelLink {
        if let stopped {
            listener(stopped)
            throw stopped
        }
        if let now = link, !now.isOpen { link = nil }
        if let link { return link }
        if let lastFailure, clock() - failedAt < Self.retryAfter {
            listener(lastFailure)
            throw lastFailure
        }
        if closed { throw SshFailure("cancelled", "Closed") }
        let task: Task<SshTunnelLink, Error>
        let mine = dialing == nil
        if let dialing { task = dialing } else {
            let dialer = self.dialer
            task = Task { try await dialer() }
            dialing = task
        }
        dialWaiters += 1
        dialJoined?(dialWaiters)
        do {
            let made = try await task.value
            guard mine else { return made }
            dialing = nil
            dialWaiters = 0
            if closed {
                made.close()
                throw SshFailure("cancelled", "Closed")
            }
            link = made
            lastFailure = nil
            return made
        } catch {
            let failure = SshFailure.from(error)
            if mine {
                dialing = nil
                dialWaiters = 0
                remember(failure)
            } else {
                listener(failure)
            }
            throw failure
        }
    }

    /// A channel to the PC's Ovis; after a refused open the Ovis is looked up again, by one request at a time.
    func channel() async throws -> NIOAsyncChannel<ByteBuffer, ByteBuffer> {
        let now = try await ready()
        if let opened = try? await now.open() { return opened }
        if let relocating { _ = try? await relocating.value }
        if let opened = try? await now.open() { return opened }
        let lookup = Task { try await now.relocate() }
        relocating = lookup
        defer { if relocating == lookup { relocating = nil } }
        do {
            try await lookup.value
            return try await now.open()
        } catch {
            let failure = (error as? SshFailure) ?? SshFailure("unreachable", String(describing: error))
            forget(now)
            remember(failure)
            throw failure
        }
    }

    /// The body of the PC's own Ovis's answer to `GET path` over this tunnel's SSH connection (made if need be), as
    /// from its own loopback, which it lets in as its own PC's: for the app itself, never a page. At most 256 KiB, in
    /// `seconds`; an answer other than 200 is `internal`.
    public func get(_ path: String, seconds: UInt64 = 20) async throws -> Data {
        let pc = try await channel()
        return try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask {
                var answer = Data()
                try await pc.executeThenClose { inbound, outbound in
                    try await outbound.write(ByteBuffer(string: "GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n"))
                    for try await bytes in inbound {
                        answer.append(contentsOf: bytes.readableBytesView)
                        if answer.count > 256 * 1024 { throw SshFailure("internal", "The answer is too long") }
                    }
                }
                return answer
            }
            group.addTask {
                try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            guard let answer = first else { throw SshFailure("timeout", "The PC's Ovis did not answer in time") }
            guard let parts = SshCommands.httpParts(answer) else { throw SshFailure("internal", "No answer") }
            guard parts.head.hasPrefix("http/1.1 200") || parts.head.hasPrefix("http/1.0 200") else {
                throw SshFailure("internal", String(parts.head.prefix(while: { $0 != "\r" })))
            }
            return parts.body
        }
    }

    private func serve(_ client: NIOAsyncChannel<ByteBuffer, ByteBuffer>) async {
        let ownOrigin = origin, gate = self.gate, cookie = cookieName, ports = sshPorts()
        let headTimer = client.channel.eventLoop.scheduleTask(in: .seconds(15)) { client.channel.close(promise: nil) }
        try? await client.executeThenClose { pageIn, toPage in
            var fromPage = pageIn.makeAsyncIterator()
            var early = ByteBuffer()
            guard let head = try await Self.readHead(&fromPage, rest: &early) else { return }
            headTimer.cancel()
            guard Self.carriesGate(head, gate: gate, cookie: cookie), Self.fromOwnPage(head, origin: ownOrigin) else {
                try await toPage.write(ByteBuffer(string: "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
                return
            }
            let pc: NIOAsyncChannel<ByteBuffer, ByteBuffer>
            do {
                pc = try await self.channel()
            } catch {
                try await toPage.write(Self.failureAnswer(SshFailure.from(error)))
                return
            }
            let pageRest = fromPage
            try await pc.executeThenClose { pcIn, toPc in
                try await toPc.write(ByteBuffer(bytes: Self.forwardHead(head)))
                if early.readableBytes > 0 { try await toPc.write(early) }
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        var rest = pageRest
                        while let bytes = try await rest.next() { try await toPc.write(bytes) }
                        toPc.finish()
                    }
                    var fromPc = pcIn.makeAsyncIterator()
                    var after = ByteBuffer()
                    var answer = try? await Self.readHead(&fromPc, rest: &after)
                    while let interim = answer, Self.interim(interim), !Self.redirectsAway(interim, own: ownOrigin, sshPorts: ports) {
                        try await toPage.write(ByteBuffer(bytes: interim))
                        answer = try? await Self.readHead(&fromPc, rest: &after)
                    }
                    if let answer, !Self.redirectsAway(answer, own: ownOrigin, sshPorts: ports) {
                        try await toPage.write(ByteBuffer(bytes: answer))
                        if after.readableBytes > 0 { try await toPage.write(after) }
                        while let bytes = try await fromPc.next() { try await toPage.write(bytes) }
                    } else if answer != nil {
                        try await toPage.write(ByteBuffer(string: "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
                    } else {
                        // the PC side ended before answering: say so, so the page never takes silence for a reason to send again
                        try await toPage.write(Self.failureAnswer(SshFailure("unreachable", "The connection to the PC ended")))
                    }
                    group.cancelAll()
                }
            }
        }
        headTimer.cancel()
    }

    static func failureAnswer(_ failure: SshFailure) -> ByteBuffer {
        let body = Array("\(failure.kind): \(failure.message)".utf8)
        let kind = failure.kind.filter { ("a"..."z").contains($0) || $0 == "-" }
        return ByteBuffer(string: "HTTP/1.1 503 Service Unavailable\r\n\(failureHeader): \(kind)\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n" + String(decoding: body, as: UTF8.self))
    }

    /// The head up to its blank line, or nil when the other side closed first or sent more than headLimit without
    /// one; bytes after the blank line (a body) are left in `rest`.
    static func readHead<I: AsyncIteratorProtocol>(_ iterator: inout I, rest: inout ByteBuffer) async throws -> [UInt8]? where I.Element == ByteBuffer {
        var head: [UInt8] = []
        if rest.readableBytes > 0 {
            head = Array(rest.readableBytesView)
            rest.clear()
        }
        while true {
            if let end = Self.headEnd(head) {
                if end < head.count { rest.writeBytes(head[end...]) }
                return Array(head[..<end])
            }
            if head.count > headLimit { return nil }
            guard let bytes = try await iterator.next() else { return nil }
            head.append(contentsOf: bytes.readableBytesView)
        }
    }

    static func headEnd(_ bytes: [UInt8]) -> Int? {
        guard bytes.count >= 4 else { return nil }
        for i in 0...(bytes.count - 4) where bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10 {
            return i + 4 <= headLimit ? i + 4 : nil
        }
        return nil
    }

    private static func lines(_ head: [UInt8]) -> [String] {
        String(decoding: head, as: UTF8.self).components(separatedBy: "\r\n")
    }

    /// Whether a request head carries `gate` as the cookie `cookie`, compared in constant time.
    static func carriesGate(_ head: [UInt8], gate: String, cookie: String) -> Bool {
        guard !gate.isEmpty else { return false }
        let expected = Data(gate.utf8)
        for line in lines(head) where line.lowercased().hasPrefix("cookie:") {
            for pair in line.dropFirst("cookie:".count).split(separator: ";") {
                let parts = pair.trimmingCharacters(in: .whitespaces).split(separator: "=", maxSplits: 1).map(String.init)
                if parts.count == 2, parts[0] == cookie, SshHostKeys.constantTimeEqual(Data(parts[1].utf8), expected) { return true }
            }
        }
        return false
    }

    /// Whether a request comes from this PC's own page or from none (a navigation typed, the app's own load): never
    /// from another origin's page, another SSH PC's on its own port included (Sec-Fetch-Site `same-site`).
    static func fromOwnPage(_ head: [UInt8], origin: String) -> Bool {
        for line in lines(head).dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if name == "origin" && value.lowercased() != origin { return false }
            if name == "sec-fetch-site" && !["same-origin", "none"].contains(value.lowercased()) { return false }
        }
        return true
    }

    /// The head as it goes to the PC: without any SSH PC's gate cookie (cookies do not separate ports, so the WebView
    /// sends every PC's gate to each one: none may leave the phone), and with `Connection: close` unless it is an
    /// upgrade (a WebSocket), so every request has a connection of its own and the WebView never re-sends one on a reused one.
    static func forwardHead(_ head: [UInt8]) -> [UInt8] {
        var all = lines(head)
        while all.last == "" { all.removeLast() }
        let upgrade = all.dropFirst().contains { $0.lowercased().hasPrefix("upgrade:") }
        var out: [String] = []
        for (i, line) in all.enumerated() {
            let lower = line.lowercased()
            if i > 0 && lower.hasPrefix("cookie:") {
                let kept = line.dropFirst("cookie:".count).split(separator: ";", omittingEmptySubsequences: false)
                    .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix(gatePrefix) }
                if kept.joined(separator: ";").trimmingCharacters(in: .whitespaces).isEmpty { continue }
                out.append("Cookie:" + kept.joined(separator: ";"))
            } else if i > 0 && !upgrade && (lower.hasPrefix("connection:") || lower.hasPrefix("keep-alive:")) {
                continue
            } else {
                out.append(line)
            }
        }
        if !upgrade { out.append("Connection: close") }
        return Array((out.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    /// Whether a response head is an interim one (1xx), after which the real answer comes; 101 (an upgrade) is final.
    static func interim(_ head: [UInt8]) -> Bool {
        let status = String(decoding: head.prefix(16), as: UTF8.self)
        return status.range(of: "^HTTP/1\\.[01] 1[0-9][0-9]", options: .regularExpression) != nil && !status.dropFirst(9).hasPrefix("101")
    }

    /// Whether a response head redirects to this phone's loopback at a port no SSH PC listens on (SshPcs.otherLoopbackPort):
    /// the WebView follows a redirect without asking the app, and would carry the gates there. `own` resolves a relative one.
    static func redirectsAway(_ head: [UInt8], own: String, sshPorts: Set<Int>) -> Bool {
        for line in lines(head) where line.lowercased().hasPrefix("location:") {
            let target = line.dropFirst("location:".count).trimmingCharacters(in: .whitespaces)
            guard let base = URL(string: own + "/"), let url = URL(string: target, relativeTo: base) else { return true }
            return SshPcs.otherLoopbackPort(url.absoluteString, sshPorts: sshPorts.union([URLComponents(string: own)?.port ?? 0]))
        }
        return false
    }
}
