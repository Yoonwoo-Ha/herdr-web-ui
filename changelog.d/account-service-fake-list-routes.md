### Maintenance
- Tests: the in-memory account service answers the signed list's routes (the genesis, the log, wraps,
  placing entries at the head, claims and posts) on the accounts, sign-ins and PCs it already holds,
  and lies on request (an injected entry, a withheld tail, a fork, a wrong head, a flipped byte) so
  that tests can show a member is not fooled.
