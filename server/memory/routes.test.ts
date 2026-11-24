import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryItem, MemoryView } from "../../shared/memory.ts";
import { createServer } from "../index.ts";
import { formatEntry } from "./entry.ts";

const BROWSER_TOKEN = "memory-browser-token";
const BRIDGE_TOKEN = "b".repeat(64);
const WATCH_TOKEN = "w".repeat(64);

describe("/api/memory", () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  let state: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${BROWSER_TOKEN}` }) =>
    fetch(url(path), { method: "POST", headers: { ...headers, origin: url(""), "content-type": "application/json" }, body: JSON.stringify(body) });
  const view = async (): Promise<MemoryView> => (await (await fetch(url("/api/memory"), { headers: { authorization: `Bearer ${BROWSER_TOKEN}` } })).json()) as MemoryView;
  const codeOf = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-memory-route-"));
    state = join(root, "state");
    mkdirSync(state);
    writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: BROWSER_TOKEN, bridgeToken: BRIDGE_TOKEN, machines: false, sidecar: false, tailscaleOwner: null });
  });
  afterAll(() => {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("adds a note from a screen and lists it, uncached", async () => {
    const added = await post("/api/memory/add", { scope: "account", project: null, kind: "preference", title: "Answer in Korean.", body: "", expires: null });
    expect(added.status).toBe(200);
    expect(((await added.json()) as MemoryItem).state).toBe("confirmed");
    const listed = await fetch(url("/api/memory"), { headers: { authorization: `Bearer ${BROWSER_TOKEN}` } });
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(((await listed.json()) as MemoryView).items.map((item) => item.title)).toEqual(["Answer in Korean."]);
  });

  it("confirms an inbox note from a screen only: the bridge token and a watching device cannot", async () => {
    const id = "01KA81B6YH3D0V7KQ2MZT4NPRS";
    mkdirSync(join(state, "memory", "inbox"), { recursive: true });
    writeFileSync(join(state, "memory", "inbox", `${id}.md`), formatEntry({
      v: 1, id, scope: "machine", project: null, kind: "fact", key: "notes.folder", title: "Meeting notes go in notes/ by date.", verified: false,
      verified_at: null, verified_by: null, expires: null, rev: 1, updated_at: new Date().toISOString(), updated_on: "m_x", source_ref: null, replaces: null,
      origin: { by: "human", surface: "cli", at: new Date().toISOString() }, body: "", extra: {},
    }));
    const digest = (await view()).items.find((item) => item.id === id)!.digest;
    expect((await post("/api/memory/confirm", { id, digest }, { authorization: `Bearer ${BRIDGE_TOKEN}` })).status).toBe(401);
    expect(await codeOf(await post("/api/memory/confirm", { id, digest }, { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9" }))).toEqual([403, "read_only"]);
    expect((await view()).items.find((item) => item.id === id)?.state).toBe("unconfirmed");
    expect(await codeOf(await post("/api/memory/confirm", { id, digest: "0".repeat(64) }))).toEqual([409, "memory_conflict"]);
    expect((await post("/api/memory/confirm", { id, digest })).status).toBe(200);
    expect((await view()).items.find((item) => item.id === id)?.state).toBe("confirmed");
  });

  it("answers a refused secret with its rule and no part of the value", async () => {
    const response = await post("/api/memory/add", { scope: "account", project: null, kind: "fact", title: "CI", body: "password: correct-horse-battery", expires: null });
    const body = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(body)).toMatchObject({ error: { code: "secret_found", rule: "secret_assignment" } });
    expect(body).not.toContain("correct-horse");
  });

  it("refuses a body that is not a note, and a method or path it does not serve", async () => {
    expect(await codeOf(await post("/api/memory/add", { scope: "galaxy", title: "x" }))).toEqual([400, "invalid_memory"]);
    expect(await codeOf(await fetch(url("/api/memory/add"), { headers: { authorization: `Bearer ${BROWSER_TOKEN}` } }))).toEqual([405, "method_not_allowed"]);
    expect(await codeOf(await post("/api/memory/purge", {}))).toEqual([404, "not_found"]);
  });
});
