import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { createServer } from "./index.ts";
import type { MachineManager } from "./machines.ts";
import { PortalService } from "./portal.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";

// Pairing this PC's server with another PC of the account (docs/account.md, "Adding a PC of your account") is the
// owner's, from a device that drives this PC: this PC itself, the token, the owner's Tailscale login, a device paired
// with it that drives, directly or over the relay (the hosted shell and the phone reach this PC only that way). Never an
// open LAN window, a Portal visitor or a device that only watches: none of them may have this PC pair itself with a PC
// they name, here or on another PC of this one's through it.
afterAll(unitHerdrOnly());
const root = mkdtempSync(join(tmpdir(), "ovis-account-pc-owner-"));
const TOKEN = "fictional-owner-token";
const open = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "open"), token: "", tailscaleOwner: "owner@example.com", machines: false, sidecar: false });
const portal = new PortalService({ stateDir: join(root, "secured") });
const secured = createServer({ port: 0, hostname: "0.0.0.0", stateDir: join(root, "secured"), portal, token: TOKEN, tailscaleOwner: null, machines: false, sidecar: false });
afterAll(() => { open.stop(); secured.stop(); rmSync(root, { recursive: true, force: true }); });
const reached: string[] = [];
// "desk", a PC of this one's: what this PC's proxy asks of it, and its comparison, which waits on `compared` once it told the digits
const asked: { path: string; machine: string | null; update: string | null; body: unknown }[] = [];
let compared = Promise.resolve();
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  asked.push({ path, machine: request.headers.get("x-herdr-machine"), update: request.headers.get("x-herdr-update"), body: await request.json() });
  if (!path.endsWith("/pair")) return Response.json({ path });
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(encoder.encode('{"digits":"123456"}\n'));
    await compared;
    controller.enqueue(encoder.encode('{"machine":{"id":"added"}}\n'));
    controller.close();
  } }), { headers: { "content-type": "application/x-ndjson" } });
} });
afterAll(() => upstream.stop(true));
const manager = {
  list: () => [],
  checkAccountPcs: async () => { reached.push("check"); return []; },
  startAccountPc: async () => { reached.push("start"); return { ticket: "t", key: "k", label: "l" }; },
  pairAccountPc: async () => { reached.push("pair"); throw new Error("not under test"); },
  endpoint: (id: string) => id === "desk" ? { url: `http://127.0.0.1:${upstream.port}`, token: "desk-token" } : undefined,
  retryNow: () => {},
} as unknown as MachineManager;
const vouches = spyOn(portal, "vouches").mockImplementation((proof) => proof === "valid-proof");
const roleFor = spyOn(portal, "roleFor").mockReturnValue("drive");
afterAll(() => { vouches.mockRestore(); roleFor.mockRestore(); });
const store = secured.context.services.devices;
const pairDevice = (label: string, role: "drive" | "watch"): string => {
  const token = store.pair(store.startPairing().code, label, role)!.token;
  store.match(token);
  return token;
};
const driveDevice = pairDevice("Owner's laptop", "drive");
const watchDevice = pairDevice("Wall screen", "watch");

const OWNERS = ["this PC", "the token", "a Tailscale login", "a paired device that drives", "a relay device that drives"] as const;
const OTHERS = ["an open LAN visitor", "a Portal visitor that drives", "a paired device that watches", "a relay device that watches"] as const;
const REFUSAL = { "an open LAN visitor": "owner_only", "a Portal visitor that drives": "owner_only", "a paired device that watches": "read_only", "a relay device that watches": "read_only" } as const;
type Kind = typeof OWNERS[number] | typeof OTHERS[number];
const lan = { address: "192.168.0.20", family: "IPv4", port: 1 };
const loopback = { address: "127.0.0.1", family: "IPv4", port: 1 };

