/**
 * Test support only: nothing in production imports it (server/conventions.test.ts).
 * It checks what the real service must check (record shape and signature, the caller's directory,
 * server proof with the `account` role), so tests fail where a PC or app relies on something the
 * service would refuse.
 */
import {
  ACCOUNT_RECORDS_MAX, AccountRecordError, isAccountKeyEncoding, isDeviceSafetyRecord, parseSafetyRecord, pcAddSigningBytes, readAccountRecord, verifySafetyRecord,
  type AccountRecord, type BlockRecord, type DeviceLiftRecord, type PcAddPurpose, type SafetyRecord,
} from "./account-records.ts";
import { ACCOUNT_SNAPSHOT_V, SNAPSHOT_GONE, type AccountSnapshotPage, type SnapshotFreezeLine } from "./account-snapshot.ts";
import { accountOsOf, type AccountOs, type AccountPlace } from "./account-asker.ts";
import { isWssOrigin } from "./relay-offer.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";
import { isListKeyEncoding, isListPoint } from "./account-list-entry.ts";
import { verifyInviteRedeem } from "./account-list-invite.ts";

export const CHALLENGE_TTL_MS = 60_000;
/** How long a PC's own leave (POST /v1/pcs/{server_id}/leave) keeps a PUT without its proof from listing it again. */
export const PC_LEFT_MS = 30 * 24 * 60 * 60 * 1000;

/** a listing's own ID (account#57), as the service makes it */
const LISTING_ID = /^[0-9a-f]{32}$/;

/** account#57's completion scope, and the context its challenge is stored and proved under */
function completionScope(value: unknown): { account: string; listing_id: string } | null {
  if (value === null || typeof value !== "object") return null;
  const { account, listing_id } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof account === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(account) && typeof listing_id === "string" && LISTING_ID.test(listing_id)
    ? { account, listing_id } : null;
}
const completionKey = (scope: { account: string; listing_id: string }, nonce: string): string => `pc-complete/1:${scope.account}:${scope.listing_id}:${nonce}`;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;
export const MAILBOX_MAX = 1000;
export const ACCESS_TOKEN_TTL_S = 3600;
export const DIRECTORY_MAX = 100;
export const LIMIT_WINDOW_MS = 10 * 60_000;
export const ADMISSIONS_PER_WINDOW = 10;
/** Quiet admissions one account may post in a window: a count of their own, apart from the ordinary ones. */
export const QUIET_ADMISSIONS_PER_WINDOW = 60;
export const ACCOUNT_REQUESTS_PER_WINDOW = 600;
export const DEVICE_CODE_TTL_S = 900;
export const DEVICE_POLL_S = 5;
export const ACCOUNT_RING = { pane_id: null, title: "Ovis", body: "Your Ovis account has news", tag: "ovis-account" } as const;

export interface FakeRing { account: string; endpoint: string; payload: typeof ACCOUNT_RING }
export const SIGNIN_CODE_TTL_MS = 60_000;

export type SignInProvider = "github" | "google" | "apple";
const SIGN_IN_PROVIDERS: readonly string[] = ["github", "google", "apple"];
const DEVICE_PAGES: Readonly<Record<string, string>> = { github: "https://github.com/login/device", google: "https://www.google.com/device" };
export const LINK_TOKEN_TTL_S = 600;
/** How recent a sign-in must be to add or remove a sign-in method. */
export const REAUTH_MS = 10 * 60_000;

/** The web app's redirect: the code comes back in the fragment there, so it never reaches the host's logs. */
export const WEB_REDIRECT = "https://app.ovis.sh/";

/** The only redirects sign-in returns to (docs/account.md, "Signing in"), compared exactly. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === WEB_REDIRECT || uri === "ovis://account/callback") return true;
  const loopback = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(uri);
  return loopback !== null && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535;
}

async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

interface Session { account: string; provider: SignInProvider | "test"; family: string; expires: number }

/** `public_key`: the PC's relay key (X25519, 64 hex), from which `server_id` derives; `relay`: the wss origin it is reached through. */
export interface FakePc { server_id: string; label: string; public_key: string; relay: string; added_at: string; last_seen_at: string | null; new_until?: string | null; admitted_at?: string | null; exempt?: boolean;
  /** PCL-1: listed by a sign-in that was no app's own (a device code) and not confirmed since, as the service's `listed_by_device` */
  listed_by_device?: boolean;
  /** listed by a device code while Step 2 was on: until confirmed or admitted it leaves the account never used (account#62) */
  pending_under_step2?: boolean;
  /** the sign-in (family) that wrote the listing, as the service's `listed_by_session` (account#63): upkeep never rewrites it */
  listed_by_session?: string;
  /** with `completions` (account#57): this listing's own ID */
  listing_id?: string;
  /** the PC completed its add (the service's `completed_at`; with `completions`, POST /v1/pc/complete), and a device was admitted to it by its digits (`digit_admitted`) */
  completed_at?: string | null;
  digit_admitted?: boolean;
  /**
   * With `pcAddProofs`, on a listing a device code made under Step 2: when that sign-in was made, which starts the listing's
   * LISTING_ASKS_MS, and who asked (the system its PUT named and the place the service saw it come from)
   */
  asking_since?: number;
  asking?: { os: AccountOs | null; country: string | null; city: string | null } }
/** How long a listing that asks to join may be let in, from the device-code sign-in that made it; past it 409 `listing_expired`. */
export const LISTING_ASKS_MS = 10 * 60_000;
/** How long a key proof's challenge (POST /v1/pcs/challenge) is good for. */
export const PC_ADD_CHALLENGE_TTL_MS = 2 * 60_000;
/** How long a PC added in one press stays new to the account's other devices. */
export const PC_NEW_MS = 24 * 60 * 60_000;
/** One-press PC adds one account may make per rolling day; past it 429 `pc_add_cap`. */
export const PC_ADMITS_PER_DAY = 3;
/** `key`: the waiting device's account key, which the PC matches against the comparison it is asked for. */
export interface FakeAdmission { id: string; server_id: string; account: string; label: string; key: string; at: string; os: AccountOs | null; country: string | null; city: string | null }
/** How long an admission reaches its PC's mailbox: the PC lets a waiting account device compare digits only within it. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** How long a PC invite works, once. */
export const PC_INVITE_TTL_MS = 15 * 60_000;
/** Open PC invites (POST /v1/pc-invites) one account may hold at once. */
export const INVITES_OPEN_MAX = 5;
/** How long GET /v1/pc-invites still lists an invite after a PC used it. */
export const INVITE_USED_SHOWN_MS = 24 * 60 * 60_000;
/** Invites one account may make, and redeems one PC may try, in a window; past it 429 `rate_limited` (retry-after 60). */
export const INVITES_PER_WINDOW = 20;
export const REDEEMS_PER_WINDOW = 10;
interface FakeInvite {
  /** `key`: the invite's public key (`invite_key`), all the service is given of it: the join line's private key never comes here */
  id: string; account: string; key: string; auto: boolean; family: string; madeAt: number; revoked: boolean;
  used: { at: number; server_id: string; public_key: string; listing_id: string; label: string; os: AccountOs | null; country: string | null; city: string | null } | null;
}

interface Mail { seq: number; record: AccountRecord; at: number }

/** Devices one snapshot page lists. */
export const SNAPSHOT_PAGE = 100;

/** Device table P6, P21: an account's registered keys, each with a `no` that is never reused, and its durable records. */
interface Registry {
  next: number;
  version: number;
  /** Device table T58: raised when the account gains or loses a sign-in method */
  methods_version: number;
  devices: Map<string, { no: number; label: string; eligible: boolean; removed: boolean }>;
  blocks: BlockRecord[];
  lifts: DeviceLiftRecord[];
  freezes: SnapshotFreezeLine[];
}

type SnapshotState = Omit<AccountSnapshotPage, "page" | "last" | "v">;

