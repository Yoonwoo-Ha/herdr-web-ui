/**
 * Web Push: pane alerts that reach a device even when Ovis is closed there.
 *
 * The browser hands us a subscription (an endpoint on its vendor's push service plus
 * the keys to encrypt for it); we POST encrypted payloads there, signed with our VAPID
 * key. Both halves persist in the state dir (default ~/.config/ovis):
 * - vapid.json: every subscription is bound to this key pair. Regenerating it silently
 *   orphans every subscribed device, so a malformed file is an error, never a rotation.
 * - push-subscriptions.json: survives restarts, so a reboot does not unsubscribe phones.
 *   A 404/410 from a push service means the device dropped it; the record is deleted.
 * - push-retired.json: the endpoint is also remembered, as a hash with the owner it was retired for
 *   (`RETIRED_LIMIT`), so a restart does not forget it and a revocation finds it: a browser can keep handing over a subscription its push
 *   service retired, and registering it again would only fail the next push, so it is refused as
 *   `subscription_gone` and the device subscribes anew (#1038). A mark has no time limit: one that
 *   expired would let any device that knows the endpoint register it as its own (#2012). Only its
 *   owner's revocation removes it, or a thousand later retirements.
 * - push-keys.json (PUSH_EXTRA_KEYS): key pairs other than vapid.json's, each with the endpoints
 *   made for it. Only state-merge.ts writes it, for subscriptions taken over from the other state
 *   dir of an install that had two: each is signed with the key it was made for until its device
 *   subscribes again with this server's key (src/lib/push.ts does when it next opens).
 * - push-delivery.json: how the last push to each subscription went (`last_success_at`,
 *   `last_failure_at`, `last_failure`), by endpoint hash, with the owner and a hash of the keys it
 *   was recorded for. A device reads its own record through POST /api/push/status once it proves
 *   both, so a subscription its push service retired can still say why alerts stopped (#1039).
 *   Bounded like the retired list, and expired (`DELIVERY_TTL_MS`) on every read and write; an explicit unsubscribe or
 *   the device's revocation removes it together with the endpoint's retired mark.
 *
 * Requests are built by web-push's generateRequestDetails (RFC 8291 aes128gcm + RFC
 * 8292 VAPID) and sent with fetch; its sendNotification path goes through node:https
 * and https-proxy-agent, which Bun does not need.
 *
 * An alert waits before it goes out, and a change of the pane's status meanwhile calls it
 * off: a question answered at the desk, or a finish followed by the next prompt, never
 * reaches the phone. herdr says nothing of whether anyone is at the PC, so a change that
 * quick is taken for someone being there (as Claude Code waits ~6 s on a permission
 * prompt and ~60 s after a reply before it notifies). A question waits `short`; a finish
 * waits `long`, and only one after a turn that worked `longTurn` or more is worth it,
 * unless the device asked for every finish (which then waits `short`).
 *
 * No device gets an alert while a window of the app is in use somewhere (`inUse`: a
 * connected page that is visible and has focus, which says so over its WebSocket): the
 * person is at a screen that already shows the change (#751). It is asked when an alert
 * would go out, so a window brought forward while the alert waits still holds it back.
 *
 * A pane on the shared mute list (`muted`, shared/preferences.ts `muted_panes`) gets no alert
 * on any device: none is scheduled for it, one already waiting is called off when the list
 * changes (`mutesChanged`), and the list is asked again right before a waiting one goes out.
 * Its status is tracked all the same, so an unmute tells only what changes after it.
 *
 * Each device also says which kinds of alert it wants (shared/notify-policy.ts AlertPrefs: a
 * question, a permission, a finish, an error) and which PCs it hears nothing of (`pcs_off`, by the
 * PC's name, which every server that device subscribes to knows its own PC by). The choice is made
 * here, not on the device: a web push the device received has to be shown (iOS takes the
 * subscription away from a page that shows none), and the phone app's relay forwards what it gets.
 * Every alert names its `kind`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import webpush from "web-push";

import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, DevicePairedEvent, HerdrPane, InteractivePrompt, PushAction, PushDeliveryFailure, PushPayload, PushSubscriptionStatus } from "../shared/protocol.ts";
import {
  type AlertKind,
  type AlertPrefs,
  alertKindAllowed,
  alertPcAllowed,
  blockedAlertKind,
  DEFAULT_ALERTS,
  ENDED_NOTIFICATION_BODY,
  ERROR_NOTIFICATION_BODY,
  PERMISSION_NOTIFICATION_BODY,
  paneNotificationTag,
  pushPaneTitle,
  parseAlerts,
  shouldNotifyStatus,
  statusNotificationBody,
} from "../shared/notify-policy.ts";
import { cleanLine, isDivider, parsedByPublicPrompt } from "./dialogs/shared.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { isLoopbackHost } from "./access.ts";
import type { AlertWebhook } from "./alert-webhook.ts";
import { writePrivateState } from "./private-state.ts";

const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const PROMPT_LOOKUP_MS = 3_000;
const ACTION_LABEL_MAX = 24;
const PROMPT_SUMMARY_LINES = 4;
const PROMPT_SUMMARY_MAX = 300;
const DEFAULT_SUBJECT = "https://github.com/devswha/ovis";
export const RELAY_MAX_BODY_BYTES = 3015;
const RELAY_ENDPOINT_PATH = /^\/v1\/push\/[^/]+$/;
const RETIRED_LIMIT = 1000;
export const PUSH_EXTRA_KEYS = "push-keys.json";

type VapidKeys = { publicKey: string; privateKey: string };
const DELIVERY_LIMIT = RETIRED_LIMIT;
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AlertTiming {
  short: number;
  long: number;
  longTurn: number;
}
export const DEFAULT_ALERT_TIMING: AlertTiming = { short: 10_000, long: 60_000, longTurn: 60_000 };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  alerts?: AlertPrefs;
  device_id?: string | null;
  browser_keys?: string[];
}

export type PushDelivery = { ok: true } | { ok: false; status: number | null; gone: boolean };

interface DeliveryRecord {
  hash: string;
  owner: string | null;
  keys: string;
  success_at: number | null;
  failure_at: number | null;
  failure: PushDeliveryFailure | null;
  at: number;
}

interface RetiredMark {
  at: number;
  owner?: string | null;
}

export function classifyFailure(status: number | null): PushDeliveryFailure {
  if (status === null) return "network";
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403) return "key-mismatch";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "rejected";
}

export interface PushService {
  publicKey(): string;
  parse(value: unknown): PushSubscriptionRecord | null;
  subscribe(subscription: PushSubscriptionRecord, alerts?: AlertPrefs, deviceId?: string | null, browserKeys?: readonly string[]): void;
  revokeDevice(id: string): void;
  unsubscribe(endpoint: string): void;
  retired(endpoint: string): boolean;
  sendTest(endpoint: string): Promise<PushDelivery | null>;
  status(subscription: PushSubscriptionRecord, owner: string | null | undefined): PushSubscriptionStatus | null;
  devicePaired(event: DevicePairedEvent, origin?: readonly string[]): Promise<void>;
  seed(panes: readonly HerdrPane[], machineId?: string, machineName?: string, serverId?: string): void;
  resync(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  onStatus(paneId: string, status: AgentStatus, machineId?: string): Promise<void>;
  onEnded(paneId: string, machineId?: string): Promise<void>;
  onFailed(paneId: string, machineId?: string): Promise<void>;
  mutesChanged(): void;
  settled(): Promise<void>;
}

export interface PushServiceOptions {
  stateDir: string;
  subject?: string;
  lookupPane?: (paneId: string) => Promise<{ title: string; agent_kind?: string } | undefined>;
  lookupPrompt?: (paneId: string, signal: AbortSignal) => Promise<{ prompt: InteractivePrompt; screen?: string } | null>;
  canAnswer?: (deviceId: string | null | undefined) => boolean;
  localName?: string;
  serverId?: () => string | undefined;
  timing?: Partial<AlertTiming>;
  now?: () => number;
  canDeliver?: (deviceId: string | null | undefined) => boolean;
  inUse?: () => boolean;
  muted?: (machineId: string, paneId: string) => boolean;
  loopbackHttp?: boolean;
  onAlertDelivered?: () => void;
  webhook?: Pick<AlertWebhook, "prefs" | "wants" | "generation" | "send">;
}

export { defaultStateDir } from "./update-state.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function decodedLength(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1;
  return Buffer.from(value, "base64url").length;
}

/**
 * The form an endpoint is retired in: the URL as WHATWG serializes it (host in lowercase, no default
 * port, no dot segments), without its fragment, which never reaches the push service. Those spellings
 * of a retired endpoint are then that same endpoint (#2012); a query string, percent-encoding and a
 * trailing slash are kept as they are, since a push service may tell them apart (WNS keeps its token in
 * the query). What does not parse is returned as it is. Only the retired check uses it: a subscription,
 * its key pair (push-keys.json), its history and state-merge.ts's records stay under the spelling the
 * browser handed over, so nothing stored before has to be found under another one.
 */
