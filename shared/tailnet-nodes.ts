/**
 * The tailnet nodes this PC keeps out (server/tailnet-nodes.ts), as this PC's own window reads and answers them:
 * GET /api/devices/tailnet-nodes, POST /api/devices/tailnet-nodes/block and /api/devices/tailnet-nodes/answer.
 */
export const TAILNET_NODE_ROUTES = {
  list: "/api/devices/tailnet-nodes",
  block: "/api/devices/tailnet-nodes/block",
  answer: "/api/devices/tailnet-nodes/answer",
} as const;

/** A node of the owner's login this PC has seen on the tailnet; `id` is its Tailscale StableNodeID. */
export interface TailnetNodeView {
  readonly id: string;
  readonly hostname: string;
  readonly login: string | null;
  readonly seen_at: string | null;
  readonly blocked: boolean;
  /** the paired rows whose own credential came from this node */
  readonly rows: readonly string[];
}

/** A blocked node that asked to get in, waiting for Allow or Decline on this PC's own window (one at a time). */
export interface TailnetNodePrompt {
  readonly id: string;
  readonly hostname: string;
  readonly login: string | null;
  readonly asked_at: string;
}

export interface TailnetNodesAnswer {
  readonly pending: TailnetNodePrompt | null;
  readonly nodes: readonly TailnetNodeView[];
}
