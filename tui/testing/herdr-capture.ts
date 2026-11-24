/**
 * Refreshes herdr's stored captures (tui/testing/herdr-captures/), the pictures the screen's parity cases compare
 * against (tui/view/parity.test.ts). Runs herdr's own server and client in a scratch folder, gives it the scenes of
 * tui/testing/parity-scenes.ts on a pseudo-terminal behind an emulated host (tui/testing/herdr-grid.ts), once under a
 * dark and once under a light host palette, and writes each picture as a styled cell grid. herdr is only run here,
 * never read into this file. The stored files are refreshed by this script alone, never by hand.
 *
 *   TMPDIR=<scratch folder> bun tui/testing/herdr-capture.ts /absolute/path/to/herdr [--worlds main,agents,ended,empty]
 *     [--sizes 120x40,80x24] [--scenes help,menu]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isolatedHcEnv } from "../../scripts/test-hc.ts";
import { entryPty } from "./entry-pty.ts";
import { type Cells, encodeGrid, hostResponder, type PaletteName, Screen, type StoredGrid } from "./herdr-grid.ts";
import { CAPTURE_FOLDER, type Checkout, type PaneSpec, sizesOf, PARITY_SIZES, SCENES, type SceneKeys, WORLDS, type WorldName } from "./parity-scenes.ts";
import { stopAllPtyRuns, type SupervisedRun } from "./pty.ts";

const SESSION = "r72";
const DETACH = "\x02q";
const ESC = "\x1b";
const CLIENT_LIMIT_MS = 400_000;
/** herdr's toast for an agent that finished: a box on a wide screen, a bottom row on a narrow one */
const DONE_TOAST = /gemini finished|gemini done ·/;
const TOOL_ENV = { PATH: "/usr/bin:/bin" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pane program: prints its name and three lines, then obeys lines written to its own named pipe. Started without a
 * name (herdr opens a workspace of its own on an empty server) it is a bare prompt.
 */
const FIXTURE = `#!/bin/sh
stty -echo 2>/dev/null
if [ -z "$R72_PANE" ]; then printf '$ '; while IFS= read -r line; do printf '$ '; done; exit 0; fi
if [ -n "$R72_MOUSE" ]; then
  printf '%s-READY\\r\\n' "$R72_PANE"
  stty raw -echo 2>/dev/null
  printf '\\033[?1000h\\033[?1002h\\033[?1006h'
  while :; do
    got=$(dd bs=64 count=1 2>/dev/null | od -An -c | tr -s ' \\n' ' ')
    printf 'GOT%s\\r\\n' "$got"
  done
fi
printf '%s-READY\\r\\n' "$R72_PANE"
i=1
while [ "$i" -le 3 ]; do printf 'line %s of %s\\r\\n' "$i" "$R72_PANE"; i=$((i + 1)); done
printf '$ '
while :; do
  if IFS= read -r line < "$R72_CTL"; then
    case "$line" in
      quit) exit 0 ;;
    esac
  fi
done
`;

/** A program on a pseudo-terminal of its own, seen through an emulated host of the given palette. */
class Client {
  readonly screen: Screen;
  readonly run: SupervisedRun;
  private last = performance.now();
  private readonly wakers = new Set<() => void>();
  closed = false;

  constructor(entry: readonly string[], env: Record<string, string>, readonly cols: number, readonly rows: number, palette: PaletteName) {
    this.screen = new Screen(cols, rows);
    const answer = hostResponder((bytes) => this.run.type(bytes), palette);
    this.run = entryPty(entry, env, cols, rows, {
      deadlineMs: CLIENT_LIMIT_MS, answers: [],
      onData: (text) => {
        this.screen.write(text);
        this.last = performance.now();
        answer(text);
        for (const waker of [...this.wakers]) waker();
      },
    });
    void this.run.exited.then(() => {
      this.closed = true;
      for (const waker of [...this.wakers]) waker();
    });
  }

  private nextData(): Promise<void> {
    return new Promise((resolve) => {
      const waker = () => { this.wakers.delete(waker); resolve(); };
      this.wakers.add(waker);
    });
  }

  type(bytes: string): void {
    this.run.type(bytes);
  }

  text(): string {
    return this.screen.text();
  }

  /** the picture as text and style together, for "is the first picture back" */
  look(): string {
    return JSON.stringify(this.screen.cells().cells);
  }

  /** Waits until `until` holds and nothing was written for `quiet` ms (counted from this call at the earliest); gives up after `max` ms. */
  async settle(options: { quiet?: number; max?: number; until?: (text: string) => boolean } = {}): Promise<boolean> {
    const quiet = options.quiet ?? 200;
    const called = performance.now();
    const end = called + (options.max ?? 6000);
    for (;;) {
      const now = performance.now();
      const good = !options.until || options.until(this.text());
      const idle = now - Math.max(this.last, called);
      if (good && idle >= quiet) return true;
      if (now >= end || this.closed) return false;
      const wait = good ? Math.min(quiet - idle, end - now) : Math.min(100, end - now);
      await Promise.race([this.nextData(), sleep(Math.max(1, wait))]);
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.type(DETACH);
      const ended = await Promise.race([this.run.exited.then(() => true), sleep(4000).then(() => false)]);
      if (!ended) await this.run.stop();
    }
    this.screen.dispose();
  }
}

/** Where `needle` first stands in the screen's text: its row and column. */
function find(text: string, needle: string, only?: number): { col: number; row: number } | null {
  const lines = text.split("\n");
  for (let row = 0; row < lines.length; row++) {
    if (only !== undefined && row !== only) continue;
    const col = lines[row]!.indexOf(needle);
    if (col >= 0) return { col, row };
  }
  return null;
}

/** SGR mouse reports (mode 1006), 0-based cells. */
const mouse = {
  click: (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`,
  rightClick: (col: number, row: number): string => `\x1b[<2;${col + 1};${row + 1}M\x1b[<2;${col + 1};${row + 1}m`,
  drag: (from: number, to: number, row: number): string => `\x1b[<0;${from + 1};${row + 1}M\x1b[<32;${to + 1};${row + 1}M\x1b[<0;${to + 1};${row + 1}m`,
};

/** herdr's own server in a scratch folder, driven through its command line. */
async function herdrServer(herdr: string, config: string) {
  const base = process.env["TMPDIR"];
  if (!base || !base.includes("/.cache/ovis-tmp/")) throw new Error("TMPDIR must be a scratch folder under ~/.cache/ovis-tmp");
  const root = mkdtempSync(join(base, "h-"));
  const shell = join(root, "fixture-shell");
  writeFileSync(shell, FIXTURE, { mode: 0o700 });
  mkdirSync(join(root, "ctl"));
  const env: Record<string, string> = {
    ...isolatedHcEnv(root, { XDG_CONFIG_HOME: join(root, "c"), PATH: "/usr/bin:/bin" }),
    TERM: "xterm-256color", COLORTERM: "truecolor", PORT: "1", TMPDIR: root,
    HERDR_TEST_SESSION: SESSION, HERDR_SOCKET: join(root, "c", "herdr", "sessions", SESSION, "herdr.sock"),
    HERDR_CONFIG_PATH: join(root, "herdr.toml"), SHELL: shell,
  };
  delete env["HC_SOCKET"];
  delete env["HC_SESSION"];
  const apiPath = env["HERDR_SOCKET"]!;
  const clientPath = join(root, "c", "herdr", "sessions", SESSION, "herdr-client.sock");
  if (Buffer.byteLength(clientPath) > 107) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`herdr's client socket exceeds 107 bytes: ${clientPath}`);
  }
  const home = join(root, "home");
  for (const path of [home, join(root, "run")]) mkdirSync(path);
  writeFileSync(env["HERDR_CONFIG_PATH"]!, `onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[ui.sound]\nenabled = false\n${config}`);
  const args = [herdr, "--session", SESSION];
  const server = Bun.spawn([...args, "server"], { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const serverErr = new Response(server.stderr).text();
  const call = async (...command: string[]): Promise<string> => {
    const child = Bun.spawn([...args, ...command], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`herdr ${command.join(" ")} exited ${code}: ${err}`);
    return out.trim();
  };
  const limit = performance.now() + 8000;
  while (!existsSync(apiPath) || !existsSync(clientPath)) {
    if (server.exitCode !== null) throw new Error(`isolated herdr exited ${server.exitCode}: ${await serverErr}`);
    if (performance.now() >= limit) throw new Error(`herdr sockets not ready at ${root}`);
    await sleep(10);
  }
  const pipe = async (pane: string): Promise<string> => {
    const path = join(root, "ctl", pane);
    const made = Bun.spawn(["mkfifo", path], { env: TOOL_ENV, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    if (await made.exited !== 0) throw new Error(`mkfifo ${path}: ${await new Response(made.stderr).text()}`);
    return path;
  };
  const tell = async (pane: string, line: string): Promise<void> => {
    const told = Bun.spawn(["sh", "-c", 'printf "%s\\n" "$1" > "$2"', "tell", line, join(root, "ctl", pane)], { env: TOOL_ENV, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 5000 });
    if (await told.exited !== 0) throw new Error(`pane ${pane} did not take "${line}"`);
  };
  const stop = async () => {
    try {
      if (server.exitCode === null && existsSync(apiPath)) await call("server", "stop");
      else if (server.exitCode === null) server.kill("SIGTERM");
    } catch (error) {
      if (server.exitCode === null) server.kill("SIGTERM");
      throw error;
    } finally {
      await server.exited;
      const left = existsSync(apiPath) || existsSync(clientPath);
      rmSync(root, { recursive: true, force: true });
      console.log(`herdr cleanup: owned server exited (${server.exitCode}); sockets ${left ? "LEFT" : "removed"}; folder removed`);
    }
  };
  return { args, env, home, call, pipe, tell, stop };
}

type Server = Awaited<ReturnType<typeof herdrServer>>;

/** The scene of a world built on herdr's server; answers how to report agents and how to put the first pane in front. */
async function build(server: Server, panes: readonly PaneSpec[], checkouts: readonly Checkout[] = []) {
  const ids = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const tabs = new Map<string, string>();
  const agents = new Map<string, string>();
  let first: { workspace: string; tab: string; pane: string; neighbour: string | null } | null = null;
  let seq = 1;
  // each checkout: a repository on its branch with one commit, made by git itself (the tooling may start processes)
  for (const checkout of checkouts) {
    const folder = join(server.home, checkout.folder);
    mkdirSync(folder, { recursive: true });
    const git = async (...args: string[]) => {
      const env = { ...TOOL_ENV, HOME: server.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "r75", GIT_AUTHOR_EMAIL: "r75@example.invalid", GIT_COMMITTER_NAME: "r75", GIT_COMMITTER_EMAIL: "r75@example.invalid" };
      const ran = Bun.spawn(["git", ...args], { cwd: folder, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      if (await ran.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(ran.stderr).text()}`);
    };
    if (checkout.linkedTo) {
      // a linked worktree of the checkout made before it: made from that repository, in this folder
      const made = Bun.spawn(["git", "worktree", "add", "-q", "-b", checkout.branch, folder], { cwd: join(server.home, checkout.linkedTo), env: { ...TOOL_ENV, HOME: server.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      if (await made.exited !== 0) throw new Error(`git worktree add ${folder}: ${await new Response(made.stderr).text()}`);
      continue;
    }
    await git("init", "-q", "-b", checkout.branch);
    await git("commit", "-q", "--allow-empty", "-m", "first");
  }
  const cwdOf = (pane: PaneSpec) => pane.folder ? join(server.home, pane.folder) : server.home;
  const paneEnv = async (pane: PaneSpec) => ["--env", `R72_PANE=${pane.name}`, "--env", `R72_CTL=${await server.pipe(pane.name)}`, ...(pane.mouse ? ["--env", "R72_MOUSE=1"] : [])];
  const report = async (name: string, state: string) => {
    await server.call("pane", "report-agent", ids.get(name)!, "--source", "r72", "--agent", agents.get(name) ?? "claude", "--state", state, "--seq", String(seq++));
  };
  for (const pane of panes) {
    const tabKey = `${pane.workspace}/${pane.tab}`;
    let id: string;
    if (!workspaces.has(pane.workspace)) {
      const made: { result: { root_pane: { pane_id: string }; workspace: { workspace_id: string } } } = JSON.parse(await server.call(
        "workspace", "create", "--cwd", cwdOf(pane), "--label", pane.workspace, ...await paneEnv(pane), ...(first ? ["--no-focus"] : ["--focus"]),
      ));
      id = made.result.root_pane.pane_id;
      const workspace = made.result.workspace.workspace_id;
      workspaces.set(pane.workspace, workspace);
      const listed: { result: { tabs: { tab_id: string }[] } } = JSON.parse(await server.call("tab", "list", "--workspace", workspace));
      const tab = listed.result.tabs[0]!.tab_id;
      tabs.set(tabKey, tab);
      await server.call("tab", "rename", tab, pane.tab);
      first ??= { workspace, tab, pane: id, neighbour: null };
    } else if (!tabs.has(tabKey)) {
      const made: { result: { root_pane: { pane_id: string }; tab: { tab_id: string } } } = JSON.parse(await server.call(
        "tab", "create", "--workspace", workspaces.get(pane.workspace)!, "--cwd", cwdOf(pane), "--label", pane.tab, ...await paneEnv(pane), "--no-focus",
      ));
      id = made.result.root_pane.pane_id;
      tabs.set(tabKey, made.result.tab.tab_id);
    } else {
      const beside = [...ids.entries()].filter(([name]) => panes.find((one) => one.name === name && one.workspace === pane.workspace && one.tab === pane.tab)).at(-1)![1];
      const made: { result: { pane: { pane_id: string } } } = JSON.parse(await server.call(
        "pane", "split", beside, "--direction", "right", "--cwd", cwdOf(pane), ...await paneEnv(pane), "--no-focus",
      ));
      id = made.result.pane.pane_id;
      if (first && beside === first.pane) first.neighbour = id;
    }
    ids.set(pane.name, id);
    await server.call("pane", "rename", id, pane.name);
    if (pane.agent && pane.state) {
      agents.set(pane.name, pane.agent);
      // herdr has no "done" to report: it shows done for an agent it saw working that went idle unseen
      await report(pane.name, pane.state === "done" ? "working" : pane.state);
    }
  }
  return {
    report: (name: string, state: "working" | "blocked" | "idle" | "done") => report(name, state === "done" ? "idle" : state),
    async reset() {
      if (!first) return;
      await server.call("workspace", "focus", first.workspace);
      await server.call("tab", "focus", first.tab);
      if (first.neighbour) await server.call("pane", "focus", "--direction", "left", "--pane", first.neighbour).catch(() => {});
    },
  };
}

type Scene = Awaited<ReturnType<typeof build>>;
interface Context { client: Client; scene: Scene; server: Server; cols: number; rows: number; palette: PaletteName; second: Client | null }

/** What herdr is typed or told for one scene's keys; null when the screen has no control for it. */
async function keysOf(keys: SceneKeys, context: Context): Promise<string | null> {
  switch (keys.kind) {
    case "type":
      return keys.text;
    case "click": {
      for (const label of keys.labels) {
        const at = find(context.client.text(), label);
        if (at) return mouse.click(at.col + 1, at.row);
      }
      return null;
    }
    case "drag": {
      const at = find(context.client.text(), keys.over);
      return at ? mouse.drag(at.col, at.col + keys.over.length - 1, at.row) : null;
    }
    case "report":
      await context.scene.report(keys.pane, keys.state);
      return "";
    case "viewer": {
      context.second = new Client([...context.server.args], context.server.env, Math.max(40, context.cols - 14), Math.max(12, context.rows - 6), context.palette);
      await context.second.settle({ quiet: 400, max: 8000, until: (text) => text.includes("READY") });
      return "";
    }
    case "rclick": {
      const at = find(context.client.text(), keys.label, keys.row);
      return at ? mouse.rightClick(at.col + (keys.dx ?? 0), at.row) : null;
    }
    case "rclickAt": {
      const [col, row] = keys.at(context.cols, context.rows);
      return mouse.rightClick(col, row);
    }
    case "steps": {
      // each step typed once the one before it has drawn its picture
      for (const step of keys.steps) {
        const before = context.client.look();
        const typed = await keysOf(step, context);
        if (typed === null) return null;
        if (typed !== "") context.client.type(typed);
        await context.client.settle({ quiet: 300, max: 3000, until: () => context.client.look() !== before });
      }
      return "";
    }
  }
}

interface Pictures { version: string; grids: Map<string, { dark?: StoredGrid; light?: StoredGrid }> }

async function session(world: WorldName, server: Server, scene: Scene, cols: number, rows: number, palette: PaletteName, only: readonly string[] | null, out: Pictures): Promise<void> {
  const spec = WORLDS[world];
  const size = `${cols}x${rows}`;
  let client: Client | null = null;
  let base = "";
  const open = async () => {
    await scene.reset();
    client = new Client([...server.args], server.env, cols, rows, palette);
    if (!await client.settle({ quiet: 500, max: 10_000, until: (text) => spec.ready(text) })) {
      throw new Error(`${world} ${size} ${palette}: herdr's first picture never came:\n${client.text()}`);
    }
    if (world === "agents") {
      // herdr shows "done" only for an agent this client saw working: it goes idle now, and its toast is waited out
      await scene.report("A-DONE", "working");
      await client.settle({ quiet: 300, max: 3000 });
      await scene.report("A-DONE", "done");
      await client.settle({ quiet: 200, max: 5000, until: (text) => DONE_TOAST.test(text) });
      await client.settle({ quiet: 800, max: 20_000, until: (text) => !DONE_TOAST.test(text) });
    }
    base = client.look();
  };
  const close = async (context: Context | null) => {
    if (context?.second) await context.second.close();
    if (client) await client.close();
    client = null;
  };
  await open();
  for (const one of SCENES[world]) {
    if (!client) await open();
    const current: Client = client!;
    const context: Context = { client: current, scene, server, cols, rows, palette, second: null };
    let note = "";
    if (one.herdr) {
      const before = current.look();
      const keys = await keysOf(one.herdr, context);
      if (keys === null) note = "no control for it";
      else {
        if (keys !== "") current.type(keys);
        const wanted = one.expect;
        await current.settle({ quiet: 350, max: one.maySame ? 1500 : 5000, until: (text) => wanted ? wanted.test(text) : current.look() !== before });
        if (current.look() === before) note = "the keys changed nothing";
      }
    }
    if (!only || only.includes(one.id)) {
      const key = `${one.id}.${size}`;
      const entry = out.grids.get(key) ?? {};
      entry[palette] = encodeGrid(current.screen.cells() as Cells);
      out.grids.set(key, entry);
      console.log([one.id, size, palette, note].filter(Boolean).join(" "));
    }
    if (one.last) {
      await close(context);
    } else if (one.herdr) {
      const back = async (max: number) => current.settle({ quiet: 250, max, until: () => current.look() === base });
      const leave = one.herdrLeave ? await keysOf(one.herdrLeave, context) : ESC;
      if (leave) current.type(leave);
      let restored = await back(1800);
      for (let again = 0; !restored && again < 2; again++) {
        current.type(ESC);
        restored = await back(1500);
      }
      if (!restored && one.lingerMs) restored = await back(one.lingerMs);
      if (!restored) await close(context);
    }
  }
  await close(null);
}

const [herdr, ...flags] = process.argv.slice(2);
if (!herdr || !isAbsolute(herdr)) throw new Error("pass the absolute path to herdr");
const flag = (name: string): string[] | null => {
  const at = flags.indexOf(`--${name}`);
  return at >= 0 ? flags[at + 1]!.split(",") : null;
};
const worlds = (flag("worlds") ?? Object.keys(WORLDS)) as WorldName[];
const sizes = (flag("sizes") ?? PARITY_SIZES.map(([c, r]) => `${c}x${r}`)).map((size) => size.split("x").map(Number) as [number, number]);
const only = flag("scenes");
await Screen.load();
let failed = false;
try {
  for (const world of worlds) {
    const measured = sizesOf(world).map(([c, r]) => `${c}x${r}`);
    const runs = sizes.filter(([c, r]) => measured.includes(`${c}x${r}`)).flatMap(([cols, rows]) => (["dark", "light"] as const).map((palette) => ({ cols, rows, palette })));
    const out: Pictures = { version: "", grids: new Map() };
    // one server for every session of the world, or one each when what a scene leaves must not reach the next
    for (const group of WORLDS[world].freshServer ? runs.map((one) => [one]) : [runs]) {
      const server = await herdrServer(herdr, WORLDS[world].herdrConfig ?? "");
      out.version = (await server.call("--version")).replace(/^herdr\s+/, "");
      try {
        const scene = await build(server, WORLDS[world].panes, WORLDS[world].checkouts);
        if (world === "ended") {
          await server.tell("RIGHT", "quit");
          // fixed wait: herdr closes an ended program's pane by itself and tells the command line nothing the script can wait on
          await sleep(1500);
        }
        for (const { cols, rows, palette } of group) await session(world, server, scene, cols, rows, palette, only, out);
      } finally {
        await stopAllPtyRuns();
        await server.stop();
      }
    }
    mkdirSync(CAPTURE_FOLDER, { recursive: true });
    for (const [key, { dark, light }] of out.grids) {
      if (!dark || !light) throw new Error(`${key}: a palette is missing`);
      const file = join(CAPTURE_FOLDER, `${key}.json`);
      const same = JSON.stringify(dark) === JSON.stringify(light);
      writeFileSync(file, `${JSON.stringify({ herdr: out.version, dark, light: same ? "dark" : light })}\n`);
    }
    console.log(`${world}: ${out.grids.size} captures written (herdr ${out.version})`);
  }
} catch (error) {
  failed = true;
  console.error(error);
}
process.exit(failed ? 1 : 0);
