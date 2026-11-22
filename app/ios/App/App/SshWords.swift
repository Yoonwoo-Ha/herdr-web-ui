import Foundation
import OvisSshCore

/// The SSH screens' words in English and Korean, the same as the Android app's (res/values/ssh_strings.xml and
/// values-ko, from which this table was made; the Keystore note says Keychain here), and an SshFailure in the person's words, each saying what to do
/// about it, as SshWords.java does. The app's error page says the same for a PC that is open (app/web/error.html).
enum SshWords {
    static var korean: Bool { Locale.preferredLanguages.first?.lowercased().hasPrefix("ko") ?? false }

    private static let table: [String: (String, String)] = [
        "ssh_method_tailscale": ("Tailscale SSH: no key (the PC runs Tailscale SSH)", "Tailscale SSH: 키 없이(PC에서 Tailscale SSH가 켜져 있을 때)"),
        "ssh_tailscale_note": ("Nothing to add on the PC: Tailscale lets this phone in as your Tailscale login, if that PC runs Tailscale SSH and its policy allows it. Tailscale may ask you to approve it once in the browser.", "PC에 넣을 것이 없어요. 그 PC에서 Tailscale SSH가 켜져 있고 정책이 허락하면, Tailscale이 이 휴대폰을 내 Tailscale 계정으로 들여보내요. 브라우저에서 한 번 승인하라고 할 수 있어요."),
        "ssh_tailscale_check": ("Tailscale SSH asks you to approve this phone. Open the link, approve, and the phone goes on by itself:\n\n%1$@", "Tailscale SSH가 이 휴대폰을 승인하라고 해요. 링크를 열어 승인하면 휴대폰이 알아서 이어가요:\n\n%1$@"),
        "ssh_open_link": ("Open the link", "링크 열기"),
        "ssh_fail_auth_tailscale": ("%1$@ did not let this phone in without a key. Check that Tailscale SSH is on there (tailscale up --ssh) and that its policy allows your login, or sign in another way.", "%1$@이(가) 키 없이 이 휴대폰을 들여보내지 않았어요. 그쪽에서 Tailscale SSH가 켜져 있는지(tailscale up --ssh), 정책이 내 계정을 허락하는지 확인하거나, 다른 방법으로 로그인하세요."),
        "ssh_add_title": ("Add a PC over SSH", "SSH로 PC 추가"),
        "ssh_edit_title": ("Set up %1$@ again", "%1$@ 다시 설정"),
        "ssh_add_note": ("For a machine you already reach over SSH. The phone connects straight to it: no relay, no account, no port but SSH.", "이미 SSH로 접속하는 기기용입니다. 휴대폰이 그 기기에 바로 연결합니다. 릴레이도 계정도 없고, SSH 말고는 포트를 열지 않습니다."),
        "ssh_host_label": ("Address (host name or IP)", "주소(호스트 이름 또는 IP)"),
        "ssh_port_label": ("SSH port", "SSH 포트"),
        "ssh_user_label": ("User", "사용자"),
        "ssh_method_label": ("Sign in with", "로그인 방법"),
        "ssh_method_phone": ("This phone's own key (recommended)", "이 휴대폰의 키(권장)"),
        "ssh_method_password": ("Password, once: the phone adds its key there", "비밀번호 한 번: 휴대폰이 그쪽에 자기 키를 추가"),
        "ssh_method_paste": ("A private key I paste in", "붙여 넣는 개인 키"),
        "ssh_advanced": ("Advanced: paste a private key", "고급: 개인 키 붙여 넣기"),
        "ssh_phone_key_note": ("Add this line to ~/.ssh/authorized_keys on that machine:", "그 기기의 ~/.ssh/authorized_keys에 이 줄을 추가하세요:"),
        "ssh_copy": ("Copy", "복사"),
        "ssh_copied": ("Copied", "복사했습니다"),
        "ssh_share": ("Share", "공유"),
        "ssh_share_title": ("Send this phone's key to the PC", "이 휴대폰의 키를 PC로 보내기"),
        "ssh_phone_key_failed": ("This phone could not make its key: %1$@", "휴대폰이 키를 만들지 못했습니다: %1$@"),
        "ssh_password_label": ("Password (used once, never saved)", "비밀번호(한 번만 쓰고 저장하지 않음)"),
        "ssh_key_label": ("Private key (OpenSSH or PEM)", "개인 키(OpenSSH 또는 PEM)"),
        "ssh_paste": ("Paste", "붙여 넣기"),
        "ssh_passphrase_label": ("Passphrase, if it has one", "암호 문구(있다면)"),
        "ssh_key_sealed_note": ("The key and its passphrase are sealed with a key in this iPhone's Keychain, kept on this device only, and never leave the app.", "키와 암호 문구는 이 iPhone 키체인의 키(이 기기에만 보관)로 봉인되고 앱 밖으로 나가지 않습니다."),
        "ssh_key_encrypted": ("This key has a passphrase: enter it below.", "암호 문구가 걸린 키입니다. 아래에 입력하세요."),
        "ssh_key_plain": ("This key has no passphrase.", "암호 문구가 없는 키입니다."),
        "ssh_connect": ("Connect", "연결"),
        "ssh_cancel": ("Cancel", "취소"),
        "ssh_fill_in": ("Fill in the address, a port from 1 to 65535 and the user.", "주소, 1~65535 사이의 포트, 사용자를 입력하세요."),
        "ssh_connecting": ("Connecting to %1$@…", "%1$@에 연결하는 중…"),
        "ssh_no_host_key": ("The machine did not show a host key.", "기기가 호스트 키를 보여주지 않았습니다."),
        "ssh_not_confirmed": ("Not connected: the host key was not confirmed.", "연결하지 않았습니다: 호스트 키를 확인하지 않았습니다."),
        "ssh_signing_in": ("Signing in as %1$@…", "%1$@(으)로 로그인하는 중…"),
        "ssh_reading_key": ("Opening the key…", "키를 여는 중…"),
        "ssh_adding_key": ("Adding this phone's key to %1$@…", "%1$@에 이 휴대폰의 키를 추가하는 중…"),
        "ssh_looking": ("Looking for Ovis on %1$@…", "%1$@에서 Ovis를 찾는 중…"),
        "ssh_connected": ("Connected. Opening Ovis…", "연결했습니다. Ovis를 여는 중…"),
        "ssh_confirm_title": ("Is this %1$@?", "이 기기가 %1$@인가요?"),
        "ssh_confirm_message": ("Its host key fingerprint:\n\n%1$@\n%2$@\n\nCheck it on that machine with\ncat /etc/ssh/ssh_host_*_key.pub | ssh-keygen -lf -\nand trust it only if it matches.", "호스트 키 지문:\n\n%1$@\n%2$@\n\n그 기기에서\ncat /etc/ssh/ssh_host_*_key.pub | ssh-keygen -lf -\n로 확인하고, 같을 때만 신뢰하세요."),
        "ssh_trust": ("Trust and connect", "신뢰하고 연결"),
        "ssh_install_title": ("Install Ovis on %1$@?", "%1$@에 Ovis를 설치할까요?"),
        "ssh_install_message": ("Ovis is not installed for this account there. The phone can run the official installer there now, for this account only and without sudo:\n\n%1$@\n\nIt downloads about 360 MB and needs about 1 GB of disk: half a minute on a fast connection, a few minutes on a slow one. Keep this screen open until it finishes: closing it stops the install.", "그 기기의 이 계정에는 Ovis가 설치되어 있지 않습니다. 휴대폰이 지금 그쪽에서 공식 설치 프로그램을 실행할 수 있습니다. 이 계정에만, sudo 없이 설치합니다:\n\n%1$@\n\n약 360MB를 내려받고 디스크 약 1GB가 필요합니다. 빠른 연결에서 30초쯤, 느린 연결에서 몇 분 걸립니다. 끝날 때까지 이 화면을 열어 두세요. 화면을 닫으면 설치가 멈춥니다."),
        "ssh_install_yes": ("Install", "설치"),
        "ssh_install_no": ("Not now", "나중에"),
        "ssh_installing": ("Installing Ovis on %1$@…\n%2$@", "%1$@에 Ovis를 설치하는 중…\n%2$@"),
        "ssh_fail_auth_phone": ("%1$@ refused this phone's key. Add the line above to ~/.ssh/authorized_keys there, or use the password once.", "%1$@이(가) 이 휴대폰의 키를 거부했습니다. 위의 줄을 그쪽 ~/.ssh/authorized_keys에 추가하거나, 비밀번호를 한 번 쓰세요."),
        "ssh_fail_auth_pasted": ("%1$@ refused that key. Its public key has to be in ~/.ssh/authorized_keys there:\n\n%2$@", "%1$@이(가) 그 키를 거부했습니다. 그 공개 키가 그쪽 ~/.ssh/authorized_keys에 있어야 합니다:\n\n%2$@"),
        "ssh_fail_auth_password": ("%1$@ refused that password.", "%1$@이(가) 그 비밀번호를 거부했습니다."),
        "ssh_fail_key_missing": ("Paste the private key first.", "먼저 개인 키를 붙여 넣으세요."),
        "ssh_fail_key_public": ("That is a public key. Paste the private key: the file without .pub, starting with -----BEGIN.", "공개 키입니다. 개인 키를 붙여 넣으세요: .pub가 없는 파일로, -----BEGIN으로 시작합니다."),
        "ssh_fail_key_format": ("This app reads OpenSSH and PEM keys. Convert this one on a computer, then paste it again:\n\n%1$@", "이 앱은 OpenSSH와 PEM 키를 읽습니다. 컴퓨터에서 이렇게 바꾼 뒤 다시 붙여 넣으세요:\n\n%1$@"),
        "ssh_fail_key_not_a_key": ("That is not a private key this app can read (%1$@).", "이 앱이 읽을 수 있는 개인 키가 아닙니다(%1$@)."),
        "ssh_fail_key_needs_passphrase": ("This key has a passphrase. Enter it below.", "암호 문구가 걸린 키입니다. 아래에 입력하세요."),
        "ssh_fail_key_wrong_passphrase": ("The passphrase does not open this key. Check it and try again.", "그 암호 문구로는 이 키가 열리지 않습니다. 확인하고 다시 시도하세요."),
        "ssh_fail_key_unsupported": ("This kind of key is not supported on the iPhone (%1$@). Use an ed25519 or ECDSA key.", "이 종류의 키는 iPhone에서 지원하지 않습니다(%1$@). ed25519 또는 ECDSA 키를 쓰세요."),
        "ssh_fail_key_lost": ("This phone could no longer read its own key, so it made a new one. Register it again: use the password once, or add the new line above.", "이 휴대폰이 자기 키를 더 이상 읽지 못해서 새 키를 만들었습니다. 다시 등록하세요: 비밀번호를 한 번 쓰거나, 위의 새 줄을 추가하세요."),
        "ssh_fail_key_unreadable": ("This phone can no longer open the key saved for this PC. Paste the key again.", "이 휴대폰이 이 PC용으로 저장한 키를 더 이상 열지 못합니다. 키를 다시 붙여 넣으세요."),
        "ssh_fail_host_key_pinned": ("The PC answered with another SSH host key than the one this phone confirmed for it:\n\n%1$@\n\nNothing was sent. If you know why it changed (the machine was reinstalled, its keys replaced), tap Forget host key under Manage beside this PC, then set it up again to confirm the new key.", "PC가 이 휴대폰이 확인한 것과 다른 SSH 호스트 키로 응답했습니다:\n\n%1$@\n\n아무것도 보내지 않았습니다. 바뀐 이유를 안다면(기기를 다시 설치했거나 키를 바꾼 경우) 이 PC 옆의 관리에서 호스트 키 지우기를 누른 뒤, 다시 설정해서 새 키를 확인하세요."),
        "ssh_fail_host_key_changed": ("The host key changed while connecting. Nothing was sent: try again and check the fingerprint.", "연결하는 사이에 호스트 키가 바뀌었습니다. 아무것도 보내지 않았습니다. 다시 시도하고 지문을 확인하세요."),
        "ssh_fail_unreachable": ("Could not reach %1$@ over SSH: %2$@.\n\nCheck the address and the port, that the machine is on, and that this phone reaches it (the same Wi-Fi, or Tailscale on).", "SSH로 %1$@에 연결하지 못했습니다: %2$@.\n\n주소와 포트, 기기가 켜져 있는지, 이 휴대폰이 그 기기에 닿는지(같은 Wi-Fi, 또는 Tailscale 켜짐) 확인하세요."),
        "ssh_fail_timeout": ("%1$@ did not answer in time. Check that the machine is on and that this phone reaches it (the same Wi-Fi, or Tailscale on).", "%1$@이(가) 제때 응답하지 않았습니다. 기기가 켜져 있는지, 이 휴대폰이 그 기기에 닿는지(같은 Wi-Fi, 또는 Tailscale 켜짐) 확인하세요."),
        "ssh_fail_unsupported": ("Only Linux and macOS machines can be opened from the phone for now.", "지금은 Linux와 macOS 기기만 휴대폰에서 열 수 있습니다."),
        "ssh_fail_no_ovis": ("Ovis is not installed for this account on %1$@. Install it there, in a terminal on that machine:\n\n%2$@", "%1$@의 이 계정에는 Ovis가 설치되어 있지 않습니다. 그 기기의 터미널에서 설치하세요:\n\n%2$@"),
        "ssh_fail_bridge_only": ("Ovis itself is not installed for this account on %1$@: only a bridge another PC's Ovis started runs there, and it serves that PC alone. Install Ovis there:\n\n%2$@", "%1$@의 이 계정에는 Ovis 자체가 설치되어 있지 않습니다. 다른 PC의 Ovis가 띄운 브리지만 있고, 그 브리지는 그 PC에만 응답합니다. 그 기기에 Ovis를 설치하세요:\n\n%2$@"),
        "ssh_fail_not_started": ("Ovis is installed on %1$@ but did not start. Start it there, then try again:\n\n%2$@", "%1$@에 Ovis가 설치되어 있지만 시작되지 않았습니다. 그쪽에서 시작한 뒤 다시 시도하세요:\n\n%2$@"),
        "ssh_fail_not_ovis": ("Something answers on that machine's Ovis port, but not as Ovis.", "그 기기의 Ovis 포트에서 응답이 있지만 Ovis가 아닙니다."),
        "ssh_fail_install_unsupported": ("Installing from the phone works on Linux and macOS (x64 or arm64); that machine is %1$@.", "휴대폰에서 설치는 Linux와 macOS(x64 또는 arm64)에서만 됩니다. 그 기기는 %1$@입니다."),
        "ssh_fail_install_missing_tool": ("That machine has no %1$@, which the installer needs. Install it there, then try again:\n\n%2$@", "그 기기에 설치 프로그램이 쓰는 %1$@이(가) 없습니다. 그쪽에서 설치한 뒤 다시 시도하세요:\n\n%2$@"),
        "ssh_fail_install_permission": ("This account cannot write to its home folder there, where Ovis installs.", "이 계정은 Ovis가 설치되는 자기 홈 폴더에 쓸 수 없습니다."),
        "ssh_fail_install_disk": ("That machine has %1$@ free in its home folder; installing Ovis needs about 1 GB.", "그 기기의 홈 폴더에 남은 공간이 %1$@입니다. Ovis 설치에는 약 1GB가 필요합니다."),
        "ssh_fail_install_failed": ("The install did not finish. %1$@\n\nRun it there to see why:\n\n%2$@", "설치가 끝나지 않았습니다. %1$@\n\n그쪽에서 직접 실행해 이유를 보세요:\n\n%2$@"),
        "ssh_fail_other": ("Could not finish: %1$@", "끝내지 못했습니다: %1$@"),
    ]

