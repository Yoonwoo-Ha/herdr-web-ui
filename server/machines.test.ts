import { describe, expect, it } from "bun:test";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { machinePath, paneStorageId } from "../shared/machines.ts";
import { canSendSecret, sameOrigin, shellQuote, validateTarget } from "./machine-security.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

describe("machine boundaries", () => {
  it("separates equal pane IDs while preserving historical local storage", () => {
    expect(paneStorageId("local", "p:1")).toBe("p:1");
    expect(new Set(["local", "one", "two"].map((id) => paneStorageId(id, "p:1"))).size).toBe(3);
    expect(paneNotificationTag("p:1", "one")).not.toBe(paneNotificationTag("p:1", "two"));
    expect(machinePath("pc/name", "pane/image")).toBe("/api/machines/pc%2Fname/pane/image");
  });
  it("rejects shell and SSH-option injection in user-controlled target fields", () => {
    for (const destination of ["-oProxyCommand=touch /tmp/no", "host;id", "x\ny", "$(id)", "user@host -p 22", ""]) expect(() => validateTarget({ destination })).toThrow();
    expect(validateTarget({ destination: "user@[::1]", port: 2222, session: "work" }).port).toBe(2222);
    for (const session of ["../default", "$(id)", "work;id"]) expect(() => validateTarget({ destination: "host", session })).toThrow();
    const value = "a'$(touch /tmp/no)";
    expect(Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(value)}`]).stdout.toString()).toBe(value);
  });
  it("rejects cross-origin controls and limits secret submission to secure origins", () => {
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://evil.test" } }))).toBe(false);
    expect(sameOrigin(new Request("http://localhost:7317/api/machines", { headers: { origin: "http://localhost:7317" } }))).toBe(true);
    expect(canSendSecret(new Request("http://192.0.2.1/api/machines"))).toBe(false);
    expect(canSendSecret(new Request("https://app.example/api/machines"))).toBe(true);
    expect(canSendSecret(new Request("http://127.0.0.1/api/machines"))).toBe(true);
  });
  it("proxies only pane/workspace data and never remote management credentials", () => {
    for (const path of ["auth", "push", "updates/install", "machines/setup", "bridge", "../auth", "pane/../../auth", "pane/prompt/answer/extra"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    for (const path of ["session", "agents", "pane/files", "pane/image", "pane/prompt/answer", "workspace/create"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
  });
});
