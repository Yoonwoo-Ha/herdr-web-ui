import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACP_KEEPER, PTY_HOST, runsHere } from "../../../scripts/pty-sidecar.ts";
import { checked, signedHelpers } from "../../../scripts/server-release-files.ts";
import { ptyAssetFor, type ServerPlatform } from "../../../scripts/server-manifest.ts";
import type { ArtifactOptions } from "../../../scripts/server-artifact.ts";
import { installedBinaryDigest } from "../../../server/native-binary.ts";

export function installedHelpers(bin: string): Pick<ArtifactOptions, "ptySidecar" | "acpKeeper"> {
  const helpers: Pick<ArtifactOptions, "ptySidecar" | "acpKeeper"> = {};
  for (const [option, name] of [["ptySidecar", "ovis-pty-sidecar"], ["acpKeeper", "ovis-acp-keeper"]] as const) {
    const binary = join(bin, name);
    const sha256 = installedBinaryDigest(binary);
    if (sha256) helpers[option] = { binary, sha256, record: `${binary}.json` };
  }
  return helpers;
}

export async function releaseHelpers(cache: string, platform: ServerPlatform, release: { at: string; version: string }) {
  const build = ptyAssetFor(platform);
  if (!build) return {};
  const { hosts, keepers } = await signedHelpers(release.at, release.version);
  const dir = mkdtempSync(join(cache, "signed-"));
  const take = async (part: typeof ACP_KEEPER, asset: typeof hosts[typeof build]) => {
    const binary = join(dir, part.name);
    writeFileSync(binary, await checked(release.at, asset), { mode: 0o755 });
    if (!runsHere(binary, part)) throw new Error("Signed release helper failed its identity check: " + part.name);
    return { binary, sha256: asset.sha256 };
  };
  return { ptySidecar: await take(PTY_HOST, hosts[build]), acpKeeper: await take(ACP_KEEPER, keepers[build]) };
}
