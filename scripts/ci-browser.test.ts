import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the whole lane without installing Chromium, building, or opening a browser.
const stub = `
bun() {
  case "$1" in
    -e) printf '/stub/chrome\\n';;
    scripts/demo-build.ts) printf 'DEMO_DIR=%s\\n' "$HERDR_DEMO_BUILD";;
    scripts/*) printf 'STEP=%s EVIDENCE=%s\\n' "$1" "\${UI_EVIDENCE_DIR:-}";;
  esac
  if [ "$1" = "\${FAIL_SCRIPT:-}" ]; then return 7; fi
}
sudo() { return 0; }
source "$1"
`;

async function lane(fail = "", kept = false, ci = "") {
  const dir = mkdtempSync(join(tmpdir(), "hwc-browser-test-"));
  try {
    const child = Bun.spawn(["bash", "-c", stub, "stub", join(import.meta.dir, "ci-browser.sh")], {
      cwd: dir,
      env: { ...process.env, CI: ci, CHECK_DIR: kept ? dir : "", UI_EVIDENCE_DIR: "", FAIL_SCRIPT: fail, TMPDIR: dir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe("");
    const demo = text.match(/^DEMO_DIR=(.+)$/m)?.[1];
    expect(demo).toBeDefined();
    expect(existsSync(demo ?? "")).toBe(false);
    return { text, code, evidence: existsSync(join(dir, kept ? "" : ".ci", "browser-evidence")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (text: string) => [...text.matchAll(/^(scripts\/\S+)\s+(\d+)\s+(\d+)$/gm)].map((row) => ({
  script: row[1], seconds: Number(row[2]), code: Number(row[3]),
}));

describe("browser lane", () => {
  it("summarizes passing and failing scripts and stops at the original exit code", async () => {
    const { text, code } = await lane("scripts/sticky-modifiers-regression.ts");
    expect(code).toBe(7);
    expect(rows(text)).toEqual([
      { script: "scripts/demo-build.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/workspace-rows-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/pending-pane-switch-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/terminal-dispose-browser-qa.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/sticky-modifiers-regression.ts", seconds: expect.any(Number), code: 7 },
    ]);
    expect(text).not.toContain("STEP=scripts/key-bar-customization-demo-regression.ts");
    expect(text).toMatch(/scripts\/sticky-modifiers-regression\.ts.*seconds=\d+.*exit=7/);
  });

  it("summarizes every script and exits zero on success without enabling local evidence", async () => {
    const { text, code, evidence } = await lane();
    expect(code).toBe(0);
    expect(rows(text)).toHaveLength(40);
    expect(rows(text).map((row) => row.script)).toContain("scripts/agy-chat-browser-qa.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/pending-pane-switch-regression.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/chat-fallback-browser-qa.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/file-preview-text-browser-qa.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/terminal-viewport-regression.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/palette-machines-demo-regression.ts");
    expect(rows(text).map((row) => row.script)).toContain("scripts/restored-draft-demo-regression.ts");
    expect(rows(text).every((row) => row.code === 0 && row.seconds >= 0)).toBe(true);
    expect(rows(text).at(-1)?.script).toBe("scripts/herdr-profiles-browser-qa.ts");
    expect(evidence).toBe(false);
    expect(text).not.toMatch(/EVIDENCE=.+/);
  });

  it("keeps only cheap existing screenshots when CHECK_DIR is set", async () => {
    const { text, code, evidence } = await lane("", true);
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    for (const script of ["sticky-modifiers-regression.ts", "file-viewer-regression.ts"]) {
      expect(text).toMatch(new RegExp(`STEP=scripts/${script} EVIDENCE=.+/browser-evidence`));
    }
    for (const script of ["ui-regression.ts", "key-bar-customization-demo-regression.ts"]) {
      expect(text).toContain(`STEP=scripts/${script} EVIDENCE=\n`);
    }
  });

  it("creates evidence under .ci when CI has no CHECK_DIR", async () => {
    const { text, code, evidence } = await lane("", false, "1");
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    expect(text).toContain("STEP=scripts/file-viewer-regression.ts EVIDENCE=.ci/browser-evidence\n");
  });
});
