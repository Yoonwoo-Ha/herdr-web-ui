import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, rmSync, truncateSync } from "node:fs";
import type { PairingIntent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { DeviceMatch } from "../devices.ts";
import { writePrivateState } from "../private-state.ts";

export const MAX_PENDING_APPROVALS = 3;
export const PAIRING_WINDOW_MS = 10 * 60_000;

export const pairingWindowFs = { rmSync, truncateSync };

export type PairingDecision = { approved: true; by?: DeviceMatch } | { approved: false };

export type RemoteDecision = { outcome: "decided"; device_id: string } | { outcome: "gone" | "wrong_digits" };

interface Waiting {
  request: RelayPairingRequest & { intent: PairingIntent };
  expiresAt: number;
  key: string;
  deviceId: string;
  membersOnly: boolean;
  /** asked while this PC's own screen waited to be added to an account: decided on this PC only, never by a member */
  localOnly: boolean;
  vouched: boolean;
  choices: [string, string, string];
  finish: (decision: PairingDecision) => void;
}

function decoys(digits: string): [string, string, string] {
  const picked = new Set([digits]);
  while (picked.size < 3) picked.add(String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const choices = [...picked];
  for (let index = choices.length - 1; index > 0; index--) {
    const other = randomInt(0, index + 1);
    [choices[index], choices[other]] = [choices[other]!, choices[index]!];
  }
  return choices as [string, string, string];
}

export class RelayPairingApprovals {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(pairings: RelayPairingRequest[]) => void>();
  private readonly remoteListeners = new Set<(pairings: RemotePairingRequest[]) => void>();
  private windowUntil = 0;
  private localOnlyUntil = 0;
  private readonly path: string | undefined;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private cancelExpiry: (() => void) | undefined;
  private closeCount = 0;

  constructor(options: { path?: string; now?: () => number; setTimer?: (run: () => void, ms: number) => () => void } = {}) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.load();
  }

  get closes(): number { return this.closeCount; }

  /**
   * Writes the window closed once it has run out, so the file never holds a deadline a later start
   * could land inside (a clock that went back). Nothing waits on it: the timer does not keep the server up.
   */
  private watchExpiry(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    if (!this.path) return;
    const until = Math.max(this.windowUntil, this.localOnlyUntil);
    if (until === 0) return;
    this.cancelExpiry = this.setTimer(() => {
      this.cancelExpiry = undefined;
      if (this.now() < Math.max(this.windowUntil, this.localOnlyUntil)) { this.watchExpiry(); return; }
      this.windowUntil = 0;
      this.localOnlyUntil = 0;
      if (this.path && existsSync(this.path) && !this.save()) this.forget();
      // never longer than a window: a clock set far back would overflow the timer and fire it at once, over and over
    }, Math.min(PAIRING_WINDOW_MS, Math.max(0, until - this.now())));
  }

  /**
   * The saved window, when the file holds both deadlines: one without the other reads as closed, since
   * a window that came back without its local-only half would show what it takes to account members.
   * A deadline further ahead than a window opened now is not a window this clock opened (the clock ran
   * ahead when it was saved, or went back since): it reads as closed, never as a fresh ten minutes at
   * every start. Whatever is not open now is written back as closed, so a clock that later goes back
   * cannot reopen it.
   */
  private load(): void {
    if (!this.path) return;
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, "utf8")); } catch { return; }
    if (typeof saved !== "object" || saved === null) return;
    const { v, window_until: windowUntil, local_only_until: localOnlyUntil } = saved as Record<string, unknown>;
    if (v !== 1) return;
    if (typeof windowUntil !== "number" || !Number.isFinite(windowUntil)) return;
    if (typeof localOnlyUntil !== "number" || !Number.isFinite(localOnlyUntil)) return;
    const now = this.now();
    const latest = now + PAIRING_WINDOW_MS;
    if (windowUntil > now && windowUntil <= latest && localOnlyUntil <= latest) {
      this.windowUntil = windowUntil;
      this.localOnlyUntil = localOnlyUntil;
      this.watchExpiry();
      return;
    }
    if (windowUntil === 0 && localOnlyUntil === 0) return;
    if (!this.save()) this.forget();
  }

  private save(): boolean {
    if (!this.path) return true;
    try {
      writePrivateState(this.path, { v: 1, window_until: this.windowUntil, local_only_until: this.localOnlyUntil });
      return true;
    } catch (error) {
      console.warn(JSON.stringify({ event: "relay.pairing_window.save_failed", error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  openWindow(now = this.now(), options: { localOnly?: boolean } = {}): void {
    this.windowUntil = now + PAIRING_WINDOW_MS;
    if (options.localOnly) this.localOnlyUntil = now + PAIRING_WINDOW_MS;
    // a window that could not be saved still works until this process ends, but the file it could not
    // replace must not stand in for it at the next start (an older window without its local-only half)
    if (!this.save()) this.forget();
    this.watchExpiry();
  }

  private forget(): boolean {
    if (!this.path) return true;
    try { pairingWindowFs.rmSync(this.path, { force: true }); return true; } catch {}
    try { pairingWindowFs.truncateSync(this.path, 0); return true; }
    catch (error) {
      console.warn(JSON.stringify({ event: "relay.pairing_window.forget_failed", error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  }

  /**
   * Ends the window now: the owner stopped waiting, revoked every device, reset the relay identity or
   * turned the relay off. A comparison this PC's own windows were shown under that window ends
   * unapproved with it, so nothing asked before the close can be approved after it; a join shown to
   * account members only never depended on the window and stays. False when the saved window could
   * neither be rewritten nor taken away: it is closed for this process, but a restart could bring it back.
   */
  closeWindow(): boolean {
    const open = this.windowUntil !== 0 || this.localOnlyUntil !== 0;
    this.windowUntil = 0;
    this.localOnlyUntil = 0;
    this.closeCount += 1;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    for (const entry of [...this.waiting.values()]) if (!entry.membersOnly) entry.finish({ approved: false });
    if (!this.path || (!open && this.savedClosed())) return true;
    // a file that cannot be rewritten must not bring the window back at the next start: absent reads as closed
    return this.save() || this.forget();
  }

  private savedClosed(): boolean {
    if (!this.path || !existsSync(this.path)) return true;
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (typeof saved !== "object" || saved === null) return true;
      const { v, window_until: windowUntil, local_only_until: localOnlyUntil } = saved as Record<string, unknown>;
      return v !== 1 || typeof windowUntil !== "number" || typeof localOnlyUntil !== "number" || (windowUntil === 0 && localOnlyUntil === 0);
    } catch (error) {
      return error instanceof SyntaxError;
    }
  }

  localOnlyOpen(now = this.now()): boolean { return now < this.localOnlyUntil; }

  windowOpen(now = this.now()): boolean { return now < this.windowUntil; }

  list(now = this.now()): RelayPairingRequest[] {
    return [...this.waiting.values()].filter(({ membersOnly }) => !membersOnly)
      .map(({ request, expiresAt }) => ({ ...request, left_ms: Math.max(0, expiresAt - now) }));
  }

  private readonly joins: number[] = [];

  takeAccountJoin(now = Date.now()): boolean {
    while (this.joins.length && now - this.joins[0]! >= 60_000) this.joins.shift();
    if (this.joins.length >= 5) return false;
    this.joins.push(now);
    return true;
  }

  remoteList(): RemotePairingRequest[] {
    return [...this.waiting.values()].filter(({ localOnly }) => !localOnly).map(({ request, choices, key, vouched }) => ({
      id: request.id, label: request.label, intent: request.intent, choices, expires_at: request.expires_at, key,
      ...(vouched ? { vouched: true as const } : {}),
    }));
  }

  subscribe(listener: (pairings: RelayPairingRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.listeners.delete(listener); };
  }

  subscribeRemote(listener: (pairings: RemotePairingRequest[]) => void): () => void {
    this.remoteListeners.add(listener);
    listener(this.remoteList());
    return () => { this.remoteListeners.delete(listener); };
  }

  ask(label: string, digits: string, expiresAt: number, device: { intent: PairingIntent; key: string; deviceId: string; membersOnly?: boolean; localOnly?: boolean; vouched?: boolean } = { intent: "pc", key: "", deviceId: "" }): { decision: Promise<PairingDecision>; withdraw: () => void } | null {
    if (this.waiting.size >= MAX_PENDING_APPROVALS) return null;
    const id = randomBytes(8).toString("hex");
    const decided = Promise.withResolvers<PairingDecision>();
    const finish = (decision: PairingDecision) => {
      if (!this.waiting.delete(id)) return;
      this.changed();
      decided.resolve(decision);
    };
    const localOnly = !(device.membersOnly ?? false) && (device.localOnly ?? this.localOnlyOpen());
    this.waiting.set(id, { request: { id, label, digits, expires_at: new Date(expiresAt).toISOString(), intent: device.intent, ...(localOnly ? { local_only: true as const } : {}) },
      expiresAt, key: device.key, deviceId: device.deviceId, membersOnly: device.membersOnly ?? false, localOnly, vouched: device.vouched ?? false, choices: decoys(digits), finish });
    this.changed();
    return { decision: decided.promise, withdraw: () => finish({ approved: false }) };
  }

  decide(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    if (!entry || entry.membersOnly) return false;
    entry.finish(approved ? { approved: true } : { approved: false });
    return true;
  }

  decideRemote(id: string, approved: boolean, digits: string, by: DeviceMatch): RemoteDecision {
    const entry = this.waiting.get(id);
    if (!entry || entry.localOnly) return { outcome: "gone" };
    if (!approved) { entry.finish({ approved: false }); return { outcome: "decided", device_id: entry.deviceId }; }
    if (digits !== entry.request.digits) { entry.finish({ approved: false }); return { outcome: "wrong_digits" }; }
    entry.finish({ approved: true, by });
    return { outcome: "decided", device_id: entry.deviceId };
  }

  private changed(): void {
    const pairings = this.list();
    for (const listener of this.listeners) listener(pairings);
    const remote = this.remoteList();
    for (const listener of this.remoteListeners) listener(remote);
  }
}
