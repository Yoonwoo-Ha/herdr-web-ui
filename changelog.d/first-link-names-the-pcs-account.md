### Changed
- A PC that `ovis add`, or adding the PC from its own page, set up for an Ovis account takes its
  first member from that account. A device signed in to another account that pairs with the PC's
  code is refused when it links, at once, and the code stays good for a device of the right
  account. When the account you use has changed since the PC was set up, run `ovis add` on the PC
  again and sign in with the account you use now; the PC's answer to the refused device says the
  same.
