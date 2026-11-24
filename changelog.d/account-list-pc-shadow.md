### Added
- A PC in an account that has a signed list of its devices and PCs now reads that list and checks
  every entry itself, beside the snapshot it lets devices in by. It lets nobody in and puts nobody out
  by the list yet: it only writes to its log where the two would decide differently, so the list is
  checked on real accounts before PCs decide by it. The PC keeps its own two keys for the list in
  `account-list-keys.json`, and its own window reads how it follows the list at
  `GET /api/account/list`.
