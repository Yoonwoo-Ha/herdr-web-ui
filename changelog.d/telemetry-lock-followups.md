### Fixed
- Turning usage counts off takes precedence when two Ovis servers share a state folder. If
  another server takes over the lock before a telemetry change can be saved, the app reports
  the failure so you can try again.
