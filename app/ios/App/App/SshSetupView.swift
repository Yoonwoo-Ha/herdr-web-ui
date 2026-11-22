import NIOSSH
import OvisSshCore
import SwiftUI
import UIKit

/// Adds a PC over SSH, or sets one up again (`editing`: register the phone again, use another key, confirm a host
/// key that was forgotten on purpose), with the steps and words of the Android app's SshSetupActivity: address and
/// account, then how the phone signs in (its own key, shown to copy or share into authorized_keys; a password used
/// once to add that key there; or, under Advanced, a pasted private key). The host key's fingerprint is shown and
/// confirmed before anything is sent to the machine. The PC's Ovis is found or started, or installed from here when
/// there is none and the person agrees, then checked to answer as Ovis; then the PC opens.
@MainActor
final class SshSetupModel: ObservableObject {
    enum Method: String { case phoneKey = "phone-key", password, imported, tailscale }

    struct Question: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let yes: String
        let no: String
        let answer: (Bool) -> Void
    }

    let editing: SshPcs.Pc?
    @Published var host = ""
    @Published var port = "22"
    @Published var user = ""
    @Published var method = Method.phoneKey
    @Published var advanced = false
    @Published var keyLine = ""
    @Published var password = ""
    @Published var privateKey = "" { didSet { describeKey() } }
    @Published var keyState = ""
    @Published var passphrase = ""
    @Published var status = ""
    @Published var working = false
    @Published var question: Question?
    /// Tailscale SSH's check link while it waits for the person to approve this phone
    @Published var checkLink: String?
    var finished: ((Bool) -> Void)?
    var close: (() -> Void)?
    /// What the screen is doing, for a UI test: "connecting", "confirm-host", "signing-in", "looking", "confirm-install", "installing", "done", "failed:<kind>".
    @Published private(set) var step = ""
    private var left = false
    private var active: SshConnection?
    /// the connection being made while Tailscale waits for its check, which leaving closes
    private var attempt: SshConnection.Attempt?
    private var done = false

    init(editing: SshPcs.Pc?, user: String?, host: String?, port: Int?) {
        self.editing = editing
        if let editing {
            self.host = editing.host
            self.port = String(editing.port)
            self.user = editing.user
            if editing.auth == "imported" {
                method = .imported
                advanced = true
            }
            if editing.auth == "tailscale" { method = .tailscale }
        } else {
            self.host = host ?? ""
            self.user = user ?? ""
            if let port { self.port = String(port) }
            // a PC at a tailnet address most likely runs Tailscale SSH: no key to add there
            if Self.tailnet(self.host) { method = .tailscale }
        }
        showPhoneKey(renew: false)
    }

    /// A MagicDNS name or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48).
    static func tailnet(_ host: String) -> Bool {
        let name = host.lowercased()
        if name.hasSuffix(".ts.net") || name.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = name.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }

    var title: String { editing.map { SshWords.text("ssh_edit_title", $0.label) } ?? SshWords.text("ssh_add_title") }

    /// The screen was closed: its work asks nothing more, saves nothing, and its SSH connection is closed (which ends
    /// an install the person agreed to only while they stay).
    func leave() {
        left = true
        question?.answer(false)
        question = nil
        attempt?.cancel()
        active?.close()
        end(false)
    }

    private func end(_ added: Bool) {
        guard !done else { return }
        done = true
        finished?(added)
    }

    func showPhoneKey(renew: Bool) {
        do {
            if renew { try OvisSsh.store.renewPhoneKey() }
            keyLine = try OvisSsh.store.phoneKeyLine(model: OvisSsh.model)
        } catch {
            keyLine = SshWords.text("ssh_phone_key_failed", SshFailure.from(error).message)
        }
    }

    func pasteKey() {
        guard let text = UIPasteboard.general.string else { return }
        privateKey = text
        // a private key does not stay on the clipboard for the next app to read
        if SshKeys.precheck(text) == nil { UIPasteboard.general.string = "" }
    }

    private func describeKey() {
        if privateKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            keyState = ""
        } else if let wrong = SshKeys.precheck(privateKey) {
            keyState = SshWords.describe("", wrong, how: "imported", publicLine: nil)
        } else {
            keyState = SshWords.text(SshKeys.encrypted(privateKey) ? "ssh_key_encrypted" : "ssh_key_plain")
        }
    }

    private func say(_ words: String, working: Bool) {
        status = words
        self.working = working
    }

    private func tell(_ what: String) { step = what }

    private func fail(_ place: String, _ failure: SshFailure, how: String, publicLine: String?) {
        say(SshWords.describe(place, failure, how: how, publicLine: publicLine), working: false)
        tell("failed:" + failure.kind)
    }

    private func confirm(_ title: String, _ message: String, yes: String, no: String, step: String) async -> Bool {
        if left { return false }
        let agreed = await withCheckedContinuation { (answered: CheckedContinuation<Bool, Never>) in
            var once = false
            question = Question(title: title, message: message, yes: yes, no: no) { yes in
                guard !once else { return }
                once = true
                answered.resume(returning: yes)
            }
            tell(step)
        }
        return agreed && !left
    }

    func start() {
        let address = host.trimmingCharacters(in: .whitespaces)
        let account = user.trimmingCharacters(in: .whitespaces)
        let sshPort = Int(port.trimmingCharacters(in: .whitespaces)) ?? -1
        guard !address.isEmpty, !account.isEmpty, (1...65535).contains(sshPort), !address.contains(" "), !account.contains(" ") else {
            say(SshWords.text("ssh_fill_in"), working: false)
            return
        }
        guard !working else { return }
        let how = method.rawValue
        let secret = method == .password ? password : method == .imported ? privateKey.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        // the password is used once: it leaves the screen as soon as it is read, whatever happens next
        password = ""
        working = true
        Task { await add(address: address, sshPort: sshPort, account: account, how: how, secret: secret, secretPassphrase: passphrase) }
    }

    private func add(address: String, sshPort: Int, account: String, how: String, secret: String, secretPassphrase: String) async {
        let place = account + "@" + address + (sshPort == 22 ? "" : ":\(sshPort)")
        let store = OvisSsh.store
        // a pasted key is read before anything goes to the machine: a wrong passphrase is told at once
        var pasted: SshKeys.Read?
        var publicLine: String?
        if how == "imported" {
            say(SshWords.text("ssh_reading_key"), working: true)
            do {
                let read = try await Task.detached { try SshKeys.read(secret, passphrase: secretPassphrase) }.value
                pasted = read
                publicLine = try read.publicLine("")
            } catch {
                return fail(place, SshFailure.from(error), how: how, publicLine: nil)
            }
        }

        say(SshWords.text("ssh_connecting", address), working: true)
        tell("connecting")
        let before = editing.flatMap { store.get($0.origin) } ?? store.find(host: address, port: sshPort, user: account)
        let pinned = before?.hasHostKey == true
        let first = SshConnection.HostKeyCheck(expectedAlgorithm: pinned ? before?.hostKeyAlgorithm ?? "" : "")
        do {
            try await SshConnection.readHostKey(host: address, port: sshPort, check: first)
            say(SshWords.text("ssh_no_host_key"), working: false)
            return tell("failed:no-host-key")
        } catch {
            let failure = SshFailure.from(error)
            if failure.kind != "host-key-unknown" { return fail(place, failure, how: how, publicLine: publicLine) }
        }
        guard let seen = first.seenKey else {
            say(SshWords.text("ssh_no_host_key"), working: false)
            return tell("failed:no-host-key")
        }
        let algorithm = first.seenAlgorithm
        let hostKey = SshHostKeys.encode(seen)
        let known = before.map { SshHostKeys.judge(expectedAlgorithm: $0.hostKeyAlgorithm, expectedKey: $0.hostKey, algorithm: algorithm, key: seen) == .same } ?? false
        // a pinned key that differs stops here, before anything is sent: only Forget host key under Manage lets a new one in
        if pinned && !known {
            say(SshWords.text("ssh_fail_host_key_pinned", SshHostKeys.fingerprint(seen)), working: false)
            return tell("failed:host-key-changed")
        }
        // a key confirmed before and shown again is not asked about twice; any other is
        if !known {
            let trusted = await confirm(SshWords.text("ssh_confirm_title", address), SshWords.text("ssh_confirm_message", algorithm, SshHostKeys.fingerprint(seen)),
                                        yes: SshWords.text("ssh_trust"), no: SshWords.text("ssh_cancel"), step: "confirm-host")
            if !trusted {
                say(SshWords.text("ssh_not_confirmed"), working: false)
                return tell("failed:not-confirmed")
            }
        }

        let check = { SshConnection.HostKeyCheck(expectedAlgorithm: algorithm, expectedKey: hostKey) }
        var connection: SshConnection?
        defer { connection?.close() }
        do {
            say(SshWords.text("ssh_signing_in", account), working: true)
            tell("signing-in")
            var saveAs = how
            if how == "tailscale" {
                // the person approves this phone in the browser if Tailscale asks: up to ten minutes
                let waiting = SshConnection.Attempt()
                attempt = waiting
                let made = try await SshConnection.openTailscale(host: address, port: sshPort, check: check(), user: account, waitSeconds: 600, attempt: waiting) { banner in
                    if let link = SshConnection.checkLink(banner) {
                        Task { @MainActor in
                            self.checkLink = link
                            self.say(SshWords.text("ssh_tailscale_check", link), working: true)
                        }
                    }
                    return nil
                }
                checkLink = nil
                connection = made
            } else if how == "password" {
                let made = try await SshConnection.open(host: address, port: sshPort, check: check(), user: account, password: secret)
                active = made
                connection = made
                if left { throw SshFailure("cancelled", "The screen was closed") }
                say(SshWords.text("ssh_adding_key", place), working: true)
                let mine = try OvisSsh.store.phoneKey()
                try await SshLink.authorizeKey(made, keyLine: try SshKeys.publicLine(NIOSSHPrivateKey(ed25519Key: mine).publicKey, comment: SshPcs.phoneComment(OvisSsh.model)))
                made.close()
                // the key, not the password, is what reconnects: prove it works before the password is gone
                connection = try await SshConnection.open(host: address, port: sshPort, check: check(), user: account, key: .init(ed25519Key: mine))
                saveAs = "phone-key"
            } else {
                let key = how == "imported" ? pasted!.key : NIOSSHPrivateKey(ed25519Key: try OvisSsh.store.phoneKey())
                connection = try await SshConnection.open(host: address, port: sshPort, check: check(), user: account, key: key)
            }
            guard let signedIn = connection else { throw SshFailure("internal", "No connection") }
            active = signedIn
            if left { throw SshFailure("cancelled", "The screen was closed") }
            say(SshWords.text("ssh_looking", address), working: true)
            tell("looking")
            let ovisPort = try await findOrInstall(signedIn, address: address, place: place)
            guard try await SshLink.answersAsOvis(signedIn, port: ovisPort) else { throw SshFailure("not-ovis", "Not Ovis") }
            if left { return }

            var pc = before ?? SshPcs.Pc()
            if before == nil { pc.origin = try store.freeOrigin() }
            pc.host = address
            pc.port = sshPort
            pc.user = account
            pc.hostKeyAlgorithm = algorithm
            pc.hostKey = hostKey
            if saveAs == "imported", let pasted {
                try store.sealImported(&pc, pem: secret, passphrase: secretPassphrase, keyType: pasted.label)
            } else {
                pc.auth = saveAs == "tailscale" ? "tailscale" : "phone-key"
                pc.importedKey = ""
                pc.importedPassphrase = ""
                pc.keyType = ""
            }
            // a new gate each time the PC is set up: the tunnel starts again with what was saved here
            pc = try store.withNewGate(pc)
            try store.put(pc)
            await OvisSsh.tunnels.closeFor(pc.origin)
            if before == nil { PCStore.names[pc.origin] = place + " (SSH)" }
            PCStore.openSsh(pc.origin)
            say(SshWords.text("ssh_connected"), working: true)
            tell("done")
            end(true)
            close?()
        } catch {
            checkLink = nil
            let failure = SshFailure.from(error)
            // this phone's key could no longer be read: a new one is made and shown, as this screen registers it anyway
            if failure.kind == "key-lost" { showPhoneKey(renew: true) }
            fail(place, failure, how: how, publicLine: publicLine)
        }
    }

    /// The port of the PC's Ovis; where none is installed, the official installer runs there once the person agrees.
    private func findOrInstall(_ connection: SshConnection, address: String, place: String) async throws -> Int {
        do {
            return try await SshLink.ovisPort(connection)
        } catch let none as SshFailure where none.kind == "no-ovis" || none.kind == "bridge-only" {
            let agreed = await confirm(SshWords.text("ssh_install_title", place), SshWords.text("ssh_install_message", SshCommands.installCommand),
                                       yes: SshWords.text("ssh_install_yes"), no: SshWords.text("ssh_install_no"), step: "confirm-install")
            guard agreed else { throw none }
            tell("installing")
            say(SshWords.text("ssh_installing", address, ""), working: true)
            return try await SshLink.install(connection) { line in
                let shown = line.count > 160 ? String(line.prefix(160)) + "…" : line
                Task { @MainActor in self.say(SshWords.text("ssh_installing", address, shown), working: true) }
            }
        }
    }
}

