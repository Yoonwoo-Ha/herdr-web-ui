import { describe, expect, it } from "bun:test";
import { genesisBody, hintOf, pageOf, wrapsOf } from "./listAnswers.ts";
import { newKey } from "./store.ts";

const LIST = "5c".repeat(32);
const HEAD = { seq: 3, hash: "ab".repeat(32) };
const WRAP = "A".repeat(151);

describe("the account service's answers about a list, as a device reads them", () => {
  it("reads which list as a list id with a head, or as none, and nothing else", () => {
    expect(hintOf({ list: LIST, head: HEAD, now: 1 })).toEqual({ list: LIST, head: HEAD });
    expect(hintOf({ list: null, now: 1 })).toBeNull();
    for (const answer of [null, [], {}, { list: LIST }, { list: LIST.toUpperCase(), head: HEAD }, { list: LIST, head: { seq: -1, hash: HEAD.hash } }, { list: LIST, head: { seq: 1.5, hash: HEAD.hash } }, { list: LIST, head: { seq: 1, hash: "ab" } }, { list: "", head: HEAD }]) {
      expect(hintOf(answer)).toBeUndefined();
    }
  });

  it("reads a page for its form alone: the entries stay the texts they came as", () => {
    const page = { list: LIST, after: 2, entries: ["a.b", "not an entry"], head: HEAD, more: false, now: 1 };
    expect(pageOf(page)).toEqual({ list: LIST, after: 2, entries: ["a.b", "not an entry"], head: HEAD, more: false });
    expect(pageOf({ ...page, after: null })?.after).toBeNull();
    for (const answer of [null, { ...page, list: 7 }, { ...page, after: "2" }, { ...page, after: -1 }, { ...page, entries: "a.b" }, { ...page, entries: ["a.b", 7] }, { ...page, entries: new Array(257).fill("a.b") }, { ...page, head: null }, { ...page, more: "no" }]) {
      expect(pageOf(answer)).toBeNull();
    }
  });

  it("reads wraps as one text of a wrap's length for each epoch, once", () => {
    expect(wrapsOf({ wraps: [{ epoch: 0, wrap: WRAP }, { epoch: 2, wrap: WRAP }] })).toEqual([{ epoch: 0, wrap: WRAP }, { epoch: 2, wrap: WRAP }]);
    expect(wrapsOf({ wraps: [] })).toEqual([]);
    for (const answer of [null, {}, { wraps: {} }, { wraps: [{ epoch: 0, wrap: WRAP }, { epoch: 0, wrap: WRAP }] }, { wraps: [{ epoch: 0, wrap: WRAP.slice(1) }] }, { wraps: [{ epoch: "0", wrap: WRAP }] }, { wraps: [null] }]) {
      expect(wrapsOf(answer)).toBeNull();
    }
  });

  it("sends a genesis with the one wrap of epoch 0, for a key in its spelling", async () => {
    const KEY = (await newKey()).public_spki;
    expect(genesisBody("a.b", { member: KEY, wrap: WRAP })).toEqual({ entry: "a.b", wraps: [{ epoch: 0, member: KEY, wrap: WRAP }] });
    expect(() => genesisBody("a.b", { member: "key", wrap: WRAP })).toThrow(RangeError);
    expect(() => genesisBody("a.b", { member: KEY, wrap: "short" })).toThrow(RangeError);
  });
});
