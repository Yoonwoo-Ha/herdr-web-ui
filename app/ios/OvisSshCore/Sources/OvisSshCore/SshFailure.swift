import Foundation

/// Why something over SSH did not work, with the same kinds as Android's SshFailure.java (error.html and
/// the connect screen read them): stops (`host-key-changed`, `host-key-unknown`, `auth`, `key-unreadable`,
/// `key-lost`), a pasted key that cannot be used (`key-*`), the machine (`unreachable`, `timeout`,
/// `unsupported`, `no-ovis`, `bridge-only`, `not-started`, `not-ovis`), a first install (`install-*`),
/// `cancelled` and `internal`. `command` is one to run on the machine that fixes it, or nil.
public struct SshFailure: Error, Equatable, CustomStringConvertible {
    public let kind: String
    public let message: String
    public let command: String?

    public init(_ kind: String, _ message: String, command: String? = nil) {
        self.kind = kind
        self.message = message
        self.command = command
    }

    /// Whether reconnecting stops on it until the PC is set up again (SshTunnel); Tailscale's check until Try again, as
    /// each new sign-in would ask for another check the person never sees.
    public var stops: Bool {
        ["host-key-changed", "host-key-unknown", "auth", "key-unreadable", "key-lost", "tailscale-check"].contains(kind)
    }

    public var description: String { "\(kind): \(message)" }

    /// Any error as an SshFailure: one already is, anything else is `internal`.
    public static func from(_ error: Error) -> SshFailure {
        (error as? SshFailure) ?? SshFailure("internal", String(describing: error))
    }
}
