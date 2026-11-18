### Changed
- A pi or Command Code chat whose agent is still working no longer reparses the whole running
  task on every refresh: as for OMP, OMO, Claude and Codex chats, a refresh still reads the running
  task but parses only the records written since the last one (a rewritten file, or one dropped
  from the cache, is parsed again). Within each read of its metadata, pi looks a model's context window up once instead of
  once per answer.
