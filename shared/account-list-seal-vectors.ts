/**
 * Test support: what account-list-seal.ts gives for one vector of account-list-vectors/seal/, to set
 * beside the vector's `expect` (docs/account-list.md, "The vectors of seal/"). The Bun test runs it,
 * and a real browser runs the same code (scripts/account-list-seal-browser-qa.ts). The member's key
 * is imported so that it cannot be exported, as a device holds it.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type CannotOpen, openLink, openSealed, openWrap, wrapFromText } from "./account-list-seal.ts";
import { fromBase64Url } from "./relay-pair-sas.ts";

export interface SealVector {
  readonly name: string;
  readonly keys?: Readonly<Record<string, { readonly pkcs8: string; readonly spki: string }>>;
  readonly wrap?: { readonly list: string; readonly epoch: number; readonly commitment: string; readonly member: string; readonly text: string };
  readonly link?: { readonly list: string; readonly from: { readonly epoch: number; readonly key: string }; readonly commitment: string; readonly bytes: string };
  readonly sealed?: { readonly list: string; readonly seq: number; readonly epoch: { readonly epoch: number; readonly key: string }; readonly bytes: string };
  readonly expect: SealVectorResult;
}

export type SealVectorResult =
  | { readonly key: string }
  | { readonly fields: readonly (readonly [string, string])[] }
  | { readonly why: CannotOpen };

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export async function sealVectorResult(vector: SealVector): Promise<SealVectorResult> {
  if (vector.wrap) {
    const { list, epoch, commitment, member, text } = vector.wrap;
    const pair = vector.keys?.[member];
    if (!pair) throw new Error(`${vector.name} names a member it holds no key for`);
    const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(fromBase64Url(pair.pkcs8)), ECDH, false, ["deriveBits"]);
    const wrap = wrapFromText(text);
    if (wrap === null) return { why: "form" };
    const opened = await openWrap({ list, epoch, commitment, wrap, member: { key: pair.spki, privateKey } });
    return opened.open ? { key: bytesToHex(opened.value.key) } : { why: opened.why };
  }
  if (vector.link) {
    const { list, from, commitment, bytes } = vector.link;
    const opened = await openLink({ list, from: { epoch: from.epoch, key: hexToBytes(from.key) }, link: fromBase64Url(bytes), commitment });
    return opened.open ? { key: bytesToHex(opened.value.key) } : { why: opened.why };
  }
  if (vector.sealed) {
    const { list, seq, epoch, bytes } = vector.sealed;
    const opened = await openSealed({ place: { list, seq }, epoch: { epoch: epoch.epoch, key: hexToBytes(epoch.key) }, sealed: fromBase64Url(bytes) });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return opened.open ? { fields: opened.value.map((field) => [field.name, decoder.decode(field.value)] as const) } : { why: opened.why };
  }
  throw new Error(`${vector.name} holds no wrap, link or sealed field`);
}
