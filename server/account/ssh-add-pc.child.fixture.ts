/**
 * The Ovis the local installer artifact of ssh-account-add-install.contract.test.ts starts on "that PC": this checkout's
 * server, as its own process under that PC's HOME, registered as an independent server (not a bridge), with step 2 on,
 * the test's account service on loopback and a relay that never leaves this machine. Its state folder, account service
 * and herdr socket come from its environment, as the test's SSH shell sets them.
 */
import { createServer } from "../index.ts";
import { RelayService } from "../relay/service.ts";

const stateDir = process.env["OVIS_FIXTURE_STATE"];
const accountService = process.env["OVIS_FIXTURE_ACCOUNT_SERVICE"];
if (!stateDir || !accountService) throw new Error("OVIS_FIXTURE_STATE and OVIS_FIXTURE_ACCOUNT_SERVICE name this fixture's state and account service");

const idle = (): WebSocket => Object.assign(new EventTarget(), { binaryType: "arraybuffer", readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null }) as unknown as WebSocket;
const relay = new RelayService({ stateDir, relay: "wss://relay.test", connect: () => idle() });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, machines: false, registerBridge: true,
  accountOpensAll: true, accountService: { url: accountService }, relay });
const base = `http://127.0.0.1:${app.port}`;
// the relay identity a PC's own screen makes when its relay starts: what its server_id and key are
const started = await fetch(`${base}/api/relay/start`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
if (!started.ok) throw new Error(`The fixture's relay did not start: ${started.status} ${await started.text()}`);
const stop = () => { void relay.shutdown().finally(() => { app.stop(); process.exit(0); }); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
