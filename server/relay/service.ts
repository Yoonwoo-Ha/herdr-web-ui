import { MACHINE_DIRECT_CARRIER_ENABLED } from "../machine-profile.ts";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DeviceConnection } from "../../shared/access.ts";
import { encodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { parseRelayPass, relayPassAdmitsNewSessions } from "../../shared/relay-pass.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../../shared/relay-regions.ts";
import type { RelayErrorCode, RelayStatus } from "../../shared/protocol.ts";
import type { RequestServices } from "../dispatch.ts";
import { isJsonObject } from "../http.ts";
import { writePrivateState } from "../private-state.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../static.ts";
import { loadRelayIdentity, relayIdentityPath, RelayIdentityError, rotateRelayIdentity, savedServerId } from "./identity.ts";
import type { RelayIdentity } from "./identity.ts";
import { SignedInSessions } from "./admissions.ts";
import { DirectCarrier } from "./direct.ts";
import type { DirectCarrierOptions } from "./direct.ts";
import { RelayLink, relayEnforcesPasses } from "./link.ts";
import type { RelayLinkOptions } from "./link.ts";
import { RelayPairingApprovals } from "./pairing-approvals.ts";
import { RelayPairCodes } from "./pair-code.ts";
import { RelayPassKeeper, type RelayPassClock } from "./pass.ts";
import type { RelayPassNotice } from "./link.ts";

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface RelayServiceOptions {
  readonly stateDir: string;
  readonly relay?: string;
  readonly app?: string;
  readonly connect?: RelayLinkOptions["connect"];
  readonly clock?: RelayLinkOptions["clock"];
  readonly random?: RelayLinkOptions["random"];
  readonly serverVersion?: RelayLinkOptions["serverVersion"];
  /**
   * Regional relays to measure against `relay`. Ovis's own (shared/relay-regions.ts) when neither
   * `relay` nor OVIS_RELAY_URL names a relay; none otherwise, so a self-hosted relay stays the only one.
   */
  readonly regionalRelays?: readonly string[];
  readonly probe?: (relay: string, signal: AbortSignal) => Promise<number | null>;
  readonly pairCodeRelay?: string;
  readonly direct?: Pick<DirectCarrierOptions, "addresses" | "peerAllowed" | "preferredPort" | "refreshMs" | "advertise" | "tailnetIp" | "tailnetAddresses">;
  readonly accountService?: string | Error;
  readonly accountFetch?: (request: Request) => Promise<Response>;
  readonly passClock?: RelayPassClock;
  readonly ovisRelays?: readonly string[];
}

export const STAGING_ACCOUNT_SERVICE = "https://account-staging.devswha.workers.dev";

function originKey(origin: string): string | null {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname.replace(/\.$/, "")}${url.port ? `:${url.port}` : ""}`;
  } catch { return null; }
}

const PRODUCTION_SERVICE = originKey(DEFAULT_ACCOUNT_SERVICE);
const STAGING_SERVICE = originKey(STAGING_ACCOUNT_SERVICE);

const REGIONAL_SHARE = 0.5;
const PROBE_TIMEOUT_MS = 5_000;

async function probeRelay(relay: string, signal: AbortSignal): Promise<number | null> {
  const url = new URL("/health", relay.replace(/^wss:/, "https:"));
  let best: number | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]), cache: "no-store" });
      await response.arrayBuffer();
      if (!response.ok) return null;
      const elapsed = performance.now() - started;
      if (attempt > 0) best = best === null ? elapsed : Math.min(best, elapsed);
    }
  } catch { return null; }
  return best;
}

function offerName(): { name?: string } {
  const name = hostname().slice(0, 64);
  return name ? { name } : {};
}

export function relayEndpoint(input: string, protocol: "wss:" | "https:"): string {
  const url = new URL(input);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error(`Invalid ${protocol} relay origin`);
  return url.origin;
}

export class RelayService {
  private phase: RelayStatus["phase"] = "off";
  private error: string | null = null;
  private errorCode: RelayErrorCode | null = null;
  private blocked: RelayStatus["blocked"] = null;
  private link: RelayLink | undefined;
  private regionalLink: RelayLink | undefined;
  private regionalPhase: RelayStatus["phase"] = "off";
  private regionalRelay: string | null = null;
  private measuring: AbortController | undefined;
  private readonly regionalRelays: readonly string[];
  private readonly pinned: string | null;
  private readonly ovisRelays: readonly string[];
  private readonly stagingRelay: string | null;
  private services: RequestServices | undefined;
  private port = 0;
  private identity: RelayIdentity | undefined;
  private saved: string | null | undefined;
  private enabled = false;
  private shuttingDown = false;
  private resetting = false;
  private ending: Promise<void> = Promise.resolve();
  readonly relay: string;
  readonly app: string;
  readonly approvals: RelayPairingApprovals;
  private stopRevokeAll: (() => void) | undefined;
  private pairCodes: RelayPairCodes | undefined;
  private passKeeper: RelayPassKeeper | undefined;
  private passNotice: RelayPassNotice | null = null;
  private passRefused = false;
  private directCarrier: DirectCarrier | undefined;
  private directStarting: Promise<void> = Promise.resolve();
  private readonly signedIn = new SignedInSessions();
  private directOn: boolean | undefined;

  constructor(private readonly options: RelayServiceOptions) {
    this.approvals = new RelayPairingApprovals({ path: join(options.stateDir, "relay", "pairing-window.json") });
    const named = options.relay ?? process.env["OVIS_RELAY_URL"];
    const origin = named === undefined ? undefined : relayEndpoint(named, "wss:");
    const asked = origin !== undefined && process.env["OVIS_RELAY_STAGING"] === "1";
    const service = options.accountService;
    const staging = asked && typeof service === "string" && originKey(service) === STAGING_SERVICE;
    if (asked && !staging) console.error(JSON.stringify({ event: "relay.staging.ignored", reason: `OVIS_RELAY_STAGING needs OVIS_ACCOUNT_SERVICE_URL=${STAGING_ACCOUNT_SERVICE}` }));
    this.stagingRelay = staging ? origin : null;
    this.pinned = !staging && origin !== undefined && REGIONAL_RELAYS.includes(origin) ? origin : null;
    this.relay = origin === undefined || this.pinned ? GLOBAL_RELAY : origin;
    this.ovisRelays = options.ovisRelays ?? (staging ? [origin] : [GLOBAL_RELAY, ...REGIONAL_RELAYS]);
    this.app = relayEndpoint(options.app ?? process.env["OVIS_RELAY_APP_URL"] ?? "https://app.ovis.sh", "https:");
    this.regionalRelays = this.pinned ? [this.pinned]
      : (options.regionalRelays ?? (origin === undefined ? REGIONAL_RELAYS : []))
        .map((relay) => relayEndpoint(relay, "wss:")).filter((relay) => relay !== this.relay);
  }

  currentIdentity(): RelayIdentity | undefined {
    if (this.identity) return this.identity;
    if (!existsSync(relayIdentityPath(this.options.stateDir))) return undefined;
    try { return loadRelayIdentity(this.options.stateDir); } catch (error) {
      if (error instanceof RelayIdentityError) return undefined;
      throw error;
    }
  }


  private get advertised(): string {
    return this.regionalRelay !== null && this.regionalPhase === "online" ? this.regionalRelay : this.relay;
  }

  private relayHints(): readonly string[] {
    return [...new Set([this.advertised, this.relay])];
  }

  serverId(): string | undefined {
    if (this.identity) return this.identity.server_id;
    if (this.saved === undefined) this.saved = savedServerId(this.options.stateDir) ?? null;
    return this.saved ?? undefined;
  }

  connections(): Map<string, DeviceConnection> { return this.signedIn.connections(); }

  checkConnections(timeoutMs: number): Promise<void> { return this.signedIn.check(timeoutMs); }

  status(): RelayStatus {
    return { phase: this.phase, relay: this.advertised, app: this.app,
      sessions: (this.link?.sessions ?? 0) + (this.regionalLink?.sessions ?? 0) + (this.directCarrier?.sessions ?? 0),
      blocked: this.blocked, error: this.error, error_code: this.exactErrorCode(),
      ...(this.options.direct ? { direct: { on: this.directEnabled(), carriers: this.directCarrier?.advertised(true) ?? [] } } : {}),
      ...(this.passKeeper ? { pass: { state: this.passState(this.passKeeper), relay: this.passNotice?.state ?? null, enforce_at: this.passNotice?.enforce_at ?? null, refused: this.passRefused,
        enforced: this.passRefused || relayEnforcesPasses(this.passNotice, Date.now()), ...this.newSessions() } } : {}) };
  }

  private newSessions(): { new_sessions?: false } {
    if (this.passNotice?.state !== "ok") return {};
    const parsed = parseRelayPass(this.passFor(this.relay, true));
    return parsed && !relayPassAdmitsNewSessions(parsed.payload) ? { new_sessions: false } : {};
  }

  private passState(keeper: RelayPassKeeper): RelayPassKeeper["state"] {
    return keeper.state === "ok" && this.passFor(this.relay) === null ? "unavailable" : keeper.state;
  }

  private exactErrorCode(): RelayErrorCode | null {
    if (this.error === null) return null;
    if (this.errorCode !== "pass_required") return this.errorCode;
    if (!this.passKeeper || this.options.accountService instanceof Error) return "pass_unsupported";
    switch (this.passKeeper.state) {
      case "no_account": return "pass_required";
      case "not_listed": return "pass_not_listed";
      case "limit": return "pass_limit";
      case "unavailable": return "pass_unavailable";
      case "ok": return "pass_refused";
    }
  }

  private relayAccountPath(): string { return join(this.options.stateDir, "relay", "account.json"); }

  private passAccount(): string | null {
    const members = this.services?.devices.account() ?? null;
    if (members !== null) return members;
    try {
      const saved: unknown = JSON.parse(readFileSync(this.relayAccountPath(), "utf8"));
      return isJsonObject(saved) && typeof saved.account === "string" && ACCOUNT_ID.test(saved.account) ? saved.account : null;
    } catch { return null; }
  }

  setRelayAccount(account: string): boolean {
    if (!ACCOUNT_ID.test(account)) return false;
    const before = this.passAccount();
    writePrivateState(this.relayAccountPath(), { account });
    const unlisted = this.passKeeper?.current() === null && this.passKeeper.refusal === "not_listed";
    if (before !== this.passAccount() || unlisted) void this.passKeeper?.refresh();
    return true;
  }

  private isOvisRelay(relay: string | null): boolean {
    return relay !== null && this.ovisRelays.includes(relay);
  }

  private takes(relay: string | null, issuer: string | null): boolean {
    if (relay === null || issuer === null) return false;
    if (this.options.ovisRelays) return this.options.ovisRelays.includes(relay);
    const key = originKey(issuer);
    if (key !== null && key === PRODUCTION_SERVICE) return relay === GLOBAL_RELAY || REGIONAL_RELAYS.includes(relay);
    return key !== null && key === STAGING_SERVICE && relay === this.stagingRelay;
  }

  private passFor(relay: string | null, honored = false): string | null {
    const keeper = this.passKeeper;
    const pass = (honored ? keeper?.honored() : keeper?.current()) ?? null;
    return pass !== null && keeper && this.takes(relay, keeper.issuer()) ? pass : null;
  }

  private startPass(identity: RelayIdentity): void {
    const service = this.options.accountService;
    if (service === undefined || !this.isOvisRelay(this.relay)) return;
    this.passKeeper = new RelayPassKeeper({
      stateDir: this.options.stateDir, identity: () => this.identity ?? identity, account: () => this.passAccount(), service,
      ...(this.options.accountFetch ? { fetch: this.options.accountFetch } : {}), ...(this.options.passClock ? { clock: this.options.passClock } : {}),
      onPass: (pass) => {
        if (this.passNotice !== null && this.passNotice.state !== "ok") this.passNotice = { ...this.passNotice, state: "ok" };
        if (this.passFor(this.relay) === pass) this.link?.renewPass(pass);
        if (this.passFor(this.regionalRelay) === pass) this.regionalLink?.renewPass(pass); },
    });
    this.passKeeper.start();
  }

  private passOptions(relay: string, global: boolean): Pick<RelayLinkOptions, "pass" | "honoredPass" | "onPassNotice" | "onPassRefused"> {
    // a relay that is not Ovis's (a regional one named otherwise) never gets the pass
    if (!this.isOvisRelay(relay)) return {};
    return {
      pass: () => this.passFor(relay),
      honoredPass: () => this.passFor(relay, true),
      onPassNotice: (notice) => {
        if (global) { this.passNotice = notice; this.passRefused = false; }
        if (notice?.state === "invalid" || notice?.state === "expired") void this.passKeeper?.rejected();
      },
      onPassRefused: () => { this.passRefused = true; void this.passKeeper?.rejected(); },
    };
  }

  private directPath(): string { return join(this.options.stateDir, "relay", "direct.json"); }

  private directEnabled(): boolean {
    if (this.directOn === undefined) {
      // on unless turned off; a choice that cannot be read is taken as off, so a damaged file never opens the network
      let text: string | undefined;
      try { text = readFileSync(this.directPath(), "utf8"); }
      catch (error) { if (!(isJsonObject(error) && error.code === "ENOENT")) text = ""; }
      if (text === undefined) this.directOn = true;
      else {
        let saved: unknown;
        try { saved = JSON.parse(text); } catch { saved = null; }
        this.directOn = isJsonObject(saved) && saved.on === true;
        if (!(isJsonObject(saved) && typeof saved.on === "boolean")) console.error("Direct connections are off: relay/direct.json cannot be read; turn them on again in Settings.");
      }
    }
    return this.directOn;
  }

  get directAvailable(): boolean { return this.options.direct !== undefined && (this.services?.options.profile !== "machine" || MACHINE_DIRECT_CARRIER_ENABLED); }

  async setDirect(on: boolean): Promise<RelayStatus> {
    if (!this.directAvailable) throw new Error("Direct connections are not available on this server.");
    writePrivateState(this.directPath(), { on });
    this.directOn = on;
    if (!on) await this.stopDirect();
    else if (this.link && this.identity && this.services) {
      this.startDirect(this.services, this.identity);
      await this.directStarting;
    }
    return this.status();
  }

  private startDirect(services: RequestServices, identity: RelayIdentity): void {
    if (!this.options.direct || !this.directAvailable || this.directCarrier || !this.directEnabled()) return;
    this.directCarrier = new DirectCarrier({ ...this.options.direct, identity, services, port: this.port, sessions: this.signedIn,
      ...(this.options.clock ? { clock: this.options.clock } : {}), ...(this.options.serverVersion ? { serverVersion: this.options.serverVersion } : {}) });
    this.directStarting = this.directCarrier.start();
  }

  private stopDirect(): Promise<void> {
    const direct = this.directCarrier;
    this.directCarrier = undefined;
    return direct?.stop() ?? Promise.resolve();
  }

  private directCarriers(tailnet: boolean): readonly string[] { return this.directCarrier?.advertised(tailnet) ?? []; }

  private regionPath(): string { return join(this.options.stateDir, "relay", "region.json"); }

  private async chooseRegion(signal: AbortSignal): Promise<{ relay: string; save: boolean } | null> {
    if (this.pinned) return { relay: this.pinned, save: false };
    try {
      const saved: unknown = JSON.parse(readFileSync(this.regionPath(), "utf8"));
      if (isJsonObject(saved) && typeof saved.relay === "string" && this.regionalRelays.includes(saved.relay)) return { relay: saved.relay, save: false };
    } catch {}
    const probe = this.options.probe ?? probeRelay;
    const [global, ...regional] = await Promise.all([this.relay, ...this.regionalRelays].map((relay) => probe(relay, signal)));
    let chosen: string | null = null;
    let fastest = Infinity;
    for (const [index, rtt] of regional.entries()) {
      if (rtt !== null && rtt < fastest) { chosen = this.regionalRelays[index]!; fastest = rtt; }
    }
    if (chosen === null || global == null || fastest > global * REGIONAL_SHARE) return null;
    return { relay: chosen, save: true };
  }

  private startRegional(link: RelayLink, services: RequestServices, identity: RelayIdentity): void {
    if (this.regionalRelays.length === 0) return;
    this.measuring = new AbortController();
    void this.chooseRegion(this.measuring.signal).catch(() => null).then((choice) => {
      if (!choice || this.link !== link || this.regionalLink) return;
      const { relay } = choice;
      if (choice.save) try { writePrivateState(this.regionPath(), { relay }); } catch {}
      const regional = new RelayLink({
        relay, identity, services, port: this.port, ...this.passOptions(relay, false),
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        relayHints: () => this.relayHints(), directCarriers: (tailnet) => this.directCarriers(tailnet), sessions: this.signedIn,
        onState: (phase) => { if (this.regionalLink === regional) this.regionalPhase = phase; },
      });
      this.regionalLink = regional;
      this.regionalRelay = relay;
      this.regionalPhase = "connecting";
      regional.start();
    });
  }

  /** Boot never enables a missing or damaged state file and never replaces a damaged identity. */
  resume(services: RequestServices, port: number): void {
    this.services = services;
    this.port = port;
    this.stopRevokeAll?.();
    this.stopRevokeAll = services.devices.onRevokeAll(() => this.approvals.closeWindow());
    this.blocked = services.serveOnly ? "serve_only" : null;
    try {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(join(this.options.stateDir, "relay", "state.json"), "utf8")); }
      catch (error) {
        if (isJsonObject(error) && error.code === "ENOENT") return;
        throw new Error("Could not read saved relay state.");
      }
      if (!isJsonObject(saved) || typeof saved.enabled !== "boolean") throw new Error("Saved relay state is invalid.");
      if (saved.enabled) this.start();
    } catch (error) { this.failed(error); }
  }

  private failed(error: unknown): void {
    this.phase = this.link ? "error" : "off";
    this.error = error instanceof RelayIdentityError ? error.message : "Could not start the relay.";
    this.errorCode = error instanceof RelayIdentityError ? "identity_unreadable" : "start_failed";
    if (error instanceof RelayIdentityError) this.blocked = "identity_unreadable";
  }

  start(): RelayStatus {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    if (this.link) return this.status();
    try {
      this.identity = loadRelayIdentity(this.options.stateDir);
      // Authorization reaches disk before the first outbound socket.
      if (services.token === "" && !services.devices.gated) services.devices.closeGate();
      writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: true });
      this.enabled = true;
      this.blocked = null;
      this.error = null;
      this.phase = "connecting";
      this.startPass(this.identity);
      const link = new RelayLink({
        relay: this.relay, identity: this.identity, services, port: this.port, ...this.passOptions(this.relay, true),
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        relayHints: () => this.relayHints(), directCarriers: (tailnet) => this.directCarriers(tailnet), sessions: this.signedIn,
        onState: (phase, error, code) => { if (this.link === link) { this.phase = phase; this.error = error; this.errorCode = code ?? null; } },
      });
      this.link = link;
      link.start();
      this.startDirect(services, this.identity);
      this.startRegional(link, services, this.identity);
    } catch (error) { this.failed(error); }
    return this.status();
  }

  get linked(): boolean { return this.link !== undefined; }

  private disconnect(): Promise<void> {
    const link = this.link;
    const regional = this.regionalLink;
    this.link = undefined;
    this.regionalLink = undefined;
    this.regionalPhase = "off";
    this.regionalRelay = null;
    this.measuring?.abort();
    this.measuring = undefined;
    this.phase = "off";
    this.error = null;
    this.passKeeper?.stop();
    this.passKeeper = undefined;
    this.passNotice = null;
    this.passRefused = false;
    this.pairCodes?.cancel();
    this.ending = Promise.all([this.ending, link?.stop(), regional?.stop(), this.stopDirect()]).then(() => undefined);
    return this.ending;
  }

  async stop(): Promise<RelayStatus> {
    writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: false });
    this.enabled = false;
    this.approvals.closeWindow();
    await this.disconnect();
    return this.status();
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.disconnect();
  }

  private offerFor(code: string): RelayOffer {
    const name = hostname().slice(0, 64);
    return { v: 1, server_id: this.identity!.server_id, server_public_key: this.identity!.public_key,
      relay: this.advertised, code, ...(name ? { name } : {}) };
  }

  async pairCode(by: string | null = null): Promise<{ code: string; expires_at: string; server_id: string } | null> {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const relay = this.options.pairCodeRelay ?? (this.relay === GLOBAL_RELAY ? GLOBAL_RELAY : null);
    if (relay === null) return null;
    this.pairCodes ??= new RelayPairCodes({ relay, devices: this.services.devices, offer: (code) => this.offerFor(code), identity: () => this.identity!, connect: this.options.connect,
      pass: () => this.passFor(relay) });
    return { ...await this.pairCodes.mint(by), server_id: this.identity.server_id };
  }

  cancelPairCode(): void {
    this.pairCodes?.cancel();
  }

  offer(by: string | null = null, options: { noAccountOnly?: boolean } = {}): { url: string; expires_at: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const devices = this.services.devices;
    const pairing = options.noAccountOnly ? devices.pairingForNoAccount(by)
      : devices.activePairing() ?? devices.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, by });
    if (by !== null) devices.holdPairing(by);
    return {
      url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key,
        relay: this.advertised, code: pairing.code, ...offerName() }, this.app),
      expires_at: pairing.expires_at,
    };
  }

  pairingLink(options: { localOnly?: boolean } = {}): { url: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    this.approvals.openWindow(Date.now(), options);
    return { url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key, relay: this.advertised, ...offerName() }, this.app) };
  }

  async resetIdentity(): Promise<RelayStatus> {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    this.resetting = true;
    try {
      this.approvals.closeWindow();
      await this.disconnect();
      for (const device of services.devices.list(null)) if (device.via_relay) services.devices.revoke(device.id);
      this.identity = rotateRelayIdentity(this.options.stateDir);
      this.blocked = null;
    } finally { this.resetting = false; }
    return this.enabled ? this.start() : this.status();
  }
}
