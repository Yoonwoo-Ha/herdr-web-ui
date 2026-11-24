import { type Fixture, place } from "./fixture.ts";

/** States an agent can be in, one terminal each, as reported by the pane before the screen connects. */
const STATES = ["working", "blocked", "done", "idle"] as const;

export const agents: Fixture = {
  build(core) {
    for (const state of STATES) {
      const terminal = place(core, { space: "w-agents", spaceName: "agents", tab: "t-agents", tabName: "agents", pane: state }, `claude: ${state}\r\n`);
      core.reportStatus(terminal, { state, app: "claude" });
    }
  },
};
