### Fixed
- The browser connection trace no longer re-posts a batch the server refuses with a 4xx status,
  resumes reporting after you sign in again on the same page, and malformed reports can no longer
  use up the server's shared report quota.
