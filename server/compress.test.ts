import { expect, spyOn, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import { compressResponse } from "./compress.ts";

const asks = (path = "/api/pane/conversation", encoding = "gzip, deflate, br") => new Request(`http://local${path}`, { headers: { "accept-encoding": encoding } });
const json = (size: number) => new Response(JSON.stringify({ turns: "x".repeat(size) }), { headers: { "content-type": "application/json; charset=utf-8", etag: '"v1"' } });

test("gzips a large JSON answer for a browser that takes it, keeping its headers", async () => {
  const response = (await compressResponse(asks(), json(50_000)))!;
  expect(response.headers.get("content-encoding")).toBe("gzip");
  // the gzipped bytes are another representation: the tag goes weak
  expect(response.headers.get("etag")).toBe('W/"v1"');
  expect(response.headers.get("vary")).toContain("accept-encoding");
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body.byteLength).toBeLessThan(5_000);
  expect(JSON.parse(gunzipSync(body).toString()).turns.length).toBe(50_000);
});

test("reads Accept-Encoding qualities: q=0 refuses gzip, * takes it unless gzip is refused by name", async () => {
  const encoding = async (accept: string) => (await compressResponse(asks("/api/pane/conversation", accept), json(50_000)))!.headers.get("content-encoding");
  expect(await encoding("gzip;q=0")).toBeNull();
  expect(await encoding("br, gzip; q=0.0")).toBeNull();
  expect(await encoding("*;q=1, gzip;q=0")).toBeNull();
  expect(await encoding("gzip;q=0.5")).toBe("gzip");
  expect(await encoding("*")).toBe("gzip");
  expect(await encoding("identity, gzipped")).toBeNull();
});

test("says Vary: accept-encoding on the plain answer and a 304 too, not only on the gzipped one", async () => {
  const plain = (await compressResponse(asks("/assets/app.js", "identity"), json(50_000)))!;
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(plain.headers.get("vary")).toContain("accept-encoding");
  expect(await plain.text()).toContain("xxx");
  const head = (await compressResponse(new Request("http://local/api/pane/conversation", { method: "HEAD", headers: { "accept-encoding": "gzip" } }), json(50_000)))!;
  expect(head.headers.get("vary")).toContain("accept-encoding");
  const notModified = (await compressResponse(asks(), new Response(null, { status: 304, headers: { etag: 'W/"v1"' } })))!;
  expect(notModified.status).toBe(304);
  expect(notModified.headers.get("vary")).toContain("accept-encoding");
});

test("an /api answer is never served from another answer's gzip, even when their hashes collide", async () => {
  // Bun.hash is not collision-resistant: two different answers that hash alike must still come back as their own
  const hash = spyOn(Bun, "hash").mockReturnValue(1);
  try {
    for (const turns of ["a", "b"]) {
      const response = (await compressResponse(asks(), new Response(JSON.stringify({ turns: turns.repeat(5_000) }), { headers: { "content-type": "application/json" } })))!;
      expect(JSON.parse(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).turns[0]).toBe(turns);
    }
  } finally { hash.mockRestore(); }
});

test("a static bundle's gzip is kept and served again by its content", async () => {
  const script = () => new Response("console.log(1);".repeat(500), { headers: { "content-type": "text/javascript" } });
  const first = new Uint8Array(await (await compressResponse(asks("/assets/a.js"), script()))!.arrayBuffer());
  const again = new Uint8Array(await (await compressResponse(asks("/assets/b.js"), script()))!.arrayBuffer());
  expect(again).toEqual(first);
  expect(gunzipSync(again).toString()).toBe("console.log(1);".repeat(500));
});

test("a body that fails to read answers in the error envelope, not with a rejection", async () => {
  const broken = new Response(new ReadableStream({ pull(controller) { controller.error(new Error("file went away")); } }), { headers: { "content-type": "text/javascript" } });
  const console_ = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = (await compressResponse(asks("/assets/gone.js"), broken))!;
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("internal_error");
  } finally { console_.mockRestore(); }
});

test("leaves alone what it must not touch", async () => {
  expect((await compressResponse(asks("/x", "identity"), json(50_000)))!.headers.get("content-encoding")).toBeNull();
  expect((await compressResponse(asks(), json(10)))!.headers.get("content-encoding")).toBeNull();
  const stream = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
  expect(await compressResponse(asks("/api/machines/events"), stream)).toBe(stream);
  const image = new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } });
  expect(await compressResponse(asks(), image)).toBe(image);
  const file = new Response("y".repeat(50_000), { headers: { "content-type": "text/plain" } });
  expect(await compressResponse(asks("/api/fs/file"), file)).toBe(file);
  expect(await compressResponse(asks(), undefined)).toBeUndefined();
});
