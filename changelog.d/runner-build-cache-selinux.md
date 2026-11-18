### Maintenance
- Self-hosted CI runner: when `selinuxenabled` reports SELinux on (an EL host such as the rented
  server), `run.sh --build-cache` labels the cache and the slots' outboxes `container_file_t` (level
  `s0`) when it starts, so jobs can read the cache and hand in their builds. Before, a cache or outbox
  that was not labelled so refused every hand-in with "Permission denied" and the cache stayed empty.
  A host where the labelling fails runs without the build cache and says so. Every launcher on a
  runner host must be replaced by the new `run.sh` and restarted once its slots are idle: an ordinary
  restart stops the slots' containers and cancels the jobs they run.
