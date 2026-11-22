import Foundation
import NIOCore

/// What the app does over a signed-in SshConnection, as Android's SshLink.java (which follows what Ovis on a PC
/// does to add a PC over SSH): find the PC's own Ovis through its bridge descriptors, start an installed one,
/// install one with the official installer, add or take away this phone's key line, and check that a port
/// answers as Ovis. Only an Ovis that serves its own app (not a bridge another PC's Ovis started) opens.
public enum SshLink {
    /// The port of the PC's own Ovis: a running one, else an installed one started through its launcher, waited for
    /// up to `waitSeconds`. None fails with `no-ovis` (or `bridge-only`); one that does not come up with `not-started`.
    public static func ovisPort(_ connection: SshConnection, waitSeconds: Int = 30) async throws -> Int {
        var found = SshCommands.parseDiscovery(try await connection.run(SshCommands.discover, timeout: 20))
        guard found.system == "Linux" || found.system == "Darwin" else {
            throw SshFailure("unsupported", "Only Linux and macOS machines can be opened from the phone for now (this one says \(found.system.isEmpty ? "nothing" : found.system))")
        }
        if found.port > 0 { return found.port }
        guard let start = SshCommands.startOvis(found), let command = SshCommands.startCommand(found.launcher) else {
            throw found.bridgeOnly
                ? SshFailure("bridge-only", "Only a bridge another PC's Ovis started runs there", command: SshCommands.installCommand)
                : SshFailure("no-ovis", "Ovis is not installed there", command: SshCommands.installCommand)
        }
        try await connection.run(start, timeout: 30)
        let end = Date().addingTimeInterval(TimeInterval(waitSeconds))
        while Date() < end {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            found = SshCommands.parseDiscovery(try await connection.run(SshCommands.discover, timeout: 20))
            if found.port > 0 { return found.port }
        }
        throw SshFailure("not-started", "Ovis did not start there within \(waitSeconds) seconds", command: command)
    }

    public static func authorizeKey(_ connection: SshConnection, keyLine: String) async throws {
        try await connection.run(try SshCommands.authorize(keyLine), timeout: 20, mustSucceed: true)
    }

    /// "removed" or "absent".
    public static func unauthorizeKey(_ connection: SshConnection, blob: String) async throws -> String {
        let answer = try await connection.run(try SshCommands.unauthorize(blob), timeout: 20, mustSucceed: true).trimmingCharacters(in: .whitespacesAndNewlines)
        guard answer == "removed" || answer == "absent" else { throw SshFailure("internal", "Unexpected answer: \(answer)") }
        return answer
    }

    /// Asks the Ovis on `port` there for /api/health through the connection itself: true when it answers as Ovis.
    public static func answersAsOvis(_ connection: SshConnection, port: Int) async throws -> Bool {
        let channel = try await connection.openDirect(port: port)
        let response: Data = try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask {
                var body = Data()
                try await channel.executeThenClose { inbound, outbound in
                    try await outbound.write(ByteBuffer(string: "GET /api/health?scope=bridge HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nConnection: close\r\nAccept: application/json\r\n\r\n"))
                    for try await buffer in inbound {
                        body.append(contentsOf: buffer.readableBytesView)
                        if body.count > 256 * 1024 { break }
                    }
                }
                return body
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 20_000_000_000)
                return nil
            }
            let first = try await group.next() ?? nil
            group.cancelAll()
            guard let first else { throw SshFailure("timeout", "The machine did not answer in time") }
            return first
        }
        guard let parts = SshCommands.httpParts(response) else { return false }
        return SshCommands.answersAsOvis(parts.body)
    }

    /// Installs Ovis for this account with the official installer, then starts it and waits for it, up to
    /// `startSeconds`: its port. `progress` hears each line the installer prints.
    public static func install(_ connection: SshConnection, startSeconds: Int = 120, progress: @escaping @Sendable (String) -> Void) async throws -> Int {
        if let cannot = SshCommands.cannotInstall(try await connection.run(SshCommands.probe, timeout: 20)) { throw cannot }
        let tail = Holder<String>()
        let status = Holder<String>()
        let output = try await connection.run(SshCommands.installerRun, timeout: 10 * 60) { raw in
            // the installer colours its lines for a terminal; the phone shows them as text
            let line = raw.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("ovis-install-exit=") { status.value = line }
            if line.isEmpty || line.hasPrefix("ovis-install-exit=") { return }
            var kept = (tail.value ?? "") + line + "\n"
            if kept.count > 4000 { kept = String(kept.suffix(4000)) }
            tail.value = kept
            progress(line)
        }
        let exit = SshCommands.installerExit(status.value ?? output)
        if exit != 0 {
            let last = (tail.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let shown = last.count > 600 ? String(last.suffix(600)) : last
            throw SshFailure("install-failed", "The installer ended with \(exit < 0 ? "no status" : "status \(exit)")\(shown.isEmpty ? "" : ":\n" + shown)", command: SshCommands.installCommand)
        }
        return try await ovisPort(connection, waitSeconds: startSeconds)
    }
}

/// SshTunnel's link over a signed-in connection, to the Ovis on `port` there.
public final class SshConnectionLink: SshTunnelLink, @unchecked Sendable {
    private let connection: SshConnection
    private let remotePort = Holder<Int>()

    public init(_ connection: SshConnection, port: Int) {
        self.connection = connection
        remotePort.value = port
    }

    public func open() async throws -> NIOAsyncChannel<ByteBuffer, ByteBuffer> {
        try await connection.openDirect(port: remotePort.value ?? 0)
    }

    public func relocate() async throws {
        remotePort.value = try await SshLink.ovisPort(connection)
    }

    public func alive() async -> Bool { await connection.alive() }

    public func close() { connection.close() }

    public var isOpen: Bool { connection.isActive }
}
