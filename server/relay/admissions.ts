import type { DeviceConnection, DeviceRoute } from "../../shared/access.ts";

/** What a signed-in session tells of its way in (SignedInSessions.connections). */
export interface SessionLine {
  readonly route: DeviceRoute;
  /** the relay it came through, for `relay` */
  readonly relay?: string;
  /** when it signed in, ms since the epoch */
  readonly since: number;
  /** its mux: the keepalive's latest round trip, and a probe on demand (MuxEngine) */
  readonly mux: { readonly active: boolean; readonly rttMs: number | undefined; measure(): Promise<number | undefined> };
}

/** A check this soon after the last one answers with what that one measured. */
export const CHECK_GAP_MS = 5_000;

/** nearest first: of a device's sessions, the one it is best connected by is the one shown */
const NEAR: Record<DeviceRoute, number> = { lan: 0, tailscale: 1, relay: 2 };

/**
 * The signed-in sessions one PC serves, whichever way they came: the relay links (global and regional)
 * and the direct carriers count against the same limits, so no way in adds places of its own.
 */
export class SignedInSessions {
  private order = 0;
  private readonly entries = new Set<{ readonly deviceId: string; readonly order: number; readonly close: () => void; readonly line?: SessionLine }>();

  /** at most `max` at once, and `perDevice` for one device key, whose oldest gives way */
  constructor(private readonly max = 8, private readonly perDevice = 4) {}

  get size(): number { return this.entries.size; }

  /**
   * Counts a session that just signed in, and returns what ends its count (idempotent). With every place
   * taken it is closed itself; past its device's share, that device's oldest sessions are closed.
   */
  admit(deviceId: string, close: () => void, line?: SessionLine): () => void {
    const entry = { deviceId, order: ++this.order, close, ...(line ? { line } : {}) };
    this.entries.add(entry);
    const release = (): void => { this.entries.delete(entry); };
    // the device's own oldest give way first, so a device at its share always gets its new session in
    const own = [...this.entries].filter((other) => other.deviceId === deviceId).sort((a, b) => a.order - b.order);
    for (const oldest of own.slice(0, Math.max(0, own.length - this.perDevice))) {
      this.entries.delete(oldest);
      oldest.close();
    }
    if (this.entries.size > this.max) {
      release();
      close();
    }
    return release;
  }

  /** Each device with a session up, by its nearest way in (the newest of equals). */
  connections(): Map<string, DeviceConnection> {
    const best = new Map<string, { order: number; line: SessionLine }>();
    for (const { deviceId, order, line } of this.entries) {
      // a mux that ended counts until its socket closes, and is no way in meanwhile
      if (!line?.mux.active) continue;
      const held = best.get(deviceId);
      if (!held || NEAR[line.route] < NEAR[held.line.route] || (NEAR[line.route] === NEAR[held.line.route] && order > held.order)) best.set(deviceId, { order, line });
    }
    return new Map([...best].map(([deviceId, { line }]) => [deviceId, {
      route: line.route, ...(line.relay === undefined ? {} : { relay: line.relay }),
      rtt_ms: line.mux.rttMs === undefined ? null : Math.round(line.mux.rttMs), since: new Date(line.since).toISOString(),
    }]));
  }

  private checking: Promise<void> | undefined;
  private checkedAt = -Infinity;

  /**
   * Measures every session's round trip now; one that has not answered within `timeoutMs` keeps its last one.
   * Callers at once share one check, and one within CHECK_GAP_MS of the last measures nothing again.
   */
  check(timeoutMs: number, now = Date.now()): Promise<void> {
    if (this.checking) return this.checking;
    if (now - this.checkedAt < CHECK_GAP_MS) return Promise.resolve();
    this.checkedAt = now;
    this.checking = this.measureAll(timeoutMs).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async measureAll(timeoutMs: number): Promise<void> {
    let stop = (): void => {};
    const late = new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); stop = () => { clearTimeout(timer); resolve(); }; });
    await Promise.race([Promise.all([...this.entries].map((entry) => entry.line?.mux.measure())), late]);
    stop();
  }
}
