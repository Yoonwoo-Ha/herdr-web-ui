/**
 * A test account's signed list at the fake account service: members that sign real entries and place them through
 * the service's own routes, so a PC under test reads what a real account would hold.
 */
import { entryFromText, entryHash, entryToText, signEntry } from "../../shared/account-list-entry.ts";
import { epochKeyCommitment, generateStoredEncryptionKey, newEpochKey } from "../../shared/account-list-seal.ts";
import { kindBody, signCard, type ListKind, type ListRole } from "../../shared/account-list.ts";
import type { ListPlace } from "../../shared/account-list-signers.ts";
import { exportAccountKey } from "../../shared/account-records.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";

const SERVICE = "https://account.test";

/** A device of the test account: its member key, which signs, and its encryption key. */
export interface ListMember {
  readonly key: string;
  readonly keys: CryptoKeyPair;
  readonly enc: string;
}

export async function listMember(keys?: CryptoKeyPair): Promise<ListMember> {
  const pair = keys ?? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { key: await exportAccountKey(pair.publicKey), keys: pair, enc: (await generateStoredEncryptionKey()).key };
}

/** A device's card for `list`, as the entry that lets it in carries it. */
export function memberCard(member: ListMember, list: string): Promise<string> {
  return signCard({ key: member.key, enc: member.enc, list, endpoint: null, invite: null }, member.keys.privateKey);
}

/** The test account's list as its members write it: what they sign follows the last entry they placed or made. */
export class TestList {
  private constructor(readonly service: FakeAccountService, readonly account: string, readonly id: string, readonly first: ListMember, private head: ListPlace, private readonly token: string, private clock: () => number) {}

  /** A new list for `account`: its first device makes entry 0 and the account service takes it. */
  static async start(service: FakeAccountService, account: string, first?: ListMember, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<TestList> {
    const member = first ?? await listMember();
    const token = service.issueToken(account, { twoStep: true });
    const body = kindBody({ issued_at: now(), list: "", prev: "", seq: 0, signer: member.key },
      { kind: "genesis", account, enc: member.enc, opens: epochKeyCommitment({ list: "", epoch: newEpochKey(0) }), sealed: null });
    const text = entryToText(await signEntry(body, member.keys.privateKey));
    const answer = await service.fetch(new Request(`${SERVICE}/v2/lists`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ entry: text }) }));
    if (answer.status !== 201) throw new Error(`The genesis was not taken: ${answer.status} ${await answer.text()}`);
    const list = (await answer.json() as { list: string }).list;
    return new TestList(service, account, list, member, { seq: 0, hash: list }, token, now);
  }

  get place(): ListPlace { return this.head; }

  /**
   * An entry of `kind` signed by `signer`: its text. Nothing is placed. Without `after` it follows the last entry this
   * list made, and is the last one from then on; with `after` it follows that place and the list's own head stays, so a
   * test can sign beside the log (an entry the service only shows, another history).
   */
  async sign(kind: ListKind, signer: ListMember = this.first, after?: ListPlace): Promise<string> {
    const place = after ?? this.head;
    const body = kindBody({ issued_at: this.clock(), list: this.id, prev: place.hash, seq: place.seq + 1, signer: signer.key }, kind);
    const text = entryToText(await signEntry(body, signer.keys.privateKey));
    if (after === undefined) this.head = { seq: place.seq + 1, hash: entryHash(entryFromText(text).body) };
    return text;
  }

  /** Places texts at the account service as one batch, from a sign-in of the account. */
  async placeTexts(texts: readonly string[]): Promise<void> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/entries`, { method: "POST", headers: { authorization: `Bearer ${this.token}` }, body: JSON.stringify({ entries: texts }) }));
    if (!answer.ok) throw new Error(`The entries were not placed: ${answer.status} ${await answer.text()}`);
  }

  /** A member lets a device in: the device claims its key with a sign-in of its own (the second lock), the member signs and places. */
  async addDevice(device: ListMember, options: { role?: ListRole; until?: number | null; by?: ListMember; power?: "full" | "bound" } = {}): Promise<string> {
    const card = await memberCard(device, this.id);
    const claimed = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/claims`, { method: "POST",
      headers: { authorization: `Bearer ${this.service.issueToken(this.account, { twoStep: true })}` }, body: JSON.stringify({ key: device.key, enc: device.enc, card }) }));
    if (!claimed.ok) throw new Error(`The claim was not taken: ${claimed.status} ${await claimed.text()}`);
    const text = await this.sign({ kind: "device", key: device.key, power: options.power ?? "full", role: options.role ?? "drive", until: options.until ?? null, enc: device.enc, card, sealed: null, rotates: false }, options.by);
    await this.placeTexts([text]);
    return text;
  }

  /** A member adds the PC at `endpoint` from the keys and card that PC posted itself (the second lock). */
  async addPostedPc(endpoint: string, by?: ListMember): Promise<string> {
    const answer = await this.service.fetch(new Request(`${SERVICE}/v2/lists/${this.id}/posts`, { headers: { authorization: `Bearer ${this.token}` } }));
    const posts = (await answer.json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts;
    const post = posts.find((candidate) => candidate.endpoint === endpoint);
    if (!post) throw new Error("The PC posted no keys");
    const text = await this.sign({ kind: "pc", key: post.key, endpoint, enc: post.enc, card: post.card, sealed: null }, by);
    await this.placeTexts([text]);
    return text;
  }

  /** A member puts a key out. */
  async remove(key: string, by?: ListMember): Promise<string> {
    const text = await this.sign({ kind: "remove", ends: key }, by);
    await this.placeTexts([text]);
    return text;
  }
}
