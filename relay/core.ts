import { parsePairRequest, type PairSocketRequest } from "./pair-room.ts";
import { SERVER_KEY_INVALID, SERVER_KEY_MISMATCH, SERVER_PROOF_CLOSE, SERVER_PROOF_MS, SERVER_PROOF_REQUIRED, deriveServerId, proofKey, serverChallenge, verifyServerProof } from "../shared/relay-server-proof.ts";
import { RELAY_NEW_SESSIONS_CLOSE, RELAY_NEW_SESSIONS_REFUSED, RELAY_PASS_CLOSE, RELAY_PASS_EXPIRED, RELAY_PASS_HEADER, RELAY_PASS_INVALID, RELAY_PASS_REQUIRED, RELAY_PASS_SKEW_S } from "../shared/relay-pass.ts";
import { checkPass, passMayHold, passMode, passNotice, type PassPolicy, type PassResult, type PassState } from "./pass.ts";

export const WIRE_VERSION = "1";
export const MAX_CLIENTS = 8;
export const MAX_PENDING = 4;
export const MAX_PROVING = 16;
export const MAX_WARM = 1;
export const WARM_QUIET_MS = 25_000;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const BUFFER_FRAMES = 200;
export const BUFFER_BYTES = 1024 * 1024;
export const HANDSHAKE_MS = 15_000;
export const OFFLINE_WAIT_MS = 30_000;
export const IDLE_MS = 120_000;
/** On Cloudflare the runtime answers this keepalive itself, without waking the Durable Object. */
export const KEEPALIVE_PING = '{"type":"ping"}';
export const KEEPALIVE_PONG = '{"type":"pong"}';
export const USAGE_REPORT_MS = 5 * 60_000;
const SEEN_WRITE_MS = 30_000;

export const CLOSE = {
  GOING_AWAY: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
  RESTART: 1012,
  TRY_AGAIN: 1013,
  SERVER_PROOF: SERVER_PROOF_CLOSE,
  RELAY_PASS: RELAY_PASS_CLOSE,
  NEW_SESSIONS: RELAY_NEW_SESSIONS_CLOSE,
} as const;

const PASS_SKEW_MS = RELAY_PASS_SKEW_S * 1000;
const RENEWAL_BYTES = 1024;
const RENEWAL_GAP_MS = 60_000;

export type Role = "control" | "data" | "client" | "warm";
export type Frame = string | ArrayBuffer | Uint8Array;

/** what a socket is, kept with the socket itself so it survives a Durable Object's eviction */
export interface SocketInfo {
  role: Role;
  connection_id: string | null;
  seen: number;
  buffered: boolean;
  answered?: true;
  deadline?: number;
  arrived?: number;
  proof?: { expected: string; expires: number };
  pass_exp?: number;
  pass_kid?: string;
  pass_no_new?: true;
  pass_state?: PassState;
  generation?: string;
  server_id?: string;
  usage?: Usage;
  /**
   * the room closed it: a peer that vanished never answers that close, and the runtime keeps
   * listing the socket until it gives up, so an instance after an eviction must not end it again
   */
  ended?: true;
}

export interface Usage { since: number; up: number; down: number }

export interface UsageReport {
  server_id: string;
  side: "pc" | "device";
  up: number;
  down: number;
  ms: number;
  ended: boolean;
}

export interface SocketRequest {
  server_id: string;
  role: Role;
  connection_id: string | null;
  version: string | null;
  proof?: string | null;
  public_key?: string | null;
  generation?: string;
  pass?: PassResult;
}

export interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
export interface Limiters {
  perAddress: RateLimiter;
  global: RateLimiter;
  perPc?: RateLimiter;
  passChecks?: RateLimiter;
}

const HEX32 = /^[0-9a-f]{32}$/;

const oldestToMakeRoom = <T>(list: readonly T[], max: number): T[] => list.slice(0, Math.max(0, list.length - max + 1));

