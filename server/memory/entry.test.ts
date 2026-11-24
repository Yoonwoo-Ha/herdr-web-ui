import { describe, expect, it } from "bun:test";

import { formatEntry, parseEntry, type MemoryEntry } from "./entry.ts";

const ENTRY: MemoryEntry = {
  v: 1,
  id: "01KA81B6YH3D0V7KQ2MZT4NPRS",
  scope: "project",
  project: "git:github.com/devswha/ovis",
  kind: "decision",
  key: "launch.no-config-edit",
  title: "에이전트의 설정 파일은 고치지 않는다. 훅과 도구는 띄울 때의 인자로만 넣는다.",
  verified: true,
  verified_at: "2026-11-24T06:02:10.000Z",
  verified_by: "device:21c9",
  expires: "2027-05-23",
  rev: 2,
  updated_at: "2026-11-24T06:02:10.000Z",
  updated_on: "m_0123456789abcdef",
  source_ref: "file:shared/browser-tools.ts#L6-L11",
  replaces: null,
  origin: { by: "agent", harness: "claude", harness_version: "2.1.330", drive: "terminal", machine: "m_0123456789abcdef", run: "r_5e1c09aa", session: null, turn: 14, exposure: "none", at: "2026-11-24T05:58:33.000Z" },
  body: "실행 인자를 쓴다.\n사용자의 AGENTS.md에는 쓰지 않는다.",
  extra: {},
};

describe("memory entry files", () => {
  it("reads back what it wrote, fields and body alike", () => {
    const text = formatEntry(ENTRY);
    expect(text.startsWith("---\nv: 1\n")).toBe(true);
    expect(parseEntry(text)).toEqual({ ok: true, entry: ENTRY });
  });

  it("keeps a field it does not know, so a newer writer's field survives an edit here", () => {
    const text = formatEntry(ENTRY).replace("\n---\n", "\nsigned_by: \"device:7f3a\"\n---\n");
    const parsed = parseEntry(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.entry.extra).toEqual({ signed_by: "device:7f3a" });
    expect(formatEntry(parsed.entry)).toBe(text);
  });

  it.each([
    ["a title over 80 characters", { title: "가".repeat(81) }],
    ["a line break in the title", { title: "one\ntwo" }],
    ["a hidden character", { body: "looks fine\u202Eevil" }],
    ["a body over 2 KB", { body: "a".repeat(2049) }],
    ["a body over 30 lines", { body: Array.from({ length: 31 }, () => "x").join("\n") }],
    ["a scope it does not know", { scope: "galaxy" as never }],
    ["a project note without a project", { project: null }],
    ["a project on an account note", { scope: "account" as const }],
    ["a malformed expiry", { expires: "next spring" }],
  ])("refuses %s", (_name, change) => {
    expect(parseEntry(formatEntry({ ...ENTRY, ...change })).ok).toBe(false);
  });

  it("refuses a file without a header, one over 4 KB and a header line that is not JSON", () => {
    expect(parseEntry("just text").ok).toBe(false);
    expect(parseEntry(formatEntry(ENTRY) + "x".repeat(4096)).ok).toBe(false);
    expect(parseEntry(formatEntry(ENTRY).replace("rev: 2", "rev: two")).ok).toBe(false);
  });

  it("reads a newer format version as too new, not as damage", () => {
    expect(parseEntry(formatEntry(ENTRY).replace("v: 1", "v: 2"))).toEqual({ ok: false, reason: "too_new" });
  });
});
