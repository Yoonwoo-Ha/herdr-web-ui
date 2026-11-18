/**
 * The join line of the signed list (a machine joins by an invite): what the device that made an invite
 * shows once, and what a machine pastes to join. It has one form, and the reader proves it by
 * writing the line again from what it read. The line carries an invite's private key: no refusal of
 * this file puts any part of a line into its message or its fields. No I/O; WebCrypto only.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { isListHash, verifySignature } from "./account-list-entry.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

export const JOIN_LINE_PREFIX = "ovis-join:1:";
/** The one PKCS8 form of a P-256 private key a line carries: version 0, the curve named once, ECPrivateKey version 1 with the public point. */
export const JOIN_SECRET_BYTES = 138;

/** Why a line is refused. `not_one_form` is a line whose parts are each in form but that the writer would have written otherwise. */
export type JoinLineReason = "prefix" | "base64url" | "json" | "members" | "version" | "service" | "list" | "secret" | "not_one_form";

export class JoinLineError extends Error {
  readonly code = "line_malformed";
  constructor(readonly reason: JoinLineReason, message: string) {
    super(message);
    this.name = "JoinLineError";
  }
}

function refuse(reason: JoinLineReason, message: string): never {
  throw new JoinLineError(reason, message);
}

/** WebCrypto, or a fault: a runtime without it (a page on plain http at a LAN address) says nothing about a line. */
function webCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available here (crypto.subtle is missing), so no join line can be written or read");
  return subtle;
}

/** What a line holds once it is read. */
export interface JoinLine {
  /** The account service's origin. */
  readonly service: string;
  /** The list id. */
  readonly list: string;
  /** The invite's key: the public half of the line's secret, in the one spelling of a key. */
  readonly key: string;
  /** The line's secret, to sign `join` and the invite's read proof; it cannot be exported. */
  readonly privateKey: CryptoKey;
}

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** PKCS8 up to the private value: SEQUENCE(135) { INTEGER 0, AlgorithmIdentifier { id-ecPublicKey, prime256v1 }, OCTET STRING(109) { SEQUENCE(107) { INTEGER 1, OCTET STRING(32) } } }. */
const SECRET_HEAD = Uint8Array.from([
  0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20,
]);
/** After the private value: [1] { BIT STRING { 0 unused bits, 0x04, X, Y } }. */
const SECRET_MIDDLE = Uint8Array.from([0xa1, 0x44, 0x03, 0x42, 0x00, 0x04]);
const POINT_AT = SECRET_HEAD.length + 32 + SECRET_MIDDLE.length - 1;
/** SubjectPublicKeyInfo { id-ecPublicKey, prime256v1 } and the BIT STRING header, up to the 0x04 of the point. */
const SPKI_HEAD = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
  0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const PROBE = utf8ToBytes("ovis-join-secret-check/1");
const MEMBERS = ["v", "service", "list", "secret"] as const;

/** Base64url in its one spelling (no padding), or null. */
function oneSpelling(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const bytes = fromBase64Url(text);
  return toBase64Url(bytes) === text ? bytes : null;
}

/** An `https` origin in its one serialization: `https://host[:port]`, lower case, no default port, no path. */
export function isServiceOrigin(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.origin === text;
}

function lineText(service: string, list: string, secret: string): string {
  const json = `{"v":1,"service":${JSON.stringify(service)},"list":${JSON.stringify(list)},"secret":${JSON.stringify(secret)}}`;
  return `${JOIN_LINE_PREFIX}${toBase64Url(utf8ToBytes(json))}`;
}

function secretBytes(d: Uint8Array, x: Uint8Array, y: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(JOIN_SECRET_BYTES);
  bytes.set(SECRET_HEAD);
  bytes.set(d, SECRET_HEAD.length);
  bytes.set(SECRET_MIDDLE, SECRET_HEAD.length + 32);
  bytes.set(x, POINT_AT + 1);
  bytes.set(y, POINT_AT + 33);
  return bytes;
}

function jwkPart(value: string | undefined): Uint8Array {
  const bytes = value === undefined ? null : oneSpelling(value);
  if (bytes === null || bytes.length !== 32) refuse("secret", "The secret is not a P-256 private key");
  return bytes;
}