    static func text(_ key: String, _ args: String...) -> String {
        guard let pair = table[key] else { return key }
        let format = korean ? pair.1 : pair.0
        return args.isEmpty ? format : String(format: format, arguments: args.map { $0 as NSString })
    }

    /// `place` is user@host[:port]; `how` the sign-in tried ("phone-key", "password", "imported"); `publicLine` the pasted key's line, or nil.
    static func describe(_ place: String, _ failure: SshFailure, how: String, publicLine: String?) -> String {
        let detail = failure.message.isEmpty ? failure.kind : failure.message
        let command = failure.command ?? SshCommands.installCommand
        switch failure.kind {
        case "auth":
            if how == "password" { return text("ssh_fail_auth_password", place) }
            if how == "imported" { return text("ssh_fail_auth_pasted", place, publicLine ?? "") }
            if how == "tailscale" { return text("ssh_fail_auth_tailscale", place) }
            return text("ssh_fail_auth_phone", place)
        case "key-missing": return text("ssh_fail_key_missing")
        case "key-public": return text("ssh_fail_key_public")
        case "key-format": return text("ssh_fail_key_format", command)
        case "key-not-a-key": return text("ssh_fail_key_not_a_key", detail)
        case "key-needs-passphrase": return text("ssh_fail_key_needs_passphrase")
        case "key-wrong-passphrase": return text("ssh_fail_key_wrong_passphrase")
        case "key-unsupported": return text("ssh_fail_key_unsupported", detail)
        case "key-lost": return text("ssh_fail_key_lost")
        case "key-unreadable": return text("ssh_fail_key_unreadable")
        case "host-key-changed": return text("ssh_fail_host_key_changed")
        case "unreachable": return text("ssh_fail_unreachable", place, detail)
        case "timeout": return text("ssh_fail_timeout", place)
        case "unsupported": return text("ssh_fail_unsupported")
        case "no-ovis": return text("ssh_fail_no_ovis", place, command)
        case "bridge-only": return text("ssh_fail_bridge_only", place, command)
        case "not-started": return text("ssh_fail_not_started", place, command)
        case "not-ovis": return text("ssh_fail_not_ovis")
        case "install-unsupported": return text("ssh_fail_install_unsupported", detail)
        case "install-missing-tool": return text("ssh_fail_install_missing_tool", detail, command)
        case "install-permission": return text("ssh_fail_install_permission")
        case "install-disk": return text("ssh_fail_install_disk", detail)
        case "install-failed": return text("ssh_fail_install_failed", detail, command)
        default: return text("ssh_fail_other", detail)
        }
    }
}
