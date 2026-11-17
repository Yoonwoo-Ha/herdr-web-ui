import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { hcMachine, setRuntime, startRuntime } from "./runtime.ts";

const stateDir = process.env["OVIS_HC_MACHINE_STATE"];
if (hcMachine() === null || !stateDir) throw new Error("machine-entry.ts runs only as machine-bridge.ts starts it");
setRuntime("herdr-core");
// the adapter's socket in a short folder of its own: under a long state folder its path would pass a unix socket's limit
const socketDir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
const core = await startRuntime(socketDir);
const token = randomBytes(32).toString("hex");
const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, localFiles: false, stateDir });
process.send?.({ type: "ready", port: server.port, token });
for await (const _chunk of Bun.stdin.stream()) {}
server.stop();
core?.stop();
rmSync(socketDir, { recursive: true, force: true });
process.exit(0);