/**
 * The line for an invite: the service's origin, the list id and the invite's private key, which must
 * be extractable. The secret's 138 bytes are built here from the key's JWK, never taken from an
 * engine's PKCS8 export, so every runtime writes the same line. Refuses `line_malformed`.
 */
export async function writeJoinLine(service: string, list: string, privateKey: CryptoKey): Promise<string> {
  const subtle = webCrypto();
  if (!isServiceOrigin(service)) refuse("service", "service is an https origin");
  if (!isListHash(list)) refuse("list", "list is a list id: 64 of 0-9a-f");
  let jwk: JsonWebKey;
  try {
    jwk = await subtle.exportKey("jwk", privateKey);
  } catch (error) {
    if (error instanceof DOMException) refuse("secret", "The secret is not an extractable P-256 private key");
    throw error;
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") refuse("secret", "The secret is not a P-256 private key");
  const secret = secretBytes(jwkPart(jwk.d), jwkPart(jwk.x), jwkPart(jwk.y));
  return lineText(service, list, toBase64Url(secret));
}

/** The secret's bytes when they are the one PKCS8 form; null for anything else. Nothing here says whether the point is its own. */
function secretForm(text: string): Uint8Array | null {
  const bytes = oneSpelling(text);
  if (bytes === null || bytes.length !== JOIN_SECRET_BYTES) return null;
  const at = (fixed: Uint8Array, offset: number) => fixed.every((byte, index) => bytes[offset + index] === byte);
  return at(SECRET_HEAD, 0) && at(SECRET_MIDDLE, SECRET_HEAD.length + 32) ? bytes : null;
}

/**
 * A pasted line, read strictly: the prefix, base64url in its one spelling, a JSON object with the four
 * members, each in its form, the line written again from them equal to the line given, and a secret
 * that signs for the public point it carries. Refuses `line_malformed` with a reason, and never with
 * any part of the line. The secret's form fixes the point's SubjectPublicKeyInfo, so the key derived
 * from it is always a key in its one spelling. Throws (a fault, no refusal) without WebCrypto.
 */
export async function readJoinLine(line: string): Promise<JoinLine> {
  const subtle = webCrypto();
  if (!line.startsWith(JOIN_LINE_PREFIX)) refuse("prefix", `A join line starts with ${JOIN_LINE_PREFIX}`);
  const bytes = oneSpelling(line.slice(JOIN_LINE_PREFIX.length)) ?? refuse("base64url", "The line is base64url in its one spelling after its prefix");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("json", "The line holds a JSON object");
  const members = value as Record<string, unknown>;
  const names = Object.keys(members);
  if (names.length !== MEMBERS.length || !MEMBERS.every((name) => Object.hasOwn(members, name))) refuse("members", "The line has exactly v, service, list and secret");
  if (members.v !== 1) refuse("version", "v is 1");
  const { service, list, secret } = members;
  if (typeof service !== "string" || !isServiceOrigin(service)) refuse("service", "service is an https origin");
  if (typeof list !== "string" || !isListHash(list)) refuse("list", "list is a list id: 64 of 0-9a-f");
  const pkcs8 = typeof secret === "string" ? secretForm(secret) : null;
  if (pkcs8 === null || typeof secret !== "string") refuse("secret", "The secret is not a P-256 private key in the line's one PKCS8 form");
  if (lineText(service, list, secret) !== line) refuse("not_one_form", "The line is not in its one form");
  const key = toBase64Url(new Uint8Array([...SPKI_HEAD, ...pkcs8.subarray(POINT_AT, POINT_AT + 65)]));
  let privateKey: CryptoKey;
  let signature: Uint8Array;
  try {
    privateKey = await subtle.importKey("pkcs8", new Uint8Array(pkcs8), P256, false, ["sign"]);
    signature = new Uint8Array(await subtle.sign(SIGN, privateKey, new Uint8Array(PROBE)));
  } catch (error) {
    if (error instanceof DOMException) refuse("secret", "The secret is not a P-256 private key");
    throw error;
  }
  if (!(await verifySignature(PROBE, signature, key))) refuse("secret", "The secret does not sign for the public point it carries");
  return { service, list, key, privateKey };
}