export function parseSocketRequest(url: URL): SocketRequest | { error: string } {
  const params = url.searchParams;
  const serverId = params.get("server_id") ?? "";
  if (!HEX32.test(serverId)) return { error: "server_id must be 32 lowercase hex digits" };
  const role = params.get("role");
  const connectionId = params.get("connection_id");
  const version = params.get("v");
  if (role === "client") {
    if (connectionId !== null) return { error: "the relay assigns a client's connection_id" };
    return { server_id: serverId, role: "client", connection_id: null, version };
  }
  if (role !== "server") return { error: "role must be server or client" };
  const proof = { proof: params.get("proof"), public_key: params.get("public_key") };
  const generation = params.get("warm");
  if (generation !== null) {
    if (!HEX32.test(generation) || connectionId !== null) return { error: "warm must be 32 lowercase hex digits, without a connection_id" };
    return { server_id: serverId, role: "warm", connection_id: null, version, ...proof, generation };
  }
  if (connectionId === null) return { server_id: serverId, role: "control", connection_id: null, version, ...proof };
  if (!HEX32.test(connectionId)) return { error: "connection_id must be 32 lowercase hex digits" };
  return { server_id: serverId, role: "data", connection_id: connectionId, version, ...proof };
}

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

export async function admit(request: Request, address: string, limiters?: Limiters, policy?: PassPolicy): Promise<Response | SocketRequest | PairSocketRequest> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return request.method === "GET" || request.method === "HEAD" ? text(200, "ok") : text(405, "", { allow: "GET" });
  if (url.pathname !== "/v1/ws" && url.pathname !== "/v1/pair") return text(404, "not found");
  if (request.method !== "GET") return text(405, "", { allow: "GET" });
  const socket = url.pathname === "/v1/pair" ? parsePairRequest(url) : parseSocketRequest(url);
  if ("error" in socket) return text(400, socket.error);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "expected a WebSocket upgrade", { upgrade: "websocket" });
  const pcServerId = "kind" in socket || socket.role === "client" ? undefined : socket.server_id;
  const header = request.headers.get(RELAY_PASS_HEADER);
  const tooMany = () => text(429, "too many connections", { "retry-after": "60" });
  let pass: PassResult | undefined;
  if (limiters) {
    if ((await limiters.perAddress.limit({ key: address })).success) {
      if (!(await limiters.global.limit({ key: "all" })).success) return tooMany();
    } else {
      const { perPc, passChecks } = limiters;
      if (!policy || policy.mode === "off" || pcServerId === undefined || !perPc || !passChecks || !passMayHold(policy, header, pcServerId, Date.now())) return tooMany();
      if (!(await passChecks.limit({ key: address })).success || !(await limiters.global.limit({ key: "all" })).success) return tooMany();
      pass = await checkPass(policy, header, pcServerId, Date.now());
      if (pass.state !== "ok" || !(await perPc.limit({ key: pcServerId })).success) return tooMany();
    }
  }
  const serverId = "kind" in socket ? socket.key?.server_id : pcServerId;
  if (!policy || policy.mode === "off" || serverId === undefined) return socket;
  return { ...socket, pass: pass ?? await checkPass(policy, header, serverId, Date.now()) };
}

export function passRefusal(socket: Pick<SocketRequest, "role" | "pass"> | PairSocketRequest, policy: PassPolicy | undefined, now: number): string | null {
  if (!policy || socket.role === "client" || socket.role === "guest" || passMode(policy, now) !== "enforce") return null;
  return socket.pass?.state === "ok" ? null : socket.pass?.reason ?? RELAY_PASS_REQUIRED;
}

export interface RoomAuthorization { readonly until: number; readonly kid: string; readonly noNew?: true }
export interface RoomPass {
  readonly policy: PassPolicy;
  until(): RoomAuthorization | null;
  setUntil(value: RoomAuthorization): void;
}

export interface RoomHost<S extends object> {
  sockets(): Iterable<S>;
  info(socket: S): SocketInfo | null;
  setInfo(socket: S, info: SocketInfo): void;
  send(socket: S, frame: Frame): void;
  close(socket: S, code: number, reason: string): void;
  keepaliveAt?(socket: S): number | null;
  usage?(report: UsageReport): void;
  wake?(at: number): void;
  now(): number;
  pass?: RoomPass;
}

