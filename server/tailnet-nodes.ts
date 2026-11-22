/**
 * The tailnet nodes this PC keeps out (owner decision #13): a device removed on the PC must stay out over Tailscale
 * too, where its login, the owner's own, would otherwise let it straight back in (access.ts decideAccess).
 *
 * A node is named by its Tailscale StableNodeID (`tailscale whois`), which survives a key rotation; its hostname is
 * shown only. A paired row records the nodes its own credential arrives from (DeviceStore.noteTailnetNode); removing
 * the row blocks them, in the same step and journalled (DeviceStore.keepOutTailnetNodes). The removal dialog also
 * offers the nodes of the owner's login seen lately, for a phone that only ever came in by its login. Revoke all
 * blocks every node seen so far. The list is private, durable and merged with a sibling state folder like a
 * tombstone: per node the later change (a block, or the Allow that ended it) stands.
 *
 * A blocked node's request gets no Tailscale grant (`tailnetNodeGate`) and waits, one at a time, on this PC's own
 * window for a plain Allow or Decline: the tailnet already authenticated the node and its login, so there are no
 * digits to compare. Allow takes the node off the list (journalled); Decline keeps it. A node never seen before gets
 * in as it always did: keeping that one out is the tailnet admin's job.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TAILNET_NODE_ROUTES, type TailnetNodePrompt, type TailnetNodeView, type TailnetNodesAnswer } from "../shared/tailnet-nodes.ts";
import type { Access } from "./access.ts";
import { isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { privateStateRefusal, writePrivateState } from "./private-state.ts";
import { STABLE_NODE_ID, type TailnetNode } from "./tailscale.ts";

export const TAILNET_NODES_FILE = "tailnet-nodes.json";
/** the blocks of removals made while the list could not be read, taken in at the next start that can read it */
export const TAILNET_PENDING_FILE = "tailnet-nodes.pending.json";
/** how many nodes the file keeps: every blocked one, and the rest by when they were last seen */
export const TAILNET_NODES_MAX = 128;
/** how long a node's ask waits on the card before another blocked node may take its place */
export const TAILNET_PROMPT_MS = 2 * 60_000;
/** a declined node is not asked about again for this long */
export const TAILNET_DECLINED_QUIET_MS = 10 * 60_000;
/** a node seen again is written at most this often: when it was seen is a hint, not authority */
const SEEN_WRITE_MS = 60 * 60_000;

export interface StoredTailnetNode {
  id: string;
  hostname: string;
  login: string | null;
  seen_at: string | null;
  blocked: boolean;
  /** when it was last blocked or allowed: the later change wins a sibling merge */
  changed_at: string | null;
}

const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

function isStoredNode(value: unknown): value is StoredTailnetNode {
  return isJsonObject(value) && typeof value.id === "string" && STABLE_NODE_ID.test(value.id) && typeof value.hostname === "string"
    && isTextOrNull(value.login) && isTextOrNull(value.seen_at) && typeof value.blocked === "boolean" && isTextOrNull(value.changed_at);
}

