### Fixed
- `ovis add` (and `install.sh --add`) no longer stops after 30 seconds waiting for a relay that a PC
  signed in on the link page cannot bring online. After the sign-in it names the account that signed
  in and its PCs, asks you to type `yes`, then waits up to 10 minutes for **Add** on that PC's card
  in Ovis on your phone or another PC, comes online and says **Added**. `--account <id>` checks the
  account instead of asking, and is needed where the command does not run in a terminal (a script,
  a coding agent). On Ctrl+C or after the 10 minutes it tries to take the PC off the account's list
  again, and says what is left and what to do.
  `ovis add --qr` keeps the QR code.
- **Add this PC to your account?** adds the PC with any fresh sign-in of the account, a Google
  sign-in without two-step included, instead of saying to add it with the number. It says when the
  account added as many PCs as it may in a day, and to press No for a code someone else gave you.

### Added
- **Manage account** shows the start of the account's ID, as `ovis status` does, for
  `ovis add --account`.
