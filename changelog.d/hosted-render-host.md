### Fixed
- An HTML page drawn from a PC (an agent's report or chart) shows again in the hosted app at
  app.ovis.sh: Pages answered the page's frame with a redirect to an address that carried the
  app's own policy, which refused the frame's script, so the page stayed blank.

### Maintenance
- The loopback Pages server the browser scripts serve the hosted shell with now follows Pages' own
  html handling (its `.html` redirects, and the rules it ignores), and
  `scripts/pages-dev-check.ts` checks the built shell under `wrangler pages dev`.
