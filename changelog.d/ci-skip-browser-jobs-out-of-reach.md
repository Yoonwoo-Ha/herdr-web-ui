### Maintenance
- A pull request whose changes cannot reach the browser jobs (unit tests, the terminal client, the
  phone and native apps' own folders, the push worker, the site, the installers, the runner
  launcher, another workflow, changelog fragments) skips the Browser regression jobs; "Integration
  and browser" then passes on the integration tests. Any other path, and every push to `main`, runs
  them as before.