export class FakeAccountService {
  private readonly tokens = new Map<string, Session>();
  /** `link`: the sign-in (account and refresh family) a linking sign-in adds this identity to, once that sign-in redeems the code */
  private readonly codes = new Map<string, { account: string; provider: SignInProvider; challenge: string; redirect: string; expires: number; link: { account: string; family: string } | null }>();
  private readonly refreshTokens = new Map<string, { account: string; provider: SignInProvider; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private readonly appleTokens = new Map<string, { account: string; nonce: string }>();
  private readonly signIns = new Map<SignInProvider, string>();
  private readonly deviceSignIns = new Map<string, { provider: SignInProvider; userCode: string; account: string | null; denied: boolean; interval: number; nextPoll: number; expires: number; challenge: string | null; page?: boolean; requester?: { label: string | null; os: AccountOs | null } }>();
  private readonly identityList = new Map<string, Map<SignInProvider, { added_at: string }>>();
  private readonly linkTokens = new Map<string, { account: string; family: string; provider: SignInProvider; expires: number }>();
  /** by refresh family: when that sign-in was made (a refresh keeps it), for what needs a recent one */
  private readonly signedInAt = new Map<string, number>();
  /** by refresh family: the sign-in's two_step_set (null: unknown, as a Google sign-in without amr) */
  private readonly twoStep = new Map<string, boolean | null>();
  /** what a sign-in made through the sign-in routes says of two-step sign-in; tests set it */
  signInTwoStep: boolean | null = null;
  /** one-press admissions by account and PC (`box`), and each account's admit times, for the daily cap */
  private readonly pcAdmissions = new Map<string, { at: number; taken: boolean; family: string; listing?: string }>();
  private readonly admitTimes = new Map<string, number[]>();
  /** accounts that admitted or removed a PC: never empty again for the first-PC exemption */
  private readonly usedAccounts = new Set<string>();
  /** by refresh family: when that sign-in registered its own account device key (registerSessionKey) */
  private readonly keyRegisteredAt = new Map<string, number>();
  /** by key: the refresh family that registered it with registerSessionKey */
  private readonly keyFamily = new Map<string, string>();
  private offered: { providers: SignInProvider[]; device: SignInProvider[]; device_page?: SignInProvider[] } = { providers: ["github", "google", "apple"], device: ["github", "google"] };
  private readonly pushes = new Map<string, { account: string; endpoint: string }>();
  private readonly counters = new Map<string, { start: number; count: number }>();
  private readonly ringList: FakeRing[] = [];
  private readonly directories = new Map<string, Map<string, FakePc>>();
  private readonly mailboxes = new Map<string, Mail[]>();
  private readonly challenges = new Map<string, { server_id: string; expected: string; expires: number }>();
  /** box(server_id, account): when the PC left that account by its own proof */
  private readonly pcLeaves = new Map<string, number>();
  private readonly admissionList: FakeAdmission[] = [];
  /** quiet admissions: only an app's own sign-in posts one, and only a PC the account lists reads them */
  private readonly quietList: FakeAdmission[] = [];
  private readonly accountLimits = new Map<string, Record<string, unknown>>();
  private readonly subscribed = new Set<string>();
  private readonly deletedAccounts = new Set<string>();
  /** sign-ins made with a device code or on the link page, refreshes included: they cannot delete the account */
  private readonly deviceFamilies = new Set<string>();
  /** Where the service sees every request come from (Cloudflare's `request.cf`); unknown unless a test says. */
  requestPlace: AccountPlace = { country: null, city: null };
  linkPageAcceptsLabelAndOs = true;
  private readonly registries = new Map<string, Registry>();
  private readonly snapshots = new Map<string, SnapshotState>();
  /** OVIS_ACCOUNT_OPENS_ALL at the service: off, the snapshot and safety-record routes do not exist. */
  opensAll = false;
  /** Newer services distinguish a listed PC's snapshot opt-out from a hidden 404. */
  reportsStep2Off = false;
  /**
   * account#57: each listing has its own ID; a PC's admission may name it (`with_listing_id`), and the PC, once bound,
   * records its add complete with a proof scoped to that account and listing (POST /v1/pc/complete). Off: an older service,
   * which a PC no longer binds to in one press.
   */
  completions = true;
  /**
   * The mailbox says beside `listing_id` whether that listing stands on a one-press admission this PC took
   * (`listing_admitted`). Off: a service from before the field, which omits it.
   */
  saysListingAdmitted = true;
  /**
   * The one-press admit asks a used account's sign-in for two-step (`two_step_required`), as the service did until
   * 2026-11-23. Off, the service since: such an admit is logged as exempt instead.
   */
  admitAsksTwoStep = false;
  /**
   * The service since it takes key proofs: an own sign-in older than REAUTH_MS adds a PC (the admit, a confirm, and where
   * Step 2 is on a PUT that lists a PC the account does not list yet) only with a proof by the key registered for that very
   * sign-in, over a challenge of POST /v1/pcs/challenge; any own sign-in declines a listing that asks to join; such a listing
   * says who is asking and is let in only within LISTING_ASKS_MS (409 `listing_expired`). Off, the service before: no
   * challenge route (404), an admit's body that is not `{}` is 400 `invalid_request`, a PUT ignores `key_proof`, and the
   * admit, a confirm and a Decline all ask for a sign-in from the last ten minutes.
   */
  pcAddProofs = true;
  /**
   * With `pcAddProofs`, the service's switch for its list rule: on, an old own sign-in's PUT of a PC the account does not list yet is
   * refused `session_not_fresh` without a key proof. Off (as the service ships at first), such a PUT lists the PC as before;
   * a proof that is sent is judged all the same.
   */
  listProofRequired = true;
  /** POST /v1/pcs/challenge's challenges, by id: for one sign-in (family), spent by their first use */
  private readonly pcAddChallenges = new Map<string, { family: string; challenge: string; expires: number }>();
  /** PC invites (POST /v1/pc-invites and the routes beside it). Off: the feature is off for every account (404 `not_found`). */
  pcInvites = true;
  private readonly invites = new Map<string, FakeInvite>();
  /** box(server_id, account): the listing a plain invite made, whose card offers Add until `until` (409 `listing_expired` after) */
  private readonly inviteCards = new Map<string, { until: number; listing: string }>();
  private seq = 0;
  readonly requests: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** `device`: the token is a device code's sign-in (a PC's), never an app's own */
  issueToken(account: string, { twoStep = null, device = false }: { twoStep?: boolean | null; device?: boolean } = {}): string {
    const token = randomHex(32);
    const family = randomHex(16);
    this.tokens.set(token, { account, provider: "test", family, expires: Number.POSITIVE_INFINITY });
    this.signedInAt.set(family, this.now());
    this.twoStep.set(family, twoStep);
    if (device) this.deviceFamilies.add(family);
    return token;
  }

  setLimits(account: string, limits: Record<string, unknown> | null): void {
    if (limits === null) this.accountLimits.delete(account);
    else this.accountLimits.set(account, limits);
  }

  signInAs(provider: SignInProvider, account: string): void { this.signIns.set(provider, account); }

  subscribe(account: string, renews = true): void { if (renews) this.subscribed.add(account); else this.subscribed.delete(account); }

  deleted(account: string): boolean { return this.deletedAccounts.has(account); }

  offerSignIns(providers: SignInProvider[], device: SignInProvider[]): void { this.offered = { providers, device }; }

  offerLinkPage(providers: SignInProvider[]): void { this.offered = { ...this.offered, device_page: providers }; }

  linkRequester(userCode: string): { label: string | null; os: AccountOs | null } | undefined {
    for (const entry of this.deviceSignIns.values()) if (entry.page && entry.userCode === userCode) return entry.requester;
    return undefined;
  }

  approveOnLinkPage(userCode: string, account: string, provider: SignInProvider): void {
    // one approval, as the service: an approved request's code names nothing any more
    for (const entry of this.deviceSignIns.values()) {
      if (entry.userCode === userCode && entry.page && entry.account === null && this.now() < entry.expires) { entry.account = account; entry.provider = provider; entry.userCode = ""; }
    }
  }


  private addIdentity(account: string, provider: SignInProvider): void {
    const methods = this.identityList.get(account) ?? new Map();
    if (!methods.has(provider)) { methods.set(provider, { added_at: this.iso() }); this.methodsChanged(account); }
    this.identityList.set(account, methods);
  }

  /** An identity token as Sign in with Apple hands an iOS app, for `account`, whose `nonce` claim is the hash the app gave Apple. */
  appleIdToken(account: string, nonceHash: string): string {
    const token = randomHex(32);
    this.appleTokens.set(token, { account, nonce: nonceHash });
    return token;
  }

  approveDevice(userCode: string, account: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.account = account;
  }

  denyDevice(userCode: string): void {
    for (const entry of this.deviceSignIns.values()) if (entry.userCode === userCode) entry.denied = true;
  }

  rings(): readonly FakeRing[] { return this.ringList; }

  private ring(account: string, family: string): void {
    for (const [owner, push] of this.pushes) if (push.account === account && owner !== family) this.ringList.push({ account, endpoint: push.endpoint, payload: ACCOUNT_RING });
  }

