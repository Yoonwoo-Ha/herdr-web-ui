/**
 * The Ovis the local installer artifact of ssh-account-add-install.contract.test.ts starts on "that PC": this checkout's
 * server, as its own process under that PC's HOME, registered as an independent server (not a bridge), with step 2 on,
 * the test's account service on loopback and the test's relay on loopback. As after an install over SSH, its relay is
 * off: nobody opened its page to turn it on. Its state folder, account service, relay and herdr socket come from its
 * environment, as the test's SSH shell sets them.
 */
import { createServer } from "../index.ts";
import { RelayService } from "../relay/service.ts";

const stateDir = process.env["OVIS_FIXTURE_STATE"];
const accountService = process.env["OVIS_FIXTURE_ACCOUNT_SERVICE"];
const relayPort = process.env["OVIS_FIXTURE_RELAY_PORT"];
if (!stateDir || !accountService || !relayPort) throw new Error("OVIS_FIXTURE_STATE, OVIS_FIXTURE_ACCOUNT_SERVICE and OVIS_FIXTURE_RELAY_PORT name this fixture's state, account service and relay");

// the relay at its wss:// name, reached over plain ws on loopback
const relay = new RelayService({ stateDir, relay: `wss://127.0.0.1:${relayPort}`, connect: (url) => {
  const target = new URL(url);
  return new WebSocket(`ws://127.0.0.1:${relayPort}${target.pathname}${target.search}`);
} });
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, machines: false, registerBridge: true,
  accountOpensAll: true, accountService: { url: accountService }, relay });
const stop = () => { void relay.shutdown().finally(() => { app.stop(); process.exit(0); }); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
