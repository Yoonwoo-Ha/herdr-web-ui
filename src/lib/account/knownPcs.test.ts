import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { MyPc } from "./myPcs.ts";
import { dropKnownPcs, keepKnownPcs, knownPcs } from "./knownPcs.ts";

const id = (letter: string) => letter.repeat(32);
const row = (letter: string, patch: Partial<MyPc> = {}) => ({ server_id: id(letter), name: `pc-${letter}`, state: "paired", paired: false, listed: true, linked: false, last_seen_at: null, added_at: null, join: { server_public_key: "k", relay: "wss://relay.ovis.sh" }, ...patch }) as MyPc;

describe("the account's PCs this device listed last", () => {
  let before: PropertyDescriptor | undefined;
  let stored: Map<string, string>;
  beforeEach(() => {
    before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    stored = new Map();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } } });
  });
  afterEach(() => { if (before) Object.defineProperty(globalThis, "localStorage", before); else Reflect.deleteProperty(globalThis, "localStorage"); });

  it("keeps the account's PCs My PCs lists from the account, by id and name alone, for that account only", () => {
    keepKnownPcs("acct-a", [row("a"), row("b", { paired: true }), row("c", { join: undefined }), row("d", { state: "offline" })]);
    // a PC paired here is this device's own (its pairing lists it), and one it cannot open is not listed
    expect(knownPcs("acct-a")).toEqual([{ server_id: id("a"), name: "pc-a" }, { server_id: id("d"), name: "pc-d" }]);
    expect(knownPcs("acct-b")).toEqual([]);
    expect([...stored.values()].join("")).not.toContain("wss://");
  });

  it("forgets them once the account is left, and reads nothing it cannot trust as a PC", () => {
    keepKnownPcs("acct-a", [row("a")]);
    dropKnownPcs();
    expect(knownPcs("acct-a")).toEqual([]);
    for (const kept of ["not json", JSON.stringify({ account: "acct-a", pcs: [{ server_id: "short", name: "x" }, { server_id: id("e") }, { server_id: id("f"), name: "ok" }] })]) {
      stored.set("ovis-account-pcs", kept);
      expect(knownPcs("acct-a")).toEqual(kept === "not json" ? [] : [{ server_id: id("f"), name: "ok" }]);
    }
  });
});