export function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.hash = "";
    return url.href;
  } catch {
    return endpoint;
  }
}

export function parseSubscription(value: unknown, options: { loopbackHttp?: boolean } = {}): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    // https only. A browser never hands over an http: endpoint (push is https by
    // definition), so one is never a subscription: it is only the shape that turns this
    // server into a POST from inside the user's network at a host no browser page could
    // reach — a link-local metadata address, a router admin page, another VLAN.
    // Loopback is no exception: a watch device would make every agent alert a POST to a
    // local service. Only a push service made for the tests' fake (push.fake.ts, which runs
    // on loopback http) passes `loopbackHttp`, through createServer's `pushLoopbackHttp`.
    const loopbackHttp = options.loopbackHttp === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) return null;
  } catch {
    return null;
  }
  // p256dh is an uncompressed P-256 point (65 bytes), auth a 16-byte secret
  if (decodedLength(keys?.p256dh) !== 65 || decodedLength(keys?.auth) !== 16) return null;
  return { endpoint, keys: { p256dh: keys!.p256dh as string, auth: keys!.auth as string } };
}

export function statusMessage(paneId: string, title: string, status: AgentStatus, kind: AlertKind = status === "blocked" ? "input" : "done"): PushPayload {
  return { pane_id: paneId, title, body: kind === "permission" ? PERMISSION_NOTIFICATION_BODY : statusNotificationBody(status), tag: paneNotificationTag(paneId), kind };
}

export function promptActions(prompt: InteractivePrompt | null, screen?: string): PushAction[] | null {
  if (!prompt || (prompt.kind !== "approval" && prompt.kind !== "question")) return null;
  if (screen === undefined || !shownWhole(prompt, screen) || parsedByPublicPrompt.get(prompt)?.ompQuestionCut) return null;
  if (prompt.multi_select || prompt.custom_option_index !== null || prompt.queued !== undefined || prompt.checks_with_text) return null;
  if (prompt.steps !== undefined || prompt.answers !== undefined || prompt.can_step_back || prompt.can_step_next) return null;
  if (prompt.options.length === 0 || prompt.options.length > 2) return null;
  if (prompt.options.some((option) => option.label.trim() === "" || option.label.length > ACTION_LABEL_MAX || option.description)) return null;
  return prompt.options.map((option, index) => ({ option_index: index, label: option.label.trim() }));
}

