/**
 * Allow under attack: what an independent review of the step tried against it. Each test asserts what the rules of
 * docs/account-list.md ask for ("Letting a device in").
 */
import { describe, expect, it } from "bun:test";
import { listView, signListEntry } from "../../../shared/account-list.ts";
import { entryFromText, readBody } from "../../../shared/account-list-entry.ts";
import type { AccountListView } from "./accountList.ts";
import { listWorld, type WorldDevice } from "./accountList.test-helpers.ts";
import { admitWithList, type PcFetch } from "./join.ts";
import { allowDevice, type AllowOutcome } from "./listAllow.ts";
import { deviceListKeys } from "./listKeys.ts";
import { memoryAccountStore } from "./store.ts";

type World = ReturnType<typeof listWorld>;

const following = (view: AccountListView) => {
  if (view.status.at !== "following") throw new Error(`the device is ${view.status.at}`);
  return view.status;
};
const allowed = (outcome: AllowOutcome) => {
  if (!outcome.allowed) throw new Error(`the device was not let in: ${outcome.why}`);
  return outcome.offer;
};
const placements = (from: WorldDevice) => from.sent.filter((each) => each.route.endsWith("/entries"));
const kinds = (texts: readonly string[]): string[] => texts.map((text) => readBody(entryFromText(text).body).kind);
const noWait = { wait: async () => {} };
const isPlacement = (request: Request): boolean => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries");

async function twoDevices(w: World = listWorld(), first: Parameters<World["device"]>[0] = {}) {
  const one = await w.device({ label: "Dana's phone", ...first });
  expect(following(await one.list.sync()).standing).toBe("in");
  const two = await w.device({ label: "Dana's tablet" });
  expect((await two.list.sync()).status).toMatchObject({ at: "not_in", why: "not_mine", claim: "claimed" });
  return { w, first: one, second: two, newcomer: { key: (await two.keys()).key, label: "Dana's tablet", os: "android" as const } };
}

/** PC X as an approval meets it: records what it is sent, 204 to the introduction and the records, 404 to the list's calls. */
function pcX() {
  const sent: string[] = [];
  const fetch: PcFetch = async (path) => {
    sent.push(path);
    if (path.startsWith("/api/account/list/")) return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return new Response(null, { status: 204 });
  };
  return { sent, fetch };
}

describe("one signature per place, across calls: Try again sends the request that was signed", () => {
  it("after `busy` on a head the device's own copy never saw move, the person's Try again sends the request it signed, not a new one", async () => {
    const { w, first, newcomer } = await twoDevices();
    // the service answers every placement `409 head_moved`, and the device's own read shows the same head
    w.fake.tamperList(w.held().id, { headMoved: true });
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    // the stalled card's Try again runs the same Allow again (AccountApprovals.tsx `attempt`)
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "busy" });
    expect(w.held().entries).toHaveLength(1);
    // every request sent was meant for seq 1 on the same head: X5 allows ONE signed request for that place
    const signed = new Set(placements(first).map((each) => JSON.stringify(each.body!.entries)));
    const seqs = new Set(placements(first).map((each) => readBody(entryFromText((each.body!.entries as string[])[0]!).body).seq));
    expect([...seqs]).toEqual([1]);
    expect(signed.size).toBe(1);
  });

  it("after `unknown` (an answer lost, the log unreadable), Try again with the log readable and the head unmoved sends the request it signed (X5: lost answer, failed read-back)", async () => {
    const { w, first, newcomer } = await twoDevices();
    const list = w.held().id;
    // the request never reached the service, and the log could not be read after it
    first.wire.answer = (request) => {
      if (isPlacement(request)) { first.wire.answer = (again) => new URL(again.url).pathname === `/v2/lists/${list}/log` || new URL(again.url).pathname === "/v2/lists/mine" ? Promise.reject(new TypeError("offline")) : null; throw new TypeError("the answer was lost"); }
      return null;
    };
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "unknown" });
    first.wire.answer = null;
    w.clock.now += 1000;
    // "Not known yet ... Try again to check": the log reads now, the head is where it was, nothing was placed
    const outcome = await allowDevice(first.list, newcomer, noWait);
    expect(outcome.allowed).toBe(true);
    const signed = new Set(placements(first).map((each) => JSON.stringify(each.body!.entries)));
    expect(signed.size).toBe(1);
  });
});