struct SshSetupView: View {
    @ObservedObject var model: SshSetupModel
    let cancel: () -> Void
    let share: (String) -> Void

    private static let background = Color(red: 0x12 / 255, green: 0x10 / 255, blue: 0x0e / 255)
    private static let text = Color(red: 0xd8 / 255, green: 0xd0 / 255, blue: 0xc3 / 255)
    private static let muted = Color(red: 0x9a / 255, green: 0x91 / 255, blue: 0x84 / 255)
    private static let accent = Color(red: 0xf0 / 255, green: 0xa8 / 255, blue: 0x30 / 255)
    private static let field = Color(red: 0x1d / 255, green: 0x1a / 255, blue: 0x16 / 255)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(model.title).font(.title.bold()).foregroundColor(Color(red: 0xf2 / 255, green: 0xeb / 255, blue: 0xdf / 255))
                note(SshWords.text("ssh_add_note"))
                labelled("ssh_host_label") { input($model.host, "my-server.example.com", keyboard: .URL).accessibilityIdentifier("ssh_host") }
                labelled("ssh_port_label") { input($model.port, "22", keyboard: .numberPad).accessibilityIdentifier("ssh_port") }
                labelled("ssh_user_label") { input($model.user, "me").accessibilityIdentifier("ssh_user") }
                    .disabled(model.editing != nil)