/** Null for a file that exists and cannot be trusted or parsed; an absent file holds no nodes. */
function readNodes(path: string): StoredTailnetNode[] | null {
  const refused = privateStateRefusal(path);
  if (refused !== null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return isJsonObject(parsed) && parsed.v === 1 && Array.isArray(parsed.nodes) && parsed.nodes.every(isStoredNode) ? parsed.nodes : null;
}

/** Null for a file that exists and cannot be trusted or parsed; an absent file holds no denials. */
function readDenials(path: string): { id: string; at: string }[] | null {
  if (privateStateRefusal(path) !== null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  return isJsonObject(parsed) && parsed.v === 1 && Array.isArray(parsed.denials)
    && parsed.denials.every((d) => isJsonObject(d) && typeof d.id === "string" && STABLE_NODE_ID.test(d.id) && typeof d.at === "string")
    ? parsed.denials as { id: string; at: string }[] : null;
}

const time = (at: string | null) => at === null ? -Infinity : Date.parse(at);

/** One node from two copies: the later block or Allow stands, and the later sighting names it. */
function mergeNode(a: StoredTailnetNode, b: StoredTailnetNode): StoredTailnetNode {
  const changed = time(b.changed_at) > time(a.changed_at) ? b : a;
  const seen = time(b.seen_at) > time(a.seen_at) ? b : a;
  return { id: a.id, hostname: seen.hostname, login: seen.login, seen_at: seen.seen_at, blocked: changed.blocked, changed_at: changed.changed_at };
}

function trimmed(nodes: readonly StoredTailnetNode[]): StoredTailnetNode[] {
  const blocked = nodes.filter((node) => node.blocked);
  const rest = nodes.filter((node) => !node.blocked).sort((a, b) => time(b.seen_at) - time(a.seen_at));
  return [...blocked, ...rest.slice(0, Math.max(0, TAILNET_NODES_MAX - blocked.length))];
}

/**
 * The blocked nodes of two state dirs that share one device registry (state-merge.ts), written to both, as their
 * tombstones are (devices.ts mergeAccountTombstones): a node blocked in either stays blocked in both, unless an Allow
 * came after. A sibling file that cannot be read is returned as the problem that keeps every tailnet grant shut.
 */
export function mergeTailnetNodes(active: string, sibling: string): string | null {
  const paths = [join(active, TAILNET_NODES_FILE), join(sibling, TAILNET_NODES_FILE)];
  const read = paths.map(readNodes);
  if (read[1] === null) return `Cannot read ${paths[1]}: no Tailscale login is let in until it is restored or fixed.`;
  if (read[0] === null) return null;
  const merged = new Map<string, StoredTailnetNode>();
  for (const node of read.flatMap((list) => list ?? [])) {
    const kept = merged.get(node.id);
    merged.set(node.id, kept === undefined ? node : mergeNode(kept, node));
  }
  const nodes = trimmed([...merged.values()]);
  const text = JSON.stringify(nodes);
  for (const [index, path] of paths.entries()) {
    if (JSON.stringify(read[index]) !== text) writePrivateState(path, { v: 1, nodes });
  }
  return null;
}

export class TailnetNodes {
  private nodes: StoredTailnetNode[] = [];
  private readonly path: string;
  private readonly pendingPath: string;
  private failure: string | null = null;
  /** the file itself could not be read: nothing is written over it, and a block stands as a pending denial instead */
  private readonly unreadable: boolean;
  /** the live connections and streams of each node, ended when it is blocked (DeviceStore.onRevoke does it for a row) */
  private readonly streams = new Map<string, Set<() => void>>();
  private asking: (TailnetNodePrompt & { readonly at: number }) | null = null;
  private readonly declined = new Map<string, number>();

  /**
   * `blocked`: a merge that could not be made, which keeps every tailnet grant shut like an unreadable file.
   * `sibling`: the state dir merged with this one, whose pending blocks are taken in too, read only: that dir drops them.
   */
  constructor(stateDir: string, blocked: string | null = null, private readonly now: () => number = Date.now, sibling: string | null = null) {
    this.path = join(stateDir, TAILNET_NODES_FILE);
    this.pendingPath = join(stateDir, TAILNET_PENDING_FILE);
    const read = readNodes(this.path);
    this.unreadable = read === null;
    if (read === null) this.failure = `Cannot read ${this.path}: no Tailscale login is let in until it is restored or fixed.`;
    else this.nodes = read;
    if (blocked !== null) this.failure ??= blocked;
    // the removals made while the list could not be read are blocked now, before any request is served (index.ts
    // builds this before it listens); they are dropped only once they stand in the list
    if (this.failure === null) {
      const paths = [this.pendingPath, ...sibling === null ? [] : [join(sibling, TAILNET_PENDING_FILE)]];
      const [own, other = []] = paths.map(readDenials);
      const unread = [own, other].findIndex((denials) => denials === null);
      if (unread >= 0) this.failure = `Cannot read ${paths[unread]}: no Tailscale login is let in until it is restored or fixed.`;
      else if (own!.length + other!.length > 0) {
        this.takeDenials([...own!, ...other!]);
        if (this.failure === null && own!.length > 0) rmSync(this.pendingPath, { force: true });
      }
    }
    if (this.failure !== null) console.error(this.failure);
  }

  get problem(): string | null { return this.failure; }

  /**
   * The nodes the durable denials name (removal evidence: an account record's drop carries its rows' nodes), taken in
   * at start: a node block that did not land with its drop is written now. An Allow written after a denial stands.
   */
  takeDenials(denials: readonly { readonly id: string; readonly at: string }[]): void {
    if (this.failure !== null) return;
    const latest = new Map<string, string>();
    for (const { id, at } of denials) if (STABLE_NODE_ID.test(id) && time(at) >= time(latest.get(id) ?? null)) latest.set(id, at);
    const due = [...latest].filter(([id, at]) => {
      const kept = this.nodes.find((node) => node.id === id);
      return kept === undefined || (!kept.blocked && time(kept.changed_at) < time(at));
    });
    if (due.length === 0) return;
    const next = this.nodes.map((own) => { const at = due.find(([id]) => id === own.id)?.[1]; return at === undefined ? own : { ...own, blocked: true, changed_at: at }; });
    for (const [id, at] of due) if (!next.some((own) => own.id === id)) next.push({ id, hostname: id, login: null, seen_at: null, blocked: true, changed_at: at });
    try { this.write(trimmed(next)); }
    catch (error) { this.failClosed(`The Tailscale devices a removal keeps out could not be written (${error instanceof Error ? error.message : String(error)}): no Tailscale login is let in until this PC restarts.`); }
  }

  /** Every node is kept out from now on, and every live connection of one ends: a block that should stand did not land. */
  failClosed(reason: string): void {
    this.failure ??= reason;
    console.error(this.failure);
    this.end([...this.streams.keys()]);
  }

  /** Ends `close` when the node `id` is blocked; returns its unsubscribe. */
  onBlocked(id: string, close: () => void): () => void {
    if (this.isBlocked(id)) { close(); return () => {}; }
    const set = this.streams.get(id) ?? new Set();
    set.add(close);
    this.streams.set(id, set);
    return () => { set.delete(close); if (set.size === 0 && this.streams.get(id) === set) this.streams.delete(id); };
  }

  private end(ids: readonly string[]): void {
    for (const id of ids) {
      const closes = this.streams.get(id);
      this.streams.delete(id);
      for (const close of closes ?? []) {
        try { close(); } catch (error) { console.warn(`[tailnet-nodes] a connection of ${id} did not end: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }

  /** Whether `id` is kept out; while the list cannot be read, every node is. */
  isBlocked(id: string): boolean {
    return this.problem !== null || this.nodes.some((node) => node.id === id && node.blocked);
  }

  /**
   * Whether `id`'s block is saved: what a removal needs before its row may go. Unlike isBlocked, the fail-closed state
   * after a failed write does not count, since that ends with this run.
   */
  holds(id: string): boolean {
    return this.nodes.some((node) => node.id === id && node.blocked);
  }

  /** Whether a node this PC cannot name must be kept out: one is blocked, or the list cannot be read. */
  anyBlocked(): boolean {
    return this.problem !== null || this.nodes.some((node) => node.blocked);
  }

  /** Every node seen so far, blocked or not: what Revoke all keeps out. */
  seenIds(): string[] { return this.nodes.map((node) => node.id); }

  hostnameOf(id: string): string { return this.nodes.find((node) => node.id === id)?.hostname ?? id; }

  /** A node of the owner's login got in: kept for the removal dialog and Revoke all. Not written more than hourly. */
  seen(node: TailnetNode): void {
    if (this.problem !== null) return;
    const at = this.now();
    const kept = this.nodes.find((own) => own.id === node.id);
    if (kept !== undefined && kept.hostname === node.hostname && kept.login === node.login && at - time(kept.seen_at) < SEEN_WRITE_MS) return;
    const next = { id: node.id, hostname: node.hostname, login: node.login, seen_at: new Date(at).toISOString(), blocked: kept?.blocked ?? false, changed_at: kept?.changed_at ?? null };
    try { this.write(trimmed([next, ...this.nodes.filter((own) => own !== kept)])); }
    catch (error) { console.warn(`[tailnet-nodes] a sighting was not saved: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Blocks the nodes named, in one durable write; one that cannot be written throws, and nothing is blocked. After an
   * earlier write failed (fail closed for this run) a block is still written, so a retried removal can stand.
   */
  block(nodes: readonly { readonly id: string; readonly hostname?: string }[]): string[] {
    const changedAt = new Date(this.now()).toISOString();
    if (this.unreadable) {
      // the list is never written over: the blocks stand as denials beside it, for the start that can read it again
      if (nodes.length === 0) return [];
      const pending = readDenials(this.pendingPath);
      if (pending === null) throw new Error(`Cannot read ${this.pendingPath}`);
      writePrivateState(this.pendingPath, { v: 1, denials: [...pending, ...nodes.map((node) => ({ id: node.id, at: changedAt }))] });
      this.end(nodes.map((node) => node.id));
      return nodes.map((node) => node.id);
    }
    const fresh = nodes.filter((node) => !this.holds(node.id));
    if (nodes.length === 0) return [];
    // every node named is stamped, one already blocked too: this removal is newer than any Allow a sibling holds
    const next = this.nodes.map((own) => nodes.some((node) => node.id === own.id) ? { ...own, blocked: true, changed_at: changedAt } : own);
    for (const node of nodes) {
      if (!next.some((own) => own.id === node.id)) next.push({ id: node.id, hostname: node.hostname ?? node.id, login: null, seen_at: null, blocked: true, changed_at: changedAt });
    }
    this.write(trimmed(next));
    if (this.asking !== null && !this.isBlocked(this.asking.id)) this.asking = null;
    // a block takes effect now: what the node has open ends, as a Revoke ends a row's sessions
    this.end(fresh.map((node) => node.id));
    return fresh.map((node) => node.id);
  }

  /** Takes `id` off the list, in one durable write (Allow on the card). */
  allow(id: string): void {
    if (this.problem !== null) throw new Error(this.problem);
    const changedAt = new Date(this.now()).toISOString();
    this.write(this.nodes.map((own) => own.id === id ? { ...own, blocked: false, changed_at: changedAt } : own));
    this.declined.delete(id);
  }

  /**
   * A blocked node asked to get in: it goes on the card unless another node's ask is still on it, or it was declined
   * lately. One at a time, so a flood of nodes cannot bury the one the owner is looking at.
   */
  ask(node: TailnetNode): void {
    const at = this.now();
    if (this.problem !== null || !this.isBlocked(node.id)) return;
    if (at - (this.declined.get(node.id) ?? -Infinity) < TAILNET_DECLINED_QUIET_MS) return;
    if (this.asking !== null && this.asking.id !== node.id && at - this.asking.at < TAILNET_PROMPT_MS) return;
    if (this.asking?.id === node.id) return;
    this.asking = { id: node.id, hostname: node.hostname, login: node.login, asked_at: new Date(at).toISOString(), at };
  }

  prompt(): TailnetNodePrompt | null {
    const asking = this.asking;
    if (asking === null || this.now() - asking.at >= TAILNET_PROMPT_MS || !this.isBlocked(asking.id)) return null;
    return { id: asking.id, hostname: asking.hostname, login: asking.login, asked_at: asking.asked_at };
  }

  decline(id: string): void {
    this.declined.set(id, this.now());
    if (this.asking?.id === id) this.asking = null;
  }

  settle(id: string): void { if (this.asking?.id === id) this.asking = null; }

  list(rowsOf: (id: string) => readonly string[]): TailnetNodeView[] {
    return [...this.nodes].sort((a, b) => time(b.seen_at) - time(a.seen_at))
      .map((node) => ({ id: node.id, hostname: node.hostname, login: node.login, seen_at: node.seen_at, blocked: node.blocked, rows: rowsOf(node.id) }));
  }

  private write(nodes: StoredTailnetNode[]): void {
    writePrivateState(this.path, { v: 1, nodes });
    this.nodes = nodes;
  }
}

export interface TailnetNodeRows {
  noteTailnetNode(rowId: string, nodeId: string): void;
  tailnetRowsOf(nodeId: string): string[];
  keepOutTailnetNodes(nodes: readonly { readonly id: string; readonly hostname?: string }[], row?: string | null): string[];
  allowTailnetNode(id: string): void;
}

/**
 * The tailnet half of the access decision, after decideAccess: a Tailscale grant from a blocked node becomes a
 * refusal and an ask on this PC's own window; a paired device's credential arriving over the tailnet records its node
 * on its row. `address` is the request's one tailnet source address (X-Forwarded-For from the local tailscaled), null
 * for every request that did not come that way. A node that cannot be named is let in as before only while no node is
 * blocked: with one blocked it might be that one. `node`: the StableNodeID of a request let in from the tailnet, whose
 * connections and streams end when that node is blocked.
 */
export async function tailnetNodeGate(access: Access, input: {
  readonly address: string | null;
  readonly owner: string | null;
  readonly nodes: TailnetNodes;
  readonly rows: Pick<TailnetNodeRows, "noteTailnetNode"> & { has(rowId: string): boolean };
  readonly whois: (address: string) => Promise<TailnetNode | null>;
}): Promise<{ readonly access: Access; readonly node: string | null }> {
  const as = (next: Access, node: string | null = null) => ({ access: next, node });
  if (access.level !== "full") return as(access);
  const { address, nodes } = input;
  if (access.via === "tailscale") {
    const node = address === null ? null : await input.whois(address);
    if (node === null) return as(nodes.anyBlocked() ? { level: "none", reason: "tailnet_blocked" } : access);
    if (nodes.isBlocked(node.id)) {
      nodes.ask(node);
      return as({ level: "none", reason: "tailnet_blocked" });
    }
    nodes.seen(node);
    return as(access, node.id);
  }
  if (access.via === "device" && access.device !== undefined && address !== null) {
    const node = await input.whois(address);
    // the row was matched before the WhoIs read: one removed meanwhile gets nothing, as its revoke already ended the rest
    if (!input.rows.has(access.device.id)) return as({ level: "none", reason: "pairing_required" });
    if (node === null) return as(access);
    input.rows.noteTailnetNode(access.device.id, node.id);
    if (node.login !== null && input.owner !== null && node.login.toLowerCase() === input.owner.toLowerCase()) nodes.seen(node);
    return as(access, node.id);
  }
  return as(access);
}

/**
 * /api/devices/tailnet-nodes*: this PC's own window alone reads the nodes and the card, blocks nodes from the removal
 * dialog, and answers the card; an answer is refused while the account lock stands.
 */
export async function handleTailnetNodeRequest(request: Request, pathname: string, input: {
  readonly nodes: TailnetNodes;
  readonly rows: TailnetNodeRows;
  readonly ownWindow: boolean;
  readonly locked: boolean;
}): Promise<Response> {
  const { nodes, rows } = input;
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const view = (): TailnetNodesAnswer => ({ pending: nodes.prompt(), nodes: nodes.list((id) => rows.tailnetRowsOf(id)) });
  setRequestRoute(pathname);
  if (!input.ownWindow) return fail("local_required", "Manage Tailscale devices on this PC's own screen.", 403);
  if (pathname === TAILNET_NODE_ROUTES.list) {
    if (request.method !== "GET") return fail("method_not_allowed", "use GET", 405);
    return reply(view());
  }
  if (pathname !== TAILNET_NODE_ROUTES.block && pathname !== TAILNET_NODE_ROUTES.answer) return fail("not_found", "no such route", 404);
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage devices from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (pathname === TAILNET_NODE_ROUTES.block) {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > TAILNET_NODES_MAX || !ids.every((id) => typeof id === "string" && STABLE_NODE_ID.test(id))) {
      return fail("request_invalid", "Name the Tailscale devices by their node ids", 400);
    }
    const known = new Set(nodes.seenIds());
    if (!ids.every((id: string) => known.has(id))) return fail("tailnet_node_unknown", "This PC has not seen that Tailscale device.", 404);
    rows.keepOutTailnetNodes(ids.map((id: string) => ({ id, hostname: nodes.hostnameOf(id) })));
    return reply(view());
  }
  // an Allow lets a node back in: never while the lock stands, whatever the window
  if (input.locked) return fail("locked", "Unlock this PC before you let a device back in.", 423);
  const { id, decision } = body;
  if (typeof id !== "string" || (decision !== "allow" && decision !== "decline")) return fail("request_invalid", "Send the node's id and a decision of allow or decline", 400);
  if (nodes.prompt()?.id !== id) return fail("tailnet_node_gone", "That device is no longer waiting.", 404);
  if (decision === "decline") nodes.decline(id);
  else {
    rows.allowTailnetNode(id);
    nodes.settle(id);
  }
  return reply(view());
}