function contextFor(kind: Kind): ServerContext {
  const onOpen = kind === "this PC" || kind === "a Tailscale login" || kind === "an open LAN visitor";
  const app = onOpen ? open : secured;
  const base = { ...app.context, services: { ...app.context.services, core: { ...app.context.services.core, machines: manager } }, timeout: () => {} };
  if (kind === "a relay device that drives" || kind === "a relay device that watches") {
    const role = kind === "a relay device that drives" ? "drive" as const : "watch" as const;
    return { ...base, peer: { kind: "relay", device: { id: "0123456789abcdef", label: "Phone", role }, sessionId: "s", serverId: "0123456789abcdef0123456789abcdef", key: "" }, requestIP: () => null };
  }
  return { ...base, requestIP: () => kind === "this PC" || kind === "a Tailscale login" ? loopback : lan };
}
function headersFor(kind: Kind): Record<string, string> {
  const origin = { origin: "http://127.0.0.1", host: "127.0.0.1", "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" };
  switch (kind) {
    case "the token": return { ...origin, authorization: `Bearer ${TOKEN}` };
    case "a Tailscale login": return { ...origin, "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1" };
    case "a paired device that drives": return { ...origin, cookie: `ovis_device=${driveDevice}` };
    case "a paired device that watches": return { ...origin, cookie: `ovis_device=${watchDevice}` };
    case "a Portal visitor that drives": return { ...origin, "x-portal-proof": "valid-proof", "x-portal-user": "visitor", "x-portal-auth": "credential" };
    default: return origin;
  }
}
const BODIES = { check: { pcs: [] }, start: { pc: {} }, pair: { ticket: "t" } } as const;
const ROUTES = ["check", "start", "pair"] as const;
/** this PC's route, or the same route of "desk" through this PC's proxy */
const send = async (kind: Kind, route: keyof typeof BODIES, on: "here" | "desk") => {
  const path = on === "here" ? `/api/machines/relay/account/${route}` : `/api/machines/desk/machines/relay/account/${route}`;
  const response = await handleRequest(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: headersFor(kind), body: JSON.stringify(BODIES[route]) }), contextFor(kind));
  if (!response) throw new Error("no answer");
  return response;
};
const ask = async (kind: Kind, route: keyof typeof BODIES, on: "here" | "desk" = "here") => {
  const response = await send(kind, route, on);
  const text = await response.text();
  return response.ok ? response.status : [response.status, (JSON.parse(text) as { error: { code: string } }).error.code];
};

it("lets the owner's windows and devices that drive this PC ask whether PCs of the account would pair, start a pairing and compare its digits", async () => {
  for (const kind of OWNERS) for (const route of ROUTES) {
    reached.length = 0;
    expect([kind, route, await ask(kind, route), reached]).toEqual([kind, route, 200, [route]]);
  }
});

it("never lets an open LAN window, a Portal visitor or a watching device reach it", async () => {
  for (const kind of OTHERS) for (const route of ROUTES) {
    reached.length = 0;
    expect([kind, route, await ask(kind, route), reached]).toEqual([kind, route, [403, REFUSAL[kind]], []]);
  }
});

it("asks another PC of this one's the same through this PC, for the same devices only", async () => {
  for (const kind of OWNERS) for (const route of ROUTES) {
    asked.length = 0;
    // that PC's mutation guard and update guard are this PC's to send: it checked the caller
    expect([kind, route, await ask(kind, route, "desk"), asked]).toEqual([kind, route, 200,
      [{ path: `/api/machines/relay/account/${route}`, machine: "1", update: "1", body: BODIES[route] }]]);
  }
  for (const kind of OTHERS) for (const route of ROUTES) {
    asked.length = 0;
    expect([kind, route, await ask(kind, route, "desk"), asked]).toEqual([kind, route, [403, REFUSAL[kind]], []]);
  }
});

it("passes that PC's digits on while its comparison still waits for a member", async () => {
  const approval = deferred<void>();
  compared = approval.promise;
  try {
    const response = await send("a relay device that drives", "pair", "desk");
    expect([response.status, response.headers.get("content-type")]).toEqual([200, "application/x-ndjson"]);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await bounded(reader.read())).value).toBe('{"digits":"123456"}\n');
    approval.resolve();
    let rest = "";
    for (let chunk = await bounded(reader.read()); !chunk.done; chunk = await bounded(reader.read())) rest += chunk.value;
    expect(rest).toBe('{"machine":{"id":"added"}}\n');
  } finally {
    approval.resolve();
    compared = Promise.resolve();
  }
});
