/**
 * The agent a pane runs and the folder it works in, as herdr has them now: read by the HTTP routes and by
 * the core (server/core) alike, so it lives in neither.
 */
import { HerdrError, paneGet } from "./herdr/client.ts";

export async function paneContext(paneId: string): Promise<{ agent: string | null; cwd: string }> {
  const pane = await paneGet(paneId);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };
}
