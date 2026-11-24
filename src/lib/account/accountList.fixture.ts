/**
 * For tests of a device's list: a PC that asks to be added to an account, as far as the account service sees it. It
 * has a relay identity, a signing key and an encryption key of its own, the account lists it, and it posts its keys and
 * its card with its own relay proof, which is what the account service asks before it places a `pc` entry for it.
 */
import { signCard } from "../../../shared/account-list.ts";
import { generateStoredEncryptionKey } from "../../../shared/account-list-seal.ts";
import { exportAccountKey } from "../../../shared/account-records.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { answerServerChallenge, deriveServerId } from "../../../shared/relay-server-proof.ts";

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
