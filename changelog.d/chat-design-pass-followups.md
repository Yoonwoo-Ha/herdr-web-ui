### Fixed
- An unsent answer in a prompt card moves with its pane to another workspace, so it is no longer
  offered under the pane's old ID after herdr restarts; newer text typed in another tab is kept.
- On desktop, the composer's context ring can be reached by keyboard; its focus shows how much
  context is left and the token counts.
- The times in Recover unsent text keep counting while the dialog stays open.
- A Codex `$` skill is no longer kept from "No command matches" by a hidden `/` command of the
  same name.

### Maintenance
- Panes no longer each ask the server for this device's role when they open; they use the role the
  app already knows.
