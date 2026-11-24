import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/// One SSH connection to a PC over SwiftNIO SSH: connect with a host-key check, sign in, run a command, open a
/// direct-tcpip channel to a port on the PC's own loopback. Every step has a deadline (SwiftNIO's waits have
/// none of their own), and a step cut by it fails with `timeout`.
public final class SshConnection: @unchecked Sendable {
    public static let group: EventLoopGroup = MultiThreadedEventLoopGroup.singleton
    public static let signInSeconds: Int64 = 30

    /// The host-key check of a connection: with no expected key the connection is refused as soon as the key is
    /// read (nothing is sent to an unconfirmed host, a password least of all) and the key is kept to show; with
    /// one, any other key fails closed.
    public final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
        public let expectedAlgorithm: String
        public let expectedKey: String
        public private(set) var seenAlgorithm = ""
        public private(set) var seenKey: Data?
        public private(set) var verdict: SshHostKeys.Verdict?

        public init(expectedAlgorithm: String = "", expectedKey: String = "") {
            self.expectedAlgorithm = expectedAlgorithm
            self.expectedKey = expectedKey
        }

        public func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
            let algorithm = SshKeys.algorithm(hostKey), key = SshKeys.wireBytes(hostKey)
            seenAlgorithm = algorithm
            seenKey = key
            let verdict = SshHostKeys.judge(expectedAlgorithm: expectedAlgorithm, expectedKey: expectedKey, algorithm: algorithm, key: key)
            self.verdict = verdict
            switch verdict {
            case .same: validationCompletePromise.succeed(())
            case .unknown: validationCompletePromise.fail(SshFailure("host-key-unknown", "The host key is not confirmed"))
            case .changed: validationCompletePromise.fail(SshFailure("host-key-changed", "The host key changed"))
            }
        }
    }

    /// How a connection signs in: once, with a key or a password; a second offer means the first was refused.
    private final class SignIn: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
        enum Way { case key(NIOSSHPrivateKey), password(String), tailscale }
        let user: String
        let way: Way
        private var offered = false
        var refusedPassword = false

        init(user: String, way: Way) {
            self.user = user
            self.way = way
        }

        func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
            if offered {
                let why: String
                switch way {
                case .password: why = "The machine refused that password"
                case .key: why = "The machine refused the key"
                case .tailscale: why = "The machine did not let this phone in without a key (Tailscale SSH is off there, or its policy does not allow this login)"
                }
                nextChallengePromise.fail(SshFailure("auth", why))
                return
            }
            offered = true
            switch way {
            case .key(let key):
                nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: user, serviceName: "", offer: .privateKey(.init(privateKey: key))))
            case .password(let password):
                guard availableMethods.contains(.password) else {
                    nextChallengePromise.fail(SshFailure("auth", "The machine does not take a password over SSH (only keyboard-interactive, which this app does not answer)"))
                    return
                }
                nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: user, serviceName: "", offer: .password(.init(password: password))))
            case .tailscale:
                // Tailscale SSH lets a login of the tailnet in with no key: the "none" method, held while it asks for a check
                nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: user, serviceName: "", offer: .none))
            }
        }
    }

    /// Tells when signing in is done, or why the connection ended first.
    private final class Watch: ChannelInboundHandler, @unchecked Sendable {
        typealias InboundIn = Any
        private let signedIn: EventLoopPromise<Void>
        private let lock = NSLock()
        private var done = false
        var failure: Error?
        /// Hears each sign-in banner (Tailscale SSH's check link comes as one); a failure it returns ends the sign-in.
        var banner: (@Sendable (String) -> SshFailure?)?

        init(signedIn: EventLoopPromise<Void>) { self.signedIn = signedIn }

        /// Completes signing in once; later outcomes (the connection ending after it) change nothing.
        func finish(_ result: Result<Void, Error>) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { signedIn.completeWith(result) }
        }

        func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
            if event is UserAuthSuccessEvent { finish(.success(())) }
            if let shown = event as? NIOUserAuthBannerEvent, let stop = banner?(shown.message) {
                failure = stop
                finish(.failure(stop))
                context.close(promise: nil)
            }
            context.fireUserInboundEventTriggered(event)
        }

        func errorCaught(context: ChannelHandlerContext, error: Error) {
            if failure == nil { failure = error }
            finish(.failure(error))
            context.close(promise: nil)
        }

        func channelInactive(context: ChannelHandlerContext) {
            finish(.failure(failure ?? SshFailure("unreachable", "The connection ended")))
            context.fireChannelInactive()
        }
    }

    public let channel: Channel
    public let check: HostKeyCheck
    private let ssh: NIOSSHHandler
    private let watch: Watch
    private let signIn: SignIn

    private init(channel: Channel, check: HostKeyCheck, ssh: NIOSSHHandler, watch: Watch, signIn: SignIn) {
        self.channel = channel
        self.check = check
        self.ssh = ssh
        self.watch = watch
        self.signIn = signIn
    }

    /// Connects to `host:port`, checks its host key with `check` and signs in as `user`: a connection ready to use.
    public static func open(host: String, port: Int, check: HostKeyCheck, user: String, key: NIOSSHPrivateKey) async throws -> SshConnection {
        try await open(host: host, port: port, check: check, signIn: SignIn(user: user, way: .key(key)))
    }

    /// As open with a key, signing in with a password once (never kept).
    public static func open(host: String, port: Int, check: HostKeyCheck, user: String, password: String) async throws -> SshConnection {
        try await open(host: host, port: port, check: check, signIn: SignIn(user: user, way: .password(password)))
    }

    /// A connection being made, which the setup screen may give up on while it waits (Tailscale's check): cancel closes
    /// it, now or as soon as it exists.
    public final class Attempt: @unchecked Sendable {
        private let lock = NSLock()
        private var channel: Channel?
        private var cancelled = false

        public init() {}

        public func cancel() {
            lock.lock()
            cancelled = true
            let open = channel
            lock.unlock()
            open?.close(promise: nil)
        }

        func started(_ made: Channel) {
            lock.lock()
            channel = made
            let gone = cancelled
            lock.unlock()
            if gone { made.close(promise: nil) }
        }
    }

    /// Signs in with Tailscale SSH, no key: `banner` hears what the PC says while it waits (its check link, which the
    /// person opens to approve this phone), and may end the wait with a failure; it waits up to `waitSeconds`.
    public static func openTailscale(host: String, port: Int, check: HostKeyCheck, user: String, waitSeconds: Int64, attempt: Attempt? = nil,
                                     banner: @escaping @Sendable (String) -> SshFailure?) async throws -> SshConnection {
        try await open(host: host, port: port, check: check, signIn: SignIn(user: user, way: .tailscale), waitSeconds: waitSeconds, banner: banner, attempt: attempt)
    }

    /// The check link in a Tailscale SSH banner ("To authenticate, visit: https://login.tailscale.com/a/…"), or nil.
    public static func checkLink(_ banner: String) -> String? {
        guard let range = banner.range(of: "https://login\\.tailscale\\.com/[A-Za-z0-9/_?=&%.-]+", options: .regularExpression) else { return nil }
        var link = String(banner[range])
        while link.hasSuffix(".") { link.removeLast() }
        return link
    }

    /// Only reads the PC's host key, refused before anything is sent: `check` then holds the key to show.
    public static func readHostKey(host: String, port: Int, check: HostKeyCheck) async throws {
        _ = try await open(host: host, port: port, check: check, signIn: SignIn(user: "ovis", way: .password("")))
    }

    private static func open(host: String, port: Int, check: HostKeyCheck, signIn: SignIn, waitSeconds: Int64 = signInSeconds,
                             banner: (@Sendable (String) -> SshFailure?)? = nil, attempt: Attempt? = nil) async throws -> SshConnection {
        let signedIn = group.next().makePromise(of: Void.self)
        let watch = Watch(signedIn: signedIn)
        watch.banner = banner
        let bootstrap = ClientBootstrap(group: group)
            .connectTimeout(.seconds(10))
            .channelOption(ChannelOptions.socket(SocketOptionLevel(IPPROTO_TCP), TCP_NODELAY), value: 1)
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    let config = SSHClientConfiguration(userAuthDelegate: signIn, serverAuthDelegate: check)
                    let handler = NIOSSHHandler(role: .client(config), allocator: channel.allocator, inboundChildChannelInitializer: nil)
                    try channel.pipeline.syncOperations.addHandler(handler)
                    try channel.pipeline.syncOperations.addHandler(watch)
                }
            }
        let channel: Channel
        do {
            channel = try await bootstrap.connect(host: host, port: port).get()
        } catch {
            watch.finish(.failure(error))
            throw unreachable(error)
        }
        attempt?.started(channel)
        let deadline = channel.eventLoop.scheduleTask(in: .seconds(15 + waitSeconds)) {
            watch.finish(.failure(SshFailure("timeout", "The machine did not answer in time")))
            channel.close(promise: nil)
        }
        defer { deadline.cancel() }
        do {
            try await signedIn.futureResult.get()
        } catch {
            channel.close(promise: nil)
            if check.verdict == .changed { throw SshFailure("host-key-changed", "The host key changed") }
            if check.verdict == .unknown { throw SshFailure("host-key-unknown", "The host key is not confirmed") }
            if let failure = error as? SshFailure { throw failure }
            throw unreachable(watch.failure ?? error)
        }
        let ssh = try await channel.pipeline.handler(type: NIOSSHHandler.self).get()
        return SshConnection(channel: channel, check: check, ssh: ssh, watch: watch, signIn: signIn)
    }

    /// A failure to connect, in words a person can act on.
    static func unreachable(_ error: Error) -> SshFailure {
        if let failure = error as? SshFailure { return failure }
        if error is ChannelError, case ChannelError.connectTimeout = error { return SshFailure("timeout", "No answer in time") }
        if let io = error as? IOError {
            if io.errnoCode == ECONNREFUSED { return SshFailure("unreachable", "Nothing answers on that SSH port (\(io.description))") }
            if io.errnoCode == ETIMEDOUT { return SshFailure("timeout", "No answer in time") }
            return SshFailure("unreachable", io.description)
        }
        let text = String(describing: error)
        if text.contains("NXDOMAIN") || text.contains("getaddrinfo") || text.contains("resolution") { return SshFailure("unreachable", "No such host name: \(text)") }
        return SshFailure("unreachable", text)
    }

    public var isActive: Bool { channel.isActive }

    public func close() { channel.close(promise: nil) }

    /// A new channel of `type`, within `seconds`: a connection that died without a word (the app suspended, a NAT entry
    /// gone) answers nothing, and waiting on a NIO future ignores task cancellation, so the deadline closes the whole
    /// connection, which fails the channel's creation and lets the tunnel make a new one.
    private func childChannel(_ type: SSHChannelType, seconds: Int64 = 15, initialize: @escaping @Sendable (Channel) throws -> Void) async throws -> Channel {
        let promise = channel.eventLoop.makePromise(of: Channel.self)
        let expired = Holder<Bool>()
        let deadline = channel.eventLoop.scheduleTask(in: .seconds(seconds)) { [channel] in
            expired.value = true
            channel.close(promise: nil)
        }
        defer { deadline.cancel() }
        let ssh = self.ssh
        channel.eventLoop.execute {
            ssh.createChannel(promise, channelType: type) { child, _ in
                child.eventLoop.makeCompletedFuture {
                    try child.syncOptions?.setOption(ChannelOptions.allowRemoteHalfClosure, value: true)
                    try initialize(child)
                }
            }
        }
        do {
            return try await promise.futureResult.get()
        } catch {
            if expired.value == true { throw SshFailure("timeout", "The PC did not answer in time") }
            if !channel.isActive { throw SshFailure("unreachable", "The connection ended") }
            throw error
        }
    }

    /// A direct-tcpip channel to `127.0.0.1:port` on the PC, as bytes both ways.
    public func openDirect(port: Int) async throws -> NIOAsyncChannel<ByteBuffer, ByteBuffer> {
        let holder = Holder<NIOAsyncChannel<ByteBuffer, ByteBuffer>>()
        let origin = try SocketAddress(ipAddress: "127.0.0.1", port: 0)
        _ = try await childChannel(.directTCPIP(.init(targetHost: "127.0.0.1", targetPort: port, originatorAddress: origin))) { child in
            try child.pipeline.syncOperations.addHandler(DataUnwrapper(keepStderr: false))
            holder.value = try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: child)
        }
        guard let wrapped = holder.value else { throw SshFailure("internal", "No channel") }
        return wrapped
    }

    /// Whether the connection still answers, within `seconds`: a session channel opened and closed again.
    public func alive(seconds: Int64 = 4) async -> Bool {
        guard channel.isActive, let child = try? await childChannel(.session, seconds: seconds, initialize: { _ in }) else { return false }
        child.close(promise: nil)
        return true
    }

    /// `command`'s output (stdout only), at most 512 KiB, each line also handed to `lines` as it comes; with
    /// `mustSucceed`, failing with `internal` unless it exits 0. `timeout` covers the whole run.
    @discardableResult
    public func run(_ command: String, timeout seconds: Int64, mustSucceed: Bool = false, lines: (@Sendable (String) -> Void)? = nil) async throws -> String {
        let exit = channel.eventLoop.makePromise(of: Int.self)
        let holder = Holder<NIOAsyncChannel<ByteBuffer, ByteBuffer>>()
        let child = try await childChannel(.session) { child in
            try child.pipeline.syncOperations.addHandler(ExitWatch(exit: exit))
            try child.pipeline.syncOperations.addHandler(DataUnwrapper(keepStderr: false))
            holder.value = try NIOAsyncChannel<ByteBuffer, ByteBuffer>(wrappingChannelSynchronously: child)
        }
        guard let session = holder.value else { throw SshFailure("internal", "No session") }
        let deadline = child.eventLoop.scheduleTask(in: .seconds(seconds + 10)) { child.close(promise: nil) }
        defer { deadline.cancel() }
        let expiry = Holder<Bool>()
        let timer = child.eventLoop.scheduleTask(in: .seconds(seconds)) {
            expiry.value = true
            child.close(promise: nil)
        }
        defer { timer.cancel() }
        try await child.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true)).get()
        var text = Data()
        var line = Data()
        do {
            try await session.executeThenClose { inbound, outbound in
                outbound.finish()
                for try await buffer in inbound {
                    let bytes = Data(buffer.readableBytesView)
                    if text.count < 512 * 1024 { text.append(bytes) }
                    guard let lines else { continue }
                    for byte in bytes {
                        if byte == 0x0A {
                            let whole = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                            line.removeAll()
                            if !whole.isEmpty { lines(whole) }
                        } else {
                            line.append(byte)
                        }
                    }
                }
            }
        } catch {
            if expiry.value == true { throw SshFailure("timeout", "The machine did not answer in time") }
            if !channel.isActive { throw SshFailure("unreachable", "The connection ended") }
            // a cut answer is never read as a whole one
            throw SshFailure("unreachable", "The command's output broke off: \(error)")
        }
        if expiry.value == true { throw SshFailure("timeout", "The machine did not answer in time") }
        if mustSucceed {
            let status = try? await withThrowingTaskGroup(of: Int?.self) { group in
                group.addTask { try await exit.futureResult.get() }
                group.addTask { try await Task.sleep(nanoseconds: 2_000_000_000); return nil }
                let first = try await group.next() ?? nil
                group.cancelAll()
                return first
            }
            guard status == 0 else { throw SshFailure("internal", "The command failed there (exit \(status.map(String.init) ?? "none"))") }
        }
        return String(decoding: text, as: UTF8.self)
    }
}

