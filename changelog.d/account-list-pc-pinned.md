### Added
- A PC can be pinned to its account's signed list. A pinned PC lets its account's devices in only by
  entries that members signed and that it checked itself: the account service can no longer add a
  device to it, take it out of its account or shut out a device it holds, and a device or PC the
  list removed does not come back. It keeps letting in the devices it holds while the account
  service is away. No screen pins a PC yet: a person at the PC names the list at
  `POST /api/account/list/pin`, and the PC pins it once that list holds an entry for the PC's own
  key. A PC that is not pinned works as before.
- `ovis status --json` says of a pinned PC which list it follows, where it stands in it and, when
  it lets no device of its account in, why and what to do (`list`); and of a PC that cannot read
  its own account state, what it could not read (`problem`).
- Before a PC joins a signed list, stop every older Ovis that runs on it: one started later
  refuses the PC's account file, but one that was already running can write its old copy of that
  file over the PC's place in the list.
