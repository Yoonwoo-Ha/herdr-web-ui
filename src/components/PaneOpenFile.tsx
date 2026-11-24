import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { OpenFileContext } from "../lib/filePaths.ts";

/**
 * A pane's "open this file", the same function for as long as it is the same pane on the same PC. App
 * renders on every pane's event, and a function made in that render would draw each message of the
 * chat again (every link in it reads this context).
 */
export function PaneOpenFile({ paneId, machineId, open, children }: { paneId: string | null; machineId: string; open: (file: { path: string; paneId: string; machineId: string }) => void; children: ReactNode }) {
  const openRef = useRef(open);
  useLayoutEffect(() => { openRef.current = open; }, [open]);
  const value = useMemo(() => paneId === null ? null : (path: string) => openRef.current({ path, paneId, machineId }), [paneId, machineId]);
  return <OpenFileContext.Provider value={value}>{children}</OpenFileContext.Provider>;
}
