/// <reference path="../sh-text.d.ts" />
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { version as serverVersion } from "../../package.json";
import joinScript from "./join.sh" with { type: "text" };

const REPO = resolve(import.meta.dir, "..", "..");

const ORIGINS = "--url <https:// or file:// address of the kit folder> --relay <wss://...> --account <https://...> --app <https://...>";
const USAGE = `usage: bun scripts/join/kit.ts make --server <ovis-server> --pty <ovis-pty-sidecar> --out <dir> [--test-kit] ${ORIGINS}\n       bun scripts/join/kit.ts line --kit <dir> ${ORIGINS}`;

export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitError";
  }
}

export interface Origins {
  readonly url: string;
  readonly relay: string;
  readonly account: string;
  readonly app: string;
}

export interface KitOptions extends Origins {
  readonly server: string;
  readonly pty: string;
  readonly out: string;
  readonly testKit?: boolean;
}

export interface Kit {
  readonly dir: string;
  readonly files: Readonly<Record<string, string>>;
  readonly sums: string;
  readonly line: string;
}

export const TEST_KIT = "TEST-KIT";
export const KIT_FILES = ["bin/bin/ovis-pty-sidecar", "bin/bin/ovis-pty-sidecar.json", "bin/ovis-server", "join.sh"] as const;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function answersUsage(path: string, flag: string, usage: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new KitError(`${flag} ${path} is not a file`);
  const child = Bun.spawnSync([path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (child.exitCode !== 2 || !child.stderr.toString().startsWith(usage)) throw new KitError(`${flag} ${path} is not the expected program (no "${usage}" when run with no argument)`);
}

function origin(value: string, schemes: readonly string[], flag: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new KitError(`${flag} ${value} is not an address`); }
  if (!schemes.includes(url.protocol) || (url.protocol !== "file:" && url.host === "")) throw new KitError(`${flag} takes a ${schemes.join(" or ")} address`);
  // the line quotes it in single quotes: it can hold none
  if (value.includes("'")) throw new KitError(`${flag} ${value} holds a quote`);
  return value.replace(/\/+$/, "");
}

function checkedOrigins(origins: Origins): Origins {
  return { url: origin(origins.url, ["https:", "file:"], "--url"), relay: origin(origins.relay, ["wss:"], "--relay"),
    account: origin(origins.account, ["https:"], "--account"), app: origin(origins.app, ["https:"], "--app") };
}

/**
 * An INT, TERM or HUP before join.sh runs removes the temporary folder (exit 130); `exec` drops that trap, so join.sh
 * keeps the folder it runs from. curl reads no config file of the login's (-q, its first argument).
 */
export function joinLine(origins: Origins, joinSha: string, sumsSha: string): string {
  const program = [
    "k=$1 j=$2 s=$3 r=$4 a=$5 p=$6",
    "shift 6",
    '[ "$(uname -s)" = Linux ] || { echo "Ovis: the join runs on Linux only; nothing was changed" >&2; exit 17; }',
    "d=$(mktemp -d) || exit 14",
    'trap "rm -rf \\"\\$d\\"; exit 130" INT TERM HUP',
    'curl -q -fsSL --max-time 120 --proto "=https,file" "$k/join.sh" -o "$d/join.sh" && [ "$(sha256sum "$d/join.sh" | cut -c1-64)" = "$j" ] && exec sh "$d/join.sh" --kit "$k" --sums "$s" --relay "$r" --account "$a" --app "$p" --trial "$@"',
    'rm -rf "$d"',
    'echo "Ovis: join.sh could not be fetched from $k, or it is not the one this line is for; nothing was changed" >&2',
    "exit 16",
  ].join("; ");
  return `sh -c '${program}' ovis-join '${origins.url}' ${joinSha} ${sumsSha} '${origins.relay}' '${origins.account}' '${origins.app}'`;
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => relative(dir, join(entry.parentPath, entry.name))).sort();
}

export function kitLine(dir: string, origins: Origins): Kit {
  const checked = checkedOrigins(origins);
  const at = resolve(dir);
  if (!existsSync(join(at, "SHA256SUMS"))) throw new KitError(`${at} holds no SHA256SUMS`);
  const listing = readFileSync(join(at, "SHA256SUMS"), "utf8");
  const names = existsSync(join(at, TEST_KIT)) ? [...KIT_FILES, TEST_KIT] : [...KIT_FILES];
  const expected = names.map((name) => `${sha256(readFileSync(join(at, name)))}  ${name}\n`).join("");
  if (listing !== expected) throw new KitError(`${at}: a file differs from SHA256SUMS, or SHA256SUMS is not the kit's`);
  const present = filesIn(at);
  const wanted = [...names, "SHA256SUMS"].sort();
  if (present.join("\n") !== wanted.join("\n")) throw new KitError(`${at} holds files other than the kit's: ${present.filter((name) => !wanted.includes(name)).join(", ") || "(one is missing)"}`);
  const files = Object.fromEntries(KIT_FILES.map((name) => [name, sha256(readFileSync(join(at, name)))]));
  const sums = sha256(listing);
  return { dir: at, files, sums, line: joinLine(checked, files["join.sh"]!, sums) };
}

