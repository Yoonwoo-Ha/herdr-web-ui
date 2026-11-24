import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ROOT } from "../entries.ts";
import { answersUsage, installedBinaryVouched, type BinaryVerdict } from "../native-binary.ts";

const EXE = process.platform === "win32" ? ".exe" : "";
export const ACP_KEEPER_INSTALLED = join(ROOT, "bin", `ovis-acp-keeper${EXE}`);
export const ACP_KEEPER_BUILD = join(ROOT, "crates", "acp-keeper", "target", "release", `ovis-acp-keeper${EXE}`);

const runsAsKeeper = (binary: string, env: Record<string, string | undefined>): BinaryVerdict =>
  answersUsage(binary, { usage: "Usage: ovis-acp-keeper ", what: "the ACP keeper" }, env, 3000);

/**
 * The ACP keeper to run: OVIS_ACP_KEEPER_BIN when set (an absolute path that runs as the keeper; when it
 * does not, no other is tried), else the release's installed bin/ovis-acp-keeper while its record vouches
 * for it (the PTY host's rule, server/pty/host.ts), else a local cargo build that runs as the keeper.
 */
export function acpKeeperBin(env: Record<string, string | undefined> = process.env, paths = { installed: ACP_KEEPER_INSTALLED, build: ACP_KEEPER_BUILD }): string | null {
  const chosen = env["OVIS_ACP_KEEPER_BIN"];
  if (chosen) {
    const verdict: BinaryVerdict = isAbsolute(chosen) ? runsAsKeeper(chosen, env) : { ok: false, reason: "not an absolute path" };
    if (verdict.ok) return chosen;
    console.error(`OVIS_ACP_KEEPER_BIN=${chosen}: ${verdict.reason}; no ACP keeper`);
    return null;
  }
  if (existsSync(paths.installed) && installedBinaryVouched(paths.installed) && runsAsKeeper(paths.installed, env).ok) return paths.installed;
  if (existsSync(paths.build) && runsAsKeeper(paths.build, env).ok) return paths.build;
  return null;
}
