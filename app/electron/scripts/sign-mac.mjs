/**
 * electron-builder's mac.sign (electron-builder.yml): signs the app as electron-builder does, after
 * signing the bundled PTY host and ACP keeper first. Their records take the signed bytes' hashes
 * before the app's seal covers them; neither binary may be signed again after that.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run } from "./notarize-dmg.mjs";

const BIN = "Contents/Resources/ovis/server/bin";

/**
 * @param {string} host
 * @param {{ identity: string, keychain?: string, entitlements?: string }} signing
 * @param {import("./notarize-dmg.mjs").Run} exec
 */
export async function signHostAndRecordHash(host, signing, exec = run) {
  const args = ["--sign", signing.identity, "--force", "--timestamp", "--options", "runtime"];
  if (signing.entitlements) args.push("--entitlements", signing.entitlements);
  if (signing.keychain) args.push("--keychain", signing.keychain);
  const recordPath = host + ".json";
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
  const digest = () => createHash("sha256").update(readFileSync(host)).digest("hex");
  if ((record || basename(host) === "ovis-acp-keeper") && record?.sha256 !== digest()) throw new Error("Pre-signing SHA-256 mismatch: " + host);
  await exec("codesign", [...args, host]);
  if (!record) return;
  record.sha256 = digest();
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
}

/** @param {{ app: string, identity: string, keychain?: string, ignore: (file: string) => boolean, optionsForFile: (file: string) => { entitlements?: string } }} opts */
export async function signNativeBinaries(opts, exec = run) {
  const signed = ["ovis-pty-sidecar", "ovis-acp-keeper"].map((name) => join(opts.app, BIN, name)).filter((file) => existsSync(file));
  for (const file of signed) {
    await signHostAndRecordHash(file, { identity: opts.identity, keychain: opts.keychain, entitlements: opts.optionsForFile(file).entitlements }, exec);
  }
  return (file) => signed.includes(file) || opts.ignore(file);
}

export default async function sign(opts) {
  const { sign: signApp } = await import("app-builder-lib/out/codeSign/macCodeSign.js");
  return signApp({ ...opts, ignore: await signNativeBinaries(opts) });
}
