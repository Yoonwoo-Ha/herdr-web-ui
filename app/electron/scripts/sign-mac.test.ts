import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { signHostAndRecordHash, signNativeBinaries } from "./sign-mac.mjs";

const serverHost = join(import.meta.dir, "..", "..", "..", "server", "pty", "host.ts");
const { installedHostVouched }: { installedHostVouched(installed: string): boolean } = await import(serverHost);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function server(record: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-sign-mac-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.5.0" }));
  const host = join(dir, "bin", "ovis-pty-sidecar");
  writeFileSync(host, "unsigned host");
  const sha256 = createHash("sha256").update(readFileSync(host)).digest("hex");
  if (record) writeFileSync(`${host}.json`, JSON.stringify({ crate: "abc", sha256, version: "0.5.0" }));
  return host;
}

/** codesign as far as the record is concerned: it rewrites the binary in place */
const codesign = async (_file: string, args: string[]) => {
  appendFileSync(args.at(-1)!, " + signature");
  return "";
};

describe("signHostAndRecordHash", () => {
  it("re-signs the keeper before the app seal, refreshes its record and skips a second signing, even without the host", async () => {
    const app = mkdtempSync(join(tmpdir(), "ovis-sign-keeper-"));
    dirs.push(app);
    const bin = join(app, "Contents/Resources/ovis/server/bin");
    mkdirSync(bin, { recursive: true });
    const keeper = join(bin, "ovis-acp-keeper");
    writeFileSync(keeper, "unsigned keeper");
    writeFileSync(`${keeper}.json`, JSON.stringify({ version: "1.2.3", sha256: createHash("sha256").update("unsigned keeper").digest("hex") }));
    const ignore = await signNativeBinaries({ app, identity: "HASH", ignore: (file) => file === "already ignored", optionsForFile: () => ({}) }, codesign);
    expect(readFileSync(keeper, "utf8")).toBe("unsigned keeper + signature");
    expect(JSON.parse(readFileSync(`${keeper}.json`, "utf8"))).toEqual({ version: "1.2.3", sha256: createHash("sha256").update("unsigned keeper + signature").digest("hex") });
    expect(ignore(keeper)).toBe(true);
    expect(ignore("already ignored")).toBe(true);
    expect(ignore(join(app, "Contents/Resources/ovis/server/ovis-server"))).toBe(false);
  });

  it("signs the host with the app's identity, and the server still runs it", async () => {
    const host = server(true);
    const calls: string[][] = [];
    await signHostAndRecordHash(host, { identity: "HASH", keychain: "/k.keychain-db", entitlements: "/e.plist" }, async (file, args) => {
      calls.push([file, ...args]);
      return codesign(file, args);
    });
    expect(calls).toEqual([["codesign", "--sign", "HASH", "--force", "--timestamp", "--options", "runtime", "--entitlements", "/e.plist", "--keychain", "/k.keychain-db", host]]);
    expect(installedHostVouched(host)).toBe(true);
    expect(JSON.parse(readFileSync(`${host}.json`, "utf8")).crate).toBe("abc");
  });

  it("writes no record for a host that came without one", async () => {
    const host = server(false);
    await signHostAndRecordHash(host, { identity: "HASH" }, codesign);
    expect(existsSync(`${host}.json`)).toBe(false);
  });
});

it("refuses to sign a changed keeper without refreshing its record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-changed-")); dirs.push(dir);
  const file = join(dir, "ovis-acp-keeper");
  writeFileSync(file, "changed bytes");
  writeFileSync(file + ".json", JSON.stringify({ sha256: "0".repeat(64) }));
  await expect(signHostAndRecordHash(file, { identity: "HASH" }, codesign)).rejects.toThrow("SHA-256");
  expect(readFileSync(file, "utf8")).toBe("changed bytes");
  expect(JSON.parse(readFileSync(file + ".json", "utf8")).sha256).toBe("0".repeat(64));
});
