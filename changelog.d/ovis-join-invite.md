### Added
- `ovis join` adds a PC to your Ovis account with a single-use invite that a device signed in to
  the account made, with no sign-in on the PC: `ovis join --invite-file <path>` (or `ovis join -`
  on standard input, or `OVIS_INVITE`). It names the account the invite is for and asks you to type
  `yes`, or checks it against `--account <id>` where nobody can type (a script, a coding agent).
  The invite never leaves the PC: it proves it holds it with a signature.
  A plain invite then waits up to 10 minutes for **Add** on a device of the account, as `ovis add`
  does; an auto invite adds the PC at once. Stopped or not added, it tries to take the PC off the
  account's list again, and says what to do when it could not. `--json` prints one object at the
  end with a named error; most errors have an exit code of their own (`stopped` and `not_added`
  share 1).
- `ovis status --json` prints what an agent reads: the version, whether Ovis runs, this PC's ID,
  the relay (on, connected), the account it is in and whether it waits for **Add**.

### Fixed
- `ovis add --account <id>` on a PC already in another account no longer reports success: it
  fails, names that account by the start of its id, and says to run `ovis logout` first. The same
  account still ends with exit 0.
