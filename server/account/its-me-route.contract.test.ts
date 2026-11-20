import { expect, spyOn, test } from "bun:test";
import { accountDeviceId } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import * as herdr from "../herdr/client.ts";
import { relayConnection } from "../relay/test-helpers.ts";
import { keyOf } from "./account-devices.test-helpers.ts";
import { ITS_ME_MIN_AGE_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";

test("P15/T53, OD3: It's me from an older device over its relay session ends the new device's hold at once and decides its notice", async () => {
  const closes: (() => void)[] = [];
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  try {
    const { fixture, member: sayer, service, serverId } = await createListedPc(close => closes.push(close));
    now += 2 * ITS_ME_MIN_AGE_MS;
    const { devices, accountMailbox, core } = fixture.app.context.services;
    const key = keyOf("k-held");
    const id = accountDeviceId(serverId, key);
    service.registerDevice(ACCOUNT, key, "New phone");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const notice = devices.openNotices().find(entry => entry.row === id);
    if (!notice) throw new Error("Missing the new phone's admission notice");
    expect(devices.sessionRow(id)).toBeNull();
    const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
    await link.auth(sayer, [ACCOUNT_OPENS_ALL_FEATURE]);
    const socket = link.openSocket();
    await socket.opened;

    socket.send({ type: "notice-answer", id: notice.id, answer: "its_me" });
    socket.send({ type: "ping", id: 1 });
    await socket.until(message => message.type === "pong" && message.id === 1);

    expect({
      refusal: socket.messages.find(message => message.type === "error"),
      confirmed: socket.messages.some(message => message.type === "device-notice" && message.notice.kind === "confirm" && message.notice.how === "its_me" && message.notice.row === id),
      session: devices.sessionRow(id),
      open: devices.openNotices().some(entry => entry.id === notice.id),
    }).toMatchObject({ refusal: undefined, confirmed: true, session: { role: "drive", key }, open: false });
  } finally {
    clock.mockRestore();
    snapshot.mockRestore();
    for (const close of closes) close();
  }
});

test("T53: an It's me the PC cannot record answers notice_decision_failed and the same connection keeps answering", async () => {
  const closes: (() => void)[] = [];
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { fixture, member: sayer, service, serverId } = await createListedPc(close => closes.push(close));
    now += 2 * ITS_ME_MIN_AGE_MS;
    const { devices, accountMailbox, core } = fixture.app.context.services;
    const key = keyOf("k-held");
    service.registerDevice(ACCOUNT, key, "New phone");
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    const notice = devices.openNotices().find(entry => entry.row === accountDeviceId(serverId, key));
    if (!notice) throw new Error("Missing the new phone's admission notice");
    const failing = spyOn(devices, "itsMe").mockImplementation(() => { throw new Error("EIO"); });
    const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
    await link.auth(sayer, [ACCOUNT_OPENS_ALL_FEATURE]);
    const socket = link.openSocket();
    await socket.opened;
    socket.send({ type: "notice-answer", id: notice.id, answer: "its_me" });
    socket.send({ type: "ping", id: 7 });
    await socket.until(message => message.type === "pong" && message.id === 7);
    expect({
      called: failing.mock.calls.length,
      error: socket.messages.find(message => message.type === "error")?.code,
      open: devices.openNotices().some(entry => entry.id === notice.id),
    }).toEqual({ called: 1, error: "notice_decision_failed", open: true });
    failing.mockRestore();
  } finally {
    logged.mockRestore();
    clock.mockRestore();
    snapshot.mockRestore();
    for (const close of closes) close();
  }
});
