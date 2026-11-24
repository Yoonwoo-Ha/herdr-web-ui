/**
 * What the server checks before it runs a native binary a release ships beside it (the Rust PTY host,
 * server/pty/host.ts; the ACP keeper, server/acp/keeper-bin.ts): the record that vouches for an
 * installed one, and whether a binary answers as the one it is meant to be.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { version as builtVersion } from "../package.json";
import { COMPILED } from "./entries.ts";
import { legacyName } from "./legacy-env.ts";

const digests = new Map<string, { state: string; sha256: string }>();

/** the binary's SHA-256, hashed again only when its mtime, size or inode moved (the installers replace it by rename, never in place) */
function binaryDigest(installed: string): string {
  const stat = statSync(installed);
  const state = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const known = digests.get(installed);
  if (known?.state === state) return known.sha256;
  const sha256 = createHash("sha256").update(readFileSync(installed)).digest("hex");
  digests.set(installed, { state, sha256 });
  return sha256;
}

/**
 * Whether the installed binary is the one its record (`<binary>.json`, written by scripts/pty-sidecar.ts
 * install or the remote bundle's builder) vouches for: the same SHA-256, for the version in the
 * package.json beside the server (the compiled binary's own version). The record and the version are read on every call (both are small),
 * so a rewrite of either within one tick of the file clock still counts; only the binary's hash is
 * cached, so attaches do not hash it again.
 */
export function installedBinaryDigest(installed: string, packageJson: string | null = COMPILED ? null : join(dirname(installed), "..", "package.json")): string | null {
  try {
    const record = JSON.parse(readFileSync(`${installed}.json`, "utf8")) as { sha256?: unknown; version?: unknown };
    const version = packageJson === null ? builtVersion : (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown }).version;
    return typeof record.sha256 === "string" && record.version === version && binaryDigest(installed) === record.sha256 ? record.sha256 : null;
  } catch {
    return null;
  }
}

export function installedBinaryVouched(installed: string, packageJson?: string | null): boolean {
  return installedBinaryDigest(installed, packageJson) !== null;
}

export type BinaryVerdict = { ok: true } | { ok: false; reason: string };

export function spawnErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return "code" in error && error.code != null ? String(error.code) : error.message;
}

/**
 * Runs `argv` with no input and without the bridge token (under either name) in at most `timeoutMs`:
 * a run past its time is killed with SIGKILL, since the binary (or one posing as it) may outlive
 * SIGTERM. Its exit code and first stderr line, or why it gave none.
 */
export function runBounded(argv: string[], env: Record<string, string | undefined>, timeoutMs: number): { exitCode: number; first: string } | { reason: string } {
  const clean = { ...env };
  delete clean["OVIS_TOKEN"];
  const legacyToken = legacyName("OVIS_TOKEN");
  if (legacyToken !== null) delete clean[legacyToken];
  try {
    const result = Bun.spawnSync(argv, { env: clean, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
    if (result.exitedDueToTimeout) return { reason: `no answer in ${timeoutMs} ms` };
    if (result.signalCode != null) return { reason: String(result.signalCode) };
    return { exitCode: result.exitCode ?? -1, first: result.stderr.toString().split("\n")[0] ?? "" };
  } catch (error) {
    return { reason: spawnErrorReason(error) };
  }
}

export const exitText = (run: { exitCode: number; first: string }): string => `exit ${run.exitCode}${run.first ? `: ${run.first}` : ""}`;

/** Whether `binary`, run without arguments, answers as `what`: exit 2 with a first stderr line that starts with `usage`. */
export function answersUsage(binary: string, identity: { usage: string; what: string }, env: Record<string, string | undefined>, timeoutMs: number): BinaryVerdict {
  const run = runBounded([binary], env, timeoutMs);
  if ("reason" in run) return { ok: false, reason: run.reason };
  if (run.exitCode !== 2 || !run.first.startsWith(identity.usage)) return { ok: false, reason: `not ${identity.what} (${exitText(run)})` };
  return { ok: true };
}
