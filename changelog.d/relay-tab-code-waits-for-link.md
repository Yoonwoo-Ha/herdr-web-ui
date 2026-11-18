### Changed
- A device that scans the QR code of Add a connection's relay tab is a device of the PC once it has
  linked itself into its Ovis account, which a signed-in app does by itself right after it pairs.
  Until then it is in no device list and reads nothing of the PC, and one that has not linked
  within 30 seconds is dropped, so a device that is signed in to no account no longer stays paired
  through that QR code: sign in on it first, or pair it from Phones and devices. The code now takes
  five scans instead of one, and ends when the PC has joined an account. Any other relay QR code
  or pairing link asked for while that one is up gets a code of its own, which ends it.
