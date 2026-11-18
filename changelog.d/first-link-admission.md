### Changed
- A signed-in device that opens a QR code marked as one whose PC checks new devices with the Ovis
  account now, once Add and pair is pressed, lists the PC in its account if needed and has the account
  check it before it pairs. The account decides, and each such add counts toward the account's limit
  on adds. When the account
  does not confirm it, nothing is paired, the code is not used, and the screen says what to do. Every
  other QR code pairs as before.
- Add a connection → Ovis relay also lists the PC in the signed-in account beside its QR code when the
  PC made that code for this account and the account does not list the PC yet; the listing never
  holds the code up.

### Fixed
- When a PC turns away the first link of a device that paired from such a marked code (its code ended,
  it is set up for another account, or the account did not confirm the device), the device says so in
  plain words and forgets that pairing. A machine that makes no pairing code by itself says so too.
