import Foundation

/// The shell commands the phone runs on a PC over SSH and how their answers are read: the same commands,
/// byte for byte, as Android's SshLink.java (which follows server/remote-host.ts and server/pc-install.ts),
/// so a PC answers both apps alike.
public enum SshCommands {
    public static let remotePath = "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; "
    public static let installCommand = "curl -fsSL https://ovis.sh/install.sh | sh"

    public struct Found: Equatable {
        public var port = 0
        public var launcher = "none"
        public var system = ""
        public var arch = ""
        public var herdrRunning = false
        public var bridgeOnly = false
    }

    /// The live bridge descriptors (their PID answers kill -0), whether herdr runs, and the launcher test.
    public static let discover =
        remotePath +
        "uname -s; uname -m; " +
        "for f in \"$HOME/.config/herdr-web-ui/bridges/\"*.json; do test -f \"$f\" && test ! -L \"$f\" || continue; " +
        "c=$(head -c 16384 \"$f\" | tr -d '\\n'); pid=$(printf '%s' \"$c\" | sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p'); " +
        "test -n \"$pid\" && kill -0 \"$pid\" 2>/dev/null && printf 'D %s\\n' \"$c\"; done; " +
        "herdr status server --json 2>/dev/null </dev/null | grep -q '\"running\":true' && echo herdr_running=1; " +
        "plugins=$(herdr plugin list 2>/dev/null </dev/null); " +
        "if printf '%s\\n' \"$plugins\" | grep -q 'devswha.ovis '; then echo launcher=plugin; " +
        "elif printf '%s\\n' \"$plugins\" | grep -q 'devswha.herdr-web-ui '; then echo launcher=plugin-legacy; " +
        "elif systemctl --user cat ovis.service >/dev/null 2>&1; then echo launcher=systemd; " +
        "elif test -f \"$HOME/Library/LaunchAgents/sh.ovis.server.plist\"; then echo launcher=launchd; " +
        "else echo launcher=none; fi"

    /// The Ovis of herdr's default session (its socket `.../herdr/herdr.sock`) first, else the first other one;
    /// never a bridge another PC's Ovis started (`managed_remote`), which serves that PC with a token the phone lacks.
    public static func parseDiscovery(_ answer: String) -> Found {
        var found = Found()
        let lines = answer.components(separatedBy: "\n")
        if lines.count > 0 { found.system = lines[0].trimmingCharacters(in: .whitespaces) }
        if lines.count > 1 { found.arch = lines[1].trimmingCharacters(in: .whitespaces) }
        var fallback = 0
        for line in lines {
            if line.hasPrefix("launcher=") { found.launcher = String(line.dropFirst("launcher=".count)).trimmingCharacters(in: .whitespaces) }
            if line.trimmingCharacters(in: .whitespaces) == "herdr_running=1" { found.herdrRunning = true }
            guard line.hasPrefix("D "), found.port == 0,
                  let data = line.dropFirst(2).data(using: .utf8),
                  let descriptor = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            guard let port = (descriptor["port"] as? NSNumber)?.intValue, port > 0, port <= 65535 else { continue }
            if (descriptor["managed_remote"] as? Bool) == true {
                found.bridgeOnly = true
                continue
            }
            if (descriptor["socket_path"] as? String)?.hasSuffix("/herdr/herdr.sock") == true { found.port = port }
            else if fallback == 0 { fallback = port }
        }
        if found.port == 0 { found.port = fallback }
        return found
    }

    /// The one command that starts an installed Ovis there through its launcher; nil for none.
    public static func startCommand(_ launcher: String) -> String? {
        switch launcher {
        case "plugin": return "herdr plugin action invoke devswha.ovis.start"
        case "plugin-legacy": return "herdr plugin action invoke devswha.herdr-web-ui.start"
        case "systemd": return "systemctl --user start ovis.service"
        case "launchd": return "launchctl kickstart gui/$(id -u)/sh.ovis.server"
        default: return nil
        }
    }

    /// herdr started headless, in a session of its own so it outlives this SSH connection; it starts its plugins.
    public static let headlessHerdr = remotePath + "if command -v setsid >/dev/null 2>&1; then setsid nohup herdr server </dev/null >/dev/null 2>&1 & else nohup herdr server </dev/null >/dev/null 2>&1 & fi"

