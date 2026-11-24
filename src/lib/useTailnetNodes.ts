import { useEffect, useState } from "react";

import type { TailnetNodesAnswer } from "../../shared/tailnet-nodes.ts";
import { ApiError, fetchTailnetNodes } from "./api.ts";
import { ADDED_POLL_MS } from "../components/AccountSection.tsx";

/**
 * The tailnet nodes this PC keeps out and the one asking on the card (server/tailnet-nodes.ts), read every ADDED_POLL_MS
 * while `enabled` and the page shows, and at once whenever `again` changes. Only this PC's own window may read them: a
 * 403, 404 or 405 is final.
 */
export function useTailnetNodes(enabled: boolean, again = 0): TailnetNodesAnswer | null {
  const [answer, setAnswer] = useState<TailnetNodesAnswer | null>(null);
  useEffect(() => {
    if (!enabled) { setAnswer(null); return; }
    let live = true;
    let refused = false;
    const read = (): void => {
      if (refused || document.hidden) return;
      fetchTailnetNodes().then((next) => { if (live) setAnswer(next); }, (error: unknown) => {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 405)) refused = true;
        else console.warn("Ovis: the Tailscale devices could not be read", error instanceof Error ? error.name : error);
      });
    };
    read();
    const timer = setInterval(read, ADDED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [enabled, again]);
  return answer;
}
