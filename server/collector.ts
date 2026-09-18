import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { sessionSnapshot, subscribeEvents, type EventFrame, type Subscription } from "./herdr/client.ts";

/**
 * Collects agent status for EVERY pane in the session, not just the attached ones.
 *
 * herdr's subscription surface (verified against protocol 22):
 * - `pane.agent_status_changed` REQUIRES a pane_id, but one connection carries any
 *   number of per-pane subscriptions, so all panes share a single status connection.
 * - A second `events.subscribe` request on an already-open connection is silently
 *   ignored: when the pane set changes the status connection must be re-opened with
 *   the full set (see `reconcile`).
 * - `pane.created` / `pane.closed` / `pane.exited` subscribe globally (no pane_id)
 *   and drive both the pane-set reconciliation and the structure broadcasts.
 *
 * Status frames are flat (`{event:"pane.agent_status_changed", data:{pane_id, agent_status, ...}}`)
 * while structure frames carry a snake_case `data.type` - both shapes below parse only
 * what the live server actually sends.
 */

const RECONNECT_DELAY_MS = 5_000;
const BACKSTOP_INTERVAL_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 500;

export interface StatusCollectorHandlers {
  onStatus: (paneId: string, status: AgentStatus) => void;
  onPaneEnded: (paneId: string) => void;
  onStructureChange: () => void;
}

export interface StatusCollector {
  stop: () => void;
}

/** A status frame's payload: flat fields, no wrapper object. */
export function parseStatusFrame(frame: EventFrame): { paneId: string; status: AgentStatus } | null {
  if (frame.event !== "pane.agent_status_changed") return null;
  const data = frame.data as { pane_id?: unknown; agent_status?: unknown } | undefined;
  if (typeof data?.pane_id !== "string" || typeof data.agent_status !== "string") return null;
  return { paneId: data.pane_id, status: data.agent_status as AgentStatus };
}

export type StructureEvent =
  | { kind: "pane-ended"; paneId: string }
  | { kind: "structure-changed" };

/** Structure frames: `{event:"pane_exited"|"pane_created"|"pane_closed", data:{type, pane_id?}}`. */
export function parseStructureFrame(frame: EventFrame): StructureEvent | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  switch (data?.type) {
    case "pane_exited":
      return typeof data.pane_id === "string" ? { kind: "pane-ended", paneId: data.pane_id } : null;
    case "pane_created":
    case "pane_closed":
      return { kind: "structure-changed" };
    default:
      return null;
  }
}

/** The per-pane subscription set for a snapshot: one status subscription per live pane. */
export function statusSubscriptionSpecs(snapshot: SessionSnapshot): { type: string; pane_id: string }[] {
  return snapshot.panes.map((pane) => ({ type: "pane.agent_status_changed", pane_id: pane.pane_id }));
}

export function startStatusCollector(handlers: StatusCollectorHandlers): StatusCollector {
  let stopped = false;
  let statusSubscription: Subscription | null = null;
  let subscribedPaneIds = new Set<string>();
  let reconciling = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let backstopTimer: ReturnType<typeof setInterval> | null = null;
  let lifecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let lifecycleSubscription: Subscription | null = null;

  const STRUCTURE_SUBSCRIPTIONS = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
  ] as const;

  function closeStatusSubscription(): void {
    subscribedPaneIds = new Set();
    statusSubscription?.close();
    statusSubscription = null;
  }

  function openStatusSubscription(paneIds: readonly string[]): void {
    if (stopped || paneIds.length === 0) return;
    subscribedPaneIds = new Set(paneIds);
    statusSubscription = subscribeEvents(
      paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
      {
        onEvent: (frame) => {
          const parsed = parseStatusFrame(frame);
          if (parsed) handlers.onStatus(parsed.paneId, parsed.status);
        },
        // herdr went away (restart): the whole set must be re-subscribed
        onClose: () => {
          if (statusSubscription === null || stopped) return;
          closeStatusSubscription();
          scheduleReconcile();
        },
      },
    );
  }

  async function reconcile(): Promise<void> {
    if (stopped || reconciling) return;
    reconciling = true;
    try {
      const snapshot = await sessionSnapshot();
      if (stopped) return;
      const paneIds = snapshot.panes.map((pane) => pane.pane_id);
      const sameSet =
        paneIds.length === subscribedPaneIds.size && paneIds.every((id) => subscribedPaneIds.has(id));
      if (sameSet) return;
      closeStatusSubscription();
      openStatusSubscription(paneIds);
    } catch {
      /* herdr unreachable: the backstop timer retries */
    } finally {
      reconciling = false;
    }
  }

  function scheduleReconcile(): void {
    if (stopped || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void reconcile();
    }, RECONCILE_DEBOUNCE_MS);
  }

  function startLifecycle(): void {
    if (stopped) return;
    lifecycleSubscription = subscribeEvents([...STRUCTURE_SUBSCRIPTIONS], {
      onEvent: (frame) => {
        const parsed = parseStructureFrame(frame);
        if (!parsed) return;
        if (parsed.kind === "pane-ended") handlers.onPaneEnded(parsed.paneId);
        else {
          handlers.onStructureChange();
          scheduleReconcile();
        }
      },
      onClose: () => {
        if (stopped) return;
        lifecycleRetryTimer = setTimeout(startLifecycle, RECONNECT_DELAY_MS);
      },
    });
  }

  startLifecycle();
  void reconcile();
  backstopTimer = setInterval(() => void reconcile(), BACKSTOP_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (backstopTimer !== null) clearInterval(backstopTimer);
      if (lifecycleRetryTimer !== null) clearTimeout(lifecycleRetryTimer);
      lifecycleSubscription?.close();
      closeStatusSubscription();
    },
  };
}
