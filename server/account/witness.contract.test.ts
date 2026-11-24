/**
 * A PC in an account records for how long it has let each of the account's keys in (docs/account.md, "How long a
 * key has been let in"): the rows of the account, never a pairing made at the PC, and nothing decides by it.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { ACCOUNT_WITNESS_FILE, type WitnessRecord } from "./witness.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in an account with one pairing made at the PC (the member) and one row the account's snapshot let in ("Laptop"), still in its hold. */
async function recordingPc() {
  const pc = await createListedPc((close) => closes.push(close));
  const { services } = pc.fixture.app.context;
  const path = join(pc.fixture.stateDir, ACCOUNT_WITNESS_FILE);
  const file = () => JSON.parse(readFileSync(path, "utf8")) as WitnessRecord;
  /** The Laptop's row leaves its join hold, as it does ten seconds after it was told. */
  const letIn = () => {
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
    try { expect(services.accountRows!.access(pc.device.id)).toEqual({ ok: true }); } finally { clock.mockRestore(); }
  };
  return { ...pc, services, path, file, letIn };
}

test("the key of an account row enters the record when the row leaves its hold, and a pairing made at the PC never does", async () => {
  const pc = await recordingPc();
  pc.services.accountWitness!.step();
  expect(pc.file()).toMatchObject({ v: 1, account: ACCOUNT, server_id: pc.serverId });
  expect(pc.file().keys).toEqual({});
  pc.letIn();
  // the row's own write told the record: nothing waits for the next interval
  expect(pc.file().keys).toEqual({ [pc.device.publicKey]: { wall: 0, ran: 0, seen: null } });
  expect(pc.services.devices.hasKey(pc.member.publicKey)).toBe(true);
  if (process.platform !== "win32") expect(statSync(pc.path).mode & 0o777).toBe(0o600);
});

test("a row the account stops naming leaves the record with it", async () => {
  const pc = await recordingPc();
  pc.letIn();
  expect(Object.keys(pc.file().keys)).toEqual([pc.device.publicKey]);
  pc.service.removeDevice(ACCOUNT, pc.device.publicKey);
  expect(await pc.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(pc.services.accountRows!.rows()).toEqual([]);
  expect(pc.file().keys).toEqual({});
});

test("the record goes with the account: a PC that leaves it keeps none", async () => {
  const pc = await recordingPc();
  pc.letIn();
  expect(existsSync(pc.path)).toBe(true);
  pc.services.devices.revokeAll();
  pc.services.accountWitness!.step();
  expect(pc.services.devices.account()).toBeNull();
  expect(existsSync(pc.path)).toBe(false);
});

test("stopping the server writes the record once more", async () => {
  const pc = await recordingPc();
  pc.letIn();
  const before = pc.file().saved;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
  try { pc.fixture.app.stop(); } finally { clock.mockRestore(); }
  expect(pc.file().saved).toBeGreaterThan(before);
});
