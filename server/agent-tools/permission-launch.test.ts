import { expect, it } from "bun:test";
import { permissionLaunch } from "./permission-launch.ts";

it("an unknown parent can launch only the named all-ask profile, never an adapter default", () => {
  const cmd = { argv: ["/bin/opencode", "acp"] };
  const recipe = permissionLaunch("opencode", undefined, "abc123", cmd);
  if (!recipe?.env?.OPENCODE_CONFIG_CONTENT) throw new Error("No all-ask launch policy");
  const config = JSON.parse(recipe.env.OPENCODE_CONFIG_CONTENT);
  expect(config.default_agent).toBe("ovis-ask-abc123");
  expect(config.agents[config.default_agent].permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  expect(recipe.ceiling.mode).toBe(config.default_agent);
  expect(recipe.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  for (const kind of ["claude","codex","gjc","agy","copilot"]) expect(permissionLaunch(kind, undefined, "abc123", cmd)).toBeNull();
  expect(permissionLaunch("opencode", "readonly", "abc123", cmd)).toBeNull();
});
