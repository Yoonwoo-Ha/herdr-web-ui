import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import {
  listPendingQuestionForms,
  opencodeAuthHeader,
  opencodeStateDir,
  readOpenCodeService,
  replyOpenCodeForm,
  type OpenCodeServiceConfig,
} from "./opencode-service.ts";

async function withService(handler: (request: Request) => Response | Promise<Response>, run: (config: OpenCodeServiceConfig) => Promise<void>): Promise<void> {
  const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try {
    await run({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "test-pass" });
  } finally { service.stop(true); }
}

describe("opencode-service", () => {
  it.skipIf(process.platform !== "linux")("closes connections after a timeout before response headers", async () => {
    const sockets = new Set<Socket>();
    const connected = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    let requests = 0;
    let disconnects = 0;
    const socketCount = () => readdirSync("/proc/self/fd").filter((fd) => {
      try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:"); }
      catch { return false; } // The directory read's own descriptor has already closed.
    }).length;
    // A wedged service does not send its half of the FIN handshake.
    const service = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("data", () => { if (++requests === 5) connected.resolve(); });
      socket.once("end", () => { if (++disconnects === 5) ended.resolve(); });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const address = service.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const before = socketCount();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = { baseUrl: `http://127.0.0.1:${address.port}`, port: address.port, pid: process.pid, password: "fixture" };
      const result = Promise.all(Array.from({ length: 5 }, () => listPendingQuestionForms(config, "session")));
      await connected.promise;
      expect(socketCount() - before - sockets.size).toBe(5);
      expect(await result).toEqual([null, null, null, null, null]);
      // Subscribe before the request; the bound is a failure deadline, not a delay.
      await Promise.race([ended.promise, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Timed-out client did not disconnect")), 500);
      })]);
      // Discount the fixture's accepted socket, which deliberately stays half open.
      expect(socketCount() - before - sockets.size).toBe(0);
    } finally {
      clearTimeout(deadline);
      for (const socket of sockets) socket.destroy();
      service.close();
    }
  }, 4_000);
  it("sends native credentials and answers directly despite proxy environment variables", async () => {
    const direct: string[] = [];
    const proxied: string[] = [];
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        direct.push(request.method);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    const proxy = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        proxied.push(new URL(request.url).pathname);
        return request.method === "GET" ? Response.json([]) : new Response(null, { status: 204 });
      },
    });
    try {
      const config = { baseUrl: service.url.origin, port: service.port, pid: process.pid, password: "fixture-secret" };
      const child = Bun.spawn([process.execPath, "-e", `
        import { listPendingQuestionForms, replyOpenCodeForm } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")};
        const config = ${JSON.stringify(config)};
        await fetch(config.baseUrl + "/control");
        console.log(JSON.stringify([await listPendingQuestionForms(config, "session"), await replyOpenCodeForm(config, "session", "form", {q0:"fixture-answer"})]));
      `], {
        env: { ...process.env, http_proxy: proxy.url.origin, HTTP_PROXY: proxy.url.origin, https_proxy: proxy.url.origin, HTTPS_PROXY: proxy.url.origin, ALL_PROXY: proxy.url.origin, all_proxy: proxy.url.origin, NO_PROXY: "", no_proxy: "" },
        stdout: "pipe", stderr: "pipe", timeout: 4_000,
      });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual([[], { ok: true, status: 204 }]);
      expect(proxied).toEqual(["/control"]);
      expect(direct).toEqual(["GET", "POST"]);
    } finally { service.stop(true); proxy.stop(true); }
  });
  it.each(["http://localhost:4000", "https://127.0.0.1:4000", "http://example.com:4000", "file:///tmp/service", "not a URL"])("rejects untrusted service URL %s even with a port", (url) => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url, port: 4000, pid: process.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects oversized service files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "x".repeat(65_536) }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects dead process ids", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    try {
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: child.pid, password: "fixture" }));
      expect(readOpenCodeService(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for its writer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    const path = join(tmp, "service.json");
    const child = Bun.spawn(["mkfifo", path], { stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).toBe(0);
    const reader = Bun.spawn([process.execPath, "-e", `import { readOpenCodeService } from ${JSON.stringify(import.meta.dir + "/opencode-service.ts")}; console.log(JSON.stringify(readOpenCodeService(${JSON.stringify(tmp)})));`], { stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => reader.kill(), 1_000);
    try {
      expect(await reader.exited).toBe(0);
      expect(await new Response(reader.stdout).text()).toBe("null\n");
    } finally {
      clearTimeout(deadline);
      reader.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed question fields at the HTTP boundary", async () => {
    const service = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch: () => Response.json([{ id: "form", sessionID: "session", title: "Form", metadata: { kind: "question" }, fields: [null] }]),
    });
    try {
      expect(await listPendingQuestionForms({ baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" }, "session")).toEqual([]);
    } finally { service.stop(true); }
  });

  it("does not follow redirects with a user's answers", async () => {
    let forwarded = 0;
    const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { forwarded++; return new Response(null, { status: 204 }); } });
    const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: target.url.href } }) });
    try {
      const config = { baseUrl: service.url.origin, port: service.port ?? 0, pid: process.pid, password: "fixture" };
      expect(await listPendingQuestionForms(config, "session")).toBeNull();
      expect(await replyOpenCodeForm(config, "session", "form", { q0: "private" })).toEqual({ ok: false, status: 307 });
      expect(forwarded).toBe(0);
    } finally { service.stop(true); target.stop(true); }
  });
  it("resolves state dir from XDG_STATE_HOME or home directory", () => {
    expect(opencodeStateDir({ XDG_STATE_HOME: "/custom/state" }, "/home/user")).toBe("/custom/state/opencode");
    expect(opencodeStateDir({}, "/home/user")).toBe("/home/user/.local/state/opencode");
  });

  it("reads service.json when valid and returns null on missing or invalid file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "opencode-service-test-"));
    try {
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), "invalid json");
      expect(readOpenCodeService(tmp)).toBeNull();

      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: 1234 }));
      expect(readOpenCodeService(tmp)).toBeNull();

      // With port
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ port: 4000, pid: process.pid, password: "test-password" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:4000", port: 4000, pid: process.pid, password: "test-password" });

      // With url (OpenCode 2.0.32 format)
      writeFileSync(join(tmp, "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", pid: process.pid, password: "secret" }));
      expect(readOpenCodeService(tmp)).toEqual({ baseUrl: "http://127.0.0.1:49374", port: 49374, pid: process.pid, password: "secret" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("formats Basic auth header correctly", () => {
    expect(atob(opencodeAuthHeader("secret-pass").slice(6))).toBe("opencode:secret-pass");
  });

  it.each(["array", "wrapper"])("lists and filters pending question forms in a %s", async (shape) => {
    let requestedUrl = "";
    let authHeader = "";
    await withService((request) => {
      requestedUrl = new URL(request.url).pathname;
      authHeader = request.headers.get("authorization") ?? "";
      const forms = [
          {
            id: "form-1",
            sessionID: "ses-123",
            title: "Question Form",
            metadata: { kind: "question" },
            fields: [{ key: "q0", type: "string", title: "Favorite color?" }],
          },
          {
            id: "form-2",
            sessionID: "ses-123",
            title: "Permission Form",
            metadata: { kind: "permission" },
            fields: [{ key: "allow", type: "boolean" }],
          },
          {
            id: "form-3",
            sessionID: "ses-123",
            title: "Unknown Form",
            fields: [],
          },
      ];
      return Response.json(shape === "array" ? forms : { data: forms });
    }, async (config) => {
      const forms = await listPendingQuestionForms(config, "ses-123");
      expect(requestedUrl).toBe("/api/session/ses-123/form");
      expect(atob(authHeader.slice(6))).toBe("opencode:test-pass");
      expect(forms?.length).toBe(1);
      expect(forms?.[0]?.id).toBe("form-1");
    });
  });

  it("handles non-200 responses when listing forms gracefully", async () => {
    await withService(() => new Response("Error", { status: 500 }), async (config) => {
      expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
    });
  });

  it("returns empty array for successful responses with no question forms", async () => {
    await withService(() => Response.json([]), async (config) => {
      expect(await listPendingQuestionForms(config, "ses-123")).toEqual([]);
    });
  });

  it("replies to forms with correct payload and headers", async () => {
    let postedBody = "";
    let authHeader = "";
    await withService(async (request) => {
      postedBody = await request.text();
      authHeader = request.headers.get("authorization") ?? "";
      expect(new URL(request.url).pathname).toBe("/api/session/ses-123/form/form-1/reply");
      return new Response(null, { status: 204 });
    }, async (config) => {
      const result = await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue", q1: ["A", "B"] });
      expect(result).toEqual({ ok: true, status: 204 });
      expect(atob(authHeader.slice(6))).toBe("opencode:test-pass");
      expect(JSON.parse(postedBody)).toEqual({ answer: { q0: "Blue", q1: ["A", "B"] } });
    });
  });

  it("handles reply errors such as 409 FormAlreadySettledError", async () => {
    await withService(() => Response.json({ error: "FormAlreadySettledError" }, { status: 409 }), async (config) => {
      expect(await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue" })).toEqual({ ok: false, status: 409 });
    });
  });

  it("rejects invalid JSON and oversized form responses", async () => {
    for (const body of ["not JSON", JSON.stringify({ data: [], padding: "x".repeat(2 * 1024 * 1024) })]) {
      await withService(() => new Response(body), async (config) => {
        expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
      });
    }
  });

  it("aborts the active native request when its caller cancels", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    await withService(() => { entered.resolve(); return release.promise; }, async (config) => {
      const controller = new AbortController();
      const listing = listPendingQuestionForms(config, "ses-123", controller.signal);
      await entered.promise;
      controller.abort();
      try { expect(await listing).toBeNull(); }
      finally { release.resolve(Response.json([])); }
    });
  });

  it("bounds a form response that sends headers but never finishes its body", async () => {
    let close: (() => void) | undefined;
    await withService(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("[")); close = () => controller.close(); },
      cancel() { close = undefined; },
    })), async (config) => {
      const start = performance.now();
      try {
        expect(await listPendingQuestionForms(config, "ses-123")).toBeNull();
        expect(performance.now() - start).toBeLessThan(2_500);
      } finally { close?.(); }
    });
  }, 3_000);

  it("accepts successful reply headers without waiting for an unused body", async () => {
    let close: (() => void) | undefined;
    await withService(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("accepted")); close = () => controller.close(); },
      cancel() { close = undefined; },
    })), async (config) => {
      try {
        expect(await replyOpenCodeForm(config, "ses-123", "form-1", { q0: "Blue" })).toEqual({ ok: true, status: 200 });
      } finally { close?.(); }
    });
  });

});