export function shownWhole(prompt: InteractivePrompt, screen: string): boolean {
  const lines = screen.split("\n").map(cleanLine).filter((line) => line !== "");
  const body = (prompt.body ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const question = prompt.question.trim();
  const at = lines.lastIndexOf(question);
  if (at < 0) return false;
  if (!prompt.options.every((option, index) => lines[at + 1 + index]?.includes(option.label.trim()))) return false;
  const start = at - body.length;
  if (start < 1 || !body.every((line, index) => lines[start + index] === line)) return false;
  const over = lines[start - 1]!;
  return over === prompt.title.trim() || isDivider(over);
}

/**
 * What an alert with buttons says: the prompt's title, its question and what it shows (the command, the file).
 * Null when that does not fit an alert whole: a button must not approve what the alert cut off.
 */
export function promptSummary(prompt: InteractivePrompt): string | null {
  const body = (prompt.body ?? "").split("\n");
  if (body.length > PROMPT_SUMMARY_LINES) return null;
  const head = prompt.title.trim() === prompt.question.trim() ? [prompt.question] : [prompt.title, prompt.question];
  const text = [...head, ...body].map((line) => line.trim()).filter((line) => line !== "").join("\n");
  return text.length > PROMPT_SUMMARY_MAX ? null : text;
}

export function endedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ENDED_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "ended" };
}

export function failedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ERROR_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "error" };
}

interface Scheduled {
  key: string;
  machineId: string;
  paneId: string;
  silenced: boolean;
  cancel: () => void;
}

