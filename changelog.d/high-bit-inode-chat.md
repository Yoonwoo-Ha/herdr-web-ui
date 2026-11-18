### Fixed
- Chat opens a conversation whose transcript sits on a file system that numbers files past 2^63
  (some NFS servers) instead of answering "could not be read; try again shortly" on every retry.