export function makeKit(options: KitOptions): Kit {
  answersUsage(options.server, "--server", "usage: ovis-server <");
  answersUsage(options.pty, "--pty", "pty-sidecar: usage:");
  checkedOrigins(options);
  if (process.platform !== "linux" || process.arch !== "x64") throw new KitError(`a trial kit is made for linux-x64 only (this is ${process.platform}-${process.arch})`);
  const dir = resolve(options.out);
  if (!existsSync(dirname(dir))) throw new KitError(`${dirname(dir)} does not exist: make the kit in a folder whose parent exists`);
  if (!readFileSync(options.server).includes(Buffer.from(JSON.stringify(serverVersion)))) throw new KitError(`--server ${options.server} was not built from this checkout's version ${serverVersion}: build it here (scripts/build-server.ts linux-x64)`);
  const real = existsSync(dir) ? realpathSync(dir) : join(realpathSync(dirname(dir)), basename(dir));
  const repo = realpathSync(REPO);
  if (real === repo || real.startsWith(`${repo}${sep}`)) throw new KitError(`${dir} is inside this checkout (${REPO}): make the kit in a folder outside it`);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) throw new KitError(`${dir} exists and is not empty`);
  mkdirSync(join(dir, "bin", "bin"), { recursive: true, mode: 0o755 });
  copyFileSync(options.server, join(dir, "bin", "ovis-server"));
  copyFileSync(options.pty, join(dir, "bin", "bin", "ovis-pty-sidecar"));
  chmodSync(join(dir, "bin", "ovis-server"), 0o755);
  chmodSync(join(dir, "bin", "bin", "ovis-pty-sidecar"), 0o755);
  writeFileSync(join(dir, "bin", "bin", "ovis-pty-sidecar.json"), `${JSON.stringify({ sha256: sha256(readFileSync(join(dir, "bin", "bin", "ovis-pty-sidecar"))), version: serverVersion })}\n`, { mode: 0o644 });
  writeFileSync(join(dir, "join.sh"), joinScript, { mode: 0o644 });
  if (options.testKit === true) writeFileSync(join(dir, TEST_KIT), "A kit for the join's container tests: join.sh honours its test switches only with this file.\n", { mode: 0o644 });
  writeFileSync(join(dir, "SHA256SUMS"), [...KIT_FILES, ...(options.testKit === true ? [TEST_KIT] : [])].map((name) => `${sha256(readFileSync(join(dir, name)))}  ${name}\n`).join(""), { mode: 0o644 });
  return kitLine(dir, options);
}

function option(args: string[], name: string): string {
  const at = args.indexOf(`--${name}`);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new KitError(USAGE);
  args.splice(at, 2);
  return value;
}

export function kitCommand(argv: readonly string[], out: (text: string) => void, err: (text: string) => void): number {
  const [verb, ...rest] = argv;
  const args = [...rest];
  try {
    if (verb !== "make" && verb !== "line") throw new KitError(USAGE);
    const kitDir = verb === "line" ? option(args, "kit") : "";
    const testKit = verb === "make" && args.includes("--test-kit");
    if (testKit) args.splice(args.indexOf("--test-kit"), 1);
    const made = verb === "make" ? { server: option(args, "server"), pty: option(args, "pty"), out: option(args, "out"), testKit } : null;
    const origins = { url: option(args, "url"), relay: option(args, "relay"), account: option(args, "account"), app: option(args, "app") };
    if (args.length > 0) throw new KitError(USAGE);
    const kit = made === null ? kitLine(kitDir, origins) : makeKit({ ...made, ...origins });
    err(`The kit is ${kit.dir}: serve that folder as it is at ${origins.url}. The line below fetches it there, checks every file against SHA256SUMS (SHA-256 ${kit.sums}) and runs the join. Paste it on the machine, in a terminal of the user that runs herdr. The join prints its own undo line.\n`);
    out(`${kit.line}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof KitError)) throw error;
    err(`kit: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.main) process.exit(kitCommand(process.argv.slice(2), (text) => process.stdout.write(text), (text) => process.stderr.write(text)));