final class Holder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: T?

    var value: T? {
        get { lock.lock(); defer { lock.unlock() }; return held }
        set { lock.lock(); held = newValue; lock.unlock() }
    }
}

/// SSH channel data to plain bytes and back; standard error is dropped unless kept.
final class DataUnwrapper: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = SSHChannelData
    let keepStderr: Bool

    init(keepStderr: Bool) { self.keepStderr = keepStderr }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard case .byteBuffer(let bytes) = message.data else { return }
        if case .channel = message.type { context.fireChannelRead(wrapInboundOut(bytes)) }
        else if keepStderr { context.fireChannelRead(wrapInboundOut(bytes)) }
    }

    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(wrapOutboundOut(SSHChannelData(type: .channel, data: .byteBuffer(unwrapOutboundIn(data)))), promise: promise)
    }
}

/// A session's exit status.
final class ExitWatch: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = SSHChannelData
    let exit: EventLoopPromise<Int>

    init(exit: EventLoopPromise<Int>) { self.exit = exit }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let status = event as? SSHChannelRequestEvent.ExitStatus { exit.succeed(status.exitStatus) }
        context.fireUserInboundEventTriggered(event)
    }

    func channelInactive(context: ChannelHandlerContext) {
        exit.fail(SshFailure("unreachable", "The session ended"))
        context.fireChannelInactive()
    }
}