    /// The command that starts the Ovis `found` describes: a plugin needs a running herdr, so without one herdr starts headless.
    public static func startOvis(_ found: Found) -> String? {
        guard let start = startCommand(found.launcher) else { return nil }
        let command = found.launcher.hasPrefix("plugin") && !found.herdrRunning ? headlessHerdr : remotePath + start + " >/dev/null </dev/null"
        return command + " 2>&1; true"
    }

    /// Adds `keyLine` to the account's authorized_keys once, as server/remote-host.ts authorizeKey does.
    public static func authorize(_ keyLine: String) throws -> String {
        guard keyLine.range(of: "^[A-Za-z0-9+/=:._@ -]+$", options: .regularExpression) != nil else {
            throw SshFailure("internal", "Unexpected characters in the key line")
        }
        return "set -eu; umask 077; mkdir -p \"$HOME/.ssh\"; touch \"$HOME/.ssh/authorized_keys\"; key='" + keyLine + "'; " +
            "grep -qxF \"$key\" \"$HOME/.ssh/authorized_keys\" || printf '\\n%s\\n' \"$key\" >> \"$HOME/.ssh/authorized_keys\"; chmod 600 \"$HOME/.ssh/authorized_keys\""
    }

    /// Takes every line whose key field is `blob` out of authorized_keys, keeping every other line and the file's
    /// mode (a symlinked file is changed where it lives); prints "removed" or "absent".
    public static func unauthorize(_ blob: String) throws -> String {
        guard blob.range(of: "^[A-Za-z0-9+/]{40,}={0,2}$", options: .regularExpression) != nil else {
            throw SshFailure("internal", "Unexpected characters in the key")
        }
        // the key field follows the first field that names a key type; a quoted option value is never a field
        let has = "{ s = $0; gsub(/\"[^\"]*\"/, \"Q\", s); n = split(s, w, /[ \\t]+/); " +
            "for (i = 1; i < n; i++) if (w[i] ~ /^(ssh-|ecdsa-sha2-|sk-)/) { if (w[i + 1] == k) { found = 1; next } break } } "
        return "set -eu; f=\"$HOME/.ssh/authorized_keys\"; key='" + blob + "'; " +
            "test -f \"$f\" || { echo absent; exit 0; }; f=$(readlink -f \"$f\" 2>/dev/null || printf %s \"$f\"); " +
            "if ! awk -v k=\"$key\" '" + has + "END { exit !found }' \"$f\"; then echo absent; exit 0; fi; " +
            "m=$(stat -c %a \"$f\" 2>/dev/null || stat -f %Lp \"$f\"); t=$(mktemp \"$f.XXXXXX\"); " +
            "if ! awk -v k=\"$key\" '" + has.replacingOccurrences(of: "found = 1; next", with: "next") + "{ print }' \"$f\" > \"$t\"; then rm -f \"$t\"; exit 1; fi; " +
            "chmod \"$m\" \"$t\"; mv \"$t\" \"$f\"; echo removed"
    }

    /// One look at the machine before an install, as server/pc-install.ts PROBE.
    public static let probe = remotePath +
        "printf 'os=%s\\narch=%s\\n' \"$(uname -s)\" \"$(uname -m)\"; " +
        "for tool in curl git tar unzip; do command -v \"$tool\" >/dev/null 2>&1 && printf 'has=%s\\n' \"$tool\"; done; " +
        "test -w \"$HOME\" && printf 'writable=1\\n'; " +
        "printf 'free_kb=%s\\n' \"$(df -Pk \"$HOME\" 2>/dev/null | awk 'NR==2 { print $4 }')\"; true"

    public static let minFreeKB: Int64 = 1024 * 1024

    /// Why the install cannot start on the machine `probe` describes, or nil.
    public static func cannotInstall(_ probe: String) -> SshFailure? {
        let os = value(probe, "os"), arch = value(probe, "arch")
        guard ["Linux", "Darwin"].contains(os), ["x86_64", "amd64", "aarch64", "arm64"].contains(arch) else {
            return SshFailure("install-unsupported", os.isEmpty ? "No POSIX shell answered" : "\(os) \(arch)")
        }
        let tools = Set(probe.components(separatedBy: "\n").filter { $0.hasPrefix("has=") }.map { String($0.dropFirst(4)) })
        for tool in ["curl", "git", "tar", "unzip"] where !tools.contains(tool) {
            return SshFailure("install-missing-tool", tool, command: os == "Darwin" ? "xcode-select --install" : "sudo apt install \(tool)   # or: sudo dnf install \(tool)")
        }
        if !probe.contains("writable=1") { return SshFailure("install-permission", "This account cannot write to its home folder") }
        if let free = Int64(value(probe, "free_kb")), free < minFreeKB { return SshFailure("install-disk", "\(free / 1024) MB free") }
        return nil
    }

