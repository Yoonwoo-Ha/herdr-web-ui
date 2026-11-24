import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_KEEPER_BUILD, acpKeeperBin } from "./keeper-bin.ts";

const fixtures = mkdtempSync(join(tmpdir(), "ovis-acp-keeper-bin-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

const KEEPER = "#!/bin/sh\nprintf 'Usage: ovis-acp-keeper ROOT [--cwd DIR] -- AGENT [ARGS...]\\n' >&2\nexit 2\n";
const PTY_HOST = "#!/bin/sh\nprintf 'pty-sidecar: usage: fixture\\n' >&2\nexit 2\n";

function script(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function layout(options: { installed?: string; record?: "vouches" | "stale"; build?: string }): { installed: string; build: string } {
  const dir = join(fixtures, crypto.randomUUID());
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const installed = join(dir, "bin", "ovis-acp-keeper");
  const build = join(dir, "build", "ovis-acp-keeper");
  if (options.installed !== undefined) script(installed, options.installed);
  if (options.installed !== undefined && options.record !== undefined) {
    const sha256 = createHash("sha256").update(options.installed).digest("hex");
    writeFileSync(`${installed}.json`, JSON.stringify({ sha256, version: options.record === "vouches" ? "9.9.9" : "0.0.1" }));
  }
  if (options.build !== undefined) {
    mkdirSync(join(dir, "build"));
    script(build, options.build);
  }
  return { installed, build };
}

describe.skipIf(process.platform === "win32")("acpKeeperBin", () => {
  it("takes OVIS_ACP_KEEPER_BIN when it runs as the keeper, and nothing else when it does not", () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const paths = layout({ installed: KEEPER, record: "vouches", build: KEEPER });
      const chosen = script(join(fixtures, crypto.randomUUID()), KEEPER);
      expect(acpKeeperBin({ OVIS_ACP_KEEPER_BIN: chosen }, paths)).toBe(chosen);
      const host = script(join(fixtures, crypto.randomUUID()), PTY_HOST);
      expect(acpKeeperBin({ OVIS_ACP_KEEPER_BIN: host }, paths)).toBeNull();
      expect(acpKeeperBin({ OVIS_ACP_KEEPER_BIN: join(fixtures, "missing") }, paths)).toBeNull();
      expect(acpKeeperBin({ OVIS_ACP_KEEPER_BIN: "ovis-acp-keeper" }, paths)).toBeNull();
      expect(said.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining("not the ACP keeper (exit 2: pty-sidecar: usage: fixture)"),
        expect.stringContaining("ENOENT"),
        expect.stringContaining("not an absolute path"),
      ]);
    } finally { said.mockRestore(); }
  });

  it("prefers the installed keeper to a local build only while its record vouches for it", () => {
    const vouched = layout({ installed: KEEPER, record: "vouches", build: KEEPER });
    expect(acpKeeperBin({}, vouched)).toBe(vouched.installed);
    const stale = layout({ installed: KEEPER, record: "stale", build: KEEPER });
    expect(acpKeeperBin({}, stale)).toBe(stale.build);
    const unrecorded = layout({ installed: KEEPER, build: KEEPER });
    expect(acpKeeperBin({}, unrecorded)).toBe(unrecorded.build);
  });

  it("passes over a vouched binary or a build that does not run as the keeper", () => {
    const notKeeper = layout({ installed: PTY_HOST, record: "vouches", build: KEEPER });
    expect(acpKeeperBin({}, notKeeper)).toBe(notKeeper.build);
    expect(acpKeeperBin({}, layout({ build: PTY_HOST }))).toBeNull();
    expect(acpKeeperBin({}, layout({}))).toBeNull();
  });

  it.skipIf(!existsSync(ACP_KEEPER_BUILD))("passes the keeper cargo builds", () => {
    expect(acpKeeperBin({ OVIS_ACP_KEEPER_BIN: ACP_KEEPER_BUILD })).toBe(ACP_KEEPER_BUILD);
  });
});
