### Added
- The Android app adds a PC you already reach over SSH: **SSH** under **Add a PC**, with no relay,
  no account and no port open but SSH. The phone signs in with a key of its own (registered there
  with your password once, or by copying or sharing its line into `authorized_keys`), or, under
  **Advanced**, with a private key you paste in (OpenSSH or PEM; ed25519, RSA or ECDSA; with a passphrase or
  not). The PC's host key fingerprint is shown to confirm first, and a changed one stops the app
  until you forget it on purpose. Keys stay on the phone, sealed by the Android Keystore.
- Where that account has no Ovis yet, the phone can install it there with the official installer,
  without sudo, and then opens it.
- An SSH PC in **Your PCs** has **Manage**: rename it, show the phone's key again, set it up
  again, forget its host key, or remove it, optionally taking the phone's key out of the PC's
  `authorized_keys` too. When it cannot open, the error page says why (the host key changed, the
  key was refused, the PC is out of reach, Ovis is not installed or not running there) and gives
  the one command to run on the PC.