interface Held { frames: Frame[]; bytes: number }

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function utf8Length(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

const byteLength = (frame: Frame) => typeof frame === "string" ? utf8Length(frame) : frame.byteLength;
/** a frame the platform may reuse once the handler returns, copied to be held */
const own = (frame: Frame): Frame => typeof frame === "string" ? frame : frame instanceof Uint8Array ? frame.slice() : frame.slice(0);

export class Room<S extends object> {
  private readonly held = new Map<string, Held>();
  private readonly ended = new WeakSet<S>();
  private readonly lastSeen = new WeakMap<S, number>();
  heldFramesLost = 0;

  constructor(private readonly host: RoomHost<S>) {}

  private peers(proving = false): { socket: S; info: SocketInfo }[] {
    const out: { socket: S; info: SocketInfo }[] = [];
    for (const socket of this.host.sockets()) {
      if (this.ended.has(socket)) continue;
      const info = this.host.info(socket);
      if (info && !info.ended && (proving || !info.proof)) out.push({ socket, info });
    }
    return out;
  }

  private setDeadline(socket: S, info: SocketInfo, at: number): void {
    this.host.setInfo(socket, { ...info, deadline: at });
    this.host.wake?.(at);
  }

  private lostHeld(client: S): void {
    this.heldFramesLost++;
    this.end(client, CLOSE.RESTART, "relay restarted");
  }

  private find(role: Role, connectionId: string): { socket: S; info: SocketInfo } | undefined {
    return this.peers().find((peer) => peer.info.role === role && peer.info.connection_id === connectionId);
  }

  private tellControls(message: object): void {
    const body = JSON.stringify(message);
    for (const peer of this.peers()) if (peer.info.role === "control") this.host.send(peer.socket, body);
  }

  private report(info: SocketInfo, usage: Usage, now: number, ended: boolean): Usage {
    if (!ended && now - usage.since < USAGE_REPORT_MS) return usage;
    if (info.role === "client" && !info.answered) return usage;
    if (info.server_id !== undefined) this.host.usage?.({ server_id: info.server_id, side: info.role === "control" ? "pc" : "device", up: usage.up, down: usage.down, ms: Math.max(0, now - usage.since), ended });
    return { since: now, up: 0, down: 0 };
  }

  private count(socket: S, direction: "up" | "down", size: number, now: number): void {
    const info = this.host.info(socket);
    if (!info?.usage) return;
    const usage = { ...info.usage, [direction]: info.usage[direction] + size };
    this.host.setInfo(socket, { ...info, usage: this.report(info, usage, now, false) });
  }

  end(socket: S, code: number, reason: string): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    if (info) this.host.setInfo(socket, { ...info, ended: true });
    this.host.close(socket, code, reason);
    this.finish(socket, info);
  }

  open(socket: S, request: Pick<SocketRequest, "server_id" | "role" | "connection_id" | "version" | "proof" | "public_key" | "generation" | "pass">): void {
    if (request.version !== WIRE_VERSION) return this.end(socket, CLOSE.POLICY, "unsupported wire version");
    const policy = this.host.pass?.policy;
    if (policy?.mode === "grace" && policy.enforceAt !== null && this.host.now() < policy.enforceAt) this.host.wake?.(policy.enforceAt);
    if (request.role === "client") return this.openClient(socket, request.server_id);
    const refused = passRefusal(request, this.host.pass?.policy, this.host.now());
    if (refused !== null) return this.end(socket, CLOSE.RELAY_PASS, refused);
    if (request.proof !== "1") return this.end(socket, CLOSE.SERVER_PROOF, SERVER_PROOF_REQUIRED);
    const key = proofKey(request.public_key);
    if (!key || deriveServerId(key) !== request.server_id) return this.end(socket, CLOSE.SERVER_PROOF, SERVER_KEY_MISMATCH);
    const proving = this.peers(true).filter((peer) => peer.info.proof).sort((a, b) => a.info.proof!.expires - b.info.proof!.expires);
    for (const peer of oldestToMakeRoom(proving, MAX_PROVING)) this.end(peer.socket, CLOSE.TRY_AGAIN, "too many server proofs pending");
    let challenge: ReturnType<typeof serverChallenge>;
    try { challenge = serverChallenge(key, { server_id: request.server_id, role: request.role, connection_id: request.role === "warm" ? request.generation ?? null : request.connection_id }); }
    catch { return this.end(socket, CLOSE.SERVER_PROOF, SERVER_KEY_INVALID); } // a low-order X25519 point
    const now = this.host.now();
    const expires = now + SERVER_PROOF_MS;
    this.host.setInfo(socket, { role: request.role, connection_id: request.connection_id, seen: now, buffered: false, proof: { expected: challenge.expected, expires }, server_id: request.server_id,
      ...(request.role === "warm" ? { generation: request.generation } : {}),
      ...(request.pass ? { pass_state: request.pass.state, ...(request.pass.exp !== undefined && request.pass.kid !== undefined ? { pass_exp: request.pass.exp, pass_kid: request.pass.kid, ...(request.pass.noNew ? { pass_no_new: true as const } : {}) } : {}) } : {}) });
    this.lastSeen.set(socket, now);
    this.host.send(socket, challenge.frame);
    this.host.wake?.(expires);
  }

  private openClient(socket: S, serverId: string): void {
    const now = this.host.now();
    const peers = this.peers();
    const clients = peers.filter((peer) => peer.info.role === "client");
    const answered = clients.filter((peer) => peer.info.answered).length;
    if (answered >= MAX_CLIENTS) return this.end(socket, CLOSE.TRY_AGAIN, "too many clients for this server");
    const waiting = clients.filter((peer) => !peer.info.answered).sort((a, b) => (a.info.arrived ?? a.info.seen) - (b.info.arrived ?? b.info.seen));
    for (const peer of oldestToMakeRoom(waiting, MAX_PENDING)) this.end(peer.socket, CLOSE.TRY_AGAIN, "too many clients waiting for this server");
    const connectionId = randomHex();
    const info: SocketInfo = { role: "client", connection_id: connectionId, seen: now, buffered: false, arrived: now, server_id: serverId, usage: { since: now, up: 0, down: 0 } };
    this.host.setInfo(socket, info);
    this.lastSeen.set(socket, now);
    const controlled = peers.some((peer) => peer.info.role === "control");
    this.setDeadline(socket, info, now + (controlled ? HANDSHAKE_MS : OFFLINE_WAIT_MS));
    const pass = this.host.pass;
    const notice = pass && pass.policy.mode !== "off" && !this.authorized(now) ? { relay_pass: passNotice(pass.policy, "missing") } : {};
    this.host.send(socket, JSON.stringify({ type: "assigned", connection_id: connectionId, ...notice }));
    const generation = peers.find((peer) => peer.info.role === "control")?.info.generation;
    let warm = generation ? peers.find((peer) => peer.info.role === "warm" && peer.info.generation === generation) : undefined;
    if (warm && now - Math.max(this.lastSeen.get(warm.socket) ?? warm.info.seen, this.host.keepaliveAt?.(warm.socket) ?? 0) >= WARM_QUIET_MS) {
      this.end(warm.socket, CLOSE.GOING_AWAY, "warm socket went quiet");
      warm = undefined;
    }
    if (!warm) return this.tellControls({ type: "connected", connection_id: connectionId });
    this.host.setInfo(warm.socket, { role: "data", connection_id: connectionId, seen: now, buffered: false });
    this.lastSeen.set(warm.socket, now);
    this.host.send(warm.socket, JSON.stringify({ type: "bound", connection_id: connectionId }));
  }

  private endWarm(reason: string): void {
    for (const peer of this.peers(true)) if (peer.info.role === "warm") this.end(peer.socket, CLOSE.GOING_AWAY, reason);
  }

  private roomServerId: string | undefined;
  private serverId(): string | undefined {
    if (this.roomServerId === undefined) for (const peer of this.peers(true)) if (peer.info.server_id !== undefined) { this.roomServerId = peer.info.server_id; break; }
    return this.roomServerId;
  }

  private lapsed(now: number): boolean {
    const pass = this.host.pass;
    return pass !== undefined && pass.policy.mode !== "off" && passMode(pass.policy, now) === "enforce" && !this.authorized(now);
  }

  private authorized(now: number): boolean {
    const pass = this.host.pass;
    const auth = pass?.until() ?? null;
    if (!pass || !auth || !pass.policy.keys.has(auth.kid)) return false;
    const serverId = this.serverId();
    return (serverId === undefined || !pass.policy.revoked.has(serverId)) && now < auth.until + PASS_SKEW_MS;
  }

  private refusesNewSessions(now: number): boolean {
    const pass = this.host.pass;
    return pass !== undefined && passMode(pass.policy, now) === "enforce" && this.authorized(now) && pass.until()?.noNew === true;
  }

  private authorize(until: number, kid: string, noNew: boolean): void {
    const pass = this.host.pass;
    if (!pass) return;
    const current = pass.until();
    if (current && this.authorized(this.host.now()) && (until < current.until || (until === current.until && (!noNew || current.noNew === true)))) return;
    pass.setUntil({ until, kid, ...(noNew ? { noNew: true as const } : {}) });
    this.host.wake?.(until + PASS_SKEW_MS);
  }

  private readonly renewedAt = new WeakMap<S, number>();
  private readonly renewing = new WeakSet<S>();

  private async renew(socket: S, info: SocketInfo, text: string): Promise<void> {
    const pass = this.host.pass;
    if (!pass || pass.policy.mode === "off" || info.server_id === undefined) return;
    const now = this.host.now();
    if (this.renewing.has(socket) || now - (this.renewedAt.get(socket) ?? -Infinity) < RENEWAL_GAP_MS) return;
    this.renewing.add(socket);
    this.renewedAt.set(socket, now);
    try {
      const result = await checkPass(pass.policy, text, info.server_id, now);
      if (this.ended.has(socket) || this.host.info(socket)?.role !== "control") return;
      if (result.state === "ok" && result.exp !== undefined && result.kid !== undefined) this.authorize(result.exp, result.kid, result.noNew === true);
    } finally { this.renewing.delete(socket); }
  }

  private attach(socket: S, info: SocketInfo): void {
    const now = this.host.now();
    const peers = this.peers();
    if (info.pass_exp !== undefined && info.pass_kid !== undefined) this.authorize(info.pass_exp, info.pass_kid, info.pass_no_new === true);
    if (info.role === "control") {
      for (const peer of peers) if (peer.info.role === "control") this.end(peer.socket, CLOSE.POLICY, "replaced by a newer control socket");
      this.endWarm("replaced by a newer control socket");
      const generation = randomHex();
      this.host.setInfo(socket, { role: "control", connection_id: null, seen: now, buffered: false, server_id: info.server_id, usage: { since: now, up: 0, down: 0 }, generation });
      this.lastSeen.set(socket, now);
      const waiting = peers.filter((peer) => peer.info.role === "client" && !peers.some((other) => other.info.role === "data" && other.info.connection_id === peer.info.connection_id));
      for (const peer of waiting) this.setDeadline(peer.socket, peer.info, now + HANDSHAKE_MS);
      const pass = this.host.pass;
      const notice = pass && pass.policy.mode !== "off" ? { relay_pass: passNotice(pass.policy, this.authorized(now) ? "ok" : info.pass_state ?? "missing") } : {};
      this.host.send(socket, JSON.stringify({ type: "sync", connection_ids: waiting.map((peer) => peer.info.connection_id), warm: generation, ...notice }));
      return;
    }
    if (info.role === "warm") {
      if (!peers.some((peer) => peer.info.role === "control" && peer.info.generation === info.generation)) return this.end(socket, CLOSE.GOING_AWAY, "no control socket of its generation");
      const warm = peers.filter((peer) => peer.info.role === "warm").sort((a, b) => a.info.seen - b.info.seen);
      for (const peer of oldestToMakeRoom(warm, MAX_WARM)) this.end(peer.socket, CLOSE.POLICY, "replaced by a newer warm socket");
      this.host.setInfo(socket, { role: "warm", connection_id: null, seen: now, buffered: false, generation: info.generation! });
      this.lastSeen.set(socket, now);
      return;
    }
    const connectionId = info.connection_id!;
    const client = peers.find((peer) => peer.info.role === "client" && peer.info.connection_id === connectionId);
    if (!client) return this.end(socket, CLOSE.GOING_AWAY, "client gone");
    if (peers.some((peer) => peer.info.role === "data" && peer.info.connection_id === connectionId)) return this.end(socket, CLOSE.POLICY, "this client already has a data socket");
    this.host.setInfo(socket, { role: "data", connection_id: connectionId, seen: now, buffered: false });
    this.lastSeen.set(socket, now);
    const held = this.held.get(connectionId);
    this.held.delete(connectionId);
    if (client.info.buffered && !held) return this.lostHeld(client.socket);
    for (const frame of held?.frames ?? []) this.host.send(socket, frame);
    this.setDeadline(client.socket, { ...client.info, buffered: false }, now + HANDSHAKE_MS);
  }

  message(socket: S, frame: Frame): void | Promise<void> {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (!info || info.ended) return;
    if (info.proof) {
      if (this.host.now() >= info.proof.expires || !verifyServerProof(frame, info.proof.expected)) return this.end(socket, CLOSE.SERVER_PROOF, "invalid or expired server proof");
      const pass = this.host.pass;
      const now = this.host.now();
      if (pass && passMode(pass.policy, now) === "enforce" && !(info.pass_exp !== undefined && now < info.pass_exp + PASS_SKEW_MS) && !this.authorized(now)) {
        return this.end(socket, CLOSE.RELAY_PASS, info.pass_exp === undefined ? RELAY_PASS_REQUIRED : RELAY_PASS_EXPIRED);
      }
      return this.attach(socket, info);
    }
    const size = byteLength(frame);
    if (size > MAX_MESSAGE_BYTES) return this.end(socket, CLOSE.TOO_BIG, "message too big");
    const now = this.host.now();
    if (this.lapsed(now)) {
      this.sweepPass(now);
      if (this.ended.has(socket)) return;
    }
    this.lastSeen.set(socket, now);
    if (now - info.seen >= SEEN_WRITE_MS) this.host.setInfo(socket, { ...info, seen: now });
    if (frame === KEEPALIVE_PING) return this.host.send(socket, KEEPALIVE_PONG);
    if (info.role === "control" && typeof frame === "string" && size <= RENEWAL_BYTES) {
      let value: unknown;
      try { value = JSON.parse(frame); } catch { return; }
      const { type, pass, connection_id } = typeof value === "object" && value !== null ? value as { type?: unknown; pass?: unknown; connection_id?: unknown } : {};
      if (type === "relay_pass" && typeof pass === "string") return this.renew(socket, info, pass);
      if (type === "new_session" && typeof connection_id === "string" && this.refusesNewSessions(now)) {
        const client = this.find("client", connection_id);
        if (client) this.end(client.socket, CLOSE.NEW_SESSIONS, RELAY_NEW_SESSIONS_REFUSED);
      }
      return;
    }
    if (info.role === "control" || info.role === "warm") return;
    const connectionId = info.connection_id!;
    if (info.role === "data") {
      const client = this.find("client", connectionId);
      if (!client) return;
      if (!client.info.answered) {
        if (this.peers().filter((peer) => peer.info.role === "client" && peer.info.answered).length >= MAX_CLIENTS) return this.end(client.socket, CLOSE.TRY_AGAIN, "too many clients for this server");
        const { deadline: _deadline, ...rest } = client.info;
        this.host.setInfo(client.socket, { ...rest, answered: true, usage: { since: now, up: rest.usage?.up ?? 0, down: 0 } });
      }
      this.count(client.socket, "down", size, now);
      this.host.send(client.socket, frame);
      return;
    }
    this.count(socket, "up", size, now);
    const data = this.find("data", connectionId);
    if (data) return this.host.send(data.socket, frame);
    if (info.buffered && !this.held.has(connectionId)) return this.lostHeld(socket);
    const held = this.held.get(connectionId) ?? { frames: [], bytes: 0 };
    if (held.frames.length >= BUFFER_FRAMES || held.bytes + size > BUFFER_BYTES) return this.end(socket, CLOSE.TRY_AGAIN, "too much sent before the server attached");
    held.frames.push(own(frame));
    held.bytes += size;
    this.held.set(connectionId, held);
    if (!info.buffered) this.host.setInfo(socket, { ...(this.host.info(socket) ?? info), buffered: true });
  }

  closed(socket: S): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    this.finish(socket, info);
  }

  private finish(socket: S, info: SocketInfo | null): void {
    this.ended.add(socket);
    if (!info || info.proof) return;
    if (info.usage) this.report(info, info.usage, this.host.now(), true);
    if (info.role === "warm") return;
    if (info.role === "control") {
      if (!this.peers().some((peer) => peer.info.role === "control")) this.endWarm("control socket gone");
      return this.pauseWaiting();
    }
    const connectionId = info.connection_id!;
    if (info.role === "client") {
      this.held.delete(connectionId);
      const data = this.find("data", connectionId);
      if (data) this.end(data.socket, CLOSE.GOING_AWAY, "client gone");
      this.tellControls({ type: "disconnected", connection_id: connectionId });
      return;
    }
    const client = this.find("client", connectionId);
    if (client) this.end(client.socket, CLOSE.RESTART, "server gone");
  }

  private pauseWaiting(): void {
    const peers = this.peers();
    if (peers.some((peer) => peer.info.role === "control")) return;
    const at = this.host.now() + OFFLINE_WAIT_MS;
    for (const peer of peers) {
      if (peer.info.role !== "client" || peer.info.answered) continue;
      if (peers.some((other) => other.info.role === "data" && other.info.connection_id === peer.info.connection_id)) continue;
      this.setDeadline(peer.socket, peer.info, at);
    }
  }

  sweep(): number | null {
    const now = this.host.now();
    let next: number | null = this.sweepPass(now);
    for (const peer of this.peers(true)) {
      if (this.ended.has(peer.socket)) continue;
      const due = peer.info.proof?.expires ?? peer.info.deadline;
      if (due !== undefined && now >= due) {
        if (peer.info.proof) this.end(peer.socket, CLOSE.SERVER_PROOF, "server proof timed out");
        else this.end(peer.socket, CLOSE.TRY_AGAIN, this.peers().some((other) => other.info.role === "control") ? "the server did not answer in time" : "the server is not connected");
        continue;
      }
      const sent = this.lastSeen.get(peer.socket) ?? peer.info.seen + SEEN_WRITE_MS;
      const last = Math.max(sent, this.host.keepaliveAt?.(peer.socket) ?? 0);
      if (now - last >= IDLE_MS) {
        this.end(peer.socket, CLOSE.GOING_AWAY, "idle");
        continue;
      }
      next = Math.min(next ?? Infinity, last + IDLE_MS, due ?? Infinity);
      // a PC's control socket wakes the room only here (its keepalive is answered without it)
      const info = this.host.info(peer.socket);
      const usage = info?.usage && this.report(info, info.usage, now, false);
      if (info && usage && usage !== info.usage) this.host.setInfo(peer.socket, { ...info, usage });
    }
    return next;
  }

  private sweepPass(now: number): number | null {
    const pass = this.host.pass;
    if (!pass || pass.policy.mode === "off" || this.empty) return null;
    if (passMode(pass.policy, now) !== "enforce") return pass.policy.enforceAt;
    if (this.authorized(now)) return pass.until()!.until + PASS_SKEW_MS;
    const auth = pass.until();
    const serverId = this.serverId();
    const reason = auth === null ? RELAY_PASS_REQUIRED : now < auth.until + PASS_SKEW_MS || (serverId !== undefined && pass.policy.revoked.has(serverId)) ? RELAY_PASS_INVALID : RELAY_PASS_EXPIRED;
    const peers = this.peers(true).sort((a, b) => Number(b.info.role === "warm") - Number(a.info.role === "warm"));
    for (const peer of peers) {
      if (peer.info.role === "client" || (peer.info.proof && peer.info.pass_exp !== undefined && now < peer.info.pass_exp + PASS_SKEW_MS)) continue;
      this.end(peer.socket, CLOSE.RELAY_PASS, reason);
    }
    return null;
  }

  get empty(): boolean {
    return this.peers(true).length === 0;
  }
}
