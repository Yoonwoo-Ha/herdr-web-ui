import { expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { DirectoryListing } from "../../shared/directories.ts";
import type { RepoDiffFileList, RepoDiffRefs } from "../../shared/repo-diff.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { FilesDialog } from "./FilesDialog.tsx";

test("keeps Branch selected when Files moves to another pane (#3028)", async () => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: class HTMLElement {},
    window: { ...listen, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  };
  const saved = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.assign(globalThis, globals);
  const listing = (root: string) => ({
    repository: { root, branch: "feature", head: "a".repeat(40), detached: false, unborn: false },
    scope: "workspace", base: null, head: null, comparison: null, files: [], total: 0, truncated: false,
    limits: { max_files: 100, max_list_bytes: 1024 },
  } satisfies RepoDiffFileList);
  const branchReply = Promise.withResolvers<Response>();
  let branchRequested = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://ovis.test");
    const root = url.searchParams.get("directory") ?? "/repo";
    if (url.pathname.endsWith("/diff/refs")) return Response.json({
      repository: listing(root).repository, refs: [], truncated: false, limits: { max_refs: 100, max_list_bytes: 1024 },
    } satisfies RepoDiffRefs);
    if (url.pathname.endsWith("/diff/files")) {
      if (url.searchParams.get("pane_id") === "p1" && url.searchParams.get("scope") === "branch") {
        branchRequested = true;
        return branchReply.promise;
      }
      return Response.json(listing(root));
    }
    return Response.json({ path: "/repo", parent: "/", home: "/home/test", files: [], directories: [], truncated: false } satisfies DirectoryListing);
  }, globalThis.fetch));
  const noop = () => undefined;
  const dialog = (paneId: string) => <SettingsProvider>
    <FilesDialog start="/repo" paneId={paneId} viewing={false} onOpenFile={noop} onOpenDiff={noop} onBrowseFolders={noop} onClose={noop} />
  </SettingsProvider>;
  const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");
  const button = (root: ReactTestInstance, name: string) => root.find((node) => node.type === "button" && text(node) === name);
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(dialog("p1")); });
    if (!renderer) throw new Error("Files did not mount");
    const view = renderer;
    await act(async () => { button(view.root, "Changes").props.onClick(); });
    expect(button(view.root, "Working tree").props["aria-pressed"]).toBe(true);
    await act(async () => { button(view.root, "Branch").props.onClick(); });
    expect(button(view.root, "Branch").props["aria-pressed"]).toBe(true);
    await act(async () => {
      view.root.findByProps({ role: "combobox" }).props.onChange({ target: { value: "main" } });
    });
    await act(async () => { view.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(branchRequested).toBe(true);
    await act(async () => { view.update(dialog("p2")); });
    await act(async () => {
      branchReply.resolve(Response.json({
        ...listing("/repo"), scope: "branch", total: 1,
        files: [{ path: "old-pane.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }],
      } satisfies RepoDiffFileList));
    });
    expect(button(view.root, "Branch").props["aria-pressed"]).toBe(true);
    expect(view.root.findByProps({ role: "combobox" }).props.value).toBe("");
    expect(text(view.root)).not.toContain("old-pane.txt");
  } finally {
    await act(async () => { renderer?.unmount(); });
    fetch.mockRestore();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