                Text(SshWords.text("ssh_method_label")).foregroundColor(Self.text).padding(.top, 12)
                choice(.tailscale, "ssh_method_tailscale", id: "ssh_method_tailscale")
                choice(.phoneKey, "ssh_method_phone", id: "ssh_method_phone")
                choice(.password, "ssh_method_password", id: "ssh_method_password")
                if model.advanced {
                    choice(.imported, "ssh_method_paste", id: "ssh_method_paste")
                } else {
                    Button(SshWords.text("ssh_advanced")) { model.advanced = true }.buttonStyle(Plain()).accessibilityIdentifier("ssh_advanced")
                }

                switch model.method {
                case .tailscale:
                    note(SshWords.text("ssh_tailscale_note"))
                case .phoneKey:
                    note(SshWords.text("ssh_phone_key_note"))
                    Text(model.keyLine).font(.system(size: 12, design: .monospaced)).foregroundColor(Self.text).textSelection(.enabled)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Self.field).accessibilityIdentifier("ssh_key_line")
                    HStack {
                        Button(SshWords.text("ssh_copy")) { UIPasteboard.general.string = model.keyLine }.buttonStyle(Plain())
                        Button(SshWords.text("ssh_share")) { share(model.keyLine) }.buttonStyle(Plain())
                    }
                case .password:
                    labelled("ssh_password_label") {
                        SecureField("", text: $model.password).textContentType(.password).fieldLook().accessibilityIdentifier("ssh_password")
                    }
                case .imported:
                    labelled("ssh_key_label") {
                        TextEditor(text: $model.privateKey).font(.system(size: 11, design: .monospaced)).frame(minHeight: 96, maxHeight: 180)
                            .textInputAutocapitalization(.never).disableAutocorrection(true).foregroundColor(Self.text).fieldLook()
                            .accessibilityIdentifier("ssh_private_key")
                    }
                    Button(SshWords.text("ssh_paste")) { model.pasteKey() }.buttonStyle(Plain())
                    if !model.keyState.isEmpty { note(model.keyState).accessibilityIdentifier("ssh_key_state") }
                    labelled("ssh_passphrase_label") { SecureField("", text: $model.passphrase).fieldLook().accessibilityIdentifier("ssh_passphrase") }
                    note(SshWords.text("ssh_key_sealed_note"))
                }

                HStack(alignment: .center, spacing: 10) {
                    if model.working { ProgressView().tint(Self.accent) }
                    Text(model.status).foregroundColor(Self.text).textSelection(.enabled).accessibilityIdentifier("ssh_status")
                }
                .padding(.vertical, 10)
                if let link = model.checkLink, let url = URL(string: link) {
                    Button(SshWords.text("ssh_open_link")) { UIApplication.shared.open(url) }
                        .buttonStyle(Plain(primary: true)).accessibilityIdentifier("ssh_open_link")
                }

                HStack(spacing: 12) {
                    Button(SshWords.text("ssh_connect")) { model.start() }
                        .buttonStyle(Plain(primary: true)).disabled(model.working).accessibilityIdentifier("ssh_connect")
                    Button(SshWords.text("ssh_cancel"), action: cancel).buttonStyle(Plain())
                }
            }
            .padding(20)
        }
        .background(Self.background.ignoresSafeArea())
        .alert(model.question?.title ?? "", isPresented: Binding(get: { model.question != nil }, set: { if !$0 { model.question = nil } }), presenting: model.question) { question in
            Button(question.yes) { question.answer(true) }
            Button(question.no, role: .cancel) { question.answer(false) }
        } message: { question in
            Text(question.message)
        }
        .preferredColorScheme(.dark)
    }

    private func note(_ words: String) -> some View {
        Text(words).font(.subheadline).foregroundColor(Self.muted).padding(.vertical, 4).fixedSize(horizontal: false, vertical: true)
    }

    private func labelled<Content: View>(_ key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(SshWords.text(key)).font(.subheadline).foregroundColor(Self.text).padding(.top, 8)
            content()
        }
    }

    private func input(_ value: Binding<String>, _ hint: String, keyboard: UIKeyboardType = .asciiCapable) -> some View {
        TextField(hint, text: value).keyboardType(keyboard).textInputAutocapitalization(.never).disableAutocorrection(true).fieldLook()
    }

    private func choice(_ method: SshSetupModel.Method, _ key: String, id: String) -> some View {
        Button {
            model.method = method
        } label: {
            HStack(alignment: .top) {
                Image(systemName: model.method == method ? "largecircle.fill.circle" : "circle").foregroundColor(Self.accent)
                Text(SshWords.text(key)).foregroundColor(Self.text).multilineTextAlignment(.leading)
            }
        }
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(model.method == method ? .isSelected : [])
    }

    struct Plain: ButtonStyle {
        var primary = false

        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .padding(.horizontal, 16).padding(.vertical, 10)
                .foregroundColor(primary ? SshSetupView.background : Color(red: 0xf2 / 255, green: 0xeb / 255, blue: 0xdf / 255))
                .background(primary ? SshSetupView.accent : Color(red: 0x18 / 255, green: 0x16 / 255, blue: 0x13 / 255))
                .opacity(configuration.isPressed ? 0.7 : 1)
        }
    }
}

