### Maintenance
- CI: a pull request that changes the desktop app runs the app's unit tests, its type check and its
  build on Linux x64 and Windows x64 instead of all five builds. The five builds run every day on
  main, at a release, and for a pull request that changes the build workflow itself.
