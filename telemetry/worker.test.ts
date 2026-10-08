import { describe, expect, test } from "bun:test";
import { handle, readEvent, type Env } from "./worker.ts";

const event = {
  event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", version: "0.4.2", previous_version: "0.4.1",
  os: "linux", arch: "x64", install_method: "plugin",
};
const now = new Date("2026-10-08T13:45:00Z");

function fakeDb() {
  const rows: { query: string; values: unknown[] }[] = [];
  const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => { rows.push({ query, values }); return {}; } }) }) } };
  return { env, rows };
}

const post = (body: string, type = "application/json") =>
  new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" }, body });

describe("telemetry receiver", () => {
  test("stores the event's fields and the day, never the address", async () => {
    const { env, rows } = fakeDb();
    const response = await handle(post(JSON.stringify(event)), env, now);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT OR IGNORE");
    expect(rows[0]!.values).toEqual(["2026-10-08", "update", event.install_id, "0.4.2", "0.4.1", "linux", "x64", "plugin"]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
  });

  test("refuses what is not one event", async () => {
    const { env, rows } = fakeDb();
    for (const body of [
      "not json", "[]",
      JSON.stringify({ ...event, event: "heartbeat" }),
      JSON.stringify({ ...event, install_id: "me@example.com" }),
      JSON.stringify({ ...event, version: "latest" }),
      JSON.stringify({ ...event, event: "install" }),
      JSON.stringify({ ...event, os: "Linux 6.8 my-laptop" }),
      JSON.stringify({ ...event, install_method: "docker" }),
    ]) expect((await handle(post(body), env, now)).status).toBe(400);
    expect((await handle(post(JSON.stringify(event), "text/plain"), env, now)).status).toBe(415);
    expect((await handle(post(JSON.stringify({ ...event, pad: "x".repeat(4096) })), env, now)).status).toBe(413);
    expect((await handle(new Request("https://receiver.test/v1/events"), env, now)).status).toBe(405);
    expect((await handle(new Request("https://receiver.test/"), env, now)).status).toBe(404);
    expect(rows).toEqual([]);
  });

  test("refuses an oversized body before it ends", async () => {
    const { env, rows } = fakeDb();
    // 4 KB arrive and the stream never closes: the answer must not wait for the rest
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4096).fill(0x20)); } });
    const request = new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    expect((await handle(request, env, now)).status).toBe(413);
    expect(rows).toEqual([]);
  });

  test("a prerelease version is one event too, so its sender is not refused at every start", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify({ ...event, version: "0.5.0-rc.1" })), env, now)).status).toBe(204);
    expect(rows[0]!.values[3]).toBe("0.5.0-rc.1");
    expect(readEvent({ ...event, version: "0.5.0-rc.1; DROP" }, now)).toBeNull();
  });

  test("an install has no previous version", () => {
    expect(readEvent({ ...event, event: "install", previous_version: null }, now)).toMatchObject({ event: "install", previous_version: null });
  });
});
