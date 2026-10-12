import { afterAll, describe, expect, it } from "bun:test";

import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// A remote bridge that answers like the local conversation route: an ETag, then 304 while unchanged.
const asked: (string | null)[] = [];
const remote = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/pane/conversation/image") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    if (path === "/api/pane/conversation/tool-output") return new Response("complete remote output", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === "/api/fs/file") return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    const ifNoneMatch = request.headers.get("if-none-match");
    asked.push(ifNoneMatch);
    if (ifNoneMatch === "\"v1\"") return new Response(null, { status: 304, headers: { etag: "\"v1\"" } });
    return Response.json({ source: "claude-transcript", turns: [] }, { headers: { etag: "\"v1\"" } });
  },
});
afterAll(() => remote.stop());

const manager = {
  endpoint: () => ({ url: `http://127.0.0.1:${remote.port}`, token: "remote-token" }),
  trackTerminal: () => () => undefined,
} as unknown as MachineManager;

describe("PC proxy", () => {
  it("carries a conversation's ETag both ways and passes an unchanged answer on as a bodyless 304", async () => {
    const url = "http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1";
    const first = await handleMachineRequest(new Request(url), manager);
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe("\"v1\"");
    await first.json();
    const unchanged = await handleMachineRequest(new Request(url, { headers: { "if-none-match": "\"v1\"" } }), manager);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe("\"v1\"");
    expect(await unchanged.text()).toBe("");
    expect(asked).toEqual([null, "\"v1\""]);
  });
});

it("forwards conversation images and complete output, while rejecting arbitrary nested paths", async () => {
  const base = "http://127.0.0.1/api/machines/pc1/pane/conversation";
  const image = await handleMachineRequest(new Request(`${base}/image?pane_id=w1:p1&ref=asset`), manager);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  const output = await handleMachineRequest(new Request(`${base}/tool-output?pane_id=w1:p1&ref=call`), manager);
  expect(output.status).toBe(200);
  expect(await output.text()).toBe("complete remote output");
  expect((await handleMachineRequest(new Request(`${base}/unknown`), manager)).status).toBe(404);
});

it("opens a PC's file from a navigation another site started, and keeps every other route to this app", async () => {
  // Chrome on Android shows a PDF in the viewer's frame as an "Open" button; its navigation is cross-site
  const file = "http://127.0.0.1/api/machines/pc1/fs/file?path=%2Ftmp%2Freport.pdf";
  for (const site of ["cross-site", "same-site"]) {
    const response = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": site, "sec-fetch-mode": "navigate" } }), manager);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.7");
  }
  const head = await handleMachineRequest(new Request(file, { method: "HEAD", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }), manager);
  // another page loading the file as a picture (a rendered HTML page probing which files exist) is not a navigation
  const probe = await handleMachineRequest(new Request(file, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } }), manager);
  expect(probe.status).toBe(403);
  expect((await probe.json()).error.code).toBe("cross_site");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toBe("application/pdf");
  const crossSite = { "sec-fetch-site": "cross-site" };
  for (const request of [
    new Request("http://127.0.0.1/api/machines/pc1/fs/stat?path=%2Ftmp%2Freport.pdf", { headers: crossSite }),
    new Request("http://127.0.0.1/api/machines/pc1/pane/conversation?pane_id=w1%3Ap1", { headers: crossSite }),
    new Request(file, { method: "POST", headers: { ...crossSite, "x-herdr-machine": "1" } }),
    new Request(file, { headers: { origin: "https://evil.invalid", "sec-fetch-site": "same-origin" }, method: "PUT" }),
  ]) {
    const response = await handleMachineRequest(request, manager);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
  }
});

it("refuses a path with an empty segment instead of forwarding it as another route", async () => {
  const before = asked.length;
  for (const path of ["pc1//fs/file?path=%2Fetc%2Fhostname", "pc1/fs//file?path=%2Fetc%2Fhostname", "pc1//session"]) {
    expect((await handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`), manager)).status).toBe(404);
  }
  expect(asked.length).toBe(before);
});
