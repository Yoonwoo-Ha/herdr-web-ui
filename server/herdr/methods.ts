import type { AgentInfo, AgentTarget, PaneProcessInfo, PaneProcessInfoParams, PaneSendKeysParams, PaneSendTextParams } from "../../shared/herdr-api.generated.ts";

/**
 * herdr's schema maps a method to its params (`request.oneOf`), but its answers are one
 * `ResponseResult.oneOf` told apart by a `type` tag (`pane_process_info`, `agent_info`, `ok`)
 * with no link back to the method.
 */
export interface HerdrMethods {
  /** `pane_id`, never `target`: given `target`, herdr silently answers for the focused pane. */
  "pane.process_info": { params: PaneProcessInfoParams & { pane_id: string }; result: { type?: "pane_process_info"; process_info?: PaneProcessInfo } };
  "agent.get": { params: AgentTarget; result: { type?: "agent_info"; agent: AgentInfo } };
  "pane.send_text": { params: PaneSendTextParams; result: { type?: "ok" } };
  "pane.send_keys": { params: PaneSendKeysParams; result: { type?: "ok" } };
}

export type HerdrMethod = keyof HerdrMethods;

export type SingleHerdrMethod<M extends HerdrMethod> = IsUnion<M> extends true ? never : M;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

export type UntypedHerdrMethod<M extends string> = M extends HerdrMethod ? never : M;
