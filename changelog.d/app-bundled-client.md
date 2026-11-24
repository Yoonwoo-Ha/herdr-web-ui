### Added
- When the phone app carries its own copy of Ovis, a PC that no longer supports that copy shows
  "Update the app" with a button to the app's store page; the app's other PCs still open.

### Changed
- The phone app's own copy of Ovis registers no service worker, removes the ones a hosted copy left
  on the phone once, and never reloads to fetch a newer copy. Browsers and the hosted app are unchanged.

### Maintenance
- The oldest client a PC supports is one constant, `MIN_SUPPORTED_CLIENT_VERSION`, and a test keeps it
  at or below a client both app stores have carried for 14 days (`server/relay/store-app-versions.json`).
  `scripts/relay-client-skew-regression.ts`, in the browser lane, runs an older release's client against this server.
