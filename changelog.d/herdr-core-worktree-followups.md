### Fixed
- On a herdr-core server, a repository's workspace whose shell went into one of its worktrees stays
  the repository's row after Ovis restarts or updates. It was drawn as that worktree, and Delete
  worktree checkout… on it deleted the other workspace's checkout. A workspace Ovis did not open
  now nests by the folder its first terminal started in: one started outside the repository
  stays outside it after a `cd` into it.
- On a herdr-core server, Delete worktree checkout… is refused while another workspace is open on
  that checkout or has a terminal in it, instead of leaving that workspace in a deleted folder.
  It is also refused for a checkout removed and added again at the same path since the row was
  drawn, however long ago that was.
- On a herdr-core server, a workspace in a folder where git answers slowly (a network folder, a very
  large repository) no longer slows every sidebar refresh by 2 seconds, and nests under its
  repository as soon as git answers.
