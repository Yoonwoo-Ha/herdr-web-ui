import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateCommand, UpdateStatus } from "../../shared/update.ts";
import { fetchUpdateStatus, requestUpdate } from "./api.ts";

declare const __APP_REVISION__: string | null;

export function useUpdates(enabled: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  useEffect(() => {
    if (!enabled) { setStatus(null); setPending(false); setError(null); return; }
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 2000;
      try {
        const next = await fetchUpdateStatus();
        if (!stopped) setStatus(next);
        if (next.phase === "idle" && !next.available) delay = 30_000;
      } catch { /* a restart/offline period must not erase the last known status */ }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [enabled, refresh]);

  const request = useCallback(async (command: UpdateCommand) => {
    setPending(true); setError(null);
    try {
      await requestUpdate(command);
      if (mounted.current) {
        setStatus(previous => previous ? { ...previous, phase: "checking", error: null } : previous);
        setRefresh(value => value + 1);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (mounted.current) setPending(false); }
  }, []);
  const busy = pending || status?.phase === "checking" || status?.phase === "building" || status?.phase === "restarting";
  const needsReload = typeof __APP_REVISION__ === "string" && !!status?.current_revision &&
    __APP_REVISION__ !== status.current_revision && !busy;
  return { status, error, busy, needsReload, request };
}

export type UpdatesModel = ReturnType<typeof useUpdates>;
