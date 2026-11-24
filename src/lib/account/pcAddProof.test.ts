import { beforeEach, describe, expect, it } from "bun:test";
import { pcAddSigningBytes, type PcAddPurpose } from "../../../shared/account-records.ts";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { fromBase64Url } from "../../../shared/relay-pair-sas.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { AccountService, AccountServiceError, PC_ADD_FRESH_MS } from "./service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "./signin.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountKey, type AccountSession, type AccountStore } from "./store.ts";

const ORIGIN = "https://account.example";
const ACCOUNT = "acct_owner";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let now = Date.now();
let fake: FakeAccountService;
let store: AccountStore;
/** what this device sent to the account service, and what the challenge route answered */
let sent: { method: string; path: string; body: Record<string, unknown> | null }[];
let challenges: { challenge_id: string; challenge: string }[];
let service: AccountService;

const hex = (key: Uint8Array): string => Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");

function newPc(): { serverId: string; publicKey: string } {
  const key = generateKeyPair().publicKey;
  return { serverId: deriveServerId(key), publicKey: hex(key) };
}

/** the account service as this device calls it: every call recorded with its body, and every challenge kept */
function recordingFetch(through: (request: Request) => Promise<Response> = (request) => fake.fetch(request)) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.clone().text();
    sent.push({ method: request.method, path: `${url.pathname}${url.search}`, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> });
    const answer = await through(request);
    if (url.pathname === "/v1/pcs/challenge" && answer.ok) challenges.push(await answer.clone().json() as { challenge_id: string; challenge: string });
    return answer;
  };
}

async function signIn(): Promise<AccountSession> {
  fake.signInAs("github", ACCOUNT);
  const start = await beginSignIn("github", { store, service: ORIGIN, redirectUri: WEB_REDIRECT, now: () => now });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  return finishSignIn(returned, { store, fetch: fake.fetch, now: () => now });
}

/** the key this sign-in registered with the account service (signInKey.ts does it after a sign-in), kept as signInKey keeps it */
async function registerKey(session: AccountSession): Promise<AccountKey> {
  const key = await newKey();
  const no = fake.registerSessionKey(session.access_token, key.public_spki, "Phone");
  await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id!, key, no });
  return key;
}

/** a PC that typed its device code into the account and listed itself: unconfirmed, asking to join */
async function listedByDeviceCode(pc = newPc()): Promise<{ serverId: string; publicKey: string; listing: string }> {
  const token = fake.issueToken(ACCOUNT, { device: true });
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${pc.serverId}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }),
  });
  expect(response.ok).toBe(true);
  return { ...pc, listing: fake.pcs(ACCOUNT).find((row) => row.server_id === pc.serverId)!.listing_id! };
}

/** checks the proof a call sent: by `key`, over the layout the service checks, for this purpose, PC and listing */
async function provedBy(key: AccountKey, proof: unknown, purpose: PcAddPurpose, serverId: string, listingId: string): Promise<boolean> {
  const { challenge_id, signature } = proof as { challenge_id: string; signature: string };
  const issued = challenges.find((each) => each.challenge_id === challenge_id);
  if (issued === undefined) return false;
  const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key.public_spki)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, new Uint8Array(fromBase64Url(signature)), pcAddSigningBytes(purpose, ACCOUNT, serverId, listingId, challenge_id, issued.challenge));
}

const asked = (path: string): number => sent.filter((each) => each.path === path).length;
const admitBodies = (serverId: string) => sent.filter((each) => each.path === `/v1/pcs/${serverId}/admit`).map((each) => each.body);

beforeEach(() => {
  now = Date.now();
  fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  store = memoryAccountStore();
  sent = [];
  challenges = [];
  service = new AccountService({ store, fetch: recordingFetch(), lock: memoryLock(), now: () => now });
});

