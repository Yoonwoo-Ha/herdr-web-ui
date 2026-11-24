import Foundation
import XCTest
@testable import OvisSshCore

/// Android's SshLinkTest: how the PC's answers are read, and the authorized_keys edits run in a real shell.
final class SshCommandsTests: XCTestCase {
    private func descriptor(_ port: Int, socket: String, remote: Bool = false) -> String {
        "D {\"pid\":1,\"port\":\(port),\"socket_path\":\"\(socket)\"\(remote ? ",\"managed_remote\":true" : "")}"
    }

    func testPicksTheOvisOfHerdrsDefaultSession() {
        let found = SshCommands.parseDiscovery(["Linux", "x86_64", descriptor(7400, socket: "/run/herdr/other.sock"), descriptor(7317, socket: "/home/a/.config/herdr/herdr.sock"), "herdr_running=1", "launcher=plugin"].joined(separator: "\n"))
        XCTAssertEqual(found.port, 7317)
        XCTAssertEqual(found.system, "Linux")
        XCTAssertEqual(found.launcher, "plugin")
        XCTAssertTrue(found.herdrRunning)
    }

    func testTakesAnotherSessionsOvisWhenTheDefaultHasNone() {
        XCTAssertEqual(SshCommands.parseDiscovery(["Darwin", "arm64", descriptor(7400, socket: "/x/other.sock"), "launcher=launchd"].joined(separator: "\n")).port, 7400)
    }

    func testNeverTakesABridgeAnotherPcStarted() {
        let found = SshCommands.parseDiscovery(["Linux", "x86_64", descriptor(7500, socket: "/x/herdr/herdr.sock", remote: true), "launcher=none"].joined(separator: "\n"))
        XCTAssertEqual(found.port, 0)
        XCTAssertTrue(found.bridgeOnly)
    }

    func testSkipsDescriptorsItCannotRead() {
        XCTAssertEqual(SshCommands.parseDiscovery("Linux\nx86_64\nD {\"port\":\nD {\"port\":99999}\n" + descriptor(7317, socket: "/a/herdr/herdr.sock")).port, 7317)
    }

    func testStartsEachLauncherWithItsOwnCommand() {
        XCTAssertEqual(SshCommands.startCommand("plugin"), "herdr plugin action invoke devswha.ovis.start")
        XCTAssertEqual(SshCommands.startCommand("systemd"), "systemctl --user start ovis.service")
        XCTAssertNil(SshCommands.startCommand("none"))
        var found = SshCommands.Found()
        found.launcher = "plugin"
        XCTAssertEqual(SshCommands.startOvis(found), SshCommands.headlessHerdr + " 2>&1; true")
        found.herdrRunning = true
        XCTAssertTrue(SshCommands.startOvis(found)?.contains("devswha.ovis.start") == true)
    }

    func testSaysWhatAMachineLacksForAnInstall() {
        XCTAssertNil(SshCommands.cannotInstall("os=Linux\narch=x86_64\nhas=curl\nhas=git\nhas=tar\nhas=unzip\nwritable=1\nfree_kb=9999999\n"))
        XCTAssertEqual(SshCommands.cannotInstall("os=Linux\narch=x86_64\nhas=curl\nhas=git\nhas=tar\nwritable=1\n")?.kind, "install-missing-tool")
        XCTAssertEqual(SshCommands.cannotInstall("os=Darwin\narch=arm64\nhas=curl\nhas=git\nhas=tar\nhas=unzip\nwritable=1\nfree_kb=10\n")?.kind, "install-disk")
        XCTAssertEqual(SshCommands.cannotInstall("os=FreeBSD\narch=amd64\n")?.kind, "install-unsupported")
        XCTAssertEqual(SshCommands.cannotInstall("os=Linux\narch=x86_64\nhas=curl\nhas=git\nhas=tar\nhas=unzip\n")?.kind, "install-permission")
    }

    func testReadsTheInstallersLastStatus() {
        XCTAssertEqual(SshCommands.installerExit("…\novis-install-exit=1\nmore\novis-install-exit=0\n"), 0)
        XCTAssertEqual(SshCommands.installerExit("cut off"), -1)
    }

    func testReadsAChunkedHealthAnswer() {
        XCTAssertEqual(SshCommands.unchunk(Data("7\r\n{\"ok\":t\r\n9\r\nrue,\"auth\r\n5;x=1\r\n\":{}}\r\n0\r\n\r\n".utf8)), Data("{\"ok\":true,\"auth\":{}}".utf8))
        XCTAssertTrue(SshCommands.answersAsOvis(Data("{\"ok\":true,\"auth\":{}}".utf8)))
        XCTAssertFalse(SshCommands.answersAsOvis(Data("{\"ok\":true}".utf8)))
    }

    func testAChunkBoundaryInsideACharacterKeepsTheCharacter() {
        let name = Array("{\"name\":\"집\"}".utf8)
        let cut = name.firstIndex(of: 0xEC)! + 1
        var chunked = Data(String(format: "%x\r\n", cut).utf8) + Data(name[..<cut]) + Data("\r\n".utf8)
        chunked += Data(String(format: "%x\r\n", name.count - cut).utf8) + Data(name[cut...]) + Data("\r\n0\r\n\r\n".utf8)
        let parts = SshCommands.httpParts(Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".utf8) + chunked)
        XCTAssertEqual(parts.map { String(decoding: $0.body, as: UTF8.self) }, "{\"name\":\"집\"}")
    }

    private func shell(_ script: String, home: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script]
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let out = Pipe()
        process.standardOutput = out
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testAuthorizeAddsTheLineOnceAndRemoveTakesOutOnlyLinesWhoseKeyFieldIsThePhonesKey() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-ssh-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let blob = String(repeating: "A", count: 43) + "phone="
        let line = "ssh-ed25519 \(blob) ovis-phone:iPhone"
        _ = try shell(try SshCommands.authorize(line), home: home)
        _ = try shell(try SshCommands.authorize(line), home: home)
        let file = home.appendingPathComponent(".ssh/authorized_keys")
        var text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(text.components(separatedBy: line).count - 1, 1)
        let kept = ["ssh-ed25519 OTHERKEY0000000000000000000000000000000000000 mentions \(blob)", "command=\"echo ssh-ed25519 \(blob)\" ssh-rsa KEPTKEY00000000000000000000000000000000000000"]
        try (text + kept.joined(separator: "\n") + "\nfrom=\"10.0.0.1\" ssh-ed25519 \(blob) other-comment\n").write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(try shell(try SshCommands.unauthorize(blob), home: home), "removed")
        text = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(text.contains("ovis-phone:iPhone"))
        XCTAssertFalse(text.contains("other-comment"))
        for line in kept { XCTAssertTrue(text.contains(line)) }
        XCTAssertEqual(try shell(try SshCommands.unauthorize(blob), home: home), "absent")
        XCTAssertThrowsError(try SshCommands.unauthorize("short'"))
        XCTAssertThrowsError(try SshCommands.authorize("ssh-ed25519 x'; rm -rf ~"))
    }
}
