/**
 * Joins this PC announced and nobody has seen yet (`join-notices.json` beside devices.json): any of this PC's windows
 * that opens later is told of them (machine-pairing-events.ts), until one window marks one seen, which is seen for all.
 */
import { readFileSync } from "node:fs";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { writePrivateState } from "./private-state.ts";

/** As many as a window shows at once (src/lib/pairedNotices.ts PAIRED_NOTICE_LIMIT). */
export const WAITING_JOIN_LIMIT = 3;
export const WAITING_JOIN_MS = 7 * 24 * 60 * 60 * 1000;
export const JOIN_SEEN_PATH = "/api/devices/joins/seen";

/** `origin`: the stream keys of the browser that paired, which is never told of its own pairing. */
export interface WaitingJoin { readonly event: DevicePairedEvent; readonly origin: readonly string[] }

/** The window asking: this PC's own (dispatch.ts ownWindow), and when it is a device, when that device was added here. */
export interface JoinViewer { readonly ownWindow: boolean; readonly since: string | undefined }

/**
 * Who is told of a waiting join, and so may mark it seen for all: this PC's own window, or a device that was here before
 * the join (the journal's T57 rule). A device paired later never hears of older joins, nor clears them.
 */
export function shownTo(join: WaitingJoin, viewer: JoinViewer): boolean {
  return viewer.ownWindow || (viewer.since !== undefined && Date.parse(viewer.since) < Date.parse(join.event.enrolled_at));
}

function readJoins(path: string): WaitingJoin[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  try {
    const joins = (JSON.parse(text) as { joins?: unknown }).joins;
    return Array.isArray(joins) ? joins.filter((join): join is WaitingJoin => typeof join?.event?.event_id === "string"
      && typeof join.event.device_id === "string" && typeof join.event.enrolled_at === "string" && Array.isArray(join.origin)) : [];
  } catch (error) {
    // a notice that cannot be read is only a notice: the PC starts with none rather than refusing anything
    console.warn(`[devices] ${path} could not be read, so no join waits to be seen: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export class JoinNotices {
  private joins: WaitingJoin[];
  private readonly seenListeners = new Set<(eventId: string) => void>();

  /** `stands`: whether the device a join names is still here; a removed device's join is not news any more. */
  constructor(private readonly path: string, private readonly stands: (deviceId: string) => boolean) {
    this.joins = readJoins(path);
  }

  /** A durable join, kept until seen; the newest few within the week. A failed write keeps it for this run. */
  add(event: DevicePairedEvent, origin: readonly string[], now = Date.now()): void {
    this.joins = this.fresh([...this.joins, { event, origin }], now);
    this.save();
  }

  waiting(now = Date.now()): readonly WaitingJoin[] {
    const kept = this.fresh(this.joins, now).filter((join) => this.stands(join.event.device_id));
    if (kept.length !== this.joins.length) {
      this.joins = kept;
      this.save();
    }
    return kept;
  }

  /** Seen in one window, seen in all: false when no such join waits. */
  see(eventId: string): boolean {
    const kept = this.joins.filter((join) => join.event.event_id !== eventId);
    if (kept.length === this.joins.length) return false;
    this.joins = kept;
    this.save();
    for (const listener of [...this.seenListeners]) {
      try { listener(eventId); } catch (error) { console.warn(`[devices] a seen-join listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return true;
  }

  onSeen(listener: (eventId: string) => void): () => void {
    this.seenListeners.add(listener);
    return () => { this.seenListeners.delete(listener); };
  }

  private fresh(joins: readonly WaitingJoin[], now: number): WaitingJoin[] {
    return joins.filter((join) => now - Date.parse(join.event.enrolled_at) < WAITING_JOIN_MS).slice(-WAITING_JOIN_LIMIT);
  }

  private save(): void {
    try { writePrivateState(this.path, { joins: this.joins }); }
    catch (error) { console.warn(`[devices] ${this.path} could not be written: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/**
 * POST /api/devices/joins/seen { event_id }: any window that may drive this PC marks a join seen for all its windows. A
 * window the open LAN let in is never told of a join, so it marks none (an account row is held to `drive` by its rights).
 */
export async function handleJoinSeen(request: Request, joins: JoinNotices, access: Access, viewer: JoinViewer): Promise<Response> {
  setRequestRoute(JOIN_SEEN_PATH);
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level !== "full" || access.via === "open") return jsonResponse({ error: { code: "owner_only", message: "Mark a new device seen from this PC or a paired device" } }, 403);
  if (access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
  if (!isJsonObject(body) || typeof body["event_id"] !== "string" || !/^[0-9a-f]{16}$/.test(body["event_id"])) return badRequest("invalid_body", "event_id must be a join's event id");
  const eventId = body["event_id"];
  // a join this window was never told of is none of its business: as if it did not wait
  if (!joins.waiting().some((join) => join.event.event_id === eventId && shownTo(join, viewer))) {
    return jsonResponse({ error: { code: "join_not_found", message: "No such new device waits to be seen here" } }, 404, { "cache-control": "no-store" });
  }
  return jsonResponse({ seen: joins.see(eventId) }, 200, { "cache-control": "no-store" });
}
