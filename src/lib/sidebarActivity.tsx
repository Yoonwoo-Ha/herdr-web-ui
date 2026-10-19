/** Shared raw Activity order and browser-local acknowledgement of server-identified finishes. */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import { liveSeqs, markSeen, newSeqMemory, shownStatus, type SeenRecord, type SeqMemory } from "./sidebarOrder.ts";
import { cleanSeen, loadSeen, saveSeen, seenEvent, seenKey, SEEN_PREFIX } from "./seenFinishes.ts";
import { conversationFinishEvidence } from "./panePresentation.ts";

export interface SidebarActivity {
  seqs(machineId: string): ReadonlyMap<string, number>;
  status(machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait" | "finish_id">): AgentStatus | undefined;
}
const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => shownStatus(pane, null) });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

interface MachineSeen { epoch: string; record: SeenRecord }
const unobscured = () => true;

export function useSidebarActivityState(machines: readonly Machine[], selectedMachineId: string, presentedPaneId: string | null, paneInFront: () => boolean = unobscured): SidebarActivity {
  const memories = useRef(new Map<string, { epoch: string | undefined; memory: SeqMemory }>());
  const seqsByMachine = useMemo(() => new Map(machines.map((machine) => {
    const epoch = machine.snapshot?.finish_epoch;
    let kept = memories.current.get(machine.id);
    if (!kept || kept.epoch !== epoch) {
      kept = { epoch, memory: newSeqMemory() };
      memories.current.set(machine.id, kept);
    }
    return [machine.id, liveSeqs(machine.snapshot, kept.memory)] as const;
  })), [machines]);
  const [seen, setSeen] = useState<ReadonlyMap<string, MachineSeen>>(() => new Map());
  const seenRef = useRef(seen); seenRef.current = seen;
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  const [storageRevision, setStorageRevision] = useState(0);
  const epochs = useRef(new Map<string, string>());
  useEffect(() => {
    cleanSeen();
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    const onStorage = (event: StorageEvent) => {
      // A lower write can race a higher one for the same key. The event carries the higher
      // value even if storage has since changed; converge on max. Deletions never resurrect keys.
      const incoming = event.key ? seenEvent(event.key, event.newValue) : null;
      if (incoming) {
        const current = seenRef.current.get(incoming.pc);
        const stored = loadSeen(incoming.pc, incoming.epoch)[incoming.pane];
        if (stored !== undefined && current?.epoch === incoming.epoch) saveSeen(incoming.pc, incoming.epoch, incoming.pane,
          Math.max(incoming.id, current.record[incoming.pane] ?? 0));
      }
      if (event.key === null || event.key.startsWith(SEEN_PREFIX)) setStorageRevision((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    const next = new Map<string, MachineSeen>();
    for (const machine of machines) {
      const epoch = machine.snapshot?.finish_epoch;
      if (!epoch) continue;
      const previousEpoch = epochs.current.get(machine.id);
      if (previousEpoch && previousEpoch !== epoch) cleanSeen([{ pc: machine.id, epoch: previousEpoch }]);
      epochs.current.set(machine.id, epoch);
      let record = loadSeen(machine.id, epoch);
      const previous = seenRef.current.get(machine.id);
      // Keep this page's views if storage is unavailable. Never rewrite a roster's marks:
      // a cap or another epoch's cleanup must not provoke a write-back loop.
      if (previous?.epoch === epoch) {
        for (const [pane, id] of Object.entries(previous.record)) {
          record = markSeen(record, pane, id);
        }
      }
      const pane = machine.state === "connected" && machine.id === selectedMachineId && pageVisible && paneInFront()
        ? machine.snapshot?.panes.find((pane) => pane.pane_id === presentedPaneId) : undefined;
      if (pane?.agent_status === "done" && !pane.background_wait && pane.finish_id !== undefined && pane.finish_id > 0) {
        record = markSeen(record, pane.pane_id, saveSeen(machine.id, epoch, pane.pane_id, pane.finish_id,
          conversationFinishEvidence.answer(seenKey(machine.id, epoch, pane.pane_id), pane.finish_id)));
      }
      next.set(machine.id, { epoch, record });
    }
    setSeen(next);
  }, [machines, selectedMachineId, presentedPaneId, paneInFront, pageVisible, storageRevision]);

  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => seqsByMachine.get(machineId) ?? NO_SEQS,
    status: (machineId, pane) => {
      const epoch = machines.find((machine) => machine.id === machineId)?.snapshot?.finish_epoch;
      const kept = seen.get(machineId);
      return shownStatus(pane, epoch && kept?.epoch === epoch ? kept.record : null);
    },
  }), [machines, seqsByMachine, seen]);
}
