import { describe, expect, it } from "bun:test";

import type { MyPc } from "../lib/account/myPcs.ts";
import { pcsShown, phoneShellState, phoneSavedPcs, relayTabPcs } from "./ConnectStart.tsx";

const id = (letter: string) => letter.repeat(32);
const accountPc = (letter: string, patch: Partial<MyPc> = {}) => ({ server_id: id(letter), name: `pc-${letter}`, state: "paired", paired: false, listed: true, linked: false, join: { relay: "wss://relay.ovis.sh" }, ...patch }) as unknown as MyPc;

describe("the relay PCs of My PCs", () => {
  it("lists the PCs this phone paired (by a code too) and, signed in, the account's PCs it can open", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "code-paired" }], [accountPc("b"), accountPc("c", { state: "offline" })]);
    expect(rows.map((row) => [row.name, row.status ?? "", row.saved])).toEqual([["code-paired", "", true], ["pc-b", "online", false], ["pc-c", "off", false]]);
  });

  it("lists an account PC this phone also paired once, as the phone's own", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "code-paired" }, { server_id: id("b"), name: "desk", status: "online" }], [accountPc("b", { paired: true }), accountPc("c")]);
    expect(rows.map((row) => row.server_id)).toEqual([id("a"), id("b"), id("c")]);
    expect(rows.filter((row) => row.saved).length).toBe(2);
  });

  it("says On or Off for a PC of the account this phone is not let into yet, never that it waits for an approval", () => {
    const rows = relayTabPcs([], [accountPc("b", { state: "needs-approval" }), accountPc("d", { state: "offline" })]);
    expect(rows.map((row) => row.status)).toEqual(["online", "off"]);
  });

  it("says first what this device knows itself (a pairing's saved Ovis too old, a check that settled), then the account's word", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "desk", status: "update" }, { server_id: id("e"), name: "attic" }, { server_id: id("f"), name: "nuc", status: "online" }],
      [accountPc("a", { paired: true }), accountPc("b", { state: "needs-update" }), accountPc("e", { paired: true, state: "offline" }), accountPc("f", { paired: true, state: "offline" })]);
    expect(rows.map((row) => [row.name, row.status ?? ""])).toEqual([["desk", "update"], ["attic", "off"], ["nuc", "online"], ["pc-b", "update"]]);
    // an account PC a check found off is off, however recent its heartbeat; one that answered is on, however old
    const checked = relayTabPcs([], [accountPc("c"), accountPc("d", { state: "offline" })], {}, new Map([[id("c"), "off"], [id("d"), "online"]]));
    expect(checked.map((row) => row.status)).toEqual(["off", "online"]);
  });

  it("says On for a PC this phone paired that the directory lists and does not call off, after what this device knows itself", () => {
    const rows = relayTabPcs([{ server_id: id("a"), name: "desk" }, { server_id: id("b"), name: "attic" }, { server_id: id("c"), name: "nuc", status: "off" }, { server_id: id("d"), name: "lab" }],
      [accountPc("a", { paired: true }), accountPc("b", { paired: true, listed: false }), accountPc("c", { paired: true })]);
    // attic: the directory does not list it, so it says nothing of it; lab: in no account
    expect(rows.map((row) => [row.name, row.status ?? ""])).toEqual([["desk", "online"], ["attic", ""], ["nuc", "off"], ["lab", ""]]);
  });

  it("says Removed, with no state word, for a PC that turned this phone away as removed, and leaves it out once forgotten", () => {
    const removed = relayTabPcs([], [accountPc("b"), accountPc("c")], { [id("b")]: "removed" });
    expect(removed.map((row) => [row.name, row.status ?? ""])).toEqual([["pc-b", "removed"], ["pc-c", "online"]]);
    expect(relayTabPcs([], [accountPc("b"), accountPc("c")], { [id("b")]: "hidden" }).map((row) => row.name)).toEqual(["pc-c"]);
    // paired again since (a saved pairing): its own row, as its last check found it
    expect(relayTabPcs([{ server_id: id("b"), name: "desk", status: "online" }], [], { [id("b")]: "removed" }).map((row) => row.status)).toEqual(["online"]);
  });

  it("lists the account's PCs it listed last when the account cannot be read now, by name with no state, each once", () => {
    const known = [{ server_id: id("a"), name: "desk" }, { server_id: id("b"), name: "mac" }, { server_id: id("c"), name: "nuc" }, { server_id: id("d"), name: "lab" }];
    const rows = relayTabPcs([{ server_id: id("a"), name: "desk" }], [accountPc("b")], { [id("c")]: "hidden", [id("d")]: "removed" }, new Map(), known);
    // desk is this phone's own pairing and mac is in the account's word read now: neither twice; nuc was forgotten here
    expect(rows.map((row) => [row.name, row.status ?? "", row.saved])).toEqual([["desk", "", true], ["pc-b", "online", false], ["lab", "removed", false]]);
  });

  it("lists none of the account's PCs signed out, nor one it cannot open", () => {
    expect(relayTabPcs([{ server_id: id("a") }], null).length).toBe(1);
    const unopenable = accountPc("b");
    expect(relayTabPcs([], [{ ...unopenable, join: undefined } as MyPc]).length).toBe(0);
  });
});

