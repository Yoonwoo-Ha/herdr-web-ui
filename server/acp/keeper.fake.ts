/**
 * The real keeper (crates/acp-keeper) and its scripted agent (examples/fake_agent.rs), as the ACP tests run them: built
 * with `cargo build --release --manifest-path crates/acp-keeper/Cargo.toml --bins --examples`. A test that needs them
 * is skipped, saying so, where they are not built.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeeperClient } from "./client.ts";
import { ACP_KEEPER_BUILD as KEEPER_BUILD } from "./keeper-bin.ts";

export { KEEPER_BUILD };
export const FAKE_AGENT = fileURLToPath(new URL("../../crates/acp-keeper/target/release/examples/fake_agent", import.meta.url));
export const keeperBuilt = existsSync(KEEPER_BUILD) && existsSync(FAKE_AGENT);
if (!keeperBuilt) {
  const reason = `${KEEPER_BUILD} or ${FAKE_AGENT} is not built (cargo build --release --manifest-path crates/acp-keeper/Cargo.toml --bins --examples)`;
  if (process.env["OVIS_REQUIRE_ACP_KEEPER"] === "1") throw new Error(reason);
  console.warn(`[acp tests] skipped: ${reason}`);
}

const WAIT_MS = 10_000;

/** A private ROOT (0700) in a fresh folder: under TMPDIR, kept short for the socket's path. */
export function keeperRoot(): string {
  const root = join(mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "acp-")), "r");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

/** Waits, bounded, for `check` to hold, rechecking whenever the client says something changed. */
export function until(client: KeeperClient, label: string, check: () => boolean, ms = WAIT_MS): Promise<void> {
  if (check()) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { off(); reject(new Error(`no ${label} within ${ms}ms`)); }, ms);
  const off = client.onChange(() => {
    if (!check()) return;
    clearTimeout(timer);
    off();
    resolve();
  });
  return promise;
}

/** A headless keeper started by the test itself in `root`, running the fake agent; stopped (SIGTERM, its own PID) by `stop`. */
export async function startKeeper(root: string, agentArgs: readonly string[] = []): Promise<{ pid: number; stop: (signal?: "SIGTERM" | "SIGKILL") => Promise<void> }> {
  const proc = Bun.spawn([KEEPER_BUILD, root, "--headless", "--cwd", root, "--", FAKE_AGENT, ...agentArgs], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  // the keeper prints KEEPER_READY once acp.sock listens
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + WAIT_MS;
  let out = "";
  while (!out.includes("KEEPER_READY")) {
    if (Date.now() > deadline) throw new Error("the keeper did not start");
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => ({ value: undefined, done: false }))]);
    if (done) throw new Error(`the keeper exited: ${proc.exitCode}`);
    if (value) out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return {
    pid: proc.pid,
    stop: async (signal = "SIGTERM") => {
      proc.kill(signal);
      await proc.exited;
    },
  };
}
