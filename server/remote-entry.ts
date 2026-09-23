// The bundle is launched only through SSH. Keep it alive after the tunnel closes;
// herdr owns the terminal processes and no disconnect should terminate their work.
import { createServer } from "./index.ts";
import { bridgeIdentity, descriptorPath, registerBridge } from "./bridge.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

process.env["HERDR_WEB_REMOTE"] = "1";
const bundle = join(import.meta.dir, "..");
process.env["PATH"] = `${join(bundle, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
const session = process.env["HERDR_REMOTE_SESSION"];
process.env["HERDR_SOCKET"] = session ? join(homedir(), ".config/herdr/sessions", session, "herdr.sock") : join(homedir(), ".config/herdr/herdr.sock");
const descriptor = descriptorPath();
mkdirSync(dirname(descriptor), { recursive: true, mode: 0o700 });
const lock = descriptor + ".lock";
try { mkdirSync(lock, { mode: 0o700 }); } catch {
  let stale = false;
  try {
    const owner = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
    }
  } catch { /* a concurrent starter may not yet have written its PID */ }
  if (!stale) throw new Error("Another bridge is starting; retry shortly");
  rmSync(lock, { recursive: true }); mkdirSync(lock, { mode: 0o700 });
}
writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 });
try {
  let existing = false;
  try { const data = JSON.parse(readFileSync(descriptor, "utf8")); process.kill(data.pid, 0); existing = true; } catch {}
  if (!existing) {
  try { await bridgeIdentity(); } catch (error) {
    // A socket that exists but cannot answer is an operator problem, not permission
    // to replace the daemon. Only absent sockets permit starting a new server.
    const { existsSync } = await import("node:fs");
    if (existsSync(process.env["HERDR_SOCKET"]!)) throw error;
    const herdr = process.env["HERDR_WEB_HERDR_BIN"] || join(bundle, "bin/herdr");
    const args = session ? ["--session", session, "server"] : ["server"];
    Bun.spawn([herdr, ...args], { stdin: "ignore", stdout: Bun.file(join(dirname(descriptor), "herdr.log")), stderr: Bun.file(join(dirname(descriptor), "herdr.log")) }).unref();
    let ready = false;
    for (let i = 0; i < 100; i++) { try { await bridgeIdentity(); ready = true; break; } catch { await Bun.sleep(100); } }
    if (!ready) throw new Error("herdr did not start; inspect ~/.config/herdr-web-ui/bridges/herdr.log");
  }
  const info = await bridgeIdentity();
  if (info.herdr.protocol < 22) throw new Error("herdr 0.9+ is required; update it explicitly before connecting");
  const token = randomBytes(32).toString("hex");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, stateDir: descriptor + ".state" });
  const registration = registerBridge(server.port, token);
  const close = () => { registration.close(); server.stop(); setTimeout(() => process.exit(0), 2000); };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  }
} finally { rmSync(lock, { recursive: true, force: true }); }
