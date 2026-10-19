### Fixed
- The app can be installed behind a reverse proxy that signs in every request (Authelia,
  oauth2-proxy and the like): the browser now sends its cookies with the manifest request.