private extension View {
    func fieldLook() -> some View {
        padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color(red: 0x1d / 255, green: 0x1a / 255, blue: 0x16 / 255))
            .foregroundColor(Color(red: 0xf2 / 255, green: 0xeb / 255, blue: 0xdf / 255))
    }
}

/// The setup screen as a sheet over the app; pulled down or cancelled, it is left as on Android (its work stops).
final class SshSetupController: UIHostingController<SshSetupView>, UIAdaptivePresentationControllerDelegate {
    private let model: SshSetupModel

    init(model: SshSetupModel) {
        self.model = model
        weak var shown: SshSetupController?
        super.init(rootView: SshSetupView(model: model, cancel: { shown?.leave() }, share: { line in
            guard let shown else { return }
            SshSetupController.share(line, from: shown, anchor: shown.view)
        }))
        shown = self
        model.close = { [weak self] in self?.dismiss(animated: true) }
        modalPresentationStyle = .pageSheet
        presentationController?.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    private func leave() {
        model.leave()
        dismiss(animated: true)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        model.leave()
    }

    /// Hands this phone's public key line to another app (mail, a messenger, a note that syncs to the PC).
    static func share(_ line: String, from controller: UIViewController, anchor: UIView) {
        let sheet = UIActivityViewController(activityItems: [line], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = anchor
        sheet.popoverPresentationController?.sourceRect = CGRect(x: anchor.bounds.midX, y: anchor.bounds.midY, width: 1, height: 1)
        (controller.presentedViewController ?? controller).present(sheet, animated: true)
    }
}
