import { describe, expect, it } from "bun:test";
import { LIST_LEVEL, listView, readKind, replayList } from "../../../shared/account-list.ts";
import { entryFromText, entryHash, readBody } from "../../../shared/account-list-entry.ts";
import { epochKeyCommitment, openWrap, wrapFromText } from "../../../shared/account-list-seal.ts";
import { listNames, makeGenesis } from "./listGenesis.ts";
import { deviceListKeys } from "./listKeys.ts";
import { namesAt } from "./listNames.ts";
import { memoryAccountStore } from "./store.ts";

const ACCOUNT = "acct_owner";
const NOW = 1_795_000_000_123;

async function made(names = listNames("Dana's phone", "ios")) {
  const keys = await deviceListKeys(memoryAccountStore());
  return { keys, genesis: await makeGenesis({ account: ACCOUNT, keys, names, now: NOW }) };
}

describe("the genesis a device makes", () => {
  it("is entry 0 of a list a member follows: signed by the device, which is its first device", async () => {
    const { keys, genesis } = await made();
    const replayed = await replayList([genesis.entry], LIST_LEVEL, { saved: null, given: genesis.list });
    expect(replayed.stopped).toBeNull();
    const state = replayed.member!.state;
    expect(state.list).toBe(genesis.list);
    expect(entryHash(entryFromText(genesis.entry).body)).toBe(genesis.list);
    expect(listView(state).devices).toEqual([{ key: keys.key, power: "full", seq: 0, by: keys.key, ended: null, role: "drive", until: null, enc: keys.enc.key, carried: false }]);
    expect([listView(state).pcs, listView(state).invites]).toEqual([[], []]);
    const body = readBody(entryFromText(genesis.entry).body);
    expect([body.signer, body.issued_at, body.seq, body.list, body.prev]).toEqual([keys.key, Math.floor(NOW / 1000), 0, "", ""]);
    expect(readKind(body)).toMatchObject({ kind: "genesis", account: ACCOUNT, enc: keys.enc.key });
  });

  it("opens epoch 0 by a commitment to a key that only the device's own wrap gives", async () => {
    const { keys, genesis } = await made();
    const state = (await replayList([genesis.entry], LIST_LEVEL, { saved: null, given: genesis.list })).member!.state;
    const commitment = state.epochs[0]!.opens;
    const opened = await openWrap({ list: genesis.list, epoch: 0, commitment, wrap: wrapFromText(genesis.wrap), member: keys.enc });
    expect(opened.open).toBe(true);
    if (!opened.open) return;
    expect(epochKeyCommitment({ list: "", epoch: opened.value })).toBe(commitment);
    expect(genesis.enc).toBe(keys.enc.key);
    const stranger = await deviceListKeys(memoryAccountStore());
    expect(await openWrap({ list: genesis.list, epoch: 0, commitment, wrap: wrapFromText(genesis.wrap), member: stranger.enc })).toEqual({ open: false, why: "refused" });
  });

  it("seals the device's name under that key, where nobody without it reads it", async () => {
    const { keys, genesis } = await made();
    const commitment = (await replayList([genesis.entry], LIST_LEVEL, { saved: null, given: genesis.list })).member!.state.epochs[0]!.opens;
    const opened = await openWrap({ list: genesis.list, epoch: 0, commitment, wrap: wrapFromText(genesis.wrap), member: keys.enc });
    if (!opened.open) throw new Error("the device's own wrap opens");
    expect(await namesAt(genesis.list, [genesis.entry], 0, new Map([[0, opened.value]]))).toEqual({ label: "Dana's phone", os: "ios" });
    expect(await namesAt(genesis.list, [genesis.entry], 0, new Map())).toBeNull();
    expect(atob(genesis.entry.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("Dana");
  });

  it("carries no names when it has none to seal, and is the same list all the same", async () => {
    const { keys, genesis } = await made(null);
    const kind = readKind(readBody(entryFromText(genesis.entry).body));
    expect(kind).toMatchObject({ kind: "genesis", sealed: null });
    const replayed = await replayList([genesis.entry], LIST_LEVEL, { saved: null, given: genesis.list });
    expect(listView(replayed.member!.state).devices.map((row) => row.key)).toEqual([keys.key]);
  });

  it("names a device by one plain line of at most 48 units, or not at all", () => {
    expect(listNames("  Dana's\u0000  phone‮ ", "android")).toEqual({ label: "Dana's phone", os: "android" });
    expect(listNames("x".repeat(60), null)).toEqual({ label: "x".repeat(48), os: null });
    expect(listNames(" \n ", "ios")).toBeNull();
  });

  it("signs a new entry each time: two geneses of one device are two lists", async () => {
    const keys = await deviceListKeys(memoryAccountStore());
    const [one, two] = await Promise.all([1, 2].map(() => makeGenesis({ account: ACCOUNT, keys, names: null, now: NOW })));
    expect(one!.list).not.toBe(two!.list);
  });
});
