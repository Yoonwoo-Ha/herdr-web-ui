import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { previousInstallers } from "./keeper-compat.test-helpers.ts";
import { installServer } from "./server-install.ts";
import { DIST_ARCHIVE, generateKeyPair, PTY_ASSETS, RELEASE_PUBLIC_KEY, releaseFile, SERVER_PLATFORMS, signManifest, writeManifest } from "./server-manifest.ts";

const scratch = mkdtempSync(join(tmpdir(), "ovis-keeper-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const key = generateKeyPair();
const host = '#!/bin/sh\n[ "$#" != 0 ] && exit 0\necho "pty-sidecar: usage: fixture" >&2\nexit 2\n';
const keeper = '#!/bin/sh\necho "Usage: ovis-acp-keeper ROOT" >&2\nexit 2\n';
const version = "1.2.3";
const shellFrom = (checkout: string) => readFileSync(join(checkout, "install.sh"), "utf8")
  .replace(`RELEASE_PUBLIC_KEY="${RELEASE_PUBLIC_KEY}"`, `RELEASE_PUBLIC_KEY="${key.publicKey}"`)
  .replace(/\nmain "\$@"\n$/, '\n');
const installer = shellFrom(join(import.meta.dir, ".."));
const pinned = await previousInstallers(scratch);

describe.skipIf(process.platform === "win32")("optional keeper in a signed server installation", () => {
  for (const [via, shell, install, legacy, old] of [
    ["shell", installer, installServer, false, null], ["plugin", null, installServer, false, null],
    ...pinned.flatMap(release => [
      [release.tag + " shell", shellFrom(release.dir), release.install, true, release], [release.tag + " plugin", null, release.install, true, release],
      ["shell reading " + release.tag, installer, installServer, false, release], ["plugin reading " + release.tag, null, installServer, false, release],
    ] as const),
  ] as const) {
    it.each(legacy ? ["good"] : old ? ["old manifest"] : ["good", "repair", "cleanup failure", "linked asset", "missing", "wrong hash", "wrong program", "old manifest", "edited manifest", "bad signature", "missing signature", "wrong version", "wrong server", "noncanonical", "wrong platform file"])(
      `${via}: %s keeper never takes down the server or PTY host`, async (state) => {
        const root = mkdtempSync(join(scratch, "pc-"));
        const probe = keeper.replace("echo", `: > "${join(root, "ran")}"; echo`);
        const dir = join(root, `v${version}`);
        mkdirSync(dir);
        for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), "#!/bin/sh\necho running\n");
        for (const build of PTY_ASSETS) {
          writeFileSync(join(dir, `ovis-pty-sidecar-${build}`), host);
          if (state !== "old manifest") writeFileSync(join(dir, `ovis-acp-keeper-${build}`), ["wrong program", "cleanup failure"].includes(state) ? host : probe);
        }
        writeFileSync(join(root, "index.html"), "<title>Ovis</title>");
        expect(Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", root, "index.html"]).exitCode).toBe(0);
        const writer = state === "old manifest" && old ? old.manifests : { writeManifest, signManifest };
        writer.writeManifest(dir, { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
        writer.signManifest(dir, key.privateKeyPem);
        const side = join(dir, "ovis-acp-keeper-server.json");
        if (state === "edited manifest") writeFileSync(side, `${readFileSync(side, "utf8")} `);
        if (state === "bad signature") writeFileSync(`${side}.sig`, readFileSync(join(dir, "ovis-server.json.sig")));
        if (state === "missing signature") rmSync(`${side}.sig`, { force: true });
        if (["wrong version", "wrong server", "noncanonical", "wrong platform file"].includes(state)) {
          const raw = readFileSync(side, "utf8");
          writeFileSync(side, state === "wrong version" ? raw.replace(version, "1.2.2")
            : state === "wrong server" ? raw.replace(/"serverSha256": "[a-f0-9]{64}"/, `"serverSha256": "${"0".repeat(64)}"`)
            : state === "wrong platform file" ? raw.replace('ovis-acp-keeper-linux-arm64"', 'ovis-acp-keeper-linux-x64"') : raw + "\n");
          signManifest(dir, key.privateKeyPem);
        }
        const asset = join(dir, "ovis-acp-keeper-linux-x64");
        if (state === "missing") rmSync(asset);
        if (state === "linked asset") { const other = join(root, "linked"); writeFileSync(other, probe); rmSync(asset); symlinkSync(other, asset); }
        if (state === "wrong hash" || state === "old manifest") writeFileSync(asset, probe.replace("ROOT", "FAKE"));
        const releases = pathToFileURL(root).href;
        const home = join(root, ".local/share/ovis");
        if (state === "cleanup failure" && shell) writeFileSync(join(root, "rm"), '#!/bin/sh\ncase "$*" in *"/.keeper-"*|*"/ovis-acp-keeper") echo "fixture cleanup denied" >&2; exit 1;; esac\nexec /bin/rm "$@"\n', { mode: 0o755 });
        const perform = async (fresh: boolean) => {
          if (shell) {
            if (!Bun.which("node") && !existsSync(join(root,"node"))) symlinkSync(process.execPath, join(root, "node"));
            const result = Bun.spawnSync(["sh", "-c", `${shell}\nos=linux; arch=x64; platform=linux-x64; install_binary ${version}`],
              { env: { HOME: root, PATH: `${root}:${process.env["PATH"]}`, TMPDIR: tmpdir(), OVIS_RELEASES_URL: releases } });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
          } else {
            const remove = fs.rmSync;
            const failure = state === "cleanup failure" ? spyOn(fs, "rmSync").mockImplementation((path, options) => {
              if (String(path).includes("/.keeper-") || String(path).endsWith("/ovis-acp-keeper")) throw new Error("fixture cleanup denied");
              remove(path, options);
            }) : null;
            try {
              expect((await install({ home, releases, version, publicKey: key.publicKey, platform: "linux-x64" })).installed).toBe(fresh);
              if (failure) expect(failure).toHaveBeenCalled();
            } finally { failure?.mockRestore(); }
          }
        };
        await perform(true);
        const bin = join(home, "bin");
        expect(Bun.spawnSync([join(bin, "ovis-server")]).stdout.toString()).toBe("running\n");
        expect(readFileSync(join(bin, "bin/ovis-pty-sidecar"), "utf8")).toBe(host);
        const installed = join(bin, "bin/ovis-acp-keeper");
        const wanted = !legacy && ["good", "repair"].includes(state);
        expect(existsSync(join(root, "ran"))).toBe(wanted);
        if (wanted) {
          expect(Bun.spawnSync([installed]).stderr.toString()).toContain("Usage: ovis-acp-keeper ");
          expect(JSON.parse(readFileSync(`${installed}.json`, "utf8"))).toEqual({ sha256: createHash("sha256").update(probe).digest("hex"), version });
        } else {
          expect(existsSync(installed)).toBe(false);
          expect(existsSync(`${installed}.json`)).toBe(false);
        }
        if (state === "repair") {
          const serverInode = fs.statSync(join(bin, "ovis-server")).ino;
          rmSync(join(dir, releaseFile("linux-x64"))); // a keeper repair cannot download the server again
          for (const damage of ["missing", "bad bytes", "bad record"]) {
            if (damage === "missing") rmSync(installed);
            else if (damage === "bad bytes") writeFileSync(installed, "wrong");
            else writeFileSync(installed + ".json", "{}");
            await perform(false);
            expect(readFileSync(installed, "utf8")).toBe(probe);
            expect(JSON.parse(readFileSync(installed + ".json", "utf8")).sha256).toBe(createHash("sha256").update(probe).digest("hex"));
            expect(fs.statSync(join(bin, "ovis-server")).ino).toBe(serverInode);
          }
        }
        if (legacy && old) {
          const directory = realpathSync(bin);
          const updater = new old.updater.Updater({ root: directory, stateDir: join(root, "state"), autoUpdate: false,
            installedBinary: old.updater.installedBinaryAt(directory, true), publish() {}, activate: async () => {} });
          await updater.initialize();
          expect(updater.status).toMatchObject({ current_version: old.tag === "v0.5.4" ? null : version, managed: false, blocked_reason: old.updater.INSTALLED_BINARY_REASON });
        }
      },
    );
  }
});

it.skipIf(process.platform === "win32")("prepares the active herdr-core source checkout's helpers before starting the server", () => {
  const home = mkdtempSync(join(scratch, "core-"));
  mkdirSync(join(home, ".local/share/ovis/app/.git"), { recursive: true });
  mkdirSync(join(home, "active/scripts"), { recursive: true });
  writeFileSync(join(home, "active/scripts/pty-sidecar.ts"), "");
  const run = Bun.spawnSync(["sh", "-c", `${installer}
ref_not_moved() { :; }
core_settings() { settings_dir=$HOME; state_dir=$HOME; }
running_code() { echo "$HOME/active"; }
core_service() { :; }
bun() {
  case "$*" in
    "scripts/pty-sidecar.ts install") : > "$PWD/native-ready" ;;
    *"plugin.ts start") test -f "$HOME/active/native-ready" && echo ready-at-start ;;
    *) return 1 ;;
  esac
}
start_line=unused
install_core`], { env: { HOME: home, PATH: process.env["PATH"] } });
  expect(run.stdout.toString() + run.stderr.toString()).toContain("ready-at-start");
});