  private withinRateLimit(key: string, max: number): boolean {
    const now = this.now();
    const counter = this.counters.get(key);
    if (!counter || now - counter.start >= LIMIT_WINDOW_MS) { this.counters.set(key, { start: now, count: 1 }); return true; }
    counter.count += 1;
    return counter.count <= max;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  private grant(account: string, provider: SignInProvider, family?: string, device = false) {
    if (family === undefined) {
      family = randomHex(16);
      this.signedInAt.set(family, this.now());
      this.twoStep.set(family, this.signInTwoStep);
      if (device) this.deviceFamilies.add(family);
    }
    const access = randomHex(32);
    const refresh = randomHex(32);
    this.tokens.set(access, { account, provider, family, expires: this.now() + ACCESS_TOKEN_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { account, provider, family, used: false });
    return json({ access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, account, provider });
  }

  private signIn(url: URL, provider: string): Response {
    if (!SIGN_IN_PROVIDERS.includes(provider)) return problem(404, "not_found", "Unknown provider");
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!isAllowedRedirect(redirect)) return problem(400, "invalid_redirect_uri", "That redirect is not allowed");
    // the web redirect always takes the fragment; the app's scheme may ask for it; a loopback server never sees one
    const mode = url.searchParams.get("response_mode") ?? (redirect === WEB_REDIRECT ? "fragment" : "query");
    const loopback = redirect.startsWith("http://127.0.0.1:");
    if ((mode !== "fragment" && mode !== "query") || (redirect === WEB_REDIRECT && mode !== "fragment") || (loopback && mode !== "query")) {
      return problem(400, "invalid_request", "That response_mode does not go with that redirect");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length === 0) {
      return problem(400, "invalid_request", "Send state and an S256 code_challenge");
    }
    // a link token is spent here, but nothing is linked until its code is redeemed (token)
    const link = url.searchParams.get("link_token");
    const linking = link === null ? undefined : this.linkTokens.get(link);
    if (link !== null) this.linkTokens.delete(link);
    const valid = link === null || (linking !== undefined && linking.provider === provider && this.now() < linking.expires);
    const code = randomHex(32);
    if (valid) this.codes.set(code, { account: this.signIns.get(provider as SignInProvider) ?? `acct_${provider}`, provider: provider as SignInProvider, challenge, redirect, expires: this.now() + SIGNIN_CODE_TTL_MS, link: linking ? { account: linking.account, family: linking.family } : null });
    const back = new URL(redirect);
    const answer = new URLSearchParams(valid ? { code, state } : { error: "invalid_link", state });
    if (mode === "fragment") back.hash = answer.toString();
    else back.search = answer.toString();
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const invalid = (message: string) => problem(400, "invalid_grant", message);
    switch (body.grant_type) {
      case "authorization_code": {
        const code = typeof body.code === "string" ? this.codes.get(body.code) : undefined;
        if (typeof body.code === "string") this.codes.delete(body.code);
        if (!code || this.now() >= code.expires || body.redirect_uri !== code.redirect) return invalid("The code is wrong, spent or expired");
        if (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== code.challenge) return invalid("The code_verifier does not match");
        if (code.link === null) {
          this.addIdentity(code.account, code.provider);
          return this.grant(code.account, code.provider);
        }
        // a link commits only here, redeemed by the very sign-in that asked for it
        const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
        const holder = bearer === undefined ? undefined : this.tokens.get(bearer);
        if (holder === undefined || holder.family !== code.link.family || this.now() >= holder.expires || this.revokedFamilies.has(holder.family)) return invalid("Redeem a link with the sign-in that asked for it");
        if (code.account !== code.link.account && this.identityList.get(code.account)?.has(code.provider)) return problem(409, "identity_in_use", "That identity belongs to another account");
        this.signIns.set(code.provider, code.link.account);
        this.addIdentity(code.link.account, code.provider);
        return this.grant(code.link.account, code.provider);
      }
      case "refresh_token": {
        const refresh = typeof body.refresh_token === "string" ? this.refreshTokens.get(body.refresh_token) : undefined;
        if (!refresh || this.revokedFamilies.has(refresh.family)) return invalid("Sign in again");
        // a refresh token is good once: seeing it again means it leaked, so the whole family goes
        if (refresh.used) { this.revokeFamily(refresh.family); return invalid("Sign in again"); }
        refresh.used = true;
        return this.grant(refresh.account, refresh.provider, refresh.family);
      }
      case "apple_id_token": {
        const apple = typeof body.id_token === "string" ? this.appleTokens.get(body.id_token) : undefined;
        if (typeof body.id_token === "string") this.appleTokens.delete(body.id_token);
        // the app sends its plain nonce; Apple was given its SHA-256 in lowercase hex
        if (!apple || typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 128 || await sha256Hex(body.nonce) !== apple.nonce) return invalid("The identity token is not valid for that nonce");
        return this.grant(apple.account, "apple");
      }
      case "urn:ietf:params:oauth:grant-type:device_code": {
        const entry = typeof body.device_code === "string" ? this.deviceSignIns.get(body.device_code) : undefined;
        if (!entry || this.now() >= entry.expires) return problem(400, "expired_token", "Start the sign-in again");
        // a bound sign-in: refused before anything else, so a poll without the verifier moves nothing
        if (entry.challenge !== null && (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== entry.challenge)) {
          return invalid("That verifier is not this sign-in's");
        }
        if (this.now() < entry.nextPoll) {
          entry.interval += DEVICE_POLL_S;
          entry.nextPoll = this.now() + entry.interval * 1000;
          return problem(400, "slow_down", `Poll every ${entry.interval} seconds`);
        }
        entry.nextPoll = this.now() + entry.interval * 1000;
        if (entry.denied) { this.deviceSignIns.delete(body.device_code as string); return problem(400, "access_denied", "The sign-in was refused at the provider"); }
        if (entry.account === null) return problem(400, "authorization_pending", "Waiting for the sign-in at the provider");
        this.deviceSignIns.delete(body.device_code as string);
        this.addIdentity(entry.account, entry.provider);
        return this.grant(entry.account, entry.provider, undefined, true);
      }
      default: return problem(400, "unsupported_grant_type", "Use authorization_code, refresh_token or apple_id_token");
    }
  }

  /** POST /v1/signout/all: every sign-in of the account ends, codes not yet redeemed included; its PCs and device keys stay. */
  private signOutEverywhere(account: string): void {
    for (const held of [...this.tokens.values()]) if (held.account === account) this.revokeFamily(held.family);
    for (const [token, refresh] of this.refreshTokens) if (refresh.account === account) { this.revokedFamilies.add(refresh.family); this.refreshTokens.delete(token); }
    for (const [family, push] of this.pushes) if (push.account === account) this.pushes.delete(family);
    for (const [token, link] of this.linkTokens) if (link.account === account) this.linkTokens.delete(token);
    for (const [code, held] of this.codes) if (held.account === account) this.codes.delete(code);
    for (const [code, waiting] of this.deviceSignIns) if (waiting.account === account) this.deviceSignIns.delete(code);
  }

  private erase(account: string): void {
    this.signOutEverywhere(account);
    for (const [provider, signsInTo] of this.signIns) if (signsInTo === account) this.signIns.delete(provider);
    for (const key of [...this.mailboxes.keys()]) if (key.endsWith(`\0${account}`)) this.mailboxes.delete(key);
    for (const key of [...this.pcLeaves.keys()]) if (key.endsWith(`\0${account}`)) this.pcLeaves.delete(key);
    for (const key of [...this.counters.keys()]) if (key.endsWith(`:${account}`)) this.counters.delete(key);
    for (const list of [this.admissionList, this.quietList]) for (let index = list.length - 1; index >= 0; index--) if (list[index]?.account === account) list.splice(index, 1);
    this.identityList.delete(account);
    this.directories.delete(account);
    this.accountLimits.delete(account);
    this.deletedAccounts.add(account);
  }

  private revokeFamily(family: string): void {
    this.revokedFamilies.add(family);
    for (const [token, session] of this.tokens) if (session.family === family) this.tokens.delete(token);
  }

  private registry(account: string): Registry {
    const registry = this.registries.get(account) ?? { next: 1, version: 1, methods_version: 0, devices: new Map(), blocks: [], lifts: [], freezes: [] };
    this.registries.set(account, registry);
    return registry;
  }

  /** Device table P18, P21: registers a key for the account (S2-19 adds the route) and returns its `no`. */
  /** The account device key the sign-in behind `token` registers now, as POST /v1/devices would. */
  registerSessionKey(token: string, key: string, label: string): number {
    const session = this.tokens.get(token);
    if (session === undefined) throw new Error("no such token");
    this.keyRegisteredAt.set(session.family, this.now());
    this.keyFamily.set(key, session.family);
    return this.registerDevice(session.account, key, label);
  }

  /**
   * Whether the account was ever used, as the service's first-PC exemption judges it (account#62, NEVER_USED_ADMIT and
   * NEVER_USED_CONFIRM): another PC listed but a device code's listing made under Step 2 that nobody confirmed or admitted
   * (PCL-1: anyone may type a code), a one-press admit or a member's removal ever; then device keys, revoked ones
   * included, but one this sign-in registered itself. For the admit (`kind` "admit") they count only once the account
   * had a confirmed or admitted PC, since a person may sign in on the phone first; for a confirm, always.
   */
  /**
   * Whether a listing is a member of its account, as the service's memberPc (NO_PC_YET's basis): a PC of the account where
   * Step 2 is on now, or one never pending under Step 2. A device code's listing made while Step 2 was off stays one.
   */
  private member(row: FakePc): boolean {
    return !this.opensAll || row.listed_by_device !== true || row.pending_under_step2 !== true;
  }

  /**
   * With `pcAddProofs`, a listing that asks to join: one a device code made while Step 2 was on, never confirmed, admitted
   * (by one press, a confirm or digits) or completed. Ending one cuts nobody off, so any own sign-in may.
   */
  private askingToJoin(row: FakePc): boolean {
    return this.pcAddProofs && this.opensAll && row.listed_by_device === true && row.pending_under_step2 === true && row.admitted_at == null && row.completed_at == null && row.digit_admitted !== true;
  }

  /** Such a listing past its LISTING_ASKS_MS, counted from the sign-in that made it (else from its own listing). */
  private askingExpired(row: FakePc): boolean {
    return this.askingToJoin(row) && this.now() - (row.asking_since ?? Date.parse(row.added_at)) > LISTING_ASKS_MS;
  }

  /** Who is asking, on an unconfirmed PC, as GET and PUT /v1/pcs give it with `pcAddProofs`. */
  private askingView(row: FakePc): Record<string, unknown> {
    if (!this.pcAddProofs || !this.opensAll || row.listed_by_device !== true) return {};
    return {
      asking_os: row.asking?.os ?? null, asking_country: row.asking?.country ?? null, asking_city: row.asking?.city ?? null,
      asking_until: this.askingToJoin(row) ? new Date((row.asking_since ?? Date.parse(row.added_at)) + LISTING_ASKS_MS).toISOString() : null,
    };
  }

  /**
   * The key `proof` proves for an add by `session`, as the service's: null without a proof, or when its signature is not by
   * the key that very sign-in registered (not removed, not frozen), over this purpose, account, PC, listing and challenge.
   * A Response for a malformed proof (400 `invalid_request`), or a challenge that is unknown, spent, past its two minutes or
   * another sign-in's (400 `challenge_invalid`); the challenge is spent whatever comes of it.
   */
  private async provedKey(session: Session, proof: unknown, purpose: PcAddPurpose, serverId: string, listingId: string): Promise<string | null | Response> {
    if (proof === undefined) return null;
    const shaped = keyProofOf(proof);
    if (shaped === null) return problem(400, "invalid_request", "Send key_proof as { challenge_id, signature }");
    const { challenge_id: id, signature } = shaped;
    const held = this.pcAddChallenges.get(id);
    if (held?.family === session.family) this.pcAddChallenges.delete(id);
    if (held === undefined || held.family !== session.family || this.now() > held.expires) return problem(400, "challenge_invalid", "Ask for a new challenge and sign it");
    const registry = this.registries.get(session.account);
    const key = [...this.keyFamily].find(([each, family]) => {
      const device = registry?.devices.get(each);
      return family === session.family && device !== undefined && !device.removed && !this.frozen(registry!, device.no);
    })?.[0];
    if (key === undefined) return null;
    try {
      const publicKey = await crypto.subtle.importKey("spki", new Uint8Array(fromBase64Url(key)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const bytes = pcAddSigningBytes(purpose, session.account, serverId, listingId, id, held.challenge);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, new Uint8Array(fromBase64Url(signature)), bytes) ? key : null;
    } catch {
      return null;
    }
  }

  private everUsed(account: string, serverId: string, family: string, kind: "admit" | "confirm"): boolean {
    const rows = [...(this.directories.get(account)?.values() ?? [])];
    const pending = (row: FakePc): boolean => row.pending_under_step2 === true && row.listed_by_device === true && row.admitted_at == null;
    if (rows.some((row) => row.server_id !== serverId && !pending(row)) || this.usedAccounts.has(account)) return true;
    const keys = [...(this.registries.get(account)?.devices.keys() ?? [])].filter((key) => this.keyFamily.get(key) !== family);
    if (keys.length === 0) return false;
    if (kind === "confirm") return true;
    return rows.some((row) => row.admitted_at != null || (row.server_id !== serverId && row.listed_by_device !== true));
  }

  registerDevice(account: string, key: string, label: string, eligible = true): number {
    const registry = this.registry(account);
    const known = registry.devices.get(key);
    if (known) return known.no;
    const no = registry.next++;
    registry.devices.set(key, { no, label, eligible, removed: false });
    registry.version += 1;
    return no;
  }

  /** Device table T36 (service effect): the key leaves the list and keeps its `no` in `removed`. */
  removeDevice(account: string, key: string): void {
    const device = this.registry(account).devices.get(key);
    if (!device || device.removed) return;
    device.removed = true;
    this.registry(account).version += 1;
  }

  private methodsChanged(account: string): void {
    const registry = this.registry(account);
    registry.methods_version += 1;
    registry.version += 1;
  }

  /** Makes every snapshot id handed out so far answer `snapshot_gone`. */
  dropSnapshots(): void { this.snapshots.clear(); }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  quietAdmissions(): readonly FakeAdmission[] { return this.quietList; }

  mailbox(serverId: string, account: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(box(serverId, account)) ?? []).map(({ record }) => record);
  }

  dropQueuedRecords(serverId: string, account: string, predicate: (record: AccountRecord) => boolean): void {
    const key = box(serverId, account);
    this.mailboxes.set(key, (this.mailboxes.get(key) ?? []).filter(({ record }) => !predicate(record)));
  }

  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      const leaving = /^\/v1\/pcs\/([0-9a-f]{32})\/leave$/.exec(url.pathname)?.[1];
      if (leaving !== undefined && request.method === "POST") return await this.leave(request, leaving);
      if (url.pathname === "/v1/pc-invites/redeem" && request.method === "POST") return await this.redeem(request);
      const provider = /^\/v1\/signin\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (provider !== undefined && request.method === "GET") return this.signIn(url, provider);
      if (url.pathname === "/v1/token" && request.method === "POST") return await this.token(request);
      if (url.pathname === "/v1/providers" && request.method === "GET") return json(this.offered);
      if (url.pathname === "/v1/signin/ovis/device" && request.method === "POST" && (this.offered.device_page ?? []).length > 0) {
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const label = body.label;
        if (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)
          || (label !== undefined && (typeof label !== "string" || label.length < 1 || label.length > 48 || /[\p{Cc}\p{Cs}]/u.test(label)))
          || Object.keys(body).some((name) => !["code_challenge", "code_challenge_method", ...(this.linkPageAcceptsLabelAndOs ? ["label", "os"] : [])].includes(name))) {
          return problem(400, "invalid_request", "Start a sign-in on the link page with an S256 code_challenge, and a label of 1-48 characters if any");
        }
        const deviceCode = randomHex(32);
        const letters = "BCDFGHJKLMNPQRSTVWXZ";
        const pick = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
        const userCode = `${pick()}-${pick()}`;
        this.deviceSignIns.set(deviceCode, { provider: "github", userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + 600_000, challenge: body.code_challenge, page: true, requester: { label: typeof label === "string" ? label : null, os: accountOsOf(body.os) } });
        const page = new URL("/link", url.origin);
        const complete = new URL(page);
        complete.searchParams.set("code", userCode);
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: page.href, verification_uri_complete: complete.href, expires_in: 600, interval: DEVICE_POLL_S, code_challenge_method: "S256" });
      }
      const deviceProvider = /^\/v1\/signin\/([a-z]+)\/device$/.exec(url.pathname)?.[1];
      if (deviceProvider !== undefined && DEVICE_PAGES[deviceProvider] !== undefined && request.method === "POST") {
        const text = await request.text();
        const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
        // a device code can be phished (RFC 8628): it signs in, but never adds a method to an account
        if ("link_token" in body) return problem(400, "invalid_request", "Add a sign-in method through a redirect sign-in");
        const bound = Object.keys(body).length > 0;
        if (bound && (body.code_challenge_method !== "S256" || typeof body.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge) || Object.keys(body).length !== 2)) {
          return problem(400, "invalid_request", "Start a device sign-in with nothing, or an S256 code_challenge");
        }
        const deviceCode = randomHex(32);
        const userCode = `${randomHex(2).toUpperCase()}-${randomHex(2).toUpperCase()}`;
        this.deviceSignIns.set(deviceCode, { provider: deviceProvider as SignInProvider, userCode, account: null, denied: false, interval: DEVICE_POLL_S, nextPoll: this.now(), expires: this.now() + DEVICE_CODE_TTL_S * 1000, challenge: bound ? body.code_challenge as string : null });
        return json({ device_code: deviceCode, user_code: userCode, verification_uri: DEVICE_PAGES[deviceProvider], expires_in: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_S, ...(bound ? { code_challenge_method: "S256" } : {}) });
      }
      if (url.pathname === "/v1/push/key" && request.method === "GET") return json({ public_key: "BFakeVapidPublicKeyForTests" });
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family)) return problem(401, "unauthorized", "Sign in again");
    const account = session.account;
    if (!this.withinRateLimit(`requests:${account}`, ACCOUNT_REQUESTS_PER_WINDOW)) return problem(429, "rate_limited", "Too many requests; try again later");
    if (path === "/v1/signout" && request.method === "POST") {
      this.revokeFamily(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "PUT") {
      const body = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      if (typeof body.endpoint !== "string" || !URL.canParse(body.endpoint) || typeof body.keys?.p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(body.keys.p256dh)
        || typeof body.keys.auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.keys.auth)) return problem(400, "invalid_endpoint", "Send the subscription's endpoint and keys");
      this.pushes.set(session.family, { account, endpoint: body.endpoint });
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/push" && request.method === "DELETE") {
      this.pushes.delete(session.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities" && request.method === "GET") {
      return json({ identities: [...this.identityList.get(account) ?? []].map(([provider, { added_at }]) => ({ provider, added_at })) });
    }
    if (path === "/v1/account/limits" && request.method === "GET") {
      const limits = this.accountLimits.get(account);
      return limits ? json(limits) : problem(404, "not_found", "Unknown request");
    }
    const recent = this.now() - (this.signedInAt.get(session.family) ?? Number.NEGATIVE_INFINITY) <= REAUTH_MS;
    if ((path === "/v1/identities/link" && request.method === "POST") || (path.startsWith("/v1/identities/") && request.method === "DELETE")) {
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
    }
    if (path === "/v1/signout/all" && request.method === "POST") {
      // as deleting the account: a device code's sign-in never signs the account's owner out, and only a recent one does
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      this.ring(account, session.family);
      this.signOutEverywhere(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/account" && request.method === "DELETE") {
      // a device code can be typed for someone else's PC: its sign-in must not end the account
      if (this.deviceFamilies.has(session.family)) return problem(403, "web_sign_in_required", "Sign in on this device first");
      if (!recent) return problem(403, "reauth_required", "Sign in again first");
      if (this.subscribed.has(account)) return problem(409, "subscription_active", "Cancel the subscription in the billing portal first");
      this.erase(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/identities/link" && request.method === "POST") {
      const body = await request.json() as { provider?: unknown };
      if (typeof body.provider !== "string" || !this.offered.providers.includes(body.provider as SignInProvider)) return problem(400, "invalid_provider", "Name a provider this service offers");
      if (this.identityList.get(account)?.has(body.provider as SignInProvider)) return problem(409, "identity_exists", "The account already signs in with it");
      const token = randomHex(32);
      this.linkTokens.set(token, { account, family: session.family, provider: body.provider as SignInProvider, expires: this.now() + LINK_TOKEN_TTL_S * 1000 });
      return json({ link_token: token, expires_in: LINK_TOKEN_TTL_S });
    }
    const removed = /^\/v1\/identities\/([a-z]+)$/.exec(path)?.[1] as SignInProvider | undefined;
    if (removed !== undefined && request.method === "DELETE") {
      const methods = this.identityList.get(account);
      if (!methods?.has(removed)) return problem(404, "not_found", "The account does not sign in with it");
      if (methods.size === 1) return problem(409, "last_identity", "Add another way to sign in first");
      methods.delete(removed);
      this.methodsChanged(account);
      if (this.signIns.get(removed) === account) this.signIns.delete(removed);
      // the sign-ins made with it end
      for (const held of [...this.tokens.values()]) if (held.account === account && held.provider === removed) this.revokeFamily(held.family);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/pc-invites" || path.startsWith("/v1/pc-invites/")) return await this.inviteRoute(request, path, session, recent);
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    if (path === "/v1/session" && request.method === "GET") {
      return json({ account, own_sign_in: !this.deviceFamilies.has(session.family), signed_in_at: new Date(this.signedInAt.get(session.family) ?? this.now()).toISOString() });
    }
    if (path === "/v1/pcs" && request.method === "GET") {
      // PCL-1: while step 2 is on, a PC listed by a device code and not confirmed only for `?include=unconfirmed`
      const unconfirmed = new URL(request.url).searchParams.get("include") === "unconfirmed";
      // null while step 2 is off for the account, and once passed
      const keyAt = this.keyRegisteredAt.get(session.family);
      return json({ pcs: [...directory.values()].filter((entry) => unconfirmed || !this.opensAll || entry.listed_by_device !== true).map((row) => {
        const { exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, asking_since: _since, asking: _asking, ...entry } = row;
        return {
          ...entry,
          unconfirmed: this.opensAll && listed_by_device === true,
          ...this.askingView(row),
          new_until: this.opensAll && entry.new_until != null && Date.parse(entry.new_until) > this.now() ? entry.new_until : null,
          admitted_at: this.opensAll ? entry.admitted_at ?? null : null,
          // the one admit no device was told about: shown to a device whose own key came after it
          admitted_before_you: this.opensAll && exempt === true && keyAt !== undefined && entry.admitted_at != null && Date.parse(entry.admitted_at) < keyAt,
        };
      }) });
    }
    if (path === "/v1/pcs/challenge" && request.method === "POST" && this.pcAddProofs && this.opensAll) {
      // a challenge for one key proof (pcAddSigningBytes), for an app's own sign-in only, spent by its first use
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in on this device first");
      const text = await request.text();
      const body: unknown = text.trim() === "" ? {} : JSON.parse(text);
      if (typeof body !== "object" || body === null || Object.keys(body).length > 0) return problem(400, "invalid_request", "Send {}");
      const id = randomHex(16);
      const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      this.pcAddChallenges.set(id, { family: session.family, challenge, expires: this.now() + PC_ADD_CHALLENGE_TTL_MS });
      return json({ challenge_id: id, challenge, expires_in: PC_ADD_CHALLENGE_TTL_MS / 1000 });
    }
    const admitted = /^\/v1\/pcs\/([0-9a-f]{32})\/admit$/.exec(path)?.[1];
    if (admitted !== undefined && request.method === "POST" && this.opensAll) {
      // the body is `{}`, or with `pcAddProofs` `{ key_proof }`: anything else is refused before the sign-in is looked at
      const text = await request.text();
      const body = (text.trim() === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Object.keys(body).some((name) => !(this.pcAddProofs && name === "key_proof"))) return problem(400, "invalid_request", "Send {} or { key_proof }");
      // C1: an app's own sign-in, made within REAUTH_MS, or older with a proof by its own key for this PC's current listing
      if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
      const signed = directory.get(admitted)?.listing_id ?? "";
      const proved = await this.provedKey(session, body.key_proof, "admit", admitted, signed);
      if (proved instanceof Response) return proved;
      if (!recent && proved === null) return problem(403, "session_not_fresh", "Sign in again on this device first");
      // as the service binds the signed listing into its write: one replaced while the proof was checked is not admitted
      if (proved !== null && (directory.get(admitted)?.listing_id ?? "") !== signed) return problem(409, "listing_changed", "This add is no longer waiting for that action");
      // the first-PC exemption: an account never used (no other PC, no admit or removal, no device key ever) waives two-step
      const exempt = this.twoStep.get(session.family) !== true;
      const entry = directory.get(admitted);
      const open = this.pcAdmissions.get(box(admitted, account));
      // a retry of this same sign-in's own admission, still open, gets the same answer: no second exemption is granted
      const retry = entry !== undefined && open !== undefined && !open.taken && open.family === session.family && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null;
      if (this.admitAsksTwoStep && exempt && !retry && this.everUsed(account, admitted, session.family, "admit")) return problem(403, "two_step_required", "Set up two-step sign-in first");
      if (entry === undefined) return problem(400, "unknown_pc", "List PCs of this account only");
      if (this.askingExpired(entry)) return problem(409, "listing_expired", "This PC asked to join more than ten minutes ago; start adding it again on the PC");
      if (this.cardExpired(admitted, account, entry)) return problem(409, "listing_expired", "This PC's card ran out; a new invite opens it again");
      if (open !== undefined && !open.taken && this.now() - open.at <= ADMISSION_TTL_MS && entry.new_until != null) {
        return json({ server_id: admitted, account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until });
      }
      // C4: the account's one-press adds of the last day
      const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
      if (times.length >= PC_ADMITS_PER_DAY) {
        const capped = problem(429, "pc_add_cap", "This account added enough PCs today");
        capped.headers.set("retry-after", String(Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000)));
        return capped;
      }
      this.admitTimes.set(account, [...times, this.now()]);
      // one instant for the admission, its directory entry and this answer: a retry answers the same
      const at = this.now();
      this.pcAdmissions.set(box(admitted, account), { at, taken: false, family: session.family, ...(entry.listing_id === undefined ? {} : { listing: entry.listing_id }) });
      this.usedAccounts.add(account);
      entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = exempt;
      entry.listed_by_device = false;
      this.ring(account, session.family);
      return json({ server_id: admitted, account, admitted_at: new Date(at).toISOString(), new_until: entry.new_until });
    }
    const pc = /^\/v1\/pcs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (pc !== undefined && request.method === "PUT") {
      const body = await request.json() as { label?: unknown; public_key?: unknown; relay?: unknown; confirm?: unknown; listing_id?: unknown; challenge_id?: unknown; proof?: unknown; key_proof?: unknown; os?: unknown };
      // PCL-1: only an app's own sign-in may say "this is my PC"; a device code can be typed for someone else's PC
      const own = !this.deviceFamilies.has(session.family);
      const confirm = body.confirm === true;
      // account#67: a confirm names the listing its card showed, and only a confirm does
      const named = body.listing_id !== undefined;
      if (named && (!confirm || typeof body.listing_id !== "string" || !LISTING_ID.test(body.listing_id))) return problem(400, "invalid_request", "Name a listing only to confirm it");
      if (confirm && !own) return problem(403, "own_sign_in_required", "Sign in on this device to confirm the PC");
      if (typeof body.label !== "string" || body.label.length < 1 || body.label.length > 48) return problem(400, "invalid_label", "Name the PC");
      // the key is stored, but it cannot be forged: it must give this server_id
      const key = proofKey(body.public_key);
      if (!key || deriveServerId(key) !== pc) return problem(400, "server_key_mismatch", "That key does not give that server_id");
      if (typeof body.relay !== "string" || !isWssOrigin(body.relay)) return problem(400, "invalid_relay", "Give the relay's wss origin");
      // the PC's own proof of this server_id, sent beside the entry when the PC itself lists it: it lists it again after its leave
      const proven = body.challenge_id !== undefined || body.proof !== undefined;
      if (proven && !this.takeProof({ server_id: pc, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      // with `pcAddProofs` an own sign-in adds a PC only from the last ten minutes, or older with a proof by its own key: a
      // confirm, and where Step 2 is on a PUT that lists a PC the account does not list yet. Upkeep of a listed PC and a device
      // code's listing ask nothing of the sign-in, and read no proof. The service before ignores `key_proof`
      if (this.pcAddProofs && body.key_proof !== undefined && keyProofOf(body.key_proof) === null) return problem(400, "invalid_request", "Send key_proof as { challenge_id, signature }");
      if (this.pcAddProofs && own && (confirm || (this.opensAll && !directory.has(pc)))) {
        const listing = named ? body.listing_id as string : directory.get(pc)?.listing_id ?? "";
        const proved = await this.provedKey(session, body.key_proof, confirm ? "confirm" : "list", pc, listing);
        if (proved instanceof Response) return proved;
        const enforced = confirm || this.listProofRequired || body.key_proof !== undefined;
        if (!recent && proved === null && enforced) return problem(403, "session_not_fresh", "Sign in again on this device first");
      }
      // PCL-4: a confirm asks what the one-press admit asks of the sign-in: fresh (or proved, above), and two-step set unless the
      // account was never used; and a listing that asks to join is confirmed only within its ten minutes
      if (confirm) {
        if (!this.pcAddProofs && !recent) return problem(403, "session_not_fresh", "Sign in again on this device first");
        if (this.twoStep.get(session.family) !== true && this.everUsed(account, pc, session.family, "confirm")) return problem(403, "two_step_required", "Two-step sign-in must be on for one press; add this PC with the number");
        const listed = directory.get(pc);
        if (listed !== undefined && this.askingExpired(listed)) return problem(409, "listing_expired", "This PC asked to join more than ten minutes ago; start adding it again on the PC");
      }
      const fresh = !directory.has(pc);
      const leftAt = this.pcLeaves.get(box(pc, account));
      if (fresh && !proven && leftAt !== undefined && this.now() - leftAt < PC_LEFT_MS) {
        return json({ error: { left_at: new Date(leftAt).toISOString(), code: "pc_left", message: "This PC left the account; sign in on the PC to add it again" } }, 409);
      }
      if (fresh && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
      // a re-PUT (the nine-minute relist) keeps the PC's admission and its confirmation mark
      const before = directory.get(pc);
      // a named confirm acts only on that listing, still the PC's current one and still unconfirmed, and writes the confirm alone
      if (named && (before === undefined || before.listing_id !== body.listing_id || before.listed_by_device !== true)) {
        return problem(409, "listing_changed", "This add is no longer waiting for that action");
      }
      const confirming = confirm && before?.listed_by_device === true;
      const entry: FakePc = { server_id: pc, ...(named ? { label: before!.label, public_key: before!.public_key, relay: before!.relay } : { label: body.label, public_key: body.public_key as string, relay: body.relay }), added_at: before?.added_at ?? this.iso(), last_seen_at: before?.last_seen_at ?? null,
        ...(before?.new_until == null ? {} : { new_until: before.new_until, admitted_at: before.admitted_at ?? null, exempt: before.exempt ?? false }),
        listed_by_device: before === undefined ? !own : before.listed_by_device === true && !confirming,
        pending_under_step2: before === undefined ? !own && this.opensAll : before.pending_under_step2 === true,
        ...(before === undefined ? { listed_by_session: session.family } : before.listed_by_session === undefined ? {} : { listed_by_session: before.listed_by_session }),
        ...(this.completions ? { listing_id: before?.listing_id ?? randomHex(16), completed_at: before?.completed_at ?? null } : {}),
        // a listing that asks to join keeps, from its own listing on, when its sign-in was made and who asked; a confirm clears who
        ...(before === undefined
          ? !own && this.opensAll && this.pcAddProofs ? { asking_since: this.signedInAt.get(session.family) ?? this.now(), asking: { os: accountOsOf(body.os), ...this.requestPlace } } : {}
          : { ...(before.asking_since === undefined ? {} : { asking_since: before.asking_since }), ...(before.asking === undefined || confirming ? {} : { asking: before.asking }) }) };
      // a confirm makes the PC one the account's devices open, as the admit does: new to them for PC_NEW_MS (C3). It
      // writes no admission: the row it confirms is what makes the account used from then on
      if (confirming) {
        entry.admitted_at = this.iso();
        entry.new_until = new Date(this.now() + PC_NEW_MS).toISOString();
      }
      directory.set(pc, entry);
      if (proven) this.pcLeaves.delete(box(pc, account));
      if (fresh || confirming) this.ring(account, session.family);
      const { exempt: _exempt, listed_by_device, pending_under_step2: _pending, listed_by_session: _lister, digit_admitted: _digits, asking_since: _since, asking: _asking, ...shown } = entry;
      return json({ pc: { ...shown, unconfirmed: this.opensAll && listed_by_device === true, ...this.askingView(entry) } });
    }
    if (pc !== undefined && request.method === "DELETE") {
      // account#67: a Decline names the listing its card showed; after the sign-in checks, it removes only that listing while
      // it still asks to join (not admitted by one press, a confirm or digits, and not completed)
      const named = new URL(request.url).searchParams.get("listing_id");
      if (named !== null && !LISTING_ID.test(named)) return problem(400, "invalid_request", "That is no listing ID");
      const listed = directory.get(pc);
      const changed = named !== null && (listed === undefined || listed.listing_id !== named || listed.admitted_at != null || listed.digit_admitted === true || listed.completed_at != null);
      // PCR-1: removing unbinds the PC and cuts the account's devices off it, so it asks what deleting the account asks. The
      // compat ruling's one exception: a device code's sign-in ends its own listing (written by it, never confirmed, admitted
      // or completed), as an installed CLI renews its card
      if (this.deviceFamilies.has(session.family)) {
        const own = directory.get(pc);
        // as the service: written by this sign-in, never confirmed, admitted (one press or digits) or completed
        if (own === undefined || own.listed_by_session !== session.family || own.listed_by_device !== true || own.admitted_at != null
          || own.completed_at != null || own.digit_admitted === true) {
          return problem(403, "own_sign_in_required", "Sign in on this device to remove a PC");
        }
        if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
        directory.delete(pc);
        // ruling (b): a member's end is a member's removal (the account is used); a listing pending under Step 2 was never one
        if (this.member(own)) this.usedAccounts.add(account);
        return new Response(null, { status: 204 });
      }
      // with `pcAddProofs` an own sign-in of any age ends a listing that still asks to join: it cuts nobody off, so saying No
      // is never harder than Add
      if (!recent && !(listed !== undefined && this.askingToJoin(listed))) return problem(403, "reauth_required", "Sign in again first");
      if (changed) return problem(409, "listing_changed", "This PC no longer asks to join by that listing");
      const removed = directory.get(pc);
      directory.delete(pc);
      this.pcAdmissions.delete(box(pc, account));
      // PCL-1: ending a listing that was never the account's (unconfirmed under Step 2) is no member's removal
      if (removed !== undefined && this.member(removed)) this.usedAccounts.add(account);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/records" && request.method === "POST") {
      const body = await request.json() as { server_ids?: unknown; record?: unknown };
      if (!Array.isArray(body.server_ids) || body.server_ids.length > ACCOUNT_RECORDS_MAX || !body.server_ids.every((id) => typeof id === "string" && directory.has(id))) {
        return problem(400, "unknown_pc", "List PCs of this account only");
      }
      const record = await readAccountRecord(body.record);
      if (!record) return problem(400, "signature_invalid", "The signature does not hold");
      if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
      const targets = [...new Set(body.server_ids as string[])];
      this.expire();
      if (targets.some((id) => (this.mailboxes.get(box(id, account))?.length ?? 0) >= MAILBOX_MAX)) return problem(429, "mailbox_full", "That PC has not collected its records");
      for (const id of targets) {
        const queue = this.mailboxes.get(box(id, account)) ?? [];
        queue.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(box(id, account), queue);
      }
      return json({ queued: new Set(body.server_ids).size });
    }
    if (path === "/v1/safety-records" && request.method === "POST" && this.opensAll) return await this.safetyRecord(account, await request.json());
    if (path === "/v1/admissions" && request.method === "GET") {
      // what the approving client checks the key PC X shows it against, before it signs an add
      const admissions = this.admissionList
        .filter((a) => a.account === account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, server_id, at, os, country, city }) => ({ key, label, server_id, at, os, country, city }));
      return json({ admissions });
    }
    if (path === "/v1/admissions" && request.method === "POST") {
      const body = await request.json() as { server_id?: unknown; label?: unknown; key?: unknown; os?: unknown; quiet?: unknown };
      if (body.quiet !== undefined && typeof body.quiet !== "boolean") return problem(400, "invalid_request", "quiet is true or false");
      if (typeof body.server_id !== "string" || !directory.has(body.server_id) || typeof body.label !== "string") return problem(400, "unknown_pc", "List PCs of this account only");
      if (!isAccountKeyEncoding(body.key)) return problem(400, "invalid_key", "Name the waiting device's account key");
      // quiet only for an app's own sign-in: one a typed device code opened gets the ordinary kind
      const quiet = body.quiet === true && !this.deviceFamilies.has(session.family);
      if (!this.withinRateLimit(quiet ? `quiet_admissions:${account}` : `admissions:${account}`, quiet ? QUIET_ADMISSIONS_PER_WINDOW : ADMISSIONS_PER_WINDOW)) return problem(429, "too_many_admissions", "Too many requests; try again later");
      const admission = { id: randomHex(16), server_id: body.server_id, account, label: body.label, key: body.key, at: this.iso(), os: accountOsOf(body.os), ...this.requestPlace };
      (quiet ? this.quietList : this.admissionList).push(admission);
      if (!quiet) this.ring(account, session.family);
      return json({ id: admission.id });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /** Spends the challenge `body` names and says whether `body.proof` answers it for `body.server_id`. */
  private takeProof(body: { server_id: unknown; challenge_id: unknown; proof: unknown }): { server_id: string } | null {
    const challenge = typeof body.challenge_id === "string" ? this.challenges.get(body.challenge_id) : undefined;
    if (typeof body.challenge_id === "string") this.challenges.delete(body.challenge_id);
    if (!challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) return null;
    return { server_id: challenge.server_id };
  }

  /** A plain invite's listing that nobody admitted within its card's ten minutes: Add is no longer offered for it. */
  private cardExpired(serverId: string, account: string, entry: FakePc): boolean {
    const card = this.inviteCards.get(box(serverId, account));
    return card !== undefined && entry.listing_id === card.listing && entry.new_until == null && this.now() > card.until;
  }

  /**
   * POST, GET /v1/pc-invites and DELETE /v1/pc-invites/{id}: an own sign-in's. The fake holds no key-proof challenges
   * (POST /v1/pcs/challenge), so a stale sign-in makes no invite here, `key_proof` or not.
   */
  private async inviteRoute(request: Request, path: string, session: Session, recent: boolean): Promise<Response> {
    const account = session.account;
    if (!this.pcInvites) return problem(404, "not_found", "Unknown request");
    if (this.deviceFamilies.has(session.family)) return problem(403, "own_sign_in_required", "Sign in in the app itself");
    const now = this.now();
    const open = (invite: FakeInvite) => invite.used === null && !invite.revoked && !this.revokedFamilies.has(invite.family) && now - invite.madeAt < PC_INVITE_TTL_MS;
    if (path === "/v1/pc-invites" && request.method === "POST") {
      let body: unknown;
      try { body = JSON.parse(await request.text()); } catch { return problem(400, "invalid_request", "Send a JSON object"); }
      const made = body as { invite_key?: unknown; auto?: unknown; key_proof?: unknown };
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((name) => !["invite_key", "auto", "key_proof"].includes(name))
        || (made.auto !== undefined && typeof made.auto !== "boolean")
        || typeof made.invite_key !== "string" || !isListKeyEncoding(made.invite_key) || !isListPoint(made.invite_key)) return problem(400, "invalid_request", "Send the invite's public key, and auto and key_proof only");
      if ((body as { key_proof?: unknown }).key_proof !== undefined) return problem(400, "challenge_invalid", "Ask for a new challenge and answer it");
      if (!recent) return problem(403, "session_not_fresh", "Sign in again on this device first");
      if (!this.withinRateLimit(`invites:${account}`, INVITES_PER_WINDOW)) return limited("rate_limited", 60);
      if ([...this.invites.values()].filter((invite) => invite.account === account && open(invite)).length >= INVITES_OPEN_MAX) return problem(409, "invites_full", "Revoke an open invite first");
      // an auto invite would be refused at its redeem: it is refused here, while the person who makes it is there to read why
      const times = (this.admitTimes.get(account) ?? []).filter((at) => now - at < PC_NEW_MS);
      if (made.auto === true && times.length >= PC_ADMITS_PER_DAY) return limited("pc_add_cap", Math.ceil((times[0]! + PC_NEW_MS - now) / 1000));
      // a key is an invite once, of any account, open or not
      if ([...this.invites.values()].some((invite) => invite.key === made.invite_key)) return problem(409, "invite_key_used", "Make a new key for a new invite");
      const invite: FakeInvite = { id: randomHex(16), account, key: made.invite_key, auto: made.auto === true, family: session.family, madeAt: now, revoked: false, used: null };
      this.invites.set(invite.id, invite);
      return json({ id: invite.id, account, expires_at: new Date(now + PC_INVITE_TTL_MS).toISOString(), auto: invite.auto });
    }
    if (path === "/v1/pc-invites" && request.method === "GET") {
      const maker = (family: string) => {
        const key = [...this.keyFamily].find(([, of]) => of === family)?.[0];
        const device = key === undefined ? undefined : this.registries.get(account)?.devices.get(key);
        return { device_no: device?.no ?? null, device_label: device?.label ?? null };
      };
      return json({ invites: [...this.invites.values()].filter((invite) => invite.account === account && (open(invite) || (invite.used !== null && now - invite.used.at < INVITE_USED_SHOWN_MS)))
        .map((invite) => ({
          id: invite.id, made_at: new Date(invite.madeAt).toISOString(), expires_at: new Date(invite.madeAt + PC_INVITE_TTL_MS).toISOString(), auto: invite.auto,
          ...maker(invite.family), yours: invite.family === session.family, used_at: invite.used === null ? null : new Date(invite.used.at).toISOString(),
          used_by: invite.used === null ? null : { server_id: invite.used.server_id, listing_id: invite.used.listing_id, label: invite.used.label, os: invite.used.os, country: invite.used.country, city: invite.used.city },
        })) });
    }
    const id = /^\/v1\/pc-invites\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (id !== undefined && request.method === "DELETE") {
      const invite = this.invites.get(id);
      if (invite === undefined || invite.account !== account) return problem(404, "not_found", "No such invite");
      if (invite.used !== null) return problem(409, "invite_used", "A PC used this invite; remove that PC instead");
      invite.revoked = true;
      return new Response(null, { status: 204 });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * POST /v1/pc-invites/redeem: a PC, with no sign-in, lists itself in the invite's account on its own key's proof. One
   * body for every dead or malformed invite. A plain invite's listing waits for Add on its card for ten minutes; an auto
   * invite's is admitted at once, within the account's daily one-press cap. The same PC and key asking again while its
   * listing is current get the same answer.
   */
  private async redeem(request: Request): Promise<Response> {
    if (!this.pcInvites) return problem(404, "not_found", "Unknown request");
    let body: Record<string, unknown>;
    try { body = JSON.parse(await request.text()) as Record<string, unknown>; } catch { return problem(400, "invalid_request", "Send a JSON object"); }
    const strings = ["invite_key", "invite_signature", "server_id", "public_key", "relay", "label", "challenge_id", "proof"];
    if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((name) => name !== "os" && !strings.includes(name))
      || strings.some((name) => typeof body[name] !== "string") || (body.os !== undefined && accountOsOf(body.os) === null) || !/^[0-9a-f]{32}$/.test(body.server_id as string)) {
      return problem(400, "invalid_request", "Send the invite's key and signature, this PC's listing and its proof");
    }
    const serverId = body.server_id as string;
    const publicKey = body.public_key as string;
    const label = body.label as string;
    if (!this.withinRateLimit(`redeems:${serverId}`, REDEEMS_PER_WINDOW)) return limited("rate_limited", 60);
    const key = proofKey(publicKey);
    if (!key || deriveServerId(key) !== serverId) return problem(400, "server_key_mismatch", "That key does not give that server_id");
    if (!isWssOrigin(body.relay as string)) return problem(400, "invalid_relay", "Give the relay's wss origin");
    if (label.length < 1 || label.length > 48 || /\p{Cc}/u.test(label)) return problem(400, "invalid_label", "Name the PC in 1-48 characters");
    if (!this.takeProof({ server_id: serverId, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const dead = problem(400, "invite_invalid", "This invite does not work");
    const invite = [...this.invites.values()].find((held) => held.key === body.invite_key);
    if (invite === undefined || invite.revoked || this.now() - invite.madeAt >= PC_INVITE_TTL_MS || this.deletedAccounts.has(invite.account)) return dead;
    // an invite lives with the sign-in that made it: once that ends, an unused one redeems nothing (a used one still answers its PC)
    const makerGone = this.revokedFamilies.has(invite.family);
    if (invite.used === null && makerGone) return dead;
    // held by whoever holds the line: its private key signed for this account, this PC and this challenge (the account from the row, never the request)
    if (!await verifyInviteRedeem({ account: invite.account, server_id: serverId, public_key: publicKey, challenge_id: body.challenge_id as string }, body.invite_signature, invite.key)) return dead;
    const account = invite.account;
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    const before = directory.get(serverId);
    if (invite.used !== null) {
      const same = invite.used.server_id === serverId && invite.used.public_key === publicKey && before?.listing_id === invite.used.listing_id;
      return same ? json(redeemed(account, invite.used.listing_id, invite.auto, invite.used.at, makerGone)) : dead;
    }
    if (before === undefined && directory.size >= DIRECTORY_MAX) return problem(409, "directory_full", "Remove a PC first");
    const times = (this.admitTimes.get(account) ?? []).filter((at) => this.now() - at < PC_NEW_MS);
    // the invite stays open: the cap is the account's, not the invite's
    if (invite.auto && times.length >= PC_ADMITS_PER_DAY) return limited("pc_add_cap", Math.ceil((times[0]! + PC_NEW_MS - this.now()) / 1000));
    const at = this.now();
    const listing = randomHex(16);
    const entry: FakePc = { server_id: serverId, label, public_key: publicKey, relay: body.relay as string, added_at: new Date(at).toISOString(), last_seen_at: before?.last_seen_at ?? null,
      listed_by_device: !invite.auto, pending_under_step2: this.opensAll && !invite.auto, listed_by_session: invite.family, listing_id: listing, completed_at: null };
    const place = box(serverId, account);
    this.pcAdmissions.delete(place);
    this.inviteCards.delete(place);
    if (invite.auto) {
      this.admitTimes.set(account, [...times, at]);
      // the maker's session's, as a one-press admit's: it ends with that sign-in (the listing stays confirmed)
      this.pcAdmissions.set(place, { at, taken: false, family: invite.family, listing });
      this.usedAccounts.add(account);
      entry.new_until = new Date(at + PC_NEW_MS).toISOString();
      entry.admitted_at = new Date(at).toISOString();
      entry.exempt = false;
    } else this.inviteCards.set(place, { until: at + ADMISSION_TTL_MS, listing });
    directory.set(serverId, entry);
    this.pcLeaves.delete(place);
    invite.used = { at, server_id: serverId, public_key: publicKey, listing_id: listing, label, os: accountOsOf(body.os), ...this.requestPlace };
    this.ring(account, "");
    return json(redeemed(account, listing, invite.auto, at));
  }

  /**
   * The PC leaves an account by its own proof, with no bearer (`ovis logout`, account#65): as a DELETE /v1/pcs does, the
   * listing and its untaken admission end; its mailbox and admissions for the account go; and for PC_LEFT_MS a PUT
   * lists it again only with the PC's own proof. 204 whether or not the account listed it.
   */
  private async leave(request: Request, serverId: string): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    if (body.server_id !== serverId || typeof body.account !== "string" || body.challenge_id === undefined || body.proof === undefined) {
      return problem(400, "invalid_request", "Name this PC and the account it leaves");
    }
    if (!this.takeProof({ server_id: serverId, challenge_id: body.challenge_id, proof: body.proof })) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
    const account = body.account;
    const key = box(serverId, account);
    const directory = this.directories.get(account);
    const removed = directory?.get(serverId);
    directory?.delete(serverId);
    this.pcAdmissions.delete(key);
    this.mailboxes.delete(key);
    for (const list of [this.admissionList, this.quietList]) {
      for (let index = list.length - 1; index >= 0; index--) if (list[index]!.server_id === serverId && list[index]!.account === account) list.splice(index, 1);
    }
    if (!this.deletedAccounts.has(account)) this.pcLeaves.set(key, this.now());
    if (removed !== undefined) {
      if (!(this.opensAll && removed.listed_by_device === true)) this.usedAccounts.add(account);
      this.ring(account, "");
    }
    return new Response(null, { status: 204 });
  }

  private async pc(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") return problem(404, "not_found", "Unknown request");
    const body = await request.json() as Record<string, unknown>;
    if (path === "/v1/pc/challenge") {
      const key = proofKey(body.public_key);
      if (!key || typeof body.server_id !== "string" || deriveServerId(key) !== body.server_id) return problem(401, "server_key_mismatch", "That key does not give that server_id");
      const challengeId = randomHex(16);
      // a completion's proof is scoped to its account and listing: its context is not a wire nonce (account#57)
      const scope = this.completions ? completionScope(body.completion) : null;
      if (body.completion !== undefined && scope === null) return problem(400, "invalid_body", "Name the account and listing");
      const context = scope ? completionKey(scope, challengeId) : challengeId;
      const { expected, frame } = serverChallenge(key, { server_id: body.server_id, role: "account", connection_id: context });
      this.challenges.set(context, { server_id: body.server_id, expected, expires: this.now() + CHALLENGE_TTL_MS });
      return json({ challenge_id: challengeId, frame });
    }
    if (path === "/v1/pc/complete" && this.completions) {
      const scope = completionScope({ account: body.account, listing_id: body.listing_id });
      const context = scope && typeof body.challenge_id === "string" ? completionKey(scope, body.challenge_id) : null;
      const challenge = context === null ? undefined : this.challenges.get(context);
      if (context !== null) this.challenges.delete(context);
      if (!scope || !challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) {
        return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      }
      const entry = this.directories.get(scope.account)?.get(challenge.server_id);
      // the listing still current, and its own evidence: an admission of it taken (or a completion already stamped)
      const taken = this.pcAdmissions.get(box(challenge.server_id, scope.account))?.taken === true;
      if (entry?.listing_id !== scope.listing_id || (entry.completed_at == null && !taken)) return problem(409, "listing_changed", "This add is no longer waiting for that action");
      entry.completed_at ??= this.iso();
      return json({ completed_at: entry.completed_at });
    }
    if (path === "/v1/pc/mailbox" || (path === "/v1/pc/admission" && this.opensAll)
      || (path === "/v1/pc/snapshot" && (this.opensAll || this.reportsStep2Off))) {
      const challenge = this.takeProof({ server_id: body.server_id, challenge_id: body.challenge_id, proof: body.proof });
      if (!challenge) return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      if (typeof body.account !== "string") return problem(400, "invalid_account", "Name the account this PC belongs to");
      if (path === "/v1/pc/admission") {
        // G1: only the named account's own admission, while that account lists the PC; any other account's is invisible
        const open = this.pcAdmissions.get(box(challenge.server_id, body.account));
        const entry = this.directories.get(body.account)?.get(challenge.server_id);
        // retry-safe for 10 minutes, inclusive; it ends with the sign-in that made it
        if (open === undefined || this.now() - open.at > ADMISSION_TTL_MS || this.revokedFamilies.has(open.family) || entry?.new_until == null) {
          return entry !== undefined && this.cardExpired(challenge.server_id, body.account, entry)
            ? problem(409, "listing_expired", "This PC's card ran out; a new invite opens it again")
            : problem(404, "no_admission", "No account added this PC in one press");
        }
        open.taken = true;
        return json({ account: body.account, admitted_at: new Date(open.at).toISOString(), new_until: entry.new_until,
          ...(this.completions && body.with_listing_id === true ? { listing_id: entry.listing_id ?? null } : {}) });
      }
      if (path === "/v1/pc/snapshot") {
        // P6: only a PC the account lists reads the account's devices and records
        if (!this.opensAll) return this.directories.get(body.account)?.has(challenge.server_id) === true
          ? problem(404, "step2_off", "Step 2 is off for this account")
          : problem(404, "not_found", "Unknown request");
        if (this.directories.get(body.account)?.has(challenge.server_id) !== true) return problem(403, "not_listed", "This PC is not one of the account's");
        return this.snapshotPage(challenge.server_id, body.account, body.snapshot, body.page);
      }
      this.expire();
      const key = box(challenge.server_id, body.account);
      const queue = this.mailboxes.get(key) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? queue : queue.filter(({ seq }) => seq > ack);
      this.mailboxes.set(key, rest);
      // only the account the PC says it belongs to learns that it came by
      const entry = this.directories.get(body.account)?.get(challenge.server_id);
      if (entry) entry.last_seen_at = this.iso();
      const admissions = this.admissionList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // the quiet ones in a field of their own, and only while the account still lists the PC
      const quiet = entry === undefined ? [] : this.quietList
        .filter((a) => a.server_id === challenge.server_id && a.account === body.account && this.now() - Date.parse(a.at) < ADMISSION_TTL_MS)
        .map(({ key, label, at }) => ({ key, label, at }));
      // as the service: the listing it holds this PC under, when it confirms one (never one a device code listed under Step 2)
      const named = entry !== undefined && !(this.opensAll && entry.listed_by_device === true) ? entry.listing_id ?? null : null;
      const taken = this.pcAdmissions.get(key);
      const listing = this.completions && body.with_listing_id === true
        ? { listing_id: named, ...(this.saysListingAdmitted ? { listing_admitted: named !== null && entry?.admitted_at != null && taken?.taken === true && taken.listing === named } : {}) } : {};
      return json({ ...listing, records: rest.slice(0, MAILBOX_PAGE).map(({ seq, record }) => ({ seq, record })), more: rest.length > MAILBOX_PAGE, admissions, quiet_admissions: quiet });
    }
    return problem(404, "not_found", "Unknown request");
  }

  /**
   * Device table P6, G1: page 0 freezes the account's state under a new snapshot id; every later page is
   * asked by that id and served from the same state, or answered `snapshot_gone`.
   */
  private snapshotPage(serverId: string, account: string, id: unknown, page: unknown): Response {
    let state: SnapshotState | undefined;
    if (id === undefined && (page === undefined || page === 0)) {
      const registry = this.registry(account);
      const entries = [...registry.devices].sort(([, a], [, b]) => a.no - b.no);
      state = {
        snapshot: randomHex(16), account, server_id: serverId, version: registry.version, methods_version: registry.methods_version,
        // P16, G12: a key above a standing freeze line is not list-eligible
        devices: entries.filter(([, d]) => !d.removed).map(([key, { no, eligible, label }]) => ({ key, no, eligible: eligible && !this.frozen(registry, no), label })),
        removed: entries.filter(([, d]) => d.removed).map(([key, { no }]) => ({ key, no })),
        blocks: [...registry.blocks], lifts: [...registry.lifts], freezes: [...registry.freezes],
      };
      this.snapshots.set(state.snapshot, state);
    } else if (typeof id === "string") {
      state = this.snapshots.get(id);
      if (state === undefined || state.account !== account || state.server_id !== serverId) return problem(410, SNAPSHOT_GONE, "Start the read again");
    }
    if (state === undefined || !Number.isSafeInteger(page ?? 0) || (page ?? 0) as number < 0) return problem(400, "invalid_request", "Ask page 0 with no snapshot, then each page by its snapshot id");
    const index = (page ?? 0) as number;
    // every list is paged on its own, so no page holds more than SNAPSHOT_PAGE entries of any list
    const lists = [state.devices, state.removed, state.blocks, state.lifts, state.freezes];
    const pages = Math.max(1, ...lists.map((list) => Math.ceil(list.length / SNAPSHOT_PAGE)));
    if (index >= pages) return problem(400, "invalid_request", "No such page");
    const slice = <T>(list: readonly T[]) => list.slice(index * SNAPSHOT_PAGE, (index + 1) * SNAPSHOT_PAGE);
    const body: AccountSnapshotPage = {
      v: ACCOUNT_SNAPSHOT_V, snapshot: state.snapshot, account, server_id: serverId, version: state.version, methods_version: state.methods_version, page: index, last: index === pages - 1,
      devices: slice(state.devices), removed: slice(state.removed), blocks: slice(state.blocks), lifts: slice(state.lifts), freezes: slice(state.freezes),
    };
    return json(body);
  }

  /**
   * Device table P16, P21, T52 (service effect): a block commits whole (target removed, freeze line, record
   * kept); a lift ends that block's service line. Each signer must be a registered member older than the target.
   */
  private frozen(registry: { freezes: readonly SnapshotFreezeLine[] }, no: number): boolean {
    return registry.freezes.some((line) => no > line.after);
  }

  private async safetyRecord(account: string, body: { record?: unknown }): Promise<Response> {
    let record: SafetyRecord;
    try {
      record = parseSafetyRecord(body.record);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      throw error;
    }
    if (!isDeviceSafetyRecord(record)) return problem(400, "record_invalid", "Send a block or a device's lift");
    if (!await verifySafetyRecord(record)) return problem(400, "signature_invalid", "The signature does not hold");
    if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
    const registry = this.registry(account);
    const signer = registry.devices.get(record.signer);
    if (signer && this.frozen(registry, signer.no)) return problem(403, "frozen", "A key a block freezes signs nothing");
    if (!signer || signer.removed || signer.no !== record.signer_no) return problem(403, "signer_not_member", "The signer is not a device of this account");
    if (record.kind === "block") {
      const target = registry.devices.get(record.target);
      if (!target || target.no !== record.target_no) return problem(403, "unknown_target", "The target is not where the block says");
      if (signer.no >= target.no) return problem(403, "signer_not_older", "Only a device older than the target blocks it");
      if (!registry.blocks.some((held) => held.id === record.id)) {
        if (target.removed) return problem(409, "target_removed", "The target is already removed");
        target.removed = true;
        registry.blocks.push(record);
        registry.freezes.push({ block: record.id, target: record.target, after: record.target_no });
        registry.version += 1;
      }
      return json({ id: record.id });
    }
    const block = registry.blocks.find((held) => held.id === record.target);
    if (!block) return problem(404, "not_found", "No such block");
    if (record.signer_no >= block.target_no) return problem(403, "signer_not_older", "Only a device older than the blocked one lifts it");
    // T52: as the service, only a list-eligible device lifts
    if (!signer.eligible) return problem(403, "not_eligible", "This device cannot lift a block yet");
    if (!registry.lifts.some((held) => held.id === record.id)) {
      registry.lifts.push(record);
      registry.freezes = registry.freezes.filter((line) => line.block !== block.id);
      registry.version += 1;
    }
    return json({ id: record.id });
  }

  private expire(): void {
    const cutoff = this.now() - MAILBOX_TTL_MS;
    for (const [id, box] of this.mailboxes) this.mailboxes.set(id, box.filter(({ at }) => at > cutoff));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

/** One mailbox per PC and account: another account's records can neither fill nor hide this account's. */
function box(serverId: string, account: string): string {
  return `${serverId}\0${account}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** `key_proof` as the service reads it: `{ challenge_id, signature }`, 32 lowercase hex digits and 86 base64url characters; null otherwise. */
function keyProofOf(value: unknown): { challenge_id: string; signature: string } | null {
  if (value === null || typeof value !== "object" || Object.keys(value).length !== 2) return null;
  const { challenge_id, signature } = value as Record<string, unknown>;
  return typeof challenge_id === "string" && /^[0-9a-f]{32}$/.test(challenge_id) && typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature)
    ? { challenge_id, signature } : null;
}

/**
 * A redeem's answer, the same for every rerun: the card that offers Add for a plain invite's PC lasts until
 * `card_until`, and an auto invite's admission waits to be taken until `admission_until`; the other is null, and so is
 * `admission_until` once the sign-in that made the invite ended (`makerGone`), which ended its admission.
 */
function redeemed(account: string, listing: string, auto: boolean, at: number, makerGone = false) {
  const until = new Date(at + ADMISSION_TTL_MS).toISOString();
  return { account, listing_id: listing, auto, card_until: auto ? null : until, admission_until: auto && !makerGone ? until : null };
}

function limited(code: "rate_limited" | "pc_add_cap", seconds: number): Response {
  const answer = problem(429, code, code === "pc_add_cap" ? "This account added enough PCs today" : "Too many requests; try again later");
  answer.headers.set("retry-after", String(seconds));
  return answer;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
