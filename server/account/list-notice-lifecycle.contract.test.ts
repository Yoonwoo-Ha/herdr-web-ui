import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId } from "../../shared/account-records.ts";
import { privateStateFs } from "../private-state.ts";
import { relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { SAFETY_LOG_FILE } from "./safety-log.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const listed = () => createListedPc(close => closes.push(close));

test("G15/T57/P8: a plain decision changes neither the held row nor the safety log, and stays decided", async () => {
  const { fixture, device, service } = await listed();
  const { devices } = fixture.app.context.services;
  const [notice] = devices.openNotices();
  if (!notice || notice.row !== device.id) throw new Error("Missing listed admission");
  const state = () => [ACCOUNT_DEVICES_FILE, SAFETY_LOG_FILE].map(file => readFileSync(join(fixture.stateDir, file), "utf8"));
  const before = state();
  expect(devices.sessionRow(device.id)).toBeNull();
  devices.decideNotice(notice.id);
  expect(devices.openNotices()).toHaveLength(0);
  expect(state()).toEqual(before);
  expect(devices.sessionRow(device.id)).toBeNull();
  fixture.app.stop();
  const reopened = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.unshift(() => reopened.app.stop());
  const services = reopened.app.context.services;
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(services.devices.openNotices()).toHaveLength(0);
  expect(services.devices.sessionRow(device.id)).toBeNull();
});

test("G15/T57/P8: local Revoke removes the listed row and frees its notice slot", async () => {
  const { fixture, device } = await listed();
  const { devices } = fixture.app.context.services;
  expect(devices.openNotices().map(n => n.row)).toEqual([device.id]);
  expect(devices.revoke(device.id)).toBe(true);
  expect(devices.has(device.id)).toBe(false);
  expect(devices.openNotices()).toHaveLength(0);
});

test("G15/T57/P8: a key-only local recovery marker decides just its listed admission before pruning", async () => {
  const { fixture, device, service } = await listed();
  const { accountMailbox, devices } = fixture.app.context.services;
  const other = keyOf("k-other");
  service.registerDevice(ACCOUNT, other, "Kept");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(devices.openNotices().map(n => n.key)).toEqual([device.publicKey, other]);
  devices.removeKey({ target: device.publicKey, by: "local" });
  expect(devices.isTombstoned(device.publicKey)).toBe(true);
  expect(devices.openNotices().map(n => n.key)).toEqual([other]);
});

test("G15/T57/P8: a failed listed-row save leaves no open notice for the unsaved row", async () => {
  const { fixture, service, serverId } = await listed();
  const { devices, accountMailbox } = fixture.app.context.services;
  const before = devices.openNotices().map(n => n.id);
  const key = keyOf("k-unsaved");
  const id = accountDeviceId(serverId, key);
  service.registerDevice(ACCOUNT, key, "Unsaved");
  const rename = privateStateFs.renameSync;
  const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(fixture.stateDir, ACCOUNT_DEVICES_FILE) && readFileSync(from, "utf8").includes(id)) throw new Error("listed row save failed");
    rename(from, to);
  });
  try {
    await accountMailbox.readSnapshot();
    expect(accountMailbox.error).toBe("listed row save failed");
    expect(devices.has(id)).toBe(false);
    expect(devices.openNotices().map(n => n.id)).toEqual(before);
  } finally { fault.mockRestore(); }
});