describe("a placement answered 5xx is held against the log", () => {
  it("a gateway's 502 after the service placed the entry: the device reads the log and finds the newcomer in, rather than say `unreached`", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    first.wire.answer = async (request) => {
      if (!isPlacement(request)) return null;
      first.wire.answer = null;
      // the service took it, and a proxy in front answered 502 (or a 504 timeout)
      expect((await w.fake.fetch(request)).status).toBe(200);
      return Response.json({ error: { code: "bad_gateway", message: "upstream" } }, { status: 502 });
    };
    const outcome = await allowDevice(first.list, newcomer, noWait);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect(outcome.allowed).toBe(true);
    expect(following(await second.list.adopt(allowed(outcome))).standing).toBe("in");
  });
});

describe("an answer of 200 that is no JSON is the service not answering, never a throw", () => {
  it("the entry is placed; the Allow must read the log and answer, never throw a SyntaxError past the stalled card", async () => {
    const { w, first, newcomer } = await twoDevices();
    first.wire.answer = async (request) => {
      if (!isPlacement(request)) return null;
      first.wire.answer = null;
      await w.fake.fetch(request);
      return new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
    };
    const outcome = await allowDevice(first.list, newcomer, noWait).catch((error: unknown) => (error as Error).name);
    expect(kinds(w.held().entries)).toEqual(["genesis", "device"]);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it("the same for the claims read: a 200 that is no JSON is the service not answering, not a throw", async () => {
    const { w, first, newcomer } = await twoDevices();
    const list = w.held().id;
    first.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname === `/v2/lists/${list}/claims` ? new Response("<html/>", { status: 200 }) : null;
    const outcome = await allowDevice(first.list, newcomer, noWait).catch((error: unknown) => (error as Error).name);
    expect(outcome).toEqual({ allowed: false, why: "unreached", retryAfterMs: null });
  });
});

describe("a device the list put out takes no way from before lists", () => {
  it("a device whose own saved copy shows it out answers `blocked`, and the approval signs no v1 add and leaves no introduction", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    await second.list.adopt(allowed(await allowDevice(first.list, newcomer, noWait)));
    // the second device removes the first (a lost phone, say)
    const writer = second.list.writer()!;
    const removal = await signListEntry(writer.state, { kind: "remove", ends: (await first.keys()).key }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [removal.text], []);
    w.clock.now += 30_000;
    expect(following(await first.list.sync()).standing).toBe("out");
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    const joining = { key: (await third.keys()).key, label: "Laptop", os: null };
    const outcome = await allowDevice(first.list, joining, noWait);
    expect(outcome).toMatchObject({ allowed: false, why: "blocked" });
    const pc = pcX();
    const session = (await first.store.get("session"))!;
    const admitted = await admitWithList(first.list, {
      fetch: pc.fetch, service: first.service, key: await first.store.key(), account: session.account, joining, through: "a1".repeat(16), paired: [], directory: [], wait: async () => {},
    }).then(() => "admitted", (error: unknown) => (error as Error).name);
    expect([admitted, pc.sent]).toEqual(["ListAllowError", []]);
  });
});

describe("the saved floor of the clock never signs", () => {
  it("this device's clock ran two hours ahead during one round, then was set right: an Allow later puts out a borrowed browser with an hour left", async () => {
    let skew = 0;
    const w = listWorld();
    // the getter is read on every tick of this device's clock (accountList.test-helpers.ts `own`)
    const first = await w.device({ label: "Dana's phone", get skew() { return skew; } } as { label: string; skew: number });
    expect(following(await first.list.sync()).standing).toBe("in");
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const newcomer = { key: (await second.keys()).key, label: "Dana's tablet", os: "android" as const };
    // two hours ahead for one round: the floor (`seen_at`, in the `times` record) is saved at that hour, and never goes back
    skew = 2 * 3600_000;
    await first.list.sync();
    skew = 0;
    // a borrowed browser, let in now (by every true clock) for one hour
    const browser = await w.device({ label: "A borrowed browser" });
    await browser.list.sync();
    const writer = first.list.writer()!;
    const key = (await browser.keys()).key;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === key)!;
    const until = Math.floor(w.clock.now / 1000) + 3600;
    const borrowed = await signListEntry(writer.state, { kind: "device", key, power: "bound", role: "drive", until, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [borrowed.text], []);
    await second.list.sync();
    allowed(await allowDevice(first.list, newcomer, noWait));
    // the browser still has an hour by the service's clock, the device's own clock and the list's own time
    expect(listView(w.held().state).devices.find((row) => row.key === key)).toMatchObject({ ended: null, until });
    // no removal and no epoch were signed: the two devices came in, and nobody went out
    expect(kinds(w.held().entries).slice(1)).toEqual(["device", "device"]);
  });
});

describe("an Allow belongs to the account it began for", () => {
  it("a sign-in to another account made in another tab before the write: the write ends `changed`, it does not go on as `no_list`", async () => {
    const { w, first, newcomer } = await twoDevices();
    // another tab signs this device in to another account, one with no list
    w.fake.listAccounts = w.account;
    const other = { ...(await first.store.get("session"))!, account: "acct_other", access_token: w.fake.issueToken("acct_other"), sign_in_id: "sign-in-other" };
    await first.store.set("session", other);
    const outcome = await allowDevice(first.list, newcomer, noWait);
    expect(outcome).toMatchObject({ allowed: false, why: "changed" });
  });
});

describe("a placement that never answers has a time of its own", () => {
  it("no request of the write has a time of its own: a service that keeps the connection open never lets the card say anything", async () => {
    const { first, newcomer } = await twoDevices();
    first.wire.answer = (request) => isPlacement(request) ? new Promise<Response>(() => {}) : null;
    // the time one placement has is given here (thirty seconds otherwise): past it the write goes on to read the log, and ends
    const settled = await Promise.race([allowDevice(first.list, newcomer, { ...noWait, placeMs: 50 }).then(() => "settled", () => "settled"), new Promise<string>((resolve) => { setTimeout(() => resolve("hangs"), 1500); })]);
    expect(settled).toBe("settled");
  }, 5_000);
});

describe("an account with no list is approved at once, as before lists", () => {
  it("an account with no list: nothing goes to the PC while GET /v2/lists/mine is unanswered (up to ROUND_MS, 30 s, per round)", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    const newcomer = await w.device({ label: "Tablet" });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    member.wire.answer = async (request) => {
      if (new URL(request.url).pathname !== "/v2/lists/mine") return null;
      await held;
      return null;
    };
    const pc = pcX();
    const session = (await member.store.get("session"))!;
    const done = admitWithList(member.list, {
      fetch: pc.fetch, service: member.service, key: await member.store.key(), account: session.account,
      joining: { key: (await newcomer.store.key()).public_spki, label: "Tablet", os: null }, through: "a1".repeat(16), paired: [], directory: [], wait: async () => {},
    });
    // as before lists: the whole of it goes to the PC, and ends, while the answer about lists is still held back
    await done;
    const before = [...pc.sent];
    release();
    expect(pc.sent).toEqual(["/api/account/introduce", "/api/account/records"]);
    expect(before).toEqual(["/api/account/introduce", "/api/account/records"]);
  });
});

