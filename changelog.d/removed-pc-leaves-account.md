### Fixed
- A PC removed from an account with **I didn't add this** no longer keeps opening for that account's
  devices. Before it lets one in, the PC asks the account service whether its own add still stands,
  and it leaves the account when that add is gone or was replaced. One answer is used for at most
  60 seconds, so a removal refuses new sign-ins within a minute.
- When a PC cannot reach the account service to ask, the device says so and keeps its key, instead
  of reading the refusal as its own removal.
- On this PC's own page, adding it to an account that still shows its earlier add as complete works
  again.
- After an hour in which a PC could not confirm its account, the account's devices are signed out of
  it until it can, also those another device of the account approved. Devices paired with the PC
  itself keep working.

- A PC removed from an account is no longer put back by a device that still has it paired: opening
  it adds nothing to the account, and the PC joins an account again only when it is added at the PC
  itself.

- When a PC leaves an account, a phone that was paired with the PC's own QR code and then joined the
  account with the same key keeps its own access to the PC.

- A device that an account's removal of a PC cut off can join again with the number approved at the
  PC after the PC was restarted, where the PC used to turn it away although its owner pressed
  Approve.
- A phone that is already paired with a PC can put that PC back in its account by scanning the PC's
  QR code. The scan used to end with the phone told it was removed, and without the pairing it had.
- A device of the account that opens a PC which left the account is told to add the PC to the
  account again, and keeps its key. It used to be told that it was removed from the PC.
- Adding this PC with a sign-in that has no two-step sign-in now says so and what works instead; it
  no longer offers **Sign in again**, which could not help, and a second refused press says why.

### Changed
- **Remove** in Manage account now takes the PC out of the account for good, also a PC that was
  added by pairing a device: once it is online again, the account's devices no longer open it, and
  devices paired with the PC itself still do.
- A PC that was added to an account in one press before this release stays in that account after
  the update, once the account service confirms that add. Until the service answers, the account's
  devices are told the PC could not reach the account, and devices paired with the PC itself keep
  working. Only a PC the account had removed, or that a device merely listed again, is added again
  at the PC: the account's devices show **Add this PC to your account again** for it.
- After a restart, a device paired with the PC itself no longer waits when the PC can read its
  account but cannot confirm its own place in it.
