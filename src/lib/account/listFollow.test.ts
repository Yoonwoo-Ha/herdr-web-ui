import { describe, expect, it } from "bun:test";
import type { AccountList, AccountListView } from "./accountList.ts";
import { followAccountList, ROUND_GAP_MS, type FollowingPage } from "./listFollow.ts";
import { SignedOutError } from "./service.ts";

const VIEW: AccountListView = { account: null, status: { at: "off" }, reached: true, devices: [], pcs: [] };

/** a page whose clock and timers the test moves, and a list that says when it is due */
function fixture(due: (inFront: boolean, now: number) => number | null, sync: () => Promise<AccountListView> = async () => VIEW) {
  const page = { now: 1_000_000, visible: true, timer: null as { run: () => void; at: number } | null, heard: [] as (() => void)[] };
  let rounds = 0;
  const list = {
    sync: () => { rounds += 1; return sync(); },
    due: (inFront: boolean) => due(inFront, page.now),
  } as unknown as AccountList;
  const following: FollowingPage = {
    now: () => page.now,
    visible: () => page.visible,
    onVisibility(listener) { page.heard.push(listener); return () => { page.heard.splice(page.heard.indexOf(listener), 1); }; },
    setTimeout(run, ms) { page.timer = { run, at: page.now + ms }; return page.timer; },
    clearTimeout(timer) { if (page.timer === timer) page.timer = null; },
  };
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  /** moves the clock to the timer's time and runs it */
  const fire = async (): Promise<void> => { const { run, at } = page.timer!; page.timer = null; page.now = at; run(); await settle(); };
  return { page, followed: followAccountList(list, following), rounds: () => rounds, settle, fire };
}

describe("when a device reads its account's list", () => {
  it("reads at once when poked, then when the list says it is due", async () => {
    const f = fixture((_front, now) => now + 30_000);
    expect([f.rounds(), f.page.timer]).toEqual([0, null]);
    f.followed.poke();
    await f.settle();
    expect([f.rounds(), f.page.timer!.at - f.page.now]).toEqual([1, 30_000]);
    await f.fire();
    expect([f.rounds(), f.page.timer!.at - f.page.now]).toEqual([2, 30_000]);
  });

  it("keeps no timer while the list is not due by the clock, and asks again when the app comes to the front", async () => {
    const f = fixture((front, now) => front ? now + 30_000 : null);
    f.page.visible = false;
    f.followed.poke();
    await f.settle();
    expect([f.rounds(), f.page.timer]).toEqual([1, null]);
    f.page.visible = true;
    for (const heard of f.page.heard) heard();
    expect(f.page.timer!.at - f.page.now).toBe(30_000);
    f.page.visible = false;
    for (const heard of f.page.heard) heard();
    expect(f.page.timer).toBeNull();
  });

  it("never begins two rounds closer than the gap, whatever the list says of when it is due", async () => {
    const f = fixture((_front, now) => now);
    f.followed.poke();
    await f.settle();
    expect(f.page.timer!.at - f.page.now).toBe(ROUND_GAP_MS);
    await f.fire();
    expect([f.rounds(), f.page.timer!.at - f.page.now]).toEqual([2, ROUND_GAP_MS]);
  });

  it("goes on after a round that failed, and after a sign-in that ended", async () => {
    const failures: unknown[] = [new SignedOutError(), new RangeError("a fault")];
    const f = fixture((_front, now) => now + 30_000, async () => { throw failures.shift(); });
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...told: unknown[]) => { warned.push(told); };
    try {
      f.followed.poke();
      await f.settle();
      await f.fire();
    } finally { console.warn = warn; }
    expect(f.rounds()).toBe(2);
    expect(f.page.timer).not.toBeNull();
    expect(warned).toEqual([["Ovis: the account's list could not be read", "RangeError"]]);
  });

  it("lets a poke take the place of the round a timer waits for, instead of running both", async () => {
    const f = fixture((_front, now) => now + 30_000);
    f.followed.poke();
    await f.settle();
    expect(f.page.timer).not.toBeNull();
    f.followed.poke();
    expect(f.page.timer).toBeNull();
    await f.settle();
    expect([f.rounds(), f.page.timer!.at - f.page.now]).toEqual([2, 30_000]);
  });

  it("stops: no timer, no ear for the page, and no round on a poke", async () => {
    const f = fixture((_front, now) => now + 30_000);
    f.followed.poke();
    await f.settle();
    f.followed.stop();
    expect([f.page.timer, f.page.heard.length]).toEqual([null, 0]);
    f.followed.poke();
    await f.settle();
    expect([f.rounds(), f.page.timer]).toEqual([1, null]);
  });
});