describe("the phone app's PCs on My PCs", () => {
  it("sorts what the app saved by the way it connects, the app's own pages and an unreadable entry on neither", () => {
    const saved = ["https://desk.tail1e211e.ts.net", "http://100.101.1.2:7317", "http://192.168.0.5:7317", "http://127.0.0.1:41234", `https://app.ovis.sh/s/${id("a")}/`, "not an address"];
    const rows = phoneSavedPcs(saved, { "https://desk.tail1e211e.ts.net": "Desk" }, "https://app.ovis.sh");
    expect(rows.map((row) => [row.name, row.way])).toEqual([["Desk", "tailscale"], ["100.101.1.2:7317", "tailscale"], ["192.168.0.5:7317", "address"], ["127.0.0.1:41234", "ssh"]]);
  });

  it("names a PC saved by its address by the name the app keeps for it, with its address as the second line", () => {
    const rows = phoneSavedPcs(["http://192.168.0.5:7317"], { "http://192.168.0.5:7317": "home-nas" }, "https://app.ovis.sh");
    expect(rows.map((row) => [row.name, row.host, row.way])).toEqual([["home-nas", "192.168.0.5:7317", "address"]]);
  });
});

describe("finding a PC on a long My PCs", () => {
  const rows = [{ name: "eaui-MacBookAir.local", word: "in-use" }, { name: "render-box", word: "online" }, { name: "office-imac", word: "update" }, { name: "studio-pc", word: "off" }, { name: "lab-mini", word: undefined }] as const;
  const names = (query: string, show: "all" | "on" | "off" = "all") => pcsShown(rows, query, show).map((row) => row.name);

  it("matches the name anywhere, in any case, the PC in use like any other", () => {
    expect(names("MAC")).toEqual(["eaui-MacBookAir.local", "office-imac"]);
    expect(names("  box ")).toEqual(["render-box"]);
    expect(names("")).toEqual(rows.map((row) => row.name));
    expect(names("nothing")).toEqual([]);
  });

  it("keeps to the PCs on or off: the PC in use is on, one with no word only under All", () => {
    expect(names("", "on")).toEqual(["eaui-MacBookAir.local", "render-box"]);
    expect(names("", "off")).toEqual(["studio-pc"]);
    expect(names("mac", "on")).toEqual(["eaui-MacBookAir.local"]);
  });
});

describe("the phone app's own word on what is open", () => {
  const app = "https://app.ovis.sh";
  it("names the PC still open while the person chooses another, a relay PC by its page and any other by its address", () => {
    expect(phoneShellState({ saved: [], choosing: true, current: `${app}/s/${id("a")}/` }, app).current).toEqual({ serverId: id("a") });
    expect(phoneShellState({ saved: [], choosing: true, current: "https://desk.tail1e211e.ts.net" }, app).current).toEqual({ origin: "https://desk.tail1e211e.ts.net", scope: null });
    // a relay PC of another origin (a self-hosted relay) by its scope there, so another scope on it is not the one open
    expect(phoneShellState({ saved: [], choosing: true, current: `https://relay.example/s/${id("b")}/` }, app).current).toEqual({ origin: "https://relay.example", scope: id("b") });
    expect(phoneShellState({ saved: [], choosing: false, current: "https://desk.tail1e211e.ts.net" }, app).current).toBeNull();
    expect(phoneShellState({ saved: [], choosing: true, current: "" }, app).current).toBeNull();
    expect(phoneShellState({ saved: [], choosing: true, current: `${app}/` }, app).current).toBeNull();
  });

  it("passes on an SSH PC whose address on the phone another app took", () => {
    expect(phoneShellState({ kind: "ssh-port", failure: "127.0.0.1:41234" }, app).sshPort).toBe("127.0.0.1:41234");
    expect(phoneShellState({ kind: "", failure: "" }, app).sshPort).toBeNull();
  });
});