describe("a sign-in's key proof for adding a PC", () => {
  it("keeps when the sign-in was made, through a refresh, by this device's clock", async () => {
    const session = await signIn();
    expect(session.signed_in_at).toBe(now);
    now += 2 * 60 * MINUTE;
    await service.listPcs();
    const refreshed = (await store.get("session"))!;
    expect(refreshed.access_token).not.toBe(session.access_token);
    expect(refreshed.signed_in_at).toBe(session.signed_in_at!);
  });

  it("a fresh sign-in admits with no proof: no challenge is asked, and the admit's body is {}", async () => {
    const session = await signIn();
    await registerKey(session);
    const pc = await listedByDeviceCode();
    now += PC_ADD_FRESH_MS;
    await service.admitPc(pc.serverId);
    expect(asked("/v1/pcs/challenge")).toBe(0);
    expect(admitBodies(pc.serverId)).toEqual([{}]);
  });

  it("an old sign-in admits with a proof by its registered key, over the PC's current listing", async () => {
    const session = await signIn();
    const key = await registerKey(session);
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    const admitted = await service.admitPc(pc.serverId);
    expect(admitted.account).toBe(ACCOUNT);
    expect(asked("/v1/pcs/challenge")).toBe(1);
    const [body] = admitBodies(pc.serverId);
    expect(Object.keys(body ?? {})).toEqual(["key_proof"]);
    expect(await provedBy(key, body!.key_proof, "admit", pc.serverId, pc.listing)).toBe(true);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(false);
  });

  it("one older than nine minutes proves too, so a press near the ten never crosses them on its way", async () => {
    const session = await signIn();
    await registerKey(session);
    const pc = await listedByDeviceCode();
    now += PC_ADD_FRESH_MS + 1;
    await service.admitPc(pc.serverId);
    expect(asked("/v1/pcs/challenge")).toBe(1);
  });

  it("a sign-in saved before its time was kept is of unknown age: it proves", async () => {
    const session = await signIn();
    const key = await registerKey(session);
    const { signed_in_at: _at, ...saved } = session;
    await store.set("session", saved);
    const pc = await listedByDeviceCode();
    await service.admitPc(pc.serverId, undefined, pc.listing);
    const [body] = admitBodies(pc.serverId);
    expect(await provedBy(key, body!.key_proof, "admit", pc.serverId, pc.listing)).toBe(true);
  });

  it("a sign-in that registered no key sends no proof and asks no challenge: the service refuses it as before", async () => {
    await signIn();
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ status: 403, code: "session_not_fresh" });
    expect(asked("/v1/pcs/challenge")).toBe(0);
    expect(admitBodies(pc.serverId)).toEqual([{}]);
  });

  it("another sign-in's key is not this one's: no proof is made with it", async () => {
    const earlier = await signIn();
    await registerKey(earlier);
    await signIn();
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ code: "session_not_fresh" });
    expect(asked("/v1/pcs/challenge")).toBe(0);
  });

  it("a device code's sign-in gets no challenge: its admit goes with no proof, and is refused as before", async () => {
    const session = await signIn();
    await registerKey(session);
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    await store.set("session", { ...session, access_token: fake.issueToken(ACCOUNT, { device: true }), expires_at: now + DAY });
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ status: 403, code: "own_sign_in_required" });
    expect(asked("/v1/pcs/challenge")).toBe(1);
    expect(admitBodies(pc.serverId)).toEqual([{}]);
  });

  it("a pressed add lists a PC the account does not list yet with a proof for the listing, over no listing; upkeep of a listed PC proves nothing", async () => {
    const session = await signIn();
    const key = await registerKey(session);
    now += 30 * DAY;
    const pc = newPc();
    await service.putPc(pc.serverId, { label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }, undefined, undefined, { prove: true });
    const [listed] = sent.filter((each) => each.method === "PUT");
    expect(await provedBy(key, listed!.body!.key_proof, "list", pc.serverId, "")).toBe(true);
    expect((await service.listPcs()).map((row) => row.server_id)).toEqual([pc.serverId]);
    sent = [];
    await service.putPc(pc.serverId, { label: "Desk 2", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }, undefined, undefined, { prove: true });
    expect(asked("/v1/pcs/challenge")).toBe(0);
    expect(sent.filter((each) => each.method === "PUT").map((each) => each.body?.key_proof)).toEqual([undefined]);
  });

  it("an old sign-in's listing of a new PC without a key is refused as the service refuses it, and nothing is listed", async () => {
    await signIn();
    now += 30 * DAY;
    const pc = newPc();
    await expect(service.putPc(pc.serverId, { label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }, undefined, undefined, { prove: true })).rejects.toMatchObject({ code: "session_not_fresh" });
    expect(fake.pcs(ACCOUNT)).toEqual([]);
  });

  it("a listing that is no person's press (a saved pairing's enrollment) signs nothing, whatever key the sign-in holds", async () => {
    const session = await signIn();
    await registerKey(session);
    now += 30 * DAY;
    const pc = newPc();
    fake.listProofRequired = false;
    await service.putPc(pc.serverId, { label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" });
    expect(asked("/v1/pcs/challenge")).toBe(0);
    expect(asked("/v1/pcs?include=unconfirmed")).toBe(0);
    expect((await service.listPcs()).map((row) => row.server_id)).toEqual([pc.serverId]);
  });

  it("a listing sent again with a challenge spent on the way makes its proof anew, once", async () => {
    const session = await signIn();
    const key = await registerKey(session);
    now += 30 * DAY;
    const pc = newPc();
    let spent = 1;
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: recordingFetch(async (request) => {
      if (request.method === "PUT" && spent-- > 0) return Response.json({ error: { code: "challenge_invalid", message: "x" } }, { status: 400 });
      return fake.fetch(request);
    }) });
    await service.putPc(pc.serverId, { label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }, undefined, undefined, { prove: true });
    const puts = sent.filter((each) => each.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(asked("/v1/pcs/challenge")).toBe(2);
    expect(await provedBy(key, puts[1]!.body!.key_proof, "list", pc.serverId, "")).toBe(true);
    // a second refusal of the new one is the answer
    spent = 2;
    sent = [];
    const other = newPc();
    await expect(service.putPc(other.serverId, { label: "Desk", public_key: other.publicKey, relay: "wss://relay.ovis.sh" }, undefined, undefined, { prove: true })).rejects.toMatchObject({ code: "challenge_invalid" });
    expect(sent.filter((each) => each.method === "PUT")).toHaveLength(2);
  });

  it("a listing sent again when the network is back reads its listing and asks its challenge through that same wait", async () => {
    const session = await signIn();
    await registerKey(session);
    now += 30 * DAY;
    const pc = newPc();
    const before: number[] = [];
    await service.putPc(pc.serverId, { label: "Desk", public_key: pc.publicKey, relay: "wss://relay.ovis.sh" }, undefined,
      { sends: 2, before: async (send) => { before.push(send); }, wait: async () => false }, { prove: true });
    // the directory read, the challenge and the listing each went through it
    expect(before).toEqual([1, 1, 1]);
  });
});

