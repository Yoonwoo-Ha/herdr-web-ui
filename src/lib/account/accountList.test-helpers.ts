/**
 * For tests of a device's list: a world of one account service and the devices of one account (listWorld), and a PC
 * that asks to be added to an account, as far as the account service sees it. Such a PC has a relay identity, a
 * signing key and an encryption key of its own, the account lists it, and it posts its keys and its card with its own
 * relay proof, which is what the account service asks before it places a `pc` entry for it.
 */
import { signCard } from "../../../shared/account-list.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { generateStoredEncryptionKey } from "../../../shared/account-list-seal.ts";
import { exportAccountKey } from "../../../shared/account-records.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { answerServerChallenge, deriveServerId } from "../../../shared/relay-server-proof.ts";
import { accountList, type AccountList, type GenesisMode } from "./accountList.ts";
import { deviceListKeys, type DeviceListKeys } from "./listKeys.ts";
import { memoryListLock, memoryListStore, type ListStore } from "./listStore.ts";
import { AccountService } from "./service.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountSession, type AccountStore } from "./store.ts";

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface AskingPc {
  /** Its relay key, 64 hex. */
  readonly endpoint: string;
  readonly server_id: string;
  /** Its signing key and its encryption key, as a list spells a key. */
  readonly key: string;
  readonly enc: string;
  readonly signs: CryptoKey;
  readonly secret: Uint8Array;
}

export async function askingPc(): Promise<AskingPc> {
  const relay = generateKeyPair();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return {
    endpoint: Array.from(relay.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    server_id: deriveServerId(relay.publicKey),
    key: await exportAccountKey(signing.publicKey),
    enc: (await generateStoredEncryptionKey()).key,
    signs: signing.privateKey,
    secret: relay.secretKey,
  };
}

const json = (body: unknown, bearer?: string): RequestInit =>
  ({ headers: { "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body) });

/**
 * The account lists the PC under `bearer`'s sign-in, and the PC posts its keys and its card for `list`. Answers the
 * card, which the entry that adds the PC carries.
 */
export async function postPcKeys(fetch: Fetch, service: string, bearer: string, pc: AskingPc, list: string): Promise<string> {
  const listed = await fetch(`${service}/v1/pcs/${pc.server_id}`, { method: "PUT", ...json({ label: "PC", public_key: pc.endpoint, relay: "wss://relay.test" }, bearer) });
  if (!listed.ok) throw new Error(`The account did not list the PC: ${listed.status}`);
  const asked = await fetch(`${service}/v1/pc/challenge`, { method: "POST", ...json({ server_id: pc.server_id, public_key: pc.endpoint }) });
  if (!asked.ok) throw new Error(`The account service gave the PC no challenge: ${asked.status}`);
  const challenge = await asked.json() as { challenge_id: string; frame: string };
  const proof = answerServerChallenge(challenge.frame, pc.secret, { server_id: pc.server_id, role: "account", connection_id: challenge.challenge_id });
  if (proof === null) throw new Error("The PC could not answer the account service's challenge");
  const card = await signCard({ key: pc.key, enc: pc.enc, list, endpoint: pc.endpoint, invite: null }, pc.signs);
  const posted = await fetch(`${service}/v2/pc/list/keys`, { method: "POST", ...json({ server_id: pc.server_id, public_key: pc.endpoint, challenge_id: challenge.challenge_id, proof, list, key: pc.key, enc: pc.enc, card }) });
  if (!posted.ok) throw new Error(`The account service did not take the PC's keys: ${posted.status}`);
  return card;
}

/** What a device's requests meet on the way: an answer of the test's own for some of them, or the account service's. */
export interface WorldWire { answer: ((request: Request) => Response | Promise<Response | null> | null) | null }

/** One device in a test's world: its own stores (so its own keys), its sign-in, and its copy of the list. */
export interface WorldDevice {
  readonly store: AccountStore;
  readonly lists: ListStore;
  readonly session: AccountSession;
  readonly list: AccountList;
  readonly service: AccountService;
  /** `METHOD path` of every request it sent, and each with its body. */
  readonly sent: { readonly route: string; readonly body: Record<string, unknown> | null }[];
  readonly wire: WorldWire;
  keys(): Promise<DeviceListKeys>;
}

/**
 * An account service in memory with a clock the test moves, and devices that sign in to one account of it: each an
 * app's own sign-in whose key is registered, as the app does after a sign-in.
 */
export function listWorld(account = "acct_owner", start = 1_795_000_000_000) {
  const clock = { now: start };
  const fake = new FakeAccountService(() => clock.now);
  fake.opensAll = true;
  fake.listAccounts = "*";
  const origin = "https://account.example";
  /** `skew`: how far this device's own clock runs apart from the account service's, in ms. */
  const device = async (given: { readonly label?: string; readonly genesis?: GenesisMode; readonly register?: boolean; readonly skew?: number } = {}): Promise<WorldDevice> => {
    const label = given.label ?? "Phone";
    const own = (): number => clock.now + (given.skew ?? 0);
    const store = memoryAccountStore();
    const lists = memoryListStore();
    const session: AccountSession = {
      service: origin, account, provider: "github", access_token: fake.issueToken(account), refresh_token: `refresh-${Math.random()}`,
      expires_at: own() + 24 * 60 * 60_000, sign_in_id: `sign-in-${Math.random()}`, signed_in_at: own(),
    };
    await store.set("session", session);
    if (given.register !== false) {
      const key = await newKey();
      await store.set("signin_key", { account, sign_in_id: session.sign_in_id!, key, no: fake.registerSessionKey(session.access_token, key.public_spki, label) });
    }
    const sent: WorldDevice["sent"] = [];
    const wire: WorldWire = { answer: null };
    const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.clone().text();
      sent.push({ route: `${request.method} ${url.pathname}`, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> });
      return await wire.answer?.(request.clone()) ?? await fake.fetch(request);
    };
    const service = new AccountService({ store, fetch, lock: memoryLock(), now: own });
    const list = accountList({
      service, accountStore: store, listStore: lists, lock: memoryListLock(), now: own,
      names: () => ({ label, os: "ios" }), linkedPcs: async () => 0, genesis: () => given.genesis ?? "first-device", durable: async () => true,
    });
    return { store, lists, session, list, service, sent, wire, keys: () => deviceListKeys(store) };
  };
  /** The account's list as the account service holds it. */
  const held = () => {
    const list = fake.accountList(account);
    if (list === null) throw new Error("the account has no list");
    return list;
  };
  return { account, origin, clock, fake, device, held };
}
