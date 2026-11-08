import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CLIProxyLogin } from "../shared/protocol.ts";
import { requiresAuth } from "./auth.ts";
import { CLIProxyService } from "./cliproxy.ts";
import { startFakeCLIProxy } from "./cliproxy.fake.ts";
import { CLIProxyRoutes } from "./cliproxy-routes.ts";
import { createServer } from "./index.ts";
import { FRESH_MS, UsageService, type UsageContext } from "./usage.ts";

const KEY = "test-management-secret-not-in-responses";
let dir: string;
let fake: ReturnType<typeof startFakeCLIProxy>;
let service: CLIProxyService;
let routes: CLIProxyRoutes;
const call = (path = "", init: RequestInit = {}) => routes.handle(new Request(`http://localhost/api/cliproxy${path}`, init));
const send = (path: string, body: unknown) => call(path, { method: path ? "POST" : "PUT", body: JSON.stringify(body) });
const configure = (key = KEY) => send("", { url: fake.server.url.origin, management_key: key });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cliproxy-test-"));
  fake = startFakeCLIProxy(KEY); service = new CLIProxyService(dir); routes = new CLIProxyRoutes(service);
});
afterEach(() => { fake.server.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("CLIProxyAPI v8", () => {
  it.each([
    ["invalid JSON", `garbage ${KEY}`],
    ["invalid fields", JSON.stringify({ url: 42, management_key: KEY })],
    ["invalid URL", JSON.stringify({ url: "not-a-url", management_key: KEY })],
    ["unreadable file", null],
  ])("treats the hub as unconfigured when configuration has %s", async (_name, content) => {
    // Given
    const path = join(dir, "cliproxy.json");
    if (content === null) mkdirSync(path);
    else writeFileSync(path, content);
    // When
    const restored = new CLIProxyService(dir);
    const response = await new CLIProxyRoutes(restored).handle(new Request("http://localhost/api/cliproxy"));
    const status = await response.json();
    // Then
    expect(response.status).toBe(200);
    expect(status).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(await restored.report()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("starts the web UI and allows removal when hub configuration is corrupt", async () => {
    // Given
    writeFileSync(join(dir, "cliproxy.json"), "garbage");
    // When
    const app = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: dir,
      machines: false, registerBridge: false, terminalAttach: false, sidecar: false,
    });
    // Then
    try {
      const origin = `http://127.0.0.1:${app.port}`;
      expect((await fetch(`${origin}/api/health?scope=bridge`)).status).toBe(200);
      const status = await fetch(`${origin}/api/cliproxy`);
      expect(await status.json()).toMatchObject({ configured: false, ok: false, problem: expect.any(String) });
      const removed = await fetch(`${origin}/api/cliproxy`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ configured: false, problem: null });
      expect(new CLIProxyService(dir).status()).toMatchObject({ configured: false, problem: null });
    } finally { app.stop(); }
  });

  it("checks saved and reloaded connections without fetching provider usage", async () => {
    await configure();
    expect(await (await call()).json()).toMatchObject({ configured: true, ok: true });
    const restored = new CLIProxyRoutes(new CLIProxyService(dir));
    const response = await restored.handle(new Request("http://localhost/api/cliproxy"));
    expect(await response.json()).toMatchObject({ configured: true, ok: true });
    expect(fake.calls.map((entry) => entry.path)).toEqual(["/credentials", "/credentials"]);
  });

  it("reports separate email accounts using existing windows when configured", async () => {
    // Given
    await configure();
    // When
    const report = await service.report();
    // Then
    expect(report.map((entry) => [entry.key, entry.account, entry.windows[0]?.used_percent])).toEqual([
      ["claude:cliproxy:claude-a.json", "claude-a@example.test", 25],
      ["codex:cliproxy:codex-b.json", "codex-b@example.test", 32],
    ]);
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => entry.body)).toEqual([
      expect.objectContaining({ auth_index: "a", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" }) }),
      expect.objectContaining({ auth_index: "b", header: expect.objectContaining({ authorization: "Bearer $TOKEN$", "chatgpt-account-id": "workspace-b" }) }),
    ]);
  });

  it("asks the hub nothing for hidden accounts and keeps their last rows, until one is shown again", async () => {
    // Given
    await configure();
    const ctx: UsageContext = { home: dir, env: {}, platform: "linux", fetch, now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true };
    const usage = new UsageService(ctx, [], (refresh, skipped) => service.report(refresh, skipped));
    let skipped = new Set<string>();
    usage.skipAccounts(() => skipped);
    const asked = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").length;
    const start = Date.now();
    try {
      const first = await usage.report();
      expect(asked()).toBe(2);
      // When
      skipped = new Set(first.providers.map((entry) => entry.key));
      setSystemTime(start + FRESH_MS);
      const hidden = await usage.report(true);
      // Then
      expect(asked()).toBe(2);
      expect(hidden.providers).toEqual(first.providers);
      skipped = new Set(["claude:cliproxy:claude-a.json"]);
      await usage.report();
      expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
    } finally { setSystemTime(); }
  });

  it("reads only the Hub account shown again, keeping the other accounts' fresh rows", async () => {
    // Given
    await configure();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    const first = await service.report(false, hidden);
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    expect(reads()).toEqual(["a", "b"]);
    // When
    const shown = await service.report();
    // Then
    expect(reads()).toEqual(["a", "b", "a"]);
    expect(shown[1]).toBe(first[1]);
  });

  it("keeps every Hub row when the read after an account is shown again fails", async () => {
    // Given
    await configure();
    const first = await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
    fake.setKey("another-key");
    // When
    const shown = await service.report();
    // Then
    expect(shown).toEqual(first);
  });

  it("reads an account shown again at the next report when the Hub could not be read the first time", async () => {
    // Given
    await configure();
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
    fake.setDown(true);
    await service.report();
    fake.setDown(false);
    // When
    await service.report();
    // Then: a fresh server reads the hidden account once; the retry reads only the account shown again
    expect(reads()).toEqual(["a", "b", "a"]);
  });

  it("does not read an account shown again a second time at the scheduled read that follows", async () => {
    // Given
    await configure();
    const start = Date.now();
    const reads = () => fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index);
    try {
      await service.report(false, new Set(["claude:cliproxy:claude-a.json"]));
      setSystemTime(start + FRESH_MS - 1000);
      await service.report();
      // When
      setSystemTime(start + FRESH_MS);
      await service.report();
      // Then
      expect(reads()).toEqual(["a", "b", "a", "b"]);
    } finally { setSystemTime(); }
  });

  it("keeps hidden accounts unread across an invalidate, as after a Hub sign-in or a saved configuration", async () => {
    // Given
    await configure();
    const first = await service.report();
    const hidden = new Set(first.map((entry) => entry.key));
    await service.report(false, hidden);
    // When
    service.invalidate();
    const after = await service.report(false, hidden);
    // Then
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").length).toBe(2);
    expect(after).toEqual(first);
  });

  it("keeps an account hidden since the last report unread across a Hub sign-in", async () => {
    // Given
    await configure();
    let hidden = new Set<string>();
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    hidden = new Set(["claude:cliproxy:claude-a.json"]);
    // When
    service.invalidate();
    await service.report(false, hidden);
    // Then
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
  });

  it("keeps a hidden account's row unread when the Hub cannot be read right after a sign-in", async () => {
    // Given
    await configure();
    const hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.skipAccounts(() => hidden);
    const first = await service.report(false, hidden);
    service.invalidate();
    fake.setDown(true);
    await service.report(false, hidden);
    fake.setDown(false);
    // When
    const after = await service.report(false, hidden);
    // Then
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
    expect(after[0]).toBe(first[0]);
  });

  it("keeps the row of an account hidden after the report's snapshot when the Hub cannot be read", async () => {
    // Given
    await configure();
    await service.report();
    let hidden = new Set<string>();
    service.skipAccounts(() => hidden);
    hidden = new Set(["claude:cliproxy:claude-a.json"]);
    service.invalidate();
    fake.setDown(true);
    await service.report(false, new Set());
    fake.setDown(false);
    // When
    await service.report(false, hidden);
    // Then
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "b"]);
  });

  it("reads a hidden Hub file anew when it names no account", async () => {
    // Given
    Reflect.deleteProperty(fake.files[0]!, "email");
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    service.skipAccounts(() => hidden);
    await service.report(false, hidden);
    // When
    service.invalidate();
    await service.report(false, hidden);
    // Then
    expect(fake.calls.filter((entry) => entry.path === "/requests/api-call").map((entry) => (entry.body as { auth_index: string }).auth_index)).toEqual(["a", "b", "a"]);
  });

  it("drops hidden rows when the Hub URL changes", async () => {
    // Given
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    await service.report(false, hidden);
    const other = startFakeCLIProxy(KEY);
    other.files.forEach((file) => { file.email = `other-${file.email}`; });
    try {
      // When
      await send("", { url: other.server.url.origin, management_key: KEY });
      const after = await service.report(false, hidden);
      // Then
      expect(after.map((entry) => [entry.account, entry.windows[0]?.used_percent])).toEqual([
        ["other-claude-a@example.test", 25],
        ["other-codex-b@example.test", 32],
      ]);
    } finally { other.server.stop(true); }
  });

  it("reads a hidden Hub file anew once it names another account under the same name", async () => {
    // Given
    await configure();
    const hidden = new Set((await service.report()).map((entry) => entry.key));
    await service.report(false, hidden);
    fake.files[0]!.email = "bob@example.test";
    // When
    service.invalidate();
    const after = await service.report(false, hidden);
    // Then
    expect(after.map((entry) => [entry.key, entry.account])).toEqual([
      ["claude:cliproxy:claude-a.json", "bob@example.test"],
      ["codex:cliproxy:codex-b.json", "codex-b@example.test"],
    ]);
  });

  it("persists the key privately without returning it when saved or reloaded", async () => {
    // Given
    const saved = await configure();
    // When
    const restored = new CLIProxyService(dir);
    // Then
    expect(await saved.text()).not.toContain(KEY);
    expect(restored.status().configured).toBe(true);
    expect(JSON.stringify(restored.status())).not.toContain(KEY);
    expect(statSync(join(dir, "cliproxy.json")).mode & 0o777).toBe(0o600);
  });

  it("stops retrying a wrong key when status and usage are requested again", async () => {
    // Given
    await configure("wrong-secret");
    // When
    const responses = await Promise.all([call(), call(), service.report(true)]);
    // Then
    expect(fake.calls).toHaveLength(1);
    expect(service.status().problem).toContain("rejected");
    for (const response of responses) expect(response instanceof Response ? await response.text() : JSON.stringify(response)).not.toMatch(/wrong-secret|test-management-secret-not-in-responses/);
  });

  it("stops queued upstream requests when a saved key has been revoked", async () => {
    // Given
    await configure();
    fake.setKey("replacement-management-key");
    const before = fake.calls.length;
    // When
    const responses = await Promise.allSettled(Array.from({ length: 8 }, () => service.call("/credentials")));
    // Then
    expect(responses.every((response) => response.status === "rejected")).toBe(true);
    expect(fake.calls.length - before).toBe(1);
  });

  it("redacts a key when a successful proxy response quotes it", async () => {
    // Given
    const file = fake.files[0];
    if (!file) throw new Error("fixture needs a credential");
    file.email = KEY;
    await configure();
    // When
    const report = await service.report();
    // Then
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(report[0]?.account).toBe("[redacted]");
  });

  it("keeps the saved key on its server when a URL change supplies an invalid replacement", async () => {
    // Given
    await configure();
    const other = startFakeCLIProxy(KEY);
    try {
      // When
      const responses = await Promise.all([true, "   ", 12].map((management_key) => send("", { url: other.server.url.origin, management_key })));
      // Then
      expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
      expect(other.calls).toEqual([]);
      expect(service.status().url).toBe(fake.server.url.origin);
    } finally { other.server.stop(true); }
  });

  it("keeps local usage when the proxy cannot be reached", async () => {
    // Given
    const ctx: UsageContext = { home: dir, env: {}, platform: "linux", fetch, now: Date.now, keychain: async () => ({ status: "missing" }), run: async () => null, has: () => true };
    await configure();
    fake.server.stop(true);
    await service.save({ url: fake.server.url.origin, management_key: KEY });
    const local = { id: "claude", signIns: async () => [{ source: "fixture", token: "local-token", expiresAt: null }], read: async () => ({ plan: "max", windows: [] }) } as const;
    // When
    const report = await new UsageService(ctx, [local], () => service.report()).report();
    // Then
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]?.plan).toBe("max");
    expect(service.status().problem).toContain("Could not reach");
  });

  it("adds an account when a pending login receives its redirect", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "wait" });
    // When
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/callback?code=test-code&state=${login.state}` });
    // Then
    expect(response.status).toBe(200);
    expect(await (await call(`/login?state=${login.state}`)).json()).toEqual({ status: "ok" });
    expect((await service.report()).map((entry) => entry.account)).toContain(`${login.state}@example.test`);
  });

  it("rejects mismatched callback state when a login belongs to another provider", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "codex" })).json();
    // When
    const response = await send("/callback", { provider: "claude", state: login.state, redirect_url: `http://localhost/?state=${login.state}&code=x` });
    // Then
    expect(response.status).toBe(400);
    expect(fake.calls.some((entry) => entry.path === "/oauth/callback")).toBe(false);
  });

  it("cancels the upstream session when the user cancels", async () => {
    // Given
    await configure();
    const login: CLIProxyLogin = await (await send("/login", { provider: "claude" })).json();
    // When
    const response = await call(`/login?state=${login.state}`, { method: "DELETE" });
    // Then
    expect(response.status).toBe(200);
    expect(fake.sessions.has(login.state)).toBe(false);
  });

  it("removes saved configuration when requested and remains removed after restart", async () => {
    // Given
    await configure();
    // When
    await call("", { method: "DELETE" });
    // Then
    expect(new CLIProxyService(dir).status().configured).toBe(false);
    expect(await service.report()).toEqual([]);
  });

  it("requires app authentication for every proxy endpoint", () => {
    // Given / When / Then
    for (const path of ["", "/login", "/callback"]) expect(requiresAuth(`/api/cliproxy${path}`)).toBe(true);
  });
});