    private static func value(_ text: String, _ key: String) -> String {
        for line in text.components(separatedBy: "\n") where line.hasPrefix(key + "=") {
            return String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
        }
        return ""
    }

    /// The official installer's run for one SSH command, as server/pc-install.ts installerRun: downloaded first,
    /// run with nothing on stdin, its exit status printed; a watcher stops the whole run once nobody reads (the
    /// phone gone), so an install whose phone left ends instead of running on unseen.
    public static let installerRun =
        remotePath + "script=$(mktemp) || exit 1; trap 'rm -f \"$script\"' EXIT; trap 'exit 143' HUP INT TERM; " +
        "( trap '' PIPE; while printf '\\n' 2>/dev/null; do sleep 2 >/dev/null 2>&1; done; kill -TERM 0 ) </dev/null 2>/dev/null & watch=$!; " +
        "if ! curl -fsSL --max-time 120 https://ovis.sh/install.sh -o \"$script\" || ! head -n 1 \"$script\" | grep -q '^#!/bin/sh'; then " +
        "kill \"$watch\" 2>/dev/null; echo 'The installer could not be downloaded from ovis.sh'; printf '\\novis-install-exit=1\\n'; exit 0; fi; " +
        "printf '\\n' || exit 141; " +
        "OVIS_RUNTIME=herdr OVIS_NO_OPEN=1 sh \"$script\" </dev/null 2>&1; status=$?; " +
        "kill \"$watch\" 2>/dev/null; printf '\\novis-install-exit=%s\\n' \"$status\""

    /// The exit status installerRun printed, or -1 when it printed none (the connection ended).
    public static func installerExit(_ output: String) -> Int {
        guard let at = output.range(of: "ovis-install-exit=", options: .backwards) else { return -1 }
        let rest = output[at.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return Int(rest.split(whereSeparator: { $0.isWhitespace }).first ?? "") ?? -1
    }

    /// An HTTP/1.1 response split into its head (lowercased) and its body, a chunked one joined; nil without a blank line.
    public static func httpParts(_ response: Data) -> (head: String, body: Data)? {
        let bytes = [UInt8](response)
        guard bytes.count >= 4, let split = (0...(bytes.count - 4)).first(where: { bytes[$0] == 13 && bytes[$0 + 1] == 10 && bytes[$0 + 2] == 13 && bytes[$0 + 3] == 10 }) else { return nil }
        let head = String(decoding: bytes[..<split], as: UTF8.self).lowercased()
        let body = Data(bytes[(split + 4)...])
        return (head, head.contains("transfer-encoding: chunked") ? unchunk(body) : body)
    }

    /// An HTTP/1.1 chunked body, joined as bytes (a character may span two chunks).
    public static func unchunk(_ chunked: Data) -> Data {
        let bytes = [UInt8](chunked)
        var out = Data()
        var at = 0
        while let end = (at..<max(at, bytes.count - 1)).first(where: { bytes[$0] == 13 && bytes[$0 + 1] == 10 }) {
            let sizeText = String(decoding: bytes[at..<end], as: UTF8.self).split(separator: ";").first?.trimmingCharacters(in: .whitespaces) ?? ""
            guard let size = Int(sizeText, radix: 16), size > 0 else { break }
            let from = end + 2, to = min(bytes.count, from + size)
            out.append(contentsOf: bytes[from..<to])
            at = to + 2
            if at >= bytes.count { break }
        }
        return out
    }

    /// /api/health?scope=bridge as Ovis answers it: `ok` true and an `auth` object (Android's PCStore.answersAsServer).
    public static func answersAsOvis(_ data: Data) -> Bool {
        guard let answer = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let ok = answer["ok"] as? Bool, ok, answer["auth"] is [String: Any] else { return false }
        return true
    }
}
