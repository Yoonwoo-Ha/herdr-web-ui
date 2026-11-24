import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseAsset } from "./server-manifest.ts";

export const PTY_ASSETS = ["linux-x64", "linux-arm64", "darwin-universal"] as const;
export type PtyAsset = typeof PTY_ASSETS[number];
export const KEEPER_MANIFEST = "ovis-acp-keeper-server.json";
export const keeperFile = (build: PtyAsset): string => `ovis-acp-keeper-${build}`;
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const sameKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);

export const isAsset = (entry: unknown, file: string): entry is ReleaseAsset =>
  sameKeys(entry, ["file", "sha256", "size"]) && entry["file"] === file && typeof entry["sha256"] === "string" && /^[0-9a-f]{64}$/.test(entry["sha256"])
  && typeof entry["size"] === "number" && Number.isSafeInteger(entry["size"]) && entry["size"] >= 0;

export type NativeAssets = Record<PtyAsset, ReleaseAsset>;
export const nativeAssets = (asset: (build: PtyAsset) => ReleaseAsset): NativeAssets => ({
  "linux-x64": asset("linux-x64"), "linux-arm64": asset("linux-arm64"), "darwin-universal": asset("darwin-universal"),
});

/** The bytes signed before release, reproduced from the actual upload's files before publication. */
export function keeperManifestText(dir: string, version: string, serverBytes: Uint8Array): string {
  const assets = nativeAssets((build) => {
    const file = keeperFile(build);
    const bytes = readFileSync(join(dir, file));
    return { file, sha256: sha256(bytes), size: bytes.length };
  });
  return `${JSON.stringify({ schema: 1, version, serverSha256: sha256(serverBytes), assets }, null, 2)}\n`;
}

/** Only called after the companion's signature is checked. Bind it to the exact server release, not just its version. */
export function keeperAssets(bytes: Buffer, version: string, serverBytes: Uint8Array): NativeAssets | string {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return `${KEEPER_MANIFEST} is not JSON`; }
  if (!sameKeys(parsed, ["schema", "version", "serverSha256", "assets"]) || parsed["schema"] !== 1 ||
      parsed["version"] !== version || parsed["serverSha256"] !== sha256(serverBytes)) return `${KEEPER_MANIFEST} does not name this server manifest and version`;
  const assets = parsed["assets"];
  if (!sameKeys(assets, PTY_ASSETS)) return `${KEEPER_MANIFEST} must name exactly ${PTY_ASSETS.join(", ")}`;
  const linux = assets["linux-x64"], arm = assets["linux-arm64"], mac = assets["darwin-universal"];
  if (!isAsset(linux, keeperFile("linux-x64")) || !isAsset(arm, keeperFile("linux-arm64")) || !isAsset(mac, keeperFile("darwin-universal"))) return `${KEEPER_MANIFEST} has an invalid keeper asset`;
  if (!bytes.equals(Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`))) return `${KEEPER_MANIFEST} is not in its canonical form`;
  return { "linux-x64": linux, "linux-arm64": arm, "darwin-universal": mac };
}