describe("the fallbacks to Sign in again, one proof attempt per press", () => {
  it("a service from before key proofs has no challenge route: the admit goes bare and is refused session_not_fresh", async () => {
    fake.pcAddProofs = false;
    const session = await signIn();
    await registerKey(session);
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ status: 403, code: "session_not_fresh" });
    expect(asked("/v1/pcs/challenge")).toBe(1);
    expect(admitBodies(pc.serverId)).toEqual([{}]);
  });

  it("an admit that refuses the proof's field (400 invalid_request) is told as session_not_fresh, and sent once", async () => {
    const session = await signIn();
    await registerKey(session);
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: recordingFetch(async (request) => {
      if (new URL(request.url).pathname.endsWith("/admit")) return Response.json({ error: { code: "invalid_request", message: "Send {}" } }, { status: 400 });
      return fake.fetch(request);
    }) });
    const refused = await service.admitPc(pc.serverId).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AccountServiceError);
    expect(refused).toMatchObject({ status: 403, code: "session_not_fresh" });
    expect(admitBodies(pc.serverId)).toHaveLength(1);
    expect(asked("/v1/pcs/challenge")).toBe(1);
  });

  it("a 400 invalid_request to an admit that sent no proof stays what it is", async () => {
    await signIn();
    const pc = await listedByDeviceCode();
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: recordingFetch(async (request) => {
      if (new URL(request.url).pathname.endsWith("/admit")) return Response.json({ error: { code: "invalid_request", message: "x" } }, { status: 400 });
      return fake.fetch(request);
    }) });
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("a proof that does not hold (the service knows no key for this sign-in) is judged by age alone", async () => {
    const session = await signIn();
    const key = await newKey();
    await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id!, key, no: 1 });
    now += 30 * DAY;
    const pc = await listedByDeviceCode();
    await expect(service.admitPc(pc.serverId)).rejects.toMatchObject({ code: "session_not_fresh" });
    expect(asked("/v1/pcs/challenge")).toBe(1);
    expect(admitBodies(pc.serverId)).toHaveLength(1);
  });
});
