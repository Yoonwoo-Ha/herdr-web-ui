import { describe, expect, it } from "bun:test";
import { ListWriteError, signListEntries, signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { placeOf, signedOn, writeToList } from "./listWrite.ts";

type World = ReturnType<typeof listWorld>;

const noWait = { wait: async () => {} };
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));

/** An account whose first device let a borrowed browser in: power `bound`, for a day. */
async function borrowed(w: World = listWorld()) {
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const browser = await w.device({ label: "A borrowed browser" });
  await browser.list.sync();
  const writer = first.list.writer()!;
  const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key !== writer.keys.key)!;
  const written = await signListEntry(writer.state, { kind: "device", key: claim.key, power: "bound", role: "drive", until: writer.issued_at + 86_400, enc: claim.enc, card: claim.card, sealed: null, rotates: false },
    { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
  await writer.service.placeEntries(writer.list, [written.text], []);
  await browser.list.adopt({ list: writer.list, ...placeOf(written.state) });
  expect(browser.list.view().status).toMatchObject({ at: "following", standing: "in" });
  return { w, first, browser };
}

describe("a device that may sign for nobody else", () => {
  it("has no writer, and has one for the removal of its own key alone", async () => {
    const { w, first, browser } = await borrowed();
    expect(browser.list.writer()).toBeNull();
    const own = browser.list.writer({ self: true });
    expect(own).toMatchObject({ list: w.held().id, account: w.account });
    expect(own!.keys.key).toBe((await browser.keys()).key);
    // and the device of power `full` gets the same writer either way
    expect(first.list.writer({ self: true })).toEqual(first.list.writer());
  });

  it("puts itself out through the one write loop, with the writer it is handed", async () => {
    const { w, first, browser } = await borrowed();
    const key = (await browser.keys()).key;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome).toMatchObject({ written: true, list: w.held().id });
    expect(readBody(entryFromText(w.held().entries.at(-1)!).body)).toMatchObject({ kind: "remove", signer: key, ends: key });
    expect((await first.list.sync()).devices.map((device) => device.key)).toEqual([(await first.keys()).key]);
    expect(browser.list.view().status).toMatchObject({ at: "following", standing: "out" });
  });

  it("signs nothing for anybody else, whatever writer it is handed: the kinds refuse it", async () => {
    const { w, first, browser } = await borrowed();
    const before = w.held().entries.length;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: (await first.keys()).key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome).toEqual({ written: false, why: "refused", retryAfterMs: null });
    expect([placements(browser), w.held().entries.length]).toEqual([[], before]);
  });
});

describe("a write that is over once the account service took it", () => {
  it("reads nothing after the request, and is told the place it signed", async () => {
    const { browser } = await borrowed();
    const key = (await browser.keys()).key;
    let place: { seq: number; hash: string } | undefined;
    // the account service ends this device's sign-in with the placement: no read of the list answers after it
    browser.wire.answer = (request) => request.method === "GET" && placements(browser).length > 0 ? Response.json({ error: { code: "unauthorized", message: "" } }, { status: 401 }) : null;
    const outcome = await writeToList(browser.list, async (writer) => {
      const request = await signedOn(writer, [{ kind: "remove", ends: key }]);
      ({ place } = request);
      return { request };
    }, { ...noWait, writer: () => browser.list.writer({ self: true }), trustPlaced: true });
    expect(outcome).toMatchObject({ written: true, place: place! });
    expect(placements(browser).length).toBe(1);
  });

  it("without that word, a request the service took and a list that then does not read is no write", async () => {
    const { browser } = await borrowed();
    const key = (await browser.keys()).key;
    browser.wire.answer = (request) => request.method === "GET" && placements(browser).length > 0 ? new Response("away", { status: 503 }) : null;
    const outcome = await writeToList(browser.list, async (writer) => ({ request: await signedOn(writer, [{ kind: "remove", ends: key }]) }), { ...noWait, writer: () => browser.list.writer({ self: true }) });
    expect(outcome.written).toBe(false);
  });
});

describe("a device that is behind", () => {
  it("says so where the kinds refuse to sign somebody in on what it holds, and sends nothing", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const outcome = await writeToList(first.list, async (writer) => {
      const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key !== writer.keys.key)!;
      // what this device holds once a member of a later level wrote at place 1: the kinds sign nobody in on it
      const behind = { ...writer.state, behind: 1 };
      const signed = await signListEntries(behind, [{ kind: "device", key: claim.key, power: "full", role: "drive", until: null, enc: claim.enc, card: claim.card, sealed: null, rotates: false }],
        { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
      return { request: { entries: signed.entries.map((entry) => entry.text), wraps: [], place: placeOf(signed.state) } };
    }, noWait);
    expect(outcome).toEqual({ written: false, why: "behind", retryAfterMs: null });
    expect(placements(first)).toEqual([]);
    // any other entry the kinds do not sign stays a plain refusal
    expect(await writeToList(first.list, async () => { throw new ListWriteError(null, "not that key's card"); }, noWait)).toMatchObject({ written: false, why: "refused" });
  });
});
