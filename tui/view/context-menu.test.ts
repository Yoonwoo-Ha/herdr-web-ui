import { afterEach, describe, expect, it } from "bun:test";
import { defaultCheckoutPath } from "../../server/herdr-core/worktrees.ts";
import { ovisServer, type OvisServer } from "../core/ovis-server.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHcCore } from "../../server/herdr-core/core.fake.ts";
import { leaves, OVIS_LAYOUT_DOC, parseOvisLayout } from "../../server/herdr-core/layout-doc.ts";
import { editLayout, passthroughEdit } from "../../server/herdr-core/layout-ops.ts";
import { PANE_NAME_LABEL } from "../../server/herdr-core/snapshot.ts";
import { WORKTREE_LABEL } from "../../server/herdr-core/worktrees.ts";
import type { ContextAction } from "../model/context.ts";
import { focused, type Target } from "../model/focus.ts";
import { place } from "../testing/fixtures/fixture.ts";
import { Run } from "../testing/run.ts";

const TEST_MS = 60_000;
const runs: Run[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * herdr's right-click world (docs/tui/visual-parity.md R1-R8): a tab split in LEFT and RIGHT and a second tab, a second
 * workspace; with `git`, a repository and a linked worktree of it on disk, each shown by a workspace of its own.
 */
async function start(options: { git?: boolean; mouse?: boolean; nested?: boolean; server?: OvisServer } = {}): Promise<Run> {
  const core = new FakeHcCore();
  const where = (space: string, tab: string, pane: string, cwd?: string) => ({ space: `w-${space}`, spaceName: space, tab: `t-${space}-${tab}`, tabName: tab, pane, ...(cwd ? { cwd } : {}) });
  place(core, where("work", "one", "LEFT"), "LEFT-READY\r\n");
  place(core, where("work", "one", "RIGHT"), options.mouse ? "RIGHT-READY\r\n\x1b[?1002h\x1b[?1006h" : "RIGHT-READY\r\n");
  place(core, where("work", "two", "SOLO"), "SOLO-READY\r\n");
  place(core, where("docs", "notes", "NOTES"), "NOTES-READY\r\n");
  if (options.git) {
    const home = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "context-"));
    folders.push(home);
    const own = join(home, "repo", ".git", "worktrees", "repo-wt");
    mkdirSync(own, { recursive: true });
    mkdirSync(join(home, "repo-wt"));
    writeFileSync(join(home, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(home, "repo-wt", ".git"), `gitdir: ${own}\n`);
    writeFileSync(join(own, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(join(own, "gitdir"), `${join(home, "repo-wt", ".git")}\n`);
    writeFileSync(join(own, "commondir"), "../..\n");
    if (options.nested) {
      // a repository of its own inside the checkout (a clone, a submodule), its workspace listed before the repository's
      mkdirSync(join(home, "repo", "inner", ".git"), { recursive: true });
      writeFileSync(join(home, "repo", "inner", ".git", "HEAD"), "ref: refs/heads/other\n");
      place(core, where("clone", "sh", "INNER", join(home, "repo", "inner")), "INNER-READY\r\n");
    }
    place(core, where("repo", "main", "CODE", join(home, "repo")), "CODE-READY\r\n");
    place(core, where("feat", "wt", "WT", join(home, "repo-wt")), "WT-READY\r\n");
  }
  const run = await Run.start({ core, cols: 120, rows: 40, ...(options.server ? { server: options.server } : {}) });
  runs.push(run);
  await run.live();
  await run.advance(10);
  return run;
}

/** The first cell of `text` on the screen (on row `row` only, when given). */
function cellOf(run: Run, text: string, row?: number): { x: number; y: number } {
  const rows = run.grid();
  const y = row ?? rows.findIndex((line) => line.includes(text));
  const x = rows[y]?.indexOf(text) ?? -1;
  if (y < 0 || x < 0) throw new Error(`no ${text} on the screen:\n${rows.join("\n")}`);
  return { x, y };
}

const top = (run: Run) => run.loop.model().overlays.at(-1);
const menu = (run: Run) => {
  const overlay = top(run);
  return overlay?.kind === "context" ? { target: overlay.target, entries: overlay.entries, cursor: overlay.cursor, at: overlay.at } : null;
};
const focusOf = (run: Run) => JSON.stringify(run.loop.model().focus);
const paneId = (run: Run, name: string) => run.loop.model().world.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((pane) => pane.name === name)!.id;
const tabId = (run: Run, name: string) => run.loop.model().world.workspaces.flatMap((w) => w.tabs).find((tab) => tab.name === name)!.id;
const spaceId = (run: Run, name: string) => run.loop.model().world.workspaces.find((workspace) => workspace.name === name)!.id;
const layoutDoc = (run: Run) => parseOvisLayout(run.core.docs.get(OVIS_LAYOUT_DOC)?.value);

/** Escape: a lone one is told from a key's first byte after the screen's wait (about 300 ms with no reply). */
async function escape(run: Run): Promise<void> {
  await run.keys("esc");
  await run.advance(400);
}

async function rclick(run: Run, at: { x: number; y: number }, shift = false): Promise<void> {
  // a focus change before it repaints and attaches first: the press is read once that has settled
  await run.advance(400);
  await run.keys(`${shift ? "shift+" : ""}rclick@${at.x}:${at.y}`);
  await run.advance(20);
}

/** Opens `target`'s menu with a right press at `at`, then takes its entry `label`. */
async function choose(run: Run, at: { x: number; y: number }, label: string): Promise<void> {
  await rclick(run, at);
  const item = cellOf(run, label);
  await run.keys(`click@${item.x + 1}:${item.y}`);
  // what the entry writes comes back from the core before the screen shows it
  await run.advance(300);
}

describe("herdr's right-click menus: where they open (R1)", () => {
  it("on any cell of a pane's box, a tab and a workspace's row, at the pressed cell and with no focus change; nowhere else", async () => {
    const run = await start();
    const before = focusOf(run);
    const right = paneId(run, "RIGHT");
    const text = cellOf(run, "RIGHT-READY");
    const opened: [string, { x: number; y: number }, Target, readonly ContextAction[]][] = [
      ["a pane's text, not focused", { x: text.x + 3, y: text.y }, { kind: "pane", id: right }, ["rename_pane", "clear_pane_name", "swap_with_focused", "split_vertical", "split_horizontal", "zoom", "passthrough_on", "close_pane"]],
      ["its title", { x: cellOf(run, "┌ RIGHT").x + 3, y: 1 }, { kind: "pane", id: right }, ["rename_pane", "clear_pane_name", "swap_with_focused", "split_vertical", "split_horizontal", "zoom", "passthrough_on", "close_pane"]],
      ["the focused pane's bottom border", { x: 50, y: 39 }, { kind: "pane", id: paneId(run, "LEFT") }, ["rename_pane", "clear_pane_name", "split_vertical", "split_horizontal", "zoom", "passthrough_on", "close_pane"]],
      ["a tab", cellOf(run, "two", 0), { kind: "tab", id: tabId(run, "two") }, ["new_tab", "rename_tab", "close_tab"]],
      ["a workspace's row", cellOf(run, "docs"), { kind: "workspace", id: spaceId(run, "docs") }, ["rename_workspace", "close_workspace"]],
    ];
    for (const [where, at, target, entries] of opened) {
      await rclick(run, at);
      expect({ where, menu: menu(run), focus: focusOf(run) }).toEqual({ where, menu: { target, entries, cursor: 0, at: { x: at.x, y: at.y } }, focus: before });
      await escape(run);
    }
    for (const [where, at] of [["the sidebar's header", { x: 2, y: 0 }], ["its new button", cellOf(run, " new")], ["the tab bar's +", cellOf(run, "+", 0)], ["the agents' header", cellOf(run, "agents")]] as const) {
      await rclick(run, at);
      expect({ where, open: run.loop.model().overlays.length, focus: focusOf(run) }).toEqual({ where, open: 0, focus: before });
    }
    // the collapsed sidebar's rail is no workspace row for it
    await run.keys("ctrl+b,b");
    await run.advance(20);
    await rclick(run, { x: 1, y: 1 });
    expect(run.loop.model().overlays).toEqual([]);
  }, TEST_MS);
});

describe("the menu's keys and pointer (R3)", () => {
  it("up and down stop at the ends, the pointer chooses, a left press elsewhere only closes it, a right press does nothing", async () => {
    const run = await start();
    const before = focusOf(run);
    const text = cellOf(run, "RIGHT-READY");
    await rclick(run, { x: text.x + 3, y: text.y });
    await run.keys("up");
    expect(menu(run)?.cursor).toBe(0);
    await run.keys("down,down,down,down,down,down,down,down,down,down");
    expect(menu(run)?.cursor).toBe(7);
    // other keys do nothing
    await run.keys("x");
    expect(menu(run)?.cursor).toBe(7);
    const zoom = cellOf(run, "│Zoom");
    await run.keys(`move@${zoom.x + 3}:${zoom.y}`);
    await run.advance(20);
    expect(menu(run)?.cursor).toBe(5);
    // a right press anywhere, another target too, leaves it as it is
    await rclick(run, cellOf(run, "two", 0));
    expect(menu(run)?.target).toEqual({ kind: "pane", id: paneId(run, "RIGHT") });
    // a left press outside it closes it and goes no further: the pane under it is not focused
    const left = cellOf(run, "LEFT-READY");
    await run.keys(`click@${left.x + 2}:${left.y + 3}`);
    await run.advance(20);
    expect([run.loop.model().overlays.length, focusOf(run)]).toEqual([0, before]);
  }, TEST_MS);
});

describe("the pointer chooses in every menu, from the host's own motion reports (row 78)", () => {
  it("a button-less motion report (ESC[<35;x;yM, what a host in mode 1003 sends) moves the choice in the right-click menu, the menu, the picker and the switcher; a program that asked for 1002 gets none of it", async () => {
    const run = await start({ mouse: true });
    // the screen asks the host for any-motion reports, as herdr does
    expect(run.host.output()).toContain("\x1b[?1003h");
    const motion = (x: number, y: number) => `\x1b[<35;${x + 1};${y + 1}M`;
    const right = paneId(run, "RIGHT");
    const sent = () => Buffer.from(run.core.program(right).receivedHex(), "hex").toString();
    const text = cellOf(run, "RIGHT-READY");
    await rclick(run, { x: text.x + 3, y: text.y });
    const zoom = cellOf(run, "│Zoom");
    run.type(motion(zoom.x + 3, zoom.y));
    await run.advance(20);
    expect(menu(run)?.cursor).toBe(5);
    await escape(run);
    await run.keys("ctrl+b,enter");
    await run.advance(20);
    const help = cellOf(run, "help");
    run.type(motion(help.x + 1, help.y));
    await run.advance(20);
    expect(top(run)).toEqual(expect.objectContaining({ kind: "menu", cursor: 1 }));
    await escape(run);
    await run.keys("ctrl+b,g");
    await run.advance(20);
    const solo = cellOf(run, "SOLO");
    run.type(motion(solo.x, solo.y));
    await run.advance(20);
    expect(top(run)).toEqual(expect.objectContaining({ kind: "goto", chosen: paneId(run, "SOLO") }));
    await escape(run);
    // the pane program asked for 1002 (button events): a motion with no button over it, the menus closed, reaches it not
    run.type(motion(text.x + 2, text.y + 1));
    await run.advance(20);
    expect(sent()).toBe("");
  }, TEST_MS);

  it("on a narrow screen the switcher's choice does not follow the pointer (herdr's does not); the picker's pointer chooses a workspace heading, and Enter goes there", async () => {
    const run = await start();
    run.host.resize(45, 30);
    await run.advance(400);
    await run.keys("ctrl+b,w");
    await run.advance(20);
    const opened = top(run);
    const docs = cellOf(run, "docs");
    run.type(`\x1b[<35;${docs.x + 2};${docs.y + 1}M`);
    await run.advance(20);
    const overlay = top(run);
    expect(overlay?.kind === "switcher" && opened?.kind === "switcher" && overlay.cursor === opened.cursor).toBe(true);
    await escape(run);
    run.host.resize(120, 40);
    await run.advance(400);
    await run.keys("ctrl+b,g");
    await run.advance(20);
    const heading = cellOf(run, " docs");
    run.type(`\x1b[<35;${heading.x + 3};${heading.y + 1}M`);
    await run.advance(20);
    expect(top(run)).toEqual(expect.objectContaining({ kind: "goto", chosen: `heading:${spaceId(run, "docs")}` }));
    await run.keys("enter");
    await run.advance(50);
    expect(run.loop.model().focus.workspace).toBe(spaceId(run, "docs"));
  }, TEST_MS);

  it("a program that asked for any motion (1003) gets the pointer passing from the start, before any press; one in 1002 gets none", async () => {
    const run = await start({ mouse: true });
    const right = paneId(run, "RIGHT");
    const text = cellOf(run, "RIGHT-READY");
    await run.keys(`click@${text.x + 1}:${text.y}`);
    await run.advance(50);
    const sent = () => Buffer.from(run.core.program(right).receivedHex(), "hex").toString();
    const before = sent();
    run.type(`\x1b[<35;${text.x + 4};${text.y + 2}M`);
    await run.advance(20);
    // 1002: the click went (press and release), the motion did not
    expect(sent()).toBe(before);
    run.core.program(right).output("\x1b[?1003h");
    await run.advance(50);
    const afterMode = sent();
    run.type(`\x1b[<35;${text.x + 4};${text.y + 2}M`);
    await run.advance(20);
    expect(sent().slice(afterMode.length)).toMatch(/^\x1b\[<35;\d+;\d+M$/);
  }, TEST_MS);
});

describe("a pane's entries (R4)", () => {
  it("clear its name, swap it with the focused pane (the focus stays), zoom it (and focus it), split it, close it at once", async () => {
    const run = await start();
    const left = paneId(run, "LEFT");
    const right = paneId(run, "RIGHT");
    const at = () => ({ x: cellOf(run, "RIGHT-READY").x + 3, y: cellOf(run, "RIGHT-READY").y });
    await choose(run, at(), "Clear pane name");
    expect(run.core.calls().filter((call) => call.method === "terminal.label").map((call) => call.params)).toContainEqual({ terminal: right, labels: { [PANE_NAME_LABEL]: "" } });
    await choose(run, at(), "Swap with focused pane");
    const tab = () => layoutDoc(run)!.workspaces.flatMap((workspace) => workspace.tabs).find((one) => leaves(one.root).includes(left))!;
    expect([leaves(tab().root), focused(run.loop.model().world, run.loop.model().focus).pane?.id]).toEqual([[right, left], left]);
    await choose(run, at(), "Zoom");
    expect([tab().zoomed, focused(run.loop.model().world, run.loop.model().focus).pane?.id]).toEqual([right, right]);
    await run.keys("ctrl+b,z");
    await run.advance(50);
    const made = run.core.calls().filter((call) => call.method === "terminal.run").length;
    await choose(run, at(), "Split down");
    expect(run.core.calls().filter((call) => call.method === "terminal.run").length).toBe(made + 1);
    await run.advance(100);
    const focusedNow = focused(run.loop.model().world, run.loop.model().focus).pane;
    expect([focusedNow?.id === left || focusedNow?.id === right, focusedNow?.name]).toEqual([false, ""]);
    await choose(run, at(), "Close pane");
    expect(run.loop.model().overlays).toEqual([]);
    expect(run.core.calls().filter((call) => call.method === "terminal.kill").map((call) => call.params["terminal"])).toEqual([right]);
  }, TEST_MS);

  it("Send right-clicks to pane: kept in the layout document beside zoom; a right press in its text then goes to its program and focuses it, shift still opens the menu", async () => {
    const run = await start({ mouse: true });
    const right = paneId(run, "RIGHT");
    const text = cellOf(run, "RIGHT-READY");
    // by default a right press opens herdr's menu even over a program that asked for the mouse
    await choose(run, { x: text.x + 3, y: text.y }, "Send right-clicks to pane");
    const passthrough = () => layoutDoc(run)!.workspaces.flatMap((workspace) => workspace.tabs).flatMap((tab) => tab.passthrough ?? []);
    expect(passthrough()).toEqual([right]);
    await rclick(run, { x: text.x + 3, y: text.y });
    expect(run.loop.model().overlays).toEqual([]);
    expect(Buffer.from(run.core.program(right).receivedHex(), "hex").toString()).toBe("\x1b[<2;4;1M\x1b[<2;4;1m");
    expect(focused(run.loop.model().world, run.loop.model().focus).pane?.id).toBe(right);
    // shift keeps it for the screen: the menu, whose entry now turns it back
    await rclick(run, { x: text.x + 3, y: text.y }, true);
    expect(menu(run)?.entries).toContain("passthrough_off");
    const back = cellOf(run, "Use the right-click menu");
    await run.keys(`click@${back.x + 1}:${back.y}`);
    await run.advance(50);
    expect(passthrough()).toEqual([]);
  }, TEST_MS);

  it("a pane sent to another workspace keeps Send right-clicks to pane: the screen shows it there, and the next edit of anything else writes it there", async () => {
    const run = await start();
    const right = paneId(run, "RIGHT");
    const text = cellOf(run, "RIGHT-READY");
    await choose(run, { x: text.x + 3, y: text.y }, "Send right-clicks to pane");
    const kept = () => layoutDoc(run)!.workspaces.flatMap((workspace) => workspace.tabs).flatMap((tab) => (tab.passthrough ?? []).map((pane) => [tab.id, pane]));
    expect(kept()).toEqual([[tabId(run, "one"), right]]);
    // focused, then sent to a new tab of the docs workspace (navigate mode: the workspace below, then m): its labels move, nothing else
    await run.keys(`click@${text.x + 3}:${text.y}`);
    await run.advance(400);
    await run.keys("ctrl+b,w,down,m");
    await run.advance(400);
    const holder = () => run.loop.model().world.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({ workspace: workspace.name, tab }))).find(({ tab }) => tab.panes.some((pane) => pane.id === right))!;
    expect([holder().workspace, holder().tab.id === tabId(run, "one"), holder().tab.passthrough]).toEqual(["docs", false, [right]]);
    // the menu there offers to turn it back, as it does where it was set
    const notes = paneId(run, "NOTES");
    await editLayout(run.loop.link, passthroughEdit(notes, true));
    await run.advance(100);
    expect(kept().sort()).toEqual([[holder().tab.id, right], [tabId(run, "notes"), notes]].sort());
    expect(holder().tab.passthrough).toEqual([right]);
  }, TEST_MS);
});

describe("a tab's and a workspace's entries (R5, R6)", () => {
  it("a tab's entry first brings that tab to the front: New tab with the next number, Rename with its name, Close at once", async () => {
    const run = await start();
    await choose(run, cellOf(run, "two", 0), "New tab");
    expect([focused(run.loop.model().world, run.loop.model().focus).tab?.name, top(run)?.kind === "text" && top(run)]).toEqual(["two", expect.objectContaining({ purpose: "new_tab", field: expect.objectContaining({ original: "3" }) })]);
    await escape(run);
    await run.keys("ctrl+b,1");
    await run.advance(20);
    const solo = paneId(run, "SOLO");
    await choose(run, cellOf(run, "two", 0), "Close");
    expect(run.core.calls().filter((call) => call.method === "terminal.kill").map((call) => call.params["terminal"])).toEqual([solo]);
  }, TEST_MS);

  it("a workspace's Rename opens the name dialog with its name, its Close asks first; the workspace in front stays", async () => {
    const run = await start();
    const before = run.loop.model().focus.workspace;
    await choose(run, cellOf(run, "docs"), "Rename");
    expect([run.loop.model().focus.workspace, top(run)]).toEqual([before, expect.objectContaining({ kind: "text", purpose: "rename_workspace", field: expect.objectContaining({ original: "docs" }) })]);
    await escape(run);
    await choose(run, cellOf(run, "docs"), "Close");
    expect(top(run)).toEqual(expect.objectContaining({ kind: "confirm", purpose: "close_workspace", target: { kind: "workspace", id: spaceId(run, "docs") } }));
  }, TEST_MS);
});

describe("a git workspace's entries (R7)", () => {
  it("a repository of its own inside the checkout, listed first, is not taken for the checkout's workspace (the server's rule)", async () => {
    const run = await start({ git: true, nested: true });
    await choose(run, cellOf(run, " repo"), "Open worktree...");
    const dialog = top(run);
    expect(dialog?.kind === "worktrees" && dialog.checkouts.map(({ label, open }) => [label, open])).toEqual([["main", spaceId(run, "repo")], ["feature", spaceId(run, "feat")]]);
    await run.keys("down,enter");
    await run.advance(300);
    const labelled = run.core.calls().filter((call) => call.method === "terminal.label" && WORKTREE_LABEL in (call.params["labels"] as object)).map((call) => call.params["terminal"]);
    expect(labelled.sort()).toEqual([paneId(run, "CODE"), paneId(run, "WT")].sort());
  }, TEST_MS);

  it("Open worktree... lists the checkouts from git's files; Enter on one a workspace shows goes there and groups it, which folds and closes as one", async () => {
    const run = await start({ git: true });
    const repo = spaceId(run, "repo");
    const feat = spaceId(run, "feat");
    // The repository menu offers both creating and opening a worktree.
    await rclick(run, cellOf(run, "repo"));
    expect(menu(run)?.entries).toEqual(["rename_workspace", "close_workspace", "new_worktree", "open_worktree"]);
    await escape(run);
    await choose(run, cellOf(run, "repo"), "Open worktree...");
    const dialog = top(run);
    expect(dialog?.kind === "worktrees" && dialog.checkouts.map(({ label, open }) => [label, open])).toEqual([["main", repo], ["feature", feat]]);
    await run.keys("down,enter");
    await run.advance(100);
    expect(run.loop.model().focus.workspace).toBe(feat);
    const labelled = run.core.calls().filter((call) => call.method === "terminal.label" && WORKTREE_LABEL in (call.params["labels"] as object));
    expect(labelled.length).toBe(2);
    const world = run.loop.model().world;
    expect([world.workspaces.find((one) => one.id === repo)?.group, world.workspaces.find((one) => one.id === feat)?.parent]).toEqual([{ collapsed: false }, repo]);
    expect(run.grid()[cellOf(run, "repo").y]!.slice(0, 26)).toBe(" · repo                 ▾│");
    // a grouped worktree's own menu, as herdr's: Delete worktree checkout... (done by the Ovis server)
    await rclick(run, cellOf(run, "└─"));
    expect(menu(run)?.entries).toEqual(["rename_workspace", "close_workspace", "delete_checkout"]);
    await escape(run);
    await run.keys(`click@${cellOf(run, "work").x + 1}:${cellOf(run, "work").y}`);
    await run.advance(50);
    await choose(run, cellOf(run, "repo"), "Collapse");
    expect(layoutDoc(run)!.workspaces.find((one) => one.id === repo)?.collapsed).toBe(true);
    expect(run.grid().some((line) => line.slice(0, 26).includes("└─"))).toBe(false);
    const ends = [paneId(run, "CODE"), paneId(run, "WT")].sort();
    await choose(run, cellOf(run, "repo"), "Close group");
    expect(top(run)).toEqual(expect.objectContaining({ kind: "confirm", purpose: "close_group", spaces: 2 }));
    await run.keys("enter");
    await run.advance(100);
    expect(run.core.calls().filter((call) => call.method === "terminal.kill").map((call) => call.params["terminal"]).sort()).toEqual(ends);
  }, TEST_MS);
});

describe("New worktree and Delete worktree checkout... through the Ovis server (row 83)", () => {
  /** a stand-in for the server's two routes: what was asked, and the answer the server gives (its shape and status) */
  const standIn = (answers: Record<string, (body: Record<string, unknown>) => Response>) => {
    const asked: { url: string; body: unknown }[] = [];
    const server = ovisServer("http://127.0.0.1:9", async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      asked.push({ url, body });
      const answer = answers[url.slice(url.lastIndexOf("/") + 1).replace(/-checked$/, "")];
      if (!answer) throw new TypeError("connection refused");
      return answer(body);
    });
    return { asked, server };
  };
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("New worktree opens herdr's dialog with a suggested branch; Enter asks the server for that branch on the repository's workspace and goes to the new pane", async () => {
    let made = "";
    const { asked, server } = standIn({ create: (body) => json(200, { workspace_id: "w-feat", pane_id: made, path: "/x/repo-wt", branch: body["branch"], already_open: false })() });
    const run = await start({ git: true, server });
    // the server's answer names the pane it opened: here the worktree's, which the fake core already shows
    made = paneId(run, "WT");
    await choose(run, cellOf(run, " repo"), "New worktree");
    await run.advance(100);
    const dialog = top(run);
    expect(dialog?.kind === "text" && dialog.purpose).toBe("create_worktree");
    const branch = dialog?.kind === "text" ? dialog.field.graphemes.join("") : "";
    expect(branch).toMatch(/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    // the folder the server will use, as much of it as the dialog's line holds (how much depends on the home's length)
    const rows = run.grid();
    const label = rows.findIndex((line) => /│ checkout\s*│/.test(line));
    const shown = rows[label + 1]!.split("│").find((part) => part.startsWith(" /"))!.trimEnd();
    expect(` ${defaultCheckoutPath("repo", branch)}`.startsWith(shown)).toBe(true);
    expect(shown.length).toBeGreaterThanOrEqual(Math.min(` ${defaultCheckoutPath("repo", branch)}`.length, 60));
    await run.keys("enter");
    await run.advance(300);
    expect(asked).toEqual([{ url: "http://127.0.0.1:9/api/worktree/create-checked", body: { workspace_id: spaceId(run, "repo"), branch, expected_core: (await run.loop.link.hello()).core.id, expected_repo: join(folders.at(-1)!, "repo", ".git") } }]);
    expect(run.loop.model().focus.workspace).toBe(spaceId(run, "feat"));
  }, TEST_MS);

  it("Delete worktree checkout... asks first with the checkout's folder; Enter asks the server to remove it; with no server the notice names `ovis`", async () => {
    const { asked, server } = standIn({});
    const run = await start({ git: true, server });
    await choose(run, cellOf(run, " repo"), "Open worktree...");
    await run.keys("down,enter");
    await run.advance(300);
    await choose(run, cellOf(run, "└─"), "Delete worktree checkout...");
    await run.advance(100);
    const dialog = top(run);
    expect(dialog?.kind === "confirm" && dialog.purpose).toBe("remove_worktree");
    expect(run.grid().some((line) => line.includes("delete worktree checkout?"))).toBe(true);
    await run.keys("enter");
    await run.advance(300);
    expect(asked).toEqual([{ url: "http://127.0.0.1:9/api/worktree/remove-checked", body: {
      workspace_id: spaceId(run, "feat"), expected_core: (await run.loop.link.hello()).core.id,
      expected_repo: join(folders.at(-1)!, "repo", ".git"), expected_checkout: join(folders.at(-1)!, "repo-wt"),
      expected_git_id: expect.any(String),
    } }]);
    expect(run.loop.model().notices.some((notice) => notice.code === "ovis_server_none")).toBe(true);
  }, TEST_MS);

  it.each(["before selection", "after drawing"])("requires a taken delete question after resize %s", async (when) => {
    const { asked, server } = standIn({});
    const run = await start({ git: true, server });
    await choose(run, cellOf(run, " repo"), "Open worktree...");
    await run.keys("down,enter");
    await run.advance(300);
    if (when === "before selection") {
      await rclick(run, cellOf(run, "└─"));
      run.host.resize(100, 5);
      await run.advance(100);
      await run.keys("down,down,enter");
    } else {
      await choose(run, cellOf(run, "└─"), "Delete worktree checkout...");
      expect(run.grid().some((line) => line.includes("delete worktree checkout?"))).toBe(true);
      run.host.resize(100, 5);
    }
    await run.advance(100);
    expect(top(run)?.kind).toBe("confirm");
    expect(run.grid().some((line) => line.includes("delete worktree checkout?"))).toBe(false);
    await run.keys("enter");
    await run.advance(100);
    expect(asked).toEqual([]);
    run.host.resize(120, 40);
    await run.advance(100);
    await run.keys("enter");
    await run.advance(100);
    expect(asked.map(({ url }) => url)).toEqual(["http://127.0.0.1:9/api/worktree/remove-checked"]);
  }, TEST_MS);

  it("the server's refusal is said in its own words, and nothing else changes", async () => {
    const { server } = standIn({ create: json(404, { error: { code: "worktree_create_failed", message: "fatal: a branch named 'x' already exists" } }) });
    const run = await start({ git: true, server });
    const before = run.loop.model().world.workspaces.length;
    await choose(run, cellOf(run, " repo"), "New worktree");
    await run.advance(100);
    await run.keys("enter");
    await run.advance(300);
    expect(run.grid().some((line) => line.includes("worktree_create_failed: fatal: a branch named"))).toBe(true);
    expect(run.loop.model().world.workspaces.length).toBe(before);
  }, TEST_MS);
});
