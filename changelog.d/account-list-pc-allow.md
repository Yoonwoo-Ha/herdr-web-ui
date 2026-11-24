### Added
- A PC that a person added to its account's signed list can let a new device into the list itself:
  the Allow in the PC's own window, and the digits typed at `ovis approve`, sign the device's entry
  with the PC's own key. The account service places it only while a sign-in of the account has
  claimed that device's key, so the PC alone lets in nobody. A PC that follows no list works as
  before. On a pinned PC, a join that brings no card makes a pairing that opens the PC only once
  the list holds its key. A PC whose Ovis is older than what a device wrote into
  the list lets nobody new in itself and says that it needs an update; a device of the account
  can still allow the newcomer.
- On a PC pinned to its account's list, a device of the list that may add devices to it (it
  drives, with full power) sees the joins that wait at that PC, is told of them as they come and
  confirm, and allows one from its own app.
- A device a member allowed on a PC that follows no list is told its place in the account's signed
  list through that PC's introduction.
- On a PC pinned to its account's list, another PC of the account keeps watching for as long as
  the list holds it, and is put out when the list removes it.
- A PC that signed a device's entry and got no clear answer from the account service keeps that
  signed entry and sends the same one again, also after a restart, instead of signing another at
  the same place. A gateway error is no longer taken for a refusal: the PC reads the list first.
- On a PC pinned to its account's list, a device's approval of a join from afar is refused until
  the new device has confirmed its digits (`409 not_confirmed`), and the join keeps waiting.