describe("what held under attack", () => {
  it("an unreadable /v2/lists/mine (200, HTML) leaves a no-list account's Allow on the old path, byte for byte ", async () => {
    const w = listWorld();
    w.fake.listAccounts = "";
    const member = await w.device();
    const newcomer = await w.device({ label: "Tablet" });
    member.wire.answer = (request) => new URL(request.url).pathname === "/v2/lists/mine" ? new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }) : null;
    const pc = pcX();
    const session = (await member.store.get("session"))!;
    await admitWithList(member.list, {
      fetch: pc.fetch, service: member.service, key: await member.store.key(), account: session.account,
      joining: { key: (await newcomer.store.key()).public_spki, label: "Tablet", os: null }, through: "a1".repeat(16), paired: [], directory: [], wait: async () => {},
    });
    expect(pc.sent).toEqual(["/api/account/introduce", "/api/account/records"]);
  });

  it("a claim the service shows for another key never makes the approver sign that key", async () => {
    const { w, first, newcomer } = await twoDevices();
    const list = w.held().id;
    const stranger = await w.device({ label: "Stranger" });
    await stranger.list.sync();
    // the service lists only the stranger's claim, whatever key the PC compared
    first.wire.answer = async (request) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== `/v2/lists/${list}/claims`) return null;
      const all = await (await w.fake.fetch(request)).json() as { claims: { key: string }[] };
      return Response.json({ claims: all.claims.filter((claim) => claim.key !== newcomer.key) });
    };
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "not_claimed" });
    expect(w.held().entries).toHaveLength(1);
  });

  it("a removed key is never brought back on a retry, and a key let in before is answered with the place of its own entry", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    allowed(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait));
    // a repeat Allow for the tablet hands the place of the tablet's own entry, not the head
    expect(allowed(await allowDevice(first.list, newcomer, noWait))).toEqual(offer);
    expect(following(await second.list.adopt(offer)).standing).toBe("in");
  });

  it("a newcomer handed a later place than its own entry's, where its entry lies after the place, follows nothing", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const third = await w.device({ label: "Laptop" });
    await third.list.sync();
    const laptop = allowed(await allowDevice(first.list, { key: (await third.keys()).key, label: "Laptop", os: null }, noWait));
    allowed(await allowDevice(first.list, newcomer, noWait));
    // a PC hands the tablet the laptop's place (seq 1), before the tablet's own entry (seq 2)
    expect((await second.list.adopt(laptop)).status.at).toBe("not_in");
    expect(await second.lists.get("copy", w.account)).toBeUndefined();
  });

  it("a newcomer keeps the offer where the save of its copy fails, and follows on the next round", async () => {
    const { w, first, second, newcomer } = await twoDevices();
    const offer = allowed(await allowDevice(first.list, newcomer, noWait));
    const swap = second.lists.swap.bind(second.lists);
    let failing = true;
    second.lists.swap = async (...args: Parameters<typeof swap>) => {
      if (failing && args[0] === "copy") throw new DOMException("full", "QuotaExceededError");
      return swap(...args);
    };
    await second.list.adopt(offer).catch(() => undefined);
    expect([await second.lists.get("copy", w.account), await second.lists.get("offer", w.account)]).toEqual([undefined, { v: 1, ...offer }]);
    failing = false;
    w.clock.now += 300_000;
    expect(following(await second.list.sync()).standing).toBe("in");
    expect(await second.lists.get("offer", w.account)).toBeUndefined();
  });

  it("a device with a list whose service is away says so, and sends nothing to the PC: no fall-through to the old path", async () => {
    const { w, first, newcomer } = await twoDevices();
    first.wire.answer = () => Promise.reject(new TypeError("offline"));
    const pc = pcX();
    const session = (await first.store.get("session"))!;
    const outcome = await admitWithList(first.list, {
      fetch: pc.fetch, service: first.service, key: await first.store.key(), account: session.account, joining: newcomer, through: "a1".repeat(16), paired: [], directory: [], wait: async () => {},
    }).then(() => "admitted", (error: unknown) => `${(error as Error).name} ${(error as { why?: string }).why}`);
    expect([outcome, pc.sent, w.held().entries.length]).toEqual(["ListAllowError unreached", [], 1]);
  });

  it("a clock set back a day signs a newcomer in, dated by that clock, and puts out nobody whose time is not over", async () => {
    let skew = 0;
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone", get skew() { return skew; } } as { label: string; skew: number });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    const browser = await w.device({ label: "A borrowed browser" });
    await browser.list.sync();
    const writer = first.list.writer()!;
    const key = (await browser.keys()).key;
    const claim = (await writer.service.listClaims(writer.list)).find((each) => each.key === key)!;
    const until = Math.floor(w.clock.now / 1000) + 3600;
    const borrowed = await signListEntry(writer.state, { kind: "device", key, power: "bound", role: "drive", until, enc: claim.enc, card: claim.card, sealed: null, rotates: false }, { key: writer.keys.key, privateKey: writer.keys.signs }, writer.issued_at);
    await writer.service.placeEntries(writer.list, [borrowed.text], []);
    skew = -24 * 3600_000;
    allowed(await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: null }, noWait));
    expect(kinds(w.held().entries).slice(1)).toEqual(["device", "device"]);
    expect(readBody(entryFromText(w.held().entries.at(-1)!).body).issued_at).toBe(Math.floor(w.clock.now / 1000) - 24 * 3600);
  });

  it("a stranger's key never gets a card through: the writer checks the card the service hands over", async () => {
    const { w, first, newcomer } = await twoDevices();
    const other = await deviceListKeys(memoryAccountStore());
    const list = w.held().id;
    const real = (await first.service.listClaims(list)).find((each) => each.key === newcomer.key)!;
    first.wire.answer = (request) => request.method === "GET" && new URL(request.url).pathname === `/v2/lists/${list}/claims`
      ? Response.json({ claims: [{ key: newcomer.key, enc: other.enc.key, card: real.card }] }) : null;
    expect(await allowDevice(first.list, newcomer, noWait)).toMatchObject({ allowed: false, why: "refused" });
    expect(w.held().entries).toHaveLength(1);
  });
});
