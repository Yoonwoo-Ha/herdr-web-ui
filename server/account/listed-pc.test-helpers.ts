import { expect } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { pressOnce, type PressServices } from "./one-press.ts";
import { relayAccountFixture, relayFixture, type TestClock } from "../relay/test-helpers.ts";

export const ACCOUNT = "acct_1";

export async function registerSnapshotPc(service: FakeAccountService, fixture: { readonly stateDir: string }, identity = rotateRelayIdentity(fixture.stateDir)) {
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  return identity.server_id;
}

/**
 * Adds the PC to `account` as its owner's one press does, at the test account service the server was given: listed with
 * a listing of its own, admitted by a fresh two-step sign-in, and bound by its own press, so its binding names the
 * admitted listing and every later read confirms it.
 */
export async function pressInto(service: FakeAccountService, services: PressServices, account = ACCOUNT): Promise<void> {
  const identity = services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  service.opensAll = true;
  service.completions = true;
  const headers = { authorization: `Bearer ${service.issueToken(account, { twoStep: true })}` };
  const call = (path: string, method: string, body: unknown) => service.fetch(new Request(`https://account.test${path}`, { method, headers, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status}`);
  const admitted = await call(`/v1/pcs/${identity.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`The PC was not admitted: ${admitted.status} ${await admitted.text()}`);
  if (!services.relay.setRelayAccount(account)) throw new Error("The account was not named for the PC");
  const pressed = await pressOnce(services, account);
  if ("refused" in pressed) throw new Error(`The press was refused: ${pressed.refused.code}`);
  if (services.devices.serviceListing() === undefined) throw new Error("The press pinned no listing");
}

/** A PC that can apply its first snapshot once the fixture has established the account binding. */
export function memberSnapshotPc(options: Parameters<typeof relayFixture>[1] = {}) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const fixture = relayFixture(false, { ...options, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  return { fixture, async firstRead() {
    await registerSnapshotPc(service, fixture);
    expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  } };
}

/** A bound PC whose whole read has admitted one account row. */
export async function createListedPc(onClose: (close: () => void) => void, clock?: TestClock) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  onClose(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  if (clock) services.devices.useClock(clock);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, spki, "Laptop");
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const device = { keys, publicKey: spki, id: accountDeviceId(serverId, spki) };
  return { fixture, member, device, service, serverId };
}
