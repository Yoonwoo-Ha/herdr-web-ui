/** Native Linux bundles; macOS also supports assembly from verified prebuilds on Linux. */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";

const root = resolve(import.meta.dir, "..");
const hostPlatform = `${process.platform}-${process.arch}`;
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length > 1) throw new Error("Usage: bun run build:remote [linux-x64|linux-arm64|darwin-x64|darwin-arm64]");
const platform = args[0] ?? hostPlatform;
const herdrPins: Record<string, [string, string]> = {
  "linux-x64": ["herdr-linux-x86_64", "2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7"],
  "linux-arm64": ["herdr-linux-aarch64", "f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e"],
  "darwin-x64": ["herdr-macos-x86_64", "053be0639935fe54ab5efbdb46651054e4f6a753a5b43153c88bd6912bce1e94"],
  "darwin-arm64": ["herdr-macos-aarch64", "5fc7a7e7adfaca56fa80aa89dcb025693357268dab8285b9ce2d08a2313c89de"],
};
// Official release digests: oven-sh/bun bun-v1.4.2 and nodejs.org/dist/v22.23.2/SHASUMS256.txt.
const macPins: Record<string, { bunFile: string; bunSha: string; nodeSha: string }> = {
  "darwin-arm64": { bunFile: "bun-darwin-aarch64", bunSha: "90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f", nodeSha: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
  "darwin-x64": { bunFile: "bun-darwin-x64", bunSha: "80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012", nodeSha: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026" },
};
const nodePins: Record<string, string> = {
  "linux-x64": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
  "linux-arm64": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
  "darwin-x64": macPins["darwin-x64"]!.nodeSha,
  "darwin-arm64": macPins["darwin-arm64"]!.nodeSha,
};
// The PTY addon: @lydell/node-pty ships one prebuilt package per platform and bun installs only the
// host's, so a bundle for another platform fetches that platform's package from the registry.
// sha256 of the registry tarballs for the version package.json pins; a bump must update these.
const PTY_VERSION = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@lydell/node-pty"]!;
const ptyPins: Record<string, string> = {
  "linux-x64": "8d2e043026672f11aafd5f1a831f794a90d8fdd9d5e3255e8bc121df64b9d8e4",
  "linux-arm64": "c4ace306e4099a7919c7852fe29a6a9052f9d9b9eaf36617bf7c6cb72cd16118",
  "darwin-x64": "2a45297cec01dffa282f39cc1f87d1f2fa42e5c186e261ff88bfcfbce0186c00",
  "darwin-arm64": "937a533814ddeb3eb1d6d7a84f5aa2302d73ffe69332a34a94ae05e9e203eab3",
};
const pin = herdrPins[platform];
if (!pin) throw new Error(`Unsupported platform ${platform}`);
const mac = macPins[platform];
if (!mac && platform !== hostPlatform) throw new Error(`Build ${platform} on that OS/CPU: a Linux bundle carries the host's Bun binary`);
if (!existsSync(join(root, "dist/index.html"))) throw new Error("Run bun run build before building remote bundles");

const output = resolve(process.env["HERDR_BUNDLE_OUTPUT"] ?? join(root, "remote-bundles"));
const stage = join(output, `stage-${platform}`);
const downloads = join(output, `downloads-${platform}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(downloads, { recursive: true });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function download(url: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime download failed (${response.status}): ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error(`Runtime checksum mismatch: ${url}`);
  return bytes;
}
function command(argv: string[], cwd = root): void {
  const result = Bun.spawnSync(argv, { cwd, timeout: 120_000 });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString()}`);
}
function verifyMachO(path: string): void {
  const bytes = readFileSync(path);
  const cpu = platform === "darwin-arm64" ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new Error(`Wrong macOS architecture: ${path}`);
}

try {
  for (const dir of ["server", "shared", "dist", "node_modules"]) cpSync(join(root, dir), join(stage, dir), { recursive: true, dereference: false, filter: (path) => !path.endsWith(".test.ts") });
  let bunVersion = Bun.version;
  // Use a reproducible LTS runtime instead of the builder's Node: newer local
  // binaries can require extra system libraries absent on an otherwise supported PC.
  const nodeVersion = "v22.23.2";
  const nodeArchive = join(downloads, "node.tar.gz");
  writeFileSync(nodeArchive, await download(`https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-${platform}.tar.gz`, nodePins[platform]!));
  command(["tar", "xzf", nodeArchive, "-C", downloads, `node-${nodeVersion}-${platform}/bin/node`]);
  cpSync(join(downloads, `node-${nodeVersion}-${platform}/bin/node`), join(stage, "bin/node"));
  if (mac) {
    const bunArchive = join(downloads, "bun.zip");
    writeFileSync(bunArchive, await download(`https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${mac.bunFile}.zip`, mac.bunSha));
    command(["unzip", "-qo", bunArchive, "-d", downloads]);
    cpSync(join(downloads, mac.bunFile, "bun"), join(stage, "bin/bun"));
    bunVersion = "1.4.2";
  } else {
    cpSync(realpathSync(process.execPath), join(stage, "bin/bun"));
  }
  // every bundle carries exactly its own platform's PTY package (flat: pty.node, and spawn-helper on macOS)
  const ptyPackages = join(stage, "node_modules/@lydell");
  const ptyPackage = join(ptyPackages, `node-pty-${platform}`);
  for (const name of readdirSync(ptyPackages)) if (name.startsWith("node-pty-") && name !== `node-pty-${platform}`) rmSync(join(ptyPackages, name), { recursive: true, force: true });
  if (!existsSync(join(ptyPackage, "pty.node"))) {
    const ptyArchive = join(downloads, "node-pty.tgz");
    writeFileSync(ptyArchive, await download(`https://registry.npmjs.org/@lydell/node-pty-${platform}/-/node-pty-${platform}-${PTY_VERSION}.tgz`, ptyPins[platform]!));
    mkdirSync(ptyPackage, { recursive: true });
    command(["tar", "xzf", ptyArchive, "-C", ptyPackage, "--strip-components=1"]);
  }
  if (mac) {
    for (const name of ["pty.node", "spawn-helper"]) verifyMachO(join(ptyPackage, name));
    chmodSync(join(ptyPackage, "spawn-helper"), 0o755);
  }
  writeFileSync(join(stage, "bin/herdr"), await download(`https://github.com/herdrdev/herdr/releases/download/v0.9.1/${pin[0]}`, pin[1]), { mode: 0o755 });
  for (const name of ["bun", "node", "herdr"]) {
    chmodSync(join(stage, "bin", name), 0o755);
    if (mac) verifyMachO(join(stage, "bin", name));
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module", version: REMOTE_BUNDLE_VERSION }));
  writeFileSync(join(stage, "bundle.json"), JSON.stringify({ version: REMOTE_BUNDLE_VERSION, platform, herdr: "0.9.1", bun: bunVersion, node: nodeVersion, native_smoke_tested: platform === hostPlatform }));
  if (platform === hostPlatform) command([join(stage, "bin/node"), join(stage, "server/pty/smoke.mjs")], stage);
  else console.log(`${platform}: verified binary architecture and checksums; PTY execution is checked on the destination before activation`);

  const filename = `herdr-web-ui-${platform}.tgz`;
  const archive = join(output, filename);
  const temporaryArchive = archive + ".tmp";
  const tar = Bun.spawn(["tar", "czf", temporaryArchive, "-C", stage, "."], { stdout: "inherit", stderr: "inherit" });
  if (await tar.exited !== 0) throw new Error("Bundle archive failed");
  const sha256 = digest(readFileSync(temporaryArchive));
  renameSync(temporaryArchive, archive);
  const manifest = join(output, `manifest-${platform}.json`);
  writeFileSync(manifest + ".tmp", JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: filename, sha256 } } }, null, 2));
  renameSync(manifest + ".tmp", manifest);
  console.log(`${filename} sha256:${sha256}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
