import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { fileInfo, fileResponse, resolveFilePath } from "./file-view.ts";

describe("file view", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-view-")); roots.push(root); return root; };

  it("resolves absolute, ~ and pane-relative paths", () => {
    expect(resolveFilePath("/a/b.txt", "/work")).toBe("/a/b.txt");
    expect(resolveFilePath("~/x.png", null)).toBe(join(homedir(), "x.png"));
    expect(resolveFilePath("docs/demo.mp4", "/work/app")).toBe("/work/app/docs/demo.mp4");
    expect(resolveFilePath("docs/demo.mp4", null)).toBeNull();
    expect(resolveFilePath("  ", "/work")).toBeNull();
  });

  it("tells media, text and binary apart, and is null for a folder or nothing", () => {
    const root = temp();
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "run.log"), "line\n");
    writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "notes"), "plain words");
    expect(fileInfo(join(root, "a.png"))!.kind).toBe("image");
    expect(fileInfo(join(root, "run.log"))!.kind).toBe("text");
    expect(fileInfo(join(root, "blob"))!.kind).toBe("binary");
    expect(fileInfo(join(root, "notes"))!.kind).toBe("text");
    expect(fileInfo(root)).toBeNull();
    expect(fileInfo(join(root, "missing"))).toBeNull();
  });

  it("serves HTML as sandboxed plain text, and a download as an attachment", async () => {
    const root = temp();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const response = fileResponse(fileInfo(join(root, "page.html"))!, true);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(response.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });
});
