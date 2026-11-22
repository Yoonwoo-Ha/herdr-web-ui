# Open a PC over SSH from the phone app

For a computer you already reach with `ssh`: the phone connects straight to it, with no Ovis relay,
no account and no port open but SSH. Linux and macOS computers, from the Android and iPhone apps. On the iPhone a pasted private key must be
ed25519 or ECDSA (RSA keys work in the Android app), and the password once needs the computer to take SSH's
plain password sign-in.

## Add it

1. On the **SSH** tab, type `user@host` in **SSH** and tap **Connect**: the app's SSH screen opens with it filled in.
2. Fill in the address (a host name or an IP your phone reaches: on the same Wi-Fi, or over
   Tailscale), the SSH port and your user name there.
3. Choose how the phone signs in:
   - **Tailscale SSH: no key**, when the computer runs Tailscale SSH (`tailscale up --ssh`) and its policy lets
     your login in. Nothing goes on the computer. If Tailscale asks for a check, the app shows its link: open it,
     approve, and the phone goes on by itself. Picked for you when the address is a Tailscale one.
   - **This phone's own key** (recommended). The app shows one line; add it to
     `~/.ssh/authorized_keys` on the computer (Copy, or Share it to mail or a messenger you read on
     the computer, then paste it there), then tap Connect.
   - **Password, once**. The phone signs in with your password one time, adds its own key to
     `~/.ssh/authorized_keys` there, checks that the key works, and forgets the password.
   - Under **Advanced: paste a private key**, **A private key I paste in**. Use it only for a key
     you already have: a private key on the clipboard can be read by other apps. OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) or PEM
     (`-----BEGIN RSA PRIVATE KEY-----`, `-----BEGIN EC PRIVATE KEY-----`); ed25519, RSA or
     ECDSA; with its passphrase if it has one. Its public key must already be in
     `authorized_keys` there.
4. The app shows the computer's host key fingerprint. Check it on the computer:

   ```bash
   cat /etc/ssh/ssh_host_*_key.pub | ssh-keygen -lf -
   ```

   and tap **Trust and connect** only if it is the same.
5. The app finds Ovis there and opens it. If Ovis is installed but stopped, the app starts it. If
   that account has no Ovis yet, the app offers to install it (below).

The computer joins **Your PCs** on the first screen as `user@host (SSH)`. Leaving the app ends the
SSH connection after a while; coming back connects again by itself, asking nothing, and whatever you
had typed stays a draft until you send it.

## The PCs your first PC knows

Once one PC is added over SSH, the **SSH** tab lists the PCs it knows, each with **Add**: the hosts of its
`~/.ssh/config` (by their user@hostname), the PCs of its Tailscale login (as the same user), and the PCs it added
over SSH itself. Add opens the SSH screen filled in, as typing it would. The list comes from that PC's Ovis over
the phone's SSH connection; a PC whose Ovis is older lists what it can.

## Install Ovis from the phone

When the account has no Ovis, **Install** runs the official installer there, for that account only
and without sudo (the same one as `curl -fsSL https://ovis.sh/install.sh | sh`), shows its progress,
and opens Ovis when it is up. The computer needs `curl`, `git`, `tar` and `unzip` and about 1 GB free; the app
says what is missing otherwise. Keep that screen open until it finishes: closing it (Cancel or Back) stops the install.
Or run that command in a terminal on the computer yourself and add the PC again.

## Manage it

Tap **Manage** beside an SSH PC in **Your PCs**:

- **Rename**: the name in the list.
- **Show this phone's key**: the line for `authorized_keys`, to copy again.
- **Set up again**: sign in another way, paste another key, or register the phone's key again (a
  password once), keeping the PC's place and your drafts.
- **Forget host key**: only when you know why the computer's SSH key changed (it was reinstalled,
  its keys replaced). Opening the PC then shows the new fingerprint to check.
- **Remove**: forgets the PC on the phone, its host key and any key saved for it. Tick the box to
  take the phone's key out of the computer's `authorized_keys` too (the computer has to be
  reachable then).

## When it does not open

The app's error page says what happened and what to do:

| It says | Do |
| --- | --- |
| The PC's SSH key changed | Check why on the computer. If you know (reinstalled), Change PC, then Manage → Forget host key, and open it to confirm the new fingerprint. Otherwise do not connect. |
| Approve this phone in Tailscale | Tailscale SSH asks for its check again: open the link, approve it, then Try again. |
| The PC refused this phone | The key left `authorized_keys` there. Change PC, then Manage → Set up again, and use the password once. |
| Could not reach the PC over SSH | The computer is off, sshd is not running, or the phone cannot reach the address (another network; Tailscale off). |
| Ovis is not installed there | Run the command shown, in a terminal on the computer, or Manage → Set up again to install from the phone. |
| Ovis is not running there | Run the command shown on the computer (for example `herdr plugin action invoke devswha.ovis.start`), then Try again. |

## Where your keys are

The phone's own key and any key you paste are kept only in the app, sealed with a key in the
phone's Android Keystore or the iPhone's Keychain (this device only): they never leave the phone, not even
in a backup. Your password is used
once and never stored. Nothing goes to the Ovis developers or the Ovis relay: the connection is
between your phone and your computer.
