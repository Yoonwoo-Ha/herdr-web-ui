import { resolveHerdrKeys } from "../shared/herdr-keys.ts";
import type { HerdrUiConfig } from "../shared/protocol.ts";
import { herdrConfigPath, readHerdrConfig } from "./herdr-sidebar.ts";

export function readHerdrUi(path = herdrConfigPath()): HerdrUiConfig {
  const config = readHerdrConfig(path);
  const ui = typeof config === "object" && config !== null ? (config as { ui?: unknown }).ui : undefined;
  const copy = typeof ui === "object" && ui !== null ? (ui as { copy_on_select?: unknown }).copy_on_select : undefined;
  return { copy_on_select: typeof copy === "boolean" ? copy : true, keys: resolveHerdrKeys(typeof config === "object" && config !== null ? (config as { keys?: unknown }).keys : undefined) };
}

