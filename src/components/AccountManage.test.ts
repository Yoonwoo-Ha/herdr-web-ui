import { describe, expect, it } from "bun:test";

import type { PairedDevice } from "../../shared/protocol.ts";
import { offersAccountRemove, offlinePc } from "./AccountManage.tsx";

describe("who may disconnect a device from every PC", () => {
  const row = (id: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({ id, label: id, role: "drive", created_at: "", last_seen_at: "", current: false, ...extra });
  const phone = row("phone", { account: "acct", account_key: "phone-key" });

  const offered = (devices: PairedDevice[], key: string | null, target = phone) => offersAccountRemove(devices, target, "acct", key);

  it("is offered to a drive member of the same account on this PC", () => {
    expect(offered([phone, row("me", { current: true, account: "acct", account_key: "my-key" })], "my-key")).toBe(true);
  });

  it("is not offered to a browser whose account key no row of this PC holds (signed in on the PC's own address, paired by cookie)", () => {
    expect(offered([phone, row("me", { current: true })], "my-key")).toBe(false);
    expect(offered([phone], null)).toBe(false);
  });

  it("is not offered to a member of another account, nor to one that only watches", () => {
    expect(offered([phone, row("me", { account: "other", account_key: "my-key" })], "my-key")).toBe(false);
    expect(offered([phone, row("me", { role: "watch", account: "acct", account_key: "my-key" })], "my-key")).toBe(false);
  });

  it("is not offered for a row with this client's own key, which leaves with Leave the account instead", () => {
    const older = row("older", { account: "acct", account_key: "my-key" });
    expect(offered([phone, older, row("me", { current: true })], "my-key", older)).toBe(false);
  });
});

describe("which PC Manage account may remove", () => {
  const now = Date.parse("2026-11-22T00:00:00.000Z");
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

  it("is one the account has not heard from for 15 minutes, whatever its age", () => {
    expect(offlinePc({ last_seen_at: ago(16), added_at: ago(60 * 24 * 30) }, now)).toBe(true);
    expect(offlinePc({ last_seen_at: ago(16), added_at: ago(20) }, now)).toBe(true);
  });

  it("is not one heard from lately, nor one whose dates do not parse", () => {
    expect(offlinePc({ last_seen_at: ago(5), added_at: ago(60 * 24 * 30) }, now)).toBe(false);
    expect(offlinePc({ last_seen_at: null, added_at: null }, now)).toBe(false);
    expect(offlinePc({ last_seen_at: "not a date", added_at: null }, now)).toBe(false);
  });

  it("counts a PC that never pulled its mail from when it was listed", () => {
    expect(offlinePc({ last_seen_at: null, added_at: ago(16) }, now)).toBe(true);
    expect(offlinePc({ last_seen_at: null, added_at: ago(5) }, now)).toBe(false);
  });
});
