/**
 * Tests talk to their own herdr: a headless server for the named session
 * `herdr-web-ui-test` (HERDR_TEST_SESSION overrides), started on first use and left
 * running for the next run. The workspaces, panes and agents the tests create never
 * show in the herdr the user works in.
 *
 * `bun test` loads this first (bunfig.toml); the browser and SSH scripts import it.
 * HERDR_TEST_LIVE=1 keeps the old behaviour: tests use HERDR_SOCKET, else the default
 * session. Without a herdr binary nothing changes, so CI runs as before.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ping, sessionSnapshot, workspaceCreate } from "../server/herdr/client.ts";

export const TEST_SESSION = process.env["HERDR_TEST_SESSION"] || "herdr-web-ui-test";

/** Where herdr puts a named session's socket (it follows XDG_CONFIG_HOME, as remote-entry.ts does). */
export function testSocketPath(): string {
  const config = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr");
  return join(config, "sessions", TEST_SESSION, "herdr.sock");
}

function herdrBinary(): string | null {
  const configured = process.env["HERDR_WEB_HERDR_BIN"];
  if (configured) return configured;
  const found = Bun.which("herdr");
  return found ?? null;
}

async function answers(socket: string): Promise<boolean> {
  try { await ping(socket); return true; } catch { return false; }
}

/** Point this process (and what it spawns) at the test session, starting its server if needed. */
export async function useTestHerdr(): Promise<string | null> {
  if (process.env["HERDR_TEST_LIVE"] === "1") return null;
  const herdr = herdrBinary();
  if (!herdr) return null;
  const socket = testSocketPath();
  if (!(await answers(socket))) {
    mkdirSync(dirname(socket), { recursive: true });
    Bun.spawn([herdr, "--session", TEST_SESSION, "server"], {
      stdin: "ignore",
      stdout: Bun.file(join(dirname(socket), "test-server.log")),
      stderr: Bun.file(join(dirname(socket), "test-server.log")),
      // run from inside a herdr pane, this process carries that pane's HERDR_* variables
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))),
    }).unref();
    const deadline = Date.now() + 15_000;
    while (!(existsSync(socket) && await answers(socket))) {
      if (Date.now() > deadline) throw new Error(`The test herdr session "${TEST_SESSION}" did not start; see ${join(dirname(socket), "test-server.log")}`);
      await Bun.sleep(100);
    }
  }
  // some tests read "a live workspace" without owning one: keep one resident, as a
  // session in use always has
  if ((await sessionSnapshot(socket)).workspaces.length === 0) {
    await workspaceCreate({ cwd: homedir(), label: "herdr-web-ui-test-resident" }, socket);
  }
  process.env["HERDR_SOCKET"] = socket;
  return socket;
}

await useTestHerdr();
