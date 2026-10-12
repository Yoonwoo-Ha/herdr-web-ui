import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrProfileState } from "./herdr-profile-state.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "herdr-profile-state-")); dirs.push(dir); return dir; }
it("restores target-bound approval and cached panes without copying catalog fields", () => {
  const dir = directory(), target = { destination: "BuildBox", port: 2222, session: "agents" };
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  store.saveSnapshot("id", { panes: [{ pane_id: "test-pane" }] } as SessionSnapshot);
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.approved("id", { session: "agents", port: 2222, destination: "BuildBox" })).toBe(true);
  expect(restored.snapshot("id")?.panes[0]?.pane_id).toBe("test-pane");
  const text = readFileSync(join(dir, "herdr-profile-state.json"), "utf8");
  expect(text).not.toContain("BuildBox");
  expect(text).not.toContain('"enabled"');
  if (process.platform !== "win32") expect(statSync(join(dir, "herdr-profile-state.json")).mode & 0o777).toBe(0o600);
  expect(restored.reconcile("id", { ...target, session: "other" })).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(restored.snapshot("id")).toBeNull();
  restored.flush();
  expect(new HerdrProfileState(dir).approved("id", target)).toBe(false);
});
it("treats default as the unnamed session but does not merge ports or aliases", () => {
  const store = new HerdrProfileState(directory());
  store.approve("id", { destination: "BuildBox" });
  expect(store.approved("id", { destination: "BuildBox", session: "default" })).toBe(true);
  expect(store.approved("id", { destination: "BuildBox", port: 22 })).toBe(false);
  expect(store.approved("id", { destination: "buildbox" })).toBe(false);
  expect(store.prune(new Set())).toEqual(["id"]);
  expect(store.approved("id", { destination: "BuildBox" })).toBe(false);
});
it("rejects corrupt approval state without overwriting it", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  for (const data of ['{}', '[{"profile_id":"id","binding":"bad","approved":true,"snapshot":null}]']) {
    writeFileSync(path, data);
    expect(() => new HerdrProfileState(dir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(data);
  }
});

it("connection consent is separate from installation approval and survives restart", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const store = new HerdrProfileState(dir);
  store.allowConnection("id", target); store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.connectionApproved("id", target)).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(() => restored.reconcile("id", { destination: "new" }, () => { throw new Error("cleanup"); })).toThrow("cleanup");
  restored.flush();
  expect(new HerdrProfileState(dir).connectionApproved("id", target)).toBe(false);
});

it("retries a failed key removal when the old target returns, after a restart and after a re-add", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const failing = () => { throw new Error("cleanup"); };
  let retired = 0;
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  expect(() => store.reconcile("id", { destination: "new" }, failing)).toThrow("cleanup");
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(1);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(false);
  expect(retired).toBe(1);
  restored.approve("id", target);
  expect(() => restored.prune(new Set(), failing)).toThrow("cleanup will retry");
  restored.flush();
  const readded = new HerdrProfileState(dir);
  expect(readded.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(2);
  expect(readded.approved("id", target)).toBe(false);
  readded.flush();
  expect(readFileSync(join(dir, "herdr-profile-state.json"), "utf8")).not.toContain("retiring");
});