export function createPushService(options: PushServiceOptions): PushService {
  const vapidPath = join(options.stateDir, "vapid.json");
  const subscriptionsPath = join(options.stateDir, "push-subscriptions.json");
  const subject = options.subject ?? process.env["OVIS_PUSH_SUBJECT"] ?? DEFAULT_SUBJECT;

  let vapid: { publicKey: string; privateKey: string } | null = null;
  let subscriptions: Map<string, PushSubscriptionRecord> | null = null;
  let stale = false;
  const lastStatus = new Map<string, AgentStatus>();
  const titles = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const kinds = new Map<string, string>();
  const pcNames = new Map<string, string>();
  const pcIds = new Map<string, string>();
  const pcKeys = (machineId: string): [string, string | undefined] => machineId === "local"
    ? [options.localName ?? hostname(), options.serverId?.()]
    : [pcNames.get(machineId) ?? machineId, pcIds.get(machineId)];
  const retiredPath = join(options.stateDir, "push-retired.json");
  let retiredEndpoints: Map<string, RetiredMark> | null = null;
  const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");
  const retiredKey = (endpoint: string): string => endpointHash(normalizeEndpoint(endpoint));
  const isRetired = (endpoint: string): boolean => retiredStore().has(retiredKey(endpoint)) || retiredStore().has(endpointHash(endpoint));
  let extraKeys: Map<string, VapidKeys> | null = null;

  function keysFor(endpoint: string): VapidKeys {
    if (extraKeys === null) {
      extraKeys = new Map();
      const path = join(options.stateDir, PUSH_EXTRA_KEYS);
      try {
        const stored = readJson(path) as { keys?: unknown } | undefined;
        for (const entry of Array.isArray(stored?.keys) ? stored.keys as unknown[] : []) {
          const { publicKey, privateKey, endpoints } = (entry ?? {}) as { publicKey?: unknown; privateKey?: unknown; endpoints?: unknown };
          if (typeof publicKey !== "string" || typeof privateKey !== "string" || !Array.isArray(endpoints)) continue;
          for (const at of endpoints) if (typeof at === "string") extraKeys.set(at, { publicKey, privateKey });
        }
      } catch (error) {
        console.error(`Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "not JSON"}); subscriptions taken over from another state dir get no alerts until their devices subscribe again`);
      }
    }
    return extraKeys.get(endpoint) ?? keys();
  }
  const keyFingerprint = (keys: PushSubscriptionRecord["keys"]): string => createHash("sha256").update(`${keys.p256dh}.${keys.auth}`).digest("base64url");
  const deliveryPath = join(options.stateDir, "push-delivery.json");
  let deliveries: Map<string, DeliveryRecord> | null = null;

  function keys(): { publicKey: string; privateKey: string } {
    if (vapid) return vapid;
    const stored = readJson(vapidPath) as { publicKey?: unknown; privateKey?: unknown } | undefined;
    if (stored === undefined) {
      // cached only once on disk: a key no restart would find must never sign a subscription
      const created = webpush.generateVAPIDKeys();
      writePrivateState(vapidPath, created);
      vapid = created;
    } else if (typeof stored.publicKey === "string" && typeof stored.privateKey === "string") {
      vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      throw new Error(`${vapidPath} is malformed; restore it or delete it (every device then re-subscribes)`);
    }
    return vapid;
  }

  function store(): Map<string, PushSubscriptionRecord> {
    if (subscriptions) return subscriptions;
    const stored = readJson(subscriptionsPath);
    subscriptions = new Map();
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        const parsed = parseSubscription(entry, options);
        if (parsed && isRetired(parsed.endpoint)) {
          stale = true;
          continue;
        }
        const alerts = (entry as { alerts?: unknown } | null)?.alerts;
        if (parsed) {
          const owner = (entry as PushSubscriptionRecord).device_id;
          const browser = (entry as { browser_keys?: unknown }).browser_keys;
          const browserKeys = Array.isArray(browser) ? browser.filter((key): key is string => typeof key === "string" && /^[0-9a-f]{32}$/.test(key)).slice(0, 8) : [];
          subscriptions.set(parsed.endpoint, { ...parsed, ...(alerts === undefined ? {} : { alerts: parseAlerts(alerts) }),
            ...(owner === null || typeof owner === "string" ? { device_id: owner } : {}),
            ...(browserKeys.length > 0 ? { browser_keys: browserKeys } : {}) });
        }
      }
    }
    return subscriptions;
  }

  function expire<T>(entries: Map<string, T>, at: (entry: T) => number, ttl: number): boolean {
    const cutoff = (options.now ?? Date.now)() - ttl;
    let changed = false;
    for (const [key, entry] of entries) {
      if (at(entry) > cutoff) continue;
      entries.delete(key);
      changed = true;
    }
    return changed;
  }

  function rewriteRetired(): void {
    try {
      persistRetired();
    } catch (error) {
      retiredUnwritten = true;
      console.error(`Cannot write ${retiredPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); retired endpoints are kept in memory until a write succeeds`);
    }
  }
  let retiredUnwritten = false;

  function persistRetired(): void {
    writeJsonPrivate(retiredPath, [...retiredStore()].map(([hash, { at, owner }]) => ({ hash, at, ...(owner === undefined ? {} : { owner }) })));
    retiredUnwritten = false;
  }

  function retiredStore(): Map<string, RetiredMark> {
    if (retiredEndpoints) return retiredEndpoints;
    retiredEndpoints = new Map();
    let stored: unknown;
    try {
      stored = readJson(retiredPath);
    } catch {
      return retiredEndpoints;
    }
    if (!Array.isArray(stored)) return retiredEndpoints;
    for (const entry of stored.slice(-RETIRED_LIMIT)) {
      const { hash, at, owner } = (entry ?? {}) as { hash?: unknown; at?: unknown; owner?: unknown };
      if (typeof hash !== "string" || typeof at !== "number") continue;
      retiredEndpoints.set(hash, { at, ...(owner === null || typeof owner === "string" ? { owner } : {}) });
    }
    if (retiredEndpoints.size !== stored.length) {
      rewriteRetired();
    }
    return retiredEndpoints;
  }

  function persist(next: Map<string, PushSubscriptionRecord>): void {
    writePrivateState(subscriptionsPath, [...next.values()]);
    subscriptions = next;
    stale = false;
  }

  function without(remove: (endpoint: string, subscription: PushSubscriptionRecord) => boolean): Map<string, PushSubscriptionRecord> | null {
    const next = new Map([...store()].filter(([endpoint, subscription]) => !remove(endpoint, subscription)));
    return next.size === store().size ? null : next;
  }

  const FAILURES: readonly PushDeliveryFailure[] = ["gone", "key-mismatch", "rejected", "throttled", "server", "network"];

  function deliveryStore(): Map<string, DeliveryRecord> {
    if (deliveries) {
      if (expire(deliveries, (record) => record.at, DELIVERY_TTL_MS)) persistDeliveries();
      return deliveries;
    }
    deliveries = new Map();
    let stored: unknown;
    try {
      stored = readJson(deliveryPath);
    } catch {
      return deliveries;
    }
    if (!Array.isArray(stored)) return deliveries;
    const cutoff = (options.now ?? Date.now)() - DELIVERY_TTL_MS;
    for (const entry of stored.slice(-DELIVERY_LIMIT)) {
      const { hash, owner, keys, success_at, failure_at, failure, at } = (entry ?? {}) as Partial<Record<keyof DeliveryRecord, unknown>>;
      const date = (value: unknown): value is number => typeof value === "number" && Number.isFinite(new Date(value).getTime());
      const time = (value: unknown): value is number | null => value === null || date(value);
      if (typeof hash !== "string" || !(owner === null || typeof owner === "string") || typeof keys !== "string" || !date(at) || at <= cutoff) continue;
      if (!time(success_at) || !time(failure_at) || !(failure === null || FAILURES.includes(failure as PushDeliveryFailure))) continue;
      deliveries.set(hash, { hash, owner, keys, success_at, failure_at, failure: failure as PushDeliveryFailure | null, at });
    }
    if (deliveries.size !== stored.length) persistDeliveries();
    return deliveries;
  }

  function persistDeliveries(): void {
    try {
      writeJsonPrivate(deliveryPath, [...deliveryStore().values()]);
    } catch (error) {
      console.error(`Cannot write ${deliveryPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); push health is kept in memory until a write succeeds`);
    }
  }

  function identityOf(subscription: PushSubscriptionRecord): { hash: string; owner: string | null | undefined; keys: string } {
    return { hash: endpointHash(subscription.endpoint), owner: subscription.device_id, keys: keyFingerprint(subscription.keys) };
  }

  function stillOwns(identity: ReturnType<typeof identityOf>, endpoint: string): boolean {
    const current = store().get(endpoint);
    return current !== undefined && current.device_id === identity.owner && keyFingerprint(current.keys) === identity.keys;
  }

  function recordDelivery(identity: ReturnType<typeof identityOf>, failure: PushDeliveryFailure | null): void {
    if (identity.owner === undefined) return;
    const records = deliveryStore();
    const previous = records.get(identity.hash);
    const kept = previous && previous.owner === identity.owner && previous.keys === identity.keys ? previous : null;
    const now = (options.now ?? Date.now)();
    records.delete(identity.hash);
    records.set(identity.hash, {
      hash: identity.hash, owner: identity.owner, keys: identity.keys,
      success_at: failure === null ? now : kept?.success_at ?? null,
      failure_at: failure === null ? kept?.failure_at ?? null : now,
      failure: failure === null ? kept?.failure ?? null : failure,
      at: now,
    });
    while (records.size > DELIVERY_LIMIT) records.delete(records.keys().next().value!);
    persistDeliveries();
  }

  function forgetDeliveries(keep: (record: DeliveryRecord) => boolean): void {
    const records = deliveryStore();
    let changed = false;
    for (const [hash, record] of records) {
      if (keep(record)) continue;
      records.delete(hash);
      changed = true;
    }
    if (changed) persistDeliveries();
  }

  const iso = (at: number | null): string | null => at === null ? null : new Date(at).toISOString();

  async function deliver(subscription: PushSubscriptionRecord, message: PushPayload, urgency: "normal" | "high"): Promise<PushDelivery> {
    if (options.canDeliver && !options.canDeliver(subscription.device_id)) return { ok: false, status: null, gone: false };
    const identity = identityOf(subscription);
    const { publicKey, privateKey } = keysFor(subscription.endpoint);
    const request = (payload: PushPayload) => webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency,
      contentEncoding: "aes128gcm",
    });
    const toRelay = message.pane_id !== null && RELAY_ENDPOINT_PATH.test(new URL(subscription.endpoint).pathname);
    const serverId = toRelay ? options.serverId?.() : undefined;
    const named: PushPayload | null = toRelay ? { ...message, endpoint: subscription.endpoint, ...(serverId ? { server_id: serverId } : {}) } : null;
    let details = request(named ?? message);
    if (named && details.body.length > RELAY_MAX_BODY_BYTES) details = request(message);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value);
    let status: number | null = null;
    try {
      const response = await fetch(details.endpoint, {
        method: details.method,
        headers,
        body: new Uint8Array(details.body),
        // a push service answers, it never redirects: following one would send the alert to
        // wherever the endpoint points, past the https-only check (a local service, over http)
        redirect: "error",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (response.ok) {
        if (stillOwns(identity, subscription.endpoint)) recordDelivery(identity, null);
        return { ok: true };
      }
      status = response.status;
    } catch {
    }
    const gone = status === 404 || status === 410;
    if (!stillOwns(identity, subscription.endpoint)) return { ok: false, status, gone };
    recordDelivery(identity, classifyFailure(status));
    if (gone) {
      const retired = retiredStore();
      const mark = retiredKey(subscription.endpoint);
      const previous = retired.get(mark);
      const shared = (previous !== undefined && previous.owner === undefined)
        || [...store().values()].some((held) => held.endpoint !== subscription.endpoint && retiredKey(held.endpoint) === mark && held.device_id !== identity.owner);
      const owner = shared ? undefined : identity.owner;
      retired.delete(mark);
      retired.set(mark, { at: (options.now ?? Date.now)(), ...(owner === undefined ? {} : { owner }) });
      if (retired.size > RETIRED_LIMIT) retired.delete(retired.keys().next().value!);
      rewriteRetired();
      const next = without((endpoint) => endpoint === subscription.endpoint);
      if (next) {
        try {
          persist(next);
        } catch (error) {
          subscriptions = next;
          stale = true;
          console.error(`Cannot write ${subscriptionsPath} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); the retired subscription is dropped in memory until a write succeeds`);
        }
      }
    } else {
      console.error(`web push to ${new URL(subscription.endpoint).host} failed: ${status ?? "no response"}`);
    }
    return { ok: false, status, gone };
  }

  async function broadcast(message: PushPayload, urgency: "normal" | "high", to: readonly PushSubscriptionRecord[] = [...store().values()], alert = false): Promise<void> {
    await Promise.all(
      to.map((subscription) =>
        deliver(subscription, message, urgency).then((delivery) => {
          if (alert && delivery.ok) options.onAlertDelivered?.();
        }, (error: unknown) => {
          console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );
  }

  function where(key: string, machineId: string): Pick<PushPayload, "machine_id" | "workspace_id"> {
    const workspace = workspaces.get(key);
    return { ...(machineId === "local" ? {} : { machine_id: machineId }), ...(workspace ? { workspace_id: workspace } : {}) };
  }

  async function lookUp(key: string, machineId: string, paneId: string): Promise<{ title: string; agentKind: string | undefined }> {
    if (machineId === "local") {
      try {
        const fresh = await options.lookupPane?.(paneId);
        if (fresh?.title) return { title: fresh.title, agentKind: fresh.agent_kind };
      } catch {
      }
    }
    return { title: titles.get(key) ?? paneId, agentKind: kinds.get(key) };
  }

  async function readActions(paneId: string): Promise<{ promptId: string; body: string; actions: PushAction[] } | null> {
    if (!options.lookupPrompt) return null;
    const signal = AbortSignal.timeout(PROMPT_LOOKUP_MS);
    try {
      const read = await Promise.race([
        options.lookupPrompt(paneId, signal),
        new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
      const prompt = read?.prompt ?? null;
      const actions = promptActions(prompt, read?.screen);
      const body = prompt && actions ? promptSummary(prompt) : null;
      return prompt && actions && body !== null ? { promptId: prompt.id, body, actions } : null;
    } catch {
      return null;
    }
  }

  const timing = { ...DEFAULT_ALERT_TIMING, ...options.timing };
  const now = options.now ?? Date.now;
  const turnStart = new Map<string, number>();
  const waiting = new Map<string, Scheduled>();
  const unsent = new Set<Scheduled>();
  const inFlight = new Set<Promise<void>>();

  const changes = new Map<string, number>();

  function tellWebhook(key: string, machineId: string, paneId: string, message: PushPayload, generation?: number): void {
    const workspace = workspaces.get(key);
    const at = epochs.get(key) ?? 0;
    hooked.set(key, { machineId, paneId });
    options.webhook?.send({
      kind: message.kind ?? "input", title: message.title, body: message.body, pane_id: paneId,
      current: () => (epochs.get(key) ?? 0) === at && !muted(machineId, paneId) && options.inUse?.() !== true,
      ...(machineId === "local" ? { pc: pcKeys(machineId)[0] } : { machine_id: machineId }),
      ...(workspace ? { workspace_id: workspace } : {}),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  const epochs = new Map<string, number>();
  const hooked = new Map<string, { machineId: string; paneId: string }>();
  const bump = (key: string): void => { epochs.set(key, (epochs.get(key) ?? 0) + 1); };

  function callOff(key: string): void {
    changes.set(key, (changes.get(key) ?? 0) + 1);
    bump(key);
    waiting.get(key)?.cancel();
    waiting.delete(key);
  }

  const muted = (machineId: string, paneId: string): boolean => options.muted?.(machineId, paneId) === true;
  // A web push the device received has to be shown (iOS takes the subscription away from a page
  // that shows none), so a device's alert choices are applied here, not on the device.
  const wants = (subscription: PushSubscriptionRecord, kind: AlertKind, machineId: string): boolean => {
    const prefs = subscription.alerts ?? DEFAULT_ALERTS;
    return alertKindAllowed(prefs, kind) && alertPcAllowed(prefs, ...pcKeys(machineId));
  };

  function delayFor(prefs: AlertPrefs, status: AgentStatus, worked: number | null): number | null {
    if (status === "blocked") return alertKindAllowed(prefs, "input") || alertKindAllowed(prefs, "permission") ? timing.short : null;
    if (status !== "done" || prefs.done === "off") return null;
    if (prefs.done === "always") return timing.short;
    return worked === null || worked >= timing.longTurn ? timing.long : null;
  }

  function schedule(key: string, machineId: string, paneId: string, groups: Map<number, PushSubscriptionRecord[]>, send: (to: PushSubscriptionRecord[], silenced: () => boolean, delay: number) => Promise<void>): void {
    const cancels: Array<() => void> = [];
    let remaining = groups.size;
    let open = groups.size;
    for (const [delay, to] of groups) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fired = false;
      const done = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          fired = true;
          remaining -= 1;
          if (remaining === 0 && waiting.get(key) === entry) waiting.delete(key);
          send(to, () => entry.silenced, delay).catch((error: unknown) => {
            console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(resolve);
        }, delay);
        cancels.push(() => { if (fired) return; clearTimeout(timer); resolve(); });
      });
      inFlight.add(done);
      void done.finally(() => {
        inFlight.delete(done);
        open -= 1;
        if (open === 0) unsent.delete(entry);
      });
    }
    const entry: Scheduled = { key, machineId, paneId, silenced: false, cancel: () => { for (const cancel of cancels) cancel(); } };
    waiting.set(key, entry);
    unsent.add(entry);
  }

  return {
    publicKey: () => keys().publicKey,
    parse: (value) => parseSubscription(value, options),

    subscribe(subscription, alerts, deviceId, browserKeys = []) {
      const previous = store().get(subscription.endpoint);
      const kept = alerts ?? previous?.alerts;
      const merged = [...new Set([...(previous?.browser_keys ?? []), ...browserKeys])].slice(-8);
      const browser = merged.length > 0 ? merged : undefined;
      const next = new Map(store());
      next.set(subscription.endpoint, { ...subscription, ...(kept === undefined ? {} : { alerts: kept }),
        ...(deviceId === undefined ? {} : { device_id: deviceId }),
        ...(browser === undefined ? {} : { browser_keys: browser }) });
      if (retiredUnwritten) persistRetired();
      persist(next);
      const identity = identityOf({ ...subscription, device_id: deviceId });
      forgetDeliveries((record) => record.hash !== identity.hash || (identity.owner !== undefined && record.owner === identity.owner && record.keys === identity.keys));
    },

    revokeDevice(id) {
      persist(without((_, subscription) => subscription.device_id === id || subscription.device_id === undefined) ?? new Map(store()));
      const retired = retiredStore();
      let unmarked = false;
      for (const [hash, mark] of retired) {
        if (mark.owner !== id) continue;
        retired.delete(hash);
        unmarked = true;
      }
      if (unmarked) rewriteRetired();
      forgetDeliveries((record) => record.owner !== id);
    },

    unsubscribe(endpoint) {
      const next = without((key) => key === endpoint);
      if (next) persist(next);
      else if (stale) persist(new Map(store()));
      const hash = endpointHash(endpoint);
      // an explicit goodbye takes the endpoint's history with it, but never its retired mark: this route proves
      // neither owner nor keys, and a mark it cleared would let anyone register a retired endpoint again with
      // keys of their own (#1038). The mark goes only with its owner's revocation
      forgetDeliveries((record) => record.hash !== hash);
    },

    status(subscription, owner) {
      if (owner === undefined) return null;
      const hash = endpointHash(subscription.endpoint);
      const proof = keyFingerprint(subscription.keys);
      const current = store().get(subscription.endpoint);
      const record = deliveryStore().get(hash);
      const mine = record !== undefined && record.owner === owner && record.keys === proof ? record : null;
      if (current) {
        if (current.device_id !== owner || keyFingerprint(current.keys) !== proof) return null;
        return { registered: true, last_success_at: iso(mine?.success_at ?? null), last_failure_at: iso(mine?.failure_at ?? null), last_failure: mine?.failure ?? null };
      }
      if (!mine) return null;
      return { registered: false, last_success_at: iso(mine.success_at), last_failure_at: iso(mine.failure_at), last_failure: mine.failure };
    },

    retired: isRetired,

    async sendTest(endpoint) {
      const subscription = store().get(endpoint);
      if (!subscription) return null;
      return deliver(subscription, { pane_id: null, title: "Ovis", body: "Alerts are on for this device", tag: "herdr-test" }, "normal");
    },

    async devicePaired(event, origin = []) {
      const others = [...store().values()].filter((subscription) => subscription.device_id !== event.device_id
        && !(subscription.browser_keys ?? []).some((key) => origin.includes(key)));
      await broadcast({ pane_id: null, title: "Ovis", body: `New device paired: ${event.label}`, tag: `herdr-device-paired-${event.event_id}` }, "high", others);
    },

    seed(panes, machineId = "local", machineName, serverId) {
      if (machineName) pcNames.set(machineId, machineName);
      if (serverId) pcIds.set(machineId, serverId);
      for (const pane of panes) {
        const key = paneStorageId(machineId, pane.pane_id);
        titles.set(key, `${machineName ? machineName + " · " : ""}${pushPaneTitle(pane)}`);
        workspaces.set(key, pane.workspace_id);
        if (pane.agent_kind) kinds.set(key, pane.agent_kind); else kinds.delete(key);
        if (!lastStatus.has(key)) lastStatus.set(key, pane.agent_status);
      }
    },

    resync(panes, newer, machineId = "local") {
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      const present = new Set(panes.map((pane) => paneStorageId(machineId, pane.pane_id)));
      const newerKeys = new Set([...newer].map((paneId) => paneStorageId(machineId, paneId)));
      const remotePrefix = `remote:${encodeURIComponent(machineId)}:`;
      const onThisPc = (key: string): boolean => machineId === "local" ? !key.startsWith("remote:") : key.startsWith(remotePrefix);
      for (const key of [...lastStatus.keys()]) {
        if (!onThisPc(key) || present.has(key) || newerKeys.has(key)) continue;
        callOff(key);
        changes.delete(key);
        turnStart.delete(key);
        lastStatus.delete(key);
      }
      for (const pane of panes) {
        if (newer.has(pane.pane_id)) continue;
        const key = paneStorageId(machineId, pane.pane_id);
        const previous = lastStatus.get(key);
        const status = pane.agent_status;
        if (previous === status) continue;
        if (previous !== undefined && !busy(previous) && !busy(status)) { lastStatus.set(key, status); continue; }
        lastStatus.set(key, status);
        if (previous === undefined) continue;
        callOff(key);
        if (busy(status) !== busy(previous)) turnStart.delete(key);
      }
    },

    async onStatus(paneId, status, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      const previous = lastStatus.get(key);
      lastStatus.set(key, status);
      if (previous === status) return;
      callOff(key);
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      if (busy(status) && previous !== undefined && !busy(previous)) turnStart.set(key, now());
      let worked: number | null = null;
      if (!busy(status)) {
        const start = turnStart.get(key);
        worked = start === undefined ? null : now() - start;
        turnStart.delete(key);
      }
      if (!shouldNotifyStatus(previous, status)) return;
      if (muted(machineId, paneId)) return;
      const groups = new Map<number, PushSubscriptionRecord[]>();
      for (const subscription of store().values()) {
        const prefs = subscription.alerts ?? DEFAULT_ALERTS;
        if (!alertPcAllowed(prefs, ...pcKeys(machineId))) continue;
        const delay = delayFor(prefs, status, worked);
        if (delay !== null) groups.set(delay, [...(groups.get(delay) ?? []), subscription]);
      }
      const hookPrefs = options.webhook?.prefs() ?? null;
      const hookDelay = hookPrefs === null ? null : delayFor(hookPrefs, status, worked);
      if (hookDelay !== null && !groups.has(hookDelay)) groups.set(hookDelay, []);
      if (groups.size === 0) return;
      const hookAt = options.webhook?.generation();
      schedule(key, machineId, paneId, groups, async (to, silenced, delay) => {
        if (options.inUse?.() || muted(machineId, paneId)) return;
        const reading = status === "blocked" && machineId === "local" ? readActions(paneId) : Promise.resolve(null);
        const asked = changes.get(key);
        const [{ title, agentKind }, answer] = await Promise.all([lookUp(key, machineId, paneId), reading]);
        if (options.inUse?.() || silenced() || muted(machineId, paneId)) return;
        if (status === "blocked" && changes.get(key) !== asked) return;
        const kind: AlertKind = status === "blocked" ? blockedAlertKind(agentKind) : "done";
        const live = to.flatMap((subscription) => {
          const current = store().get(subscription.endpoint);
          return current && current.device_id === subscription.device_id && wants(current, kind, machineId) ? [current] : [];
        });
        const hook = delay === hookDelay && options.webhook?.wants(kind) === true;
        if (live.length === 0 && !hook) return;
        const message = statusMessage(paneId, title, status, kind);
        if (hook) tellWebhook(key, machineId, paneId, message, hookAt);
        if (live.length === 0) return;
        const alert: PushPayload = { ...message, ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) };
        const urgency = status === "blocked" ? "high" : "normal";
        const answering = answer === null ? [] : live.filter((subscription) => options.canAnswer?.(subscription.device_id) ?? true);
        await Promise.all([
          broadcast({ ...alert, ...(answer === null ? {} : { body: answer.body, prompt_id: answer.promptId, actions: answer.actions }) }, urgency, answering, true),
          broadcast(alert, urgency, live.filter((subscription) => !answering.includes(subscription)), true),
        ]);
      });
    },

    async onFailed(paneId, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      const at = lastStatus.get(key);
      if (at === "working" || at === "blocked" || muted(machineId, paneId)) return;
      const to = [...store().values()].filter((subscription) => {
        const prefs = subscription.alerts ?? DEFAULT_ALERTS;
        return alertKindAllowed(prefs, "error") && alertPcAllowed(prefs, ...pcKeys(machineId));
      });
      const hooked = options.webhook?.wants("error") === true;
      if (to.length === 0 && !hooked) return;
      const hookAt = options.webhook?.generation();
      schedule(key, machineId, paneId, new Map([[timing.short, to]]), async (group, silenced) => {
        if (options.inUse?.() || muted(machineId, paneId)) return;
        const { title } = await lookUp(key, machineId, paneId);
        if (options.inUse?.() || silenced() || muted(machineId, paneId)) return;
        const live = group.flatMap((subscription) => {
          const current = store().get(subscription.endpoint);
          return current && current.device_id === subscription.device_id && wants(current, "error", machineId) ? [current] : [];
        });
        const hook = options.webhook?.wants("error") === true;
        if (live.length === 0 && !hook) return;
        const message = failedMessage(paneId, title);
        if (hook) tellWebhook(key, machineId, paneId, message, hookAt);
        if (live.length === 0) return;
        await broadcast({ ...message, ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, "normal", live, true);
      });
    },

    async onEnded(paneId, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      callOff(key);
      changes.delete(key);
      turnStart.delete(key);
      if (muted(machineId, paneId)) return;
      const to = [...store().values()].filter((subscription) => {
        const prefs = subscription.alerts ?? DEFAULT_ALERTS;
        return alertKindAllowed(prefs, "ended") && alertPcAllowed(prefs, ...pcKeys(machineId));
      });
      const hook = options.webhook?.wants("ended") === true;
      if ((to.length === 0 && !hook) || options.inUse?.()) return;
      const message = endedMessage(paneId, titles.get(key) ?? paneId);
      if (hook) tellWebhook(key, machineId, paneId, message);
      if (to.length === 0) return;
      await broadcast({ ...message, ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, "normal", to);
    },

    mutesChanged() {
      for (const [key, pane] of hooked) {
        if (!muted(pane.machineId, pane.paneId)) continue;
        bump(key);
        hooked.delete(key);
      }
      for (const entry of [...unsent]) {
        if (!muted(entry.machineId, entry.paneId)) continue;
        entry.silenced = true;
        entry.cancel();
        unsent.delete(entry);
        if (waiting.get(entry.key) === entry) waiting.delete(entry.key);
      }
    },

    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/**
 * /api/push routes. All sit behind the token gate (they are /api/ and not health/auth):
 * a subscription receives pane titles until it is removed.
 *   GET    /api/push                        -> { public_key }
 *   POST   /api/push/subscribe { subscription, alerts? } -> 204 (alerts: this device's AlertPrefs)
 *          | 410 subscription_gone (its push service retired the endpoint: subscribe anew)
 *   DELETE /api/push/subscribe { endpoint } -> 204
 *   POST   /api/push/test      { endpoint } -> 204 | 404 subscription_not_found | 410 subscription_gone | 502 push_failed
 *   POST   /api/push/status    { subscription } -> PushSubscriptionStatus | 404 subscription_not_found (unknown, another
 *          owner's, other keys, a legacy owner: one answer, so nothing is enumerated)
 */
function subscriptionGone(): Response {
  return jsonResponse({ error: { code: "subscription_gone", message: "the push service retired this subscription; subscribe again" } }, 410);
}

function subscriptionNotFound(): Response {
  return jsonResponse({ error: { code: "subscription_not_found", message: "this device is not subscribed" } }, 404);
}

const PUSH_ROUTES = ["POST /api/push/subscribe", "DELETE /api/push/subscribe", "POST /api/push/test", "POST /api/push/status"];

export async function handlePushRequest(request: Request, pathname: string, push: PushService, deviceId: string | null | undefined, browserKeys: readonly string[] = []): Promise<Response | null> {
  if (pathname === "/api/push" || pathname === "/api/push/subscribe" || pathname === "/api/push/test" || pathname === "/api/push/status") setRequestRoute(pathname);
  const route = `${request.method} ${pathname}`;
  if (route === "GET /api/push") return jsonResponse({ public_key: push.publicKey() });
  if (!PUSH_ROUTES.includes(route)) {
    const known = pathname === "/api/push" || PUSH_ROUTES.some((candidate) => candidate.endsWith(` ${pathname}`));
    return known ? badRequest("method_not_allowed", `${request.method} is not supported on ${pathname}`) : null;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as { subscription?: unknown; endpoint?: unknown; alerts?: unknown };

  if (route === "POST /api/push/subscribe") {
    const subscription = push.parse(body.subscription);
    if (!subscription) return badRequest("invalid_subscription", "subscription needs an https endpoint and p256dh/auth keys");
    if (push.retired(subscription.endpoint)) return subscriptionGone();
    push.subscribe(subscription, body.alerts === undefined ? undefined : parseAlerts(body.alerts), deviceId, browserKeys);
    return new Response(null, { status: 204 });
  }
  if (route === "POST /api/push/status") {
    if (deviceId === undefined) return jsonResponse({ error: { code: "status_unavailable", message: "this sign-in has no device to answer for" } }, 403);
    const subscription = push.parse(body.subscription);
    if (!subscription) return badRequest("invalid_subscription", "subscription needs an https endpoint and p256dh/auth keys");
    const status = push.status(subscription, deviceId);
    return status ? jsonResponse(status, 200, { "cache-control": "no-store" }) : subscriptionNotFound();
  }
  if (typeof body.endpoint !== "string") return badRequest("missing_endpoint", "endpoint is required");
  if (route === "DELETE /api/push/subscribe") {
    push.unsubscribe(body.endpoint);
    return new Response(null, { status: 204 });
  }
  const delivery = await push.sendTest(body.endpoint);
  if (!delivery) return push.retired(body.endpoint) ? subscriptionGone() : subscriptionNotFound();
  if (delivery.ok) return new Response(null, { status: 204 });
  if (delivery.gone) return subscriptionGone();
  return jsonResponse({ error: { code: "push_failed", message: `push service answered ${delivery.status ?? "nothing"}` } }, 502);
}
