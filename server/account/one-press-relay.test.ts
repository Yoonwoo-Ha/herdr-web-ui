/**
 * The relay step of a take over SSH (one-press.ts relayForAdd), on a PC already in the account: whatever the relay does,
 * a bind already made is answered as one, and one undone while the take waited for the relay is not.
 */
import { expect, test } from "bun:test";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayService } from "../relay/service.ts";
import type { AccountMailbox } from "./mailbox.ts";
import { takeForAccount } from "./one-press.ts";

const SERVER = "0123456789abcdef0123456789abcdef";
const status = (phase: RelayStatus["phase"], blocked: RelayStatus["blocked"] = null): RelayStatus =>
  ({ phase, blocked, relay: "wss://relay.test", app: "https://app.test", sessions: 0, error: null, error_code: null, account_named: true });

function services(relay: Partial<RelayService>, account: () => string | null = () => "acct_1") {
  const binding = { account: "acct_1" };
  const devices = { account, serviceBinding: () => account() === null ? null : binding } as unknown as DeviceStore;
  const full = { currentIdentity: () => ({ server_id: SERVER }), setRelayAccount: () => true, switchSet: () => false, status: () => status("off"), ...relay } as unknown as RelayService;
  return { devices, relay: full, accountMailbox: {} as AccountMailbox };
}

test("a start the relay refuses (blocked) is answered at once, as it stands", async () => {
  const taken = await takeForAccount(services({ start: () => status("off", "serve_only") }), "acct_1", SERVER, 5_000);
  expect(taken).toEqual({ account: "acct_1", relay: { phase: "off", blocked: "serve_only" } });
});

test("a start that throws (a shutdown, an identity reset) still answers the bind, with the relay as it is", async () => {
  const taken = await takeForAccount(services({ start: () => { throw new Error("Relay identity reset is in progress."); } }), "acct_1", SERVER, 5_000);
  expect(taken).toEqual({ account: "acct_1", relay: { phase: "off", blocked: null } });
});

test("naming the account again that fails to be saved takes nothing back from the bind", async () => {
  const taken = await takeForAccount(services({ setRelayAccount: () => { throw new Error("EACCES"); }, start: () => status("online") }), "acct_1", SERVER, 5_000);
  expect(taken).toEqual({ account: "acct_1", relay: { phase: "online", blocked: null } });
});

test("a PC the account removed while the take waited for its relay is not answered as added", async () => {
  let bound: string | null = "acct_1";
  const pending = takeForAccount(services({ start: () => status("connecting"), status: () => status("connecting") }, () => bound), "acct_1", SERVER, 400);
  setTimeout(() => { bound = null; }, 50);
  expect(await pending).toMatchObject({ refused: { code: "not_listed" } });
});

test("a relay identity reset while the take waited is not answered as added", async () => {
  let identity = SERVER;
  const pending = takeForAccount(services({ currentIdentity: () => ({ server_id: identity }) as never, start: () => status("connecting"), status: () => status("connecting") }), "acct_1", SERVER, 400);
  setTimeout(() => { identity = "f".repeat(32); }, 50);
  expect(await pending).toMatchObject({ refused: { code: "identity_changed" } });
});

test("a switch its owner set (off) is left as set on a PC already in the account", async () => {
  let started = false;
  const taken = await takeForAccount(services({ switchSet: () => true, start: () => { started = true; return status("online"); } }), "acct_1", SERVER, 5_000);
  expect([started, taken]).toEqual([false, { account: "acct_1", relay: { phase: "off", blocked: null } }]);
});
