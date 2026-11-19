/** Probe results never imply account or version state. A sweep a minute while the list is shown, at most CHECK_PCS PCs each. */
import { checkPc, sweepOf } from "./pcStatus.ts";
import type { PcFinding, PcStatus } from "./pcStatus.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import type { RelaySocket } from "./channel.ts";
import { OFFLINE_AFTER_MS } from "../account/myPcs.ts";

const CHECK_PCS = 8;
const CHECK_AT_ONCE = 2;
/** a minute: one sweep's CHECK_PCS connections (up to two each, with the global relay's fallback) stay well under the relay's 30 a minute */
const CHECK_GAP_MS = 60_000;
const CHECK_KEY = "ovis-pc-check-at";
const CHECK_CURSOR_KEY = "ovis-pc-check-cursor";

function localStorageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function localStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch {}
}

interface QueuedCheck { readonly device: RelayDevice; readonly before: PcFinding | undefined; readonly settled: ReturnType<typeof Promise.withResolvers<void>> }

export function createPcSweep(store: RelayDeviceStore, view: { readonly active: () => boolean; readonly redraw: () => void }, options: { readonly probe?: typeof checkPc; readonly directSocket?: (url: string) => RelaySocket } = {}) {
  const pcStatus = new Map<string, PcStatus>();
  const probe = options.probe ?? checkPc;
  const directSocket = options.directSocket;
  const sockets = { relay: (url: string) => new WebSocket(url), ...(directSocket ? { direct: directSocket } : {}) };
  let lastCheck = -Infinity;
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let sweeping: Promise<void> | undefined;
  const queue: QueuedCheck[] = [];
  let workers = 0;
  /** PCs whose last check the relay turned away (a 429, a dropped socket): the next sweep checks them first */
  const refused = new Set<string>();
  /** answers past OFFLINE_AFTER_MS, which a refused check must not put back */
  const lapsed = new WeakSet<PcStatus>();
  const redraw = (): void => { if (view.active()) view.redraw(); };
  const cursorNow = (): number => Number(localStorageGet(CHECK_CURSOR_KEY) ?? "0");

  const enqueue = (device: RelayDevice, where: "front" | "back"): Promise<void> => {
    const shown = pcStatus.get(device.server_id);
    const before = shown?.kind === "checking" ? shown.previous : shown;
    const entry: QueuedCheck = { device, before, settled: Promise.withResolvers<void>() };
    // a re-check keeps what the last one found on screen until it finishes: an off PC must not read Ready meanwhile
    pcStatus.set(device.server_id, before === undefined ? { kind: "checking" } : { kind: "checking", previous: before });
    if (where === "front") queue.unshift(entry); else queue.push(entry);
    return entry.settled.promise;
  };
  const probeNext = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const found = await probe(next.device, sockets).catch((): PcStatus => ({ kind: "offline", reason: "relay" }));
      const serverId = next.device.server_id;
      // a relay that turned this device away, or that it could not reach, said nothing of the PC: the row keeps what it said
      // until a second such check in a row
      if (found.kind === "offline" && found.reason !== "pc" && !refused.has(serverId)) {
        refused.add(serverId);
        if (next.before === undefined || lapsed.has(next.before)) pcStatus.delete(serverId); else pcStatus.set(serverId, next.before);
      } else {
        refused.delete(serverId);
        pcStatus.set(serverId, found);
      }
      if (found.kind === "answered") setTimeout(() => {
        lapsed.add(found);
        const shown = pcStatus.get(serverId);
        if (shown === found) pcStatus.delete(serverId);
        else if (shown?.kind === "checking" && shown.previous === found) pcStatus.set(serverId, { kind: "checking" });
        else return;
        redraw();
      }, OFFLINE_AFTER_MS);
      redraw();
      next.settled.resolve();
    }
  };
  const drain = (): void => {
    for (let spare = Math.min(CHECK_AT_ONCE - workers, queue.length); spare > 0; spare -= 1) {
      workers += 1;
      void probeNext().finally(() => { workers -= 1; });
    }
  };

  const later = (wait: number): void => {
    deferred ??= setTimeout(() => {
      deferred = undefined;
      if (view.active() && globalThis.document?.visibilityState !== "hidden") void checkPcs(); else later(CHECK_GAP_MS);
    }, wait);
  };
  const checkPcs = async (): Promise<void> => {
    if (sweeping) { void sweeping.then(checkPcs); return; }
    const stored = Number(localStorageGet(CHECK_KEY) ?? "");
    const wait = CHECK_GAP_MS - (Date.now() - Math.max(lastCheck, Number.isFinite(stored) ? stored : -Infinity));
    if (wait > 0) {
      later(wait);
      redraw();
      return;
    }
    // the work starts here, so the page is asked here: a timer or a sweep waited on may come due after it was hidden
    if (globalThis.document?.visibilityState === "hidden") { later(CHECK_GAP_MS); return; }
    lastCheck = Date.now();
    localStorageSet(CHECK_KEY, String(lastCheck));
    later(CHECK_GAP_MS);
    sweeping = sweepPcs().finally(() => { sweeping = undefined; });
    await sweeping;
  };
  const sweepPcs = async (): Promise<void> => {
    const cursor = cursorNow();
    const devices = await store.list();
    const again = sweepOf(devices, 0, devices.length).filter((device) => refused.has(device.server_id)).slice(0, CHECK_PCS);
    const turn = CHECK_PCS - again.length;
    const saved = [...again, ...sweepOf(devices, cursor, turn).filter((device) => !again.includes(device))]
      .filter((device) => pcStatus.get(device.server_id)?.kind !== "checking");
    localStorageSet(CHECK_CURSOR_KEY, String(cursor + turn));
    const settled = saved.map((device) => enqueue(device, "back"));
    redraw();
    drain();
    await Promise.all(settled);
  };
  const checkOne = async (serverId: string): Promise<void> => {
    const waiting = queue.findIndex((entry) => entry.device.server_id === serverId);
    if (waiting >= 0) {
      const [entry] = queue.splice(waiting, 1);
      if (entry) { queue.unshift(entry); return entry.settled.promise; }
    }
    if (pcStatus.get(serverId)?.kind === "checking") return;
    const device = await store.get(serverId);
    if (device === undefined) return;
    const settled = enqueue(device, "front");
    redraw();
    drain();
    await settled;
  };

  return { status: pcStatus, check: checkPcs, checkOne };
}
