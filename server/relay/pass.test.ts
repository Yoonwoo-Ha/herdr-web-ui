import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRelayPass } from "../../shared/relay-pass.ts";
import { loadRelayIdentity } from "./identity.ts";
import { RelayPassKeeper, retryAfterMs } from "./pass.ts";
import { bounded, deferred, TestClock } from "./test-helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A keeper over an account service that answers the pass request with `answer` (the challenge always works). */
async function keeper(answer: () => Response | Promise<Response>) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-pass-keeper-"));
  dirs.push(stateDir);
  const identity = loadRelayIdentity(stateDir);
  const clock = new TestClock();
  const passes: string[] = [];
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const fetch = async (request: Request) => new URL(request.url).pathname === "/v1/pc/challenge"
    ? Response.json({ challenge_id: "0".repeat(32), frame: JSON.stringify({ type: "server_challenge", public_key: "9".repeat(64), nonce: "1".repeat(64) }) })
    : answer();
  const signed = () => signRelayPass(keys.privateKey, "0badc0de", identity.server_id, Math.floor(clock.now() / 1000));
  const made = new RelayPassKeeper({ stateDir, identity: () => identity, account: () => "acct_1", service: "https://account.test", fetch, clock, onPass: (pass) => passes.push(pass) });
  return { made, clock, passes, signed };
}

test("the account's refusals are told apart, and asked again later", async () => {
  for (const [status, code, state] of [[403, "not_listed", "not_listed"], [409, "relay_limit", "limit"]] as const) {
    const k = await keeper(() => Response.json({ error: { code } }, { status }));
    k.made.start();
    await k.made.refresh();
    expect(k.made.state).toBe(state);
    expect(k.made.current()).toBeNull();
    expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([30 * 60_000]);
    k.made.stop();
  }
});

test("a service that cannot answer keeps the pass that holds, and waits as long as it asks", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  const pass = k.passes[0]!;
  answer = async () => new Response("busy", { status: 503, headers: { "retry-after": "600" } });
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  expect(k.made.current()).toBe(pass);
  expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([600_000]);
  k.made.stop();
});

test("a fresh pass the relay refuses too is kept, and the keeper backs off instead of asking again", async () => {
  let asked = 0;
  const k = await keeper(async () => { asked++; return Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 }); });
  k.made.start();
  await k.made.refresh();
  expect(asked).toBe(1);
  await k.made.rejected();
  expect(asked).toBe(2);
  const replacement = k.made.current();
  k.clock.advance(120_000);
  await k.made.rejected();
  expect(asked).toBe(2);
  expect(k.made.current()).toBe(replacement);
  k.made.stop();
});

test("Retry-After in seconds or as an HTTP date, never past 24 hours", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  expect(retryAfterMs("120", now)).toBe(120_000);
  expect(retryAfterMs("Tue, 01 Dec 2026 00:10:00 GMT", now)).toBe(600_000);
  expect(retryAfterMs("99999999", now)).toBe(24 * 3600_000);
  for (const bad of [null, "", "-5", "soon", "Mon, 30 Nov 2026 00:00:00 GMT"]) expect(retryAfterMs(bad, now)).toBe(0);
});

test("a renewal time is held to 60 s .. 24 h, and a lifetime the relay would not honor is not taken", async () => {
  for (const [refresh, due] of [[-1, 60_000], [0, 60_000], [43_200, 43_200_000], [172_800, 86_400_000]]) {
    const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: refresh }));
    k.made.start();
    await k.made.refresh();
    expect(k.made.current()).not.toBeNull();
    expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([due!]);
    k.made.stop();
  }
  for (const expires of [172_800 * 2, 100]) {
    const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: expires, refresh_in: 43_200 }));
    k.made.start();
    await k.made.refresh();
    expect([expires, k.made.current()]).toEqual([expires, null]);
    k.made.stop();
  }
});

test("a pass that ran out with no new one is no longer reported ok", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  answer = async () => new Response("down", { status: 503 });
  k.clock.advance(172_800_000);
  expect(k.made.current()).toBeNull();
  expect(k.made.state).toBe("unavailable");
  k.made.stop();
});

test("a refresh asked for while a request is out is asked again once it ends", async () => {
  let asked = 0;
  const entered = deferred<void>();
  const gate = deferred<void>();
  const again = deferred<void>();
  const k = await keeper(async () => {
    asked++;
    if (asked === 1) { entered.resolve(); await gate.promise; }
    if (asked === 2) again.resolve();
    return Response.json({ error: { code: "not_listed" } }, { status: 403 });
  });
  k.made.start();
  const first = k.made.refresh();
  await entered.promise;
  // the owner names an account while the old request is out
  void k.made.refresh();
  gate.resolve();
  await first;
  await bounded(again.promise, 2000);
  expect(asked).toBe(2);
  k.made.stop();
});

test("a pass for another PC is not kept", async () => {
  const other = await keeper(async () => Response.json({ pass: await other.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  const k = await keeper(async () => Response.json({ pass: await other.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  k.made.start();
  await k.made.refresh();
  expect(k.made.current()).toBeNull();
  expect(k.passes).toEqual([]);
  k.made.stop();
});
