import { dlopen, FFIType } from "bun:ffi";
import { hostname } from "node:os";

import qrcode from "qrcode-generator";

import { isLoopbackHost } from "../server/access.ts";
import { fleetPreview } from "../server/preview.ts";
import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { startDeviceSignIn, startLinkPageSignIn } from "../src/lib/account/deviceSignIn.ts";
import { NEW_PC_MS } from "../src/lib/account/myPcs.ts";
import { AccountService, DEVICE_PROVIDERS, offeredProviders, type DeviceProvider } from "../src/lib/account/service.ts";
import { memoryAccountStore, memoryLock, type AccountProvider } from "../src/lib/account/store.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LinkOptions {
  readonly origin: string;
  readonly headers: Record<string, string>;
  readonly accountService: string | null;
  readonly app?: string;
  readonly preview?: boolean;
  readonly cliName?: string;
  readonly out: (text: string) => void;
  readonly lines: AsyncIterator<string>;
  readonly terminal?: boolean;
  readonly discard?: () => boolean;
  readonly isTty?: boolean;
  readonly size?: () => { readonly rows: number; readonly columns: number } | null;
  readonly signal: AbortSignal;
  readonly fetch?: Fetch;
  readonly serviceFetch?: Fetch;
  readonly now?: () => number;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const POLL_MS = 2_000;
const RELIST_MS = 9 * 60_000;
const REOPEN_MS = 30_000;
const WAITING_MS = 30 * 60_000;
const WINDOW_MS = 10 * 60_000;
const LAST_MS = 30_000;
const DWELL_MS = 1_500;
const MAX_CODES = 3;
/**
 * How long a device that paired gets to put this PC in its account before it is asked about: one that is signed in
 * links itself and lists the PC within seconds (src/lib/relay/accountController.ts).
 */
const ALONE_MS = 15_000;
const SWEEP_MS = 4_000;
const CLEAR_ROUNDS = 4;
const CLEAR_READS = 3;
const CLEAR_RETRY_MS = 500;
/** The terminal's other screen: what is drawn there is gone, scrollback and all, once it is left. */
const SCREEN_ON = "\x1b[?1049h";
const SCREEN_OFF = "\x1b[?1049l";
const SCREEN_CLEAR = "\x1b[2J\x1b[H";

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    // fixed wait: the time until the code runs out, or the poll interval while a device is awaited
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function qr(text: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return code.createASCII(1, 1);
}

class LocalError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "") { super(message); }
}

class AwayError extends Error {}

function localApi(options: LinkOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const control = { "content-type": "application/json", "x-herdr-machine": "1", "x-herdr-update": "1", origin: options.origin };
  return async <T>(method: "GET" | "POST" | "DELETE", path: string, extra: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${options.origin}${path}`, {
        method, headers: { ...(method === "GET" ? {} : control), ...options.headers, ...extra.headers },
        ...(method === "GET" ? {} : { body: JSON.stringify(extra.body ?? {}) }),
        signal: extra.signal ?? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw new AwayError(`${path}: the Ovis on this PC did not answer (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!response.ok) {
      let message = `${response.status}`;
      let code = "";
      try {
        const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
        if (typeof body.error?.code === "string") code = body.error.code;
      } catch {}
      throw new LocalError(`${path}: ${message}`, response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };
}

type Api = ReturnType<typeof localApi>;

const ONLINE_MS = 30_000;

async function relayOnline(options: LinkOptions, api: Api): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  let status = await relayOn(options, api);
  const deadline = now() + ONLINE_MS;
  while (status.phase !== "online") {
    if (now() >= deadline) throw new LocalError("The Ovis relay did not come online in 30 seconds. Check this PC's internet connection and try again.");
    await wait(500, options.signal);
    status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  }
}

async function relayOn(options: LinkOptions, api: Api): Promise<{ phase: string; blocked: string | null }> {
  let status = await api<{ phase: string; blocked: string | null }>("GET", "/api/relay");
  if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  if (status.phase === "off") {
    options.out("Turning on the Ovis relay (Settings → Devices and PCs → Ovis relay turns it off again).\n");
    status = await api<{ phase: string; blocked: string | null }>("POST", "/api/relay/start");
    if (status.blocked) throw new LocalError(`The Ovis relay cannot run here (${status.blocked}).`);
  }
  return status;
}

/**
 * A label a requesting device chose, as plain text: its terminal controls (C0, DEL, C1) dropped, so it
 * cannot clear the screen or hide the digits it is shown with.
 */
export const plainLabel = (label: string): string => label.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const SIX_DIGITS = /^[0-9]{6}$/;

export interface AskingDevice { readonly label: string; readonly digits: string; readonly intent?: string }

export function approvalPrompt(device: AskingDevice, whole = false): string {
  const what = device.intent === "account" ? "join your account" : "pair with this PC";
  if (!SIX_DIGITS.test(device.digits)) return `${plainLabel(device.label)} wants to ${what}, but its request came without six digits to compare, so it cannot be approved here. Press Enter to decline: `;
  const shows = `${plainLabel(device.label)} wants to ${what}. Approve it only if its screen shows ${device.digits.slice(0, 3)} ${device.digits.slice(3)}.`;
  return whole ? `${shows} Another request's digits end in ${device.digits.slice(3)} too, so type all six (${device.digits}) to approve, or press Enter to decline: `
    : `${shows} Type ${device.digits.slice(3)} to approve, or press Enter to decline: `;
}

export function answerOf(line: string, digits: string, whole = false): "approve" | "decline" | null {
  // NFKC first: an input method left in its wide mode types the digits full-width (２２２), and they are the same digits
  const typed = line.normalize("NFKC").replace(/\s/g, "");
  if (typed === "") return "decline";
  if (!SIX_DIGITS.test(digits)) return null;
  return typed === digits || (!whole && typed === digits.slice(3)) ? "approve" : null;
}

function answer(lines: AsyncIterator<string>, signal: AbortSignal): Promise<IteratorResult<string>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    lines.next().then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

const NO_LINES: AsyncIterator<string> = { next: () => Promise.resolve({ value: undefined, done: true }) };

interface Line {
  readonly text: string;
  readonly under: object | null;
  readonly at: number;
}

/** A terminal keeps a line typed while nothing reads and hands it to the next read. */
function typing(lines: AsyncIterator<string>, signal: AbortSignal, under: () => object | null, now: () => number) {
  const got: Line[] = [];
  let ended = false;
  let failed: unknown;
  let wake: (() => void) | null = null;
  const next = (): void => {
    answer(lines, signal).then((reply) => {
      if (reply.done) ended = true;
      else {
        got.push({ text: reply.value, under: under(), at: now() });
        next();
      }
      wake?.();
    }, (error: unknown) => { failed = error; ended = true; wake?.(); });
  };
  next();
  return {
    take: (): Line[] => got.splice(0),
    get ended() { return ended; },
    get failed() { return failed; },
    arrived: (): Promise<void> => new Promise((resolve) => { if (got.length > 0 || ended) resolve(); else wake = resolve; }),
  };
}

export interface WaitingDevice extends AskingDevice { readonly id: string }

export interface AnswerInput {
  readonly lines: AsyncIterator<string>;
  readonly terminal?: boolean;
  readonly discard?: () => boolean;
  readonly out: (text: string) => void;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}

let flush: (() => boolean) | null = null;

/** A line typed and not sent sits in the terminal, not in this process: only the system's tcflush drops it. */
export function discardTyped(): boolean {
  try {
    if (flush === null) {
      // TCIFLUSH, the input queue: 0 on Linux, 1 on macOS
      const [queue, libraries] = process.platform === "linux" ? [0, ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]]
        : process.platform === "darwin" ? [1, ["libSystem.B.dylib"]] : [0, []];
      flush = () => false;
      for (const library of libraries) {
        try {
          const { symbols } = dlopen(library, { tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
          flush = () => symbols.tcflush(0, queue) === 0;
          break;
        } catch {}
      }
    }
    return flush();
  } catch { return false; }
}

/** The terminal is read a line at a time (canonical mode): when a line was begun is not seen, only when its Enter came. */
function asking(input: AnswerInput) {
  const { out } = input;
  const now = input.now ?? Date.now;
  const terminal = input.terminal === true;
  let open: { readonly id: string; readonly label: string; readonly digits: string; readonly device: WaitingDevice; whole: boolean; prompt: string; shownAt: number | null } | null = null;
  const seen = new Map<string, string>();
  let reply: "approve" | "decline" | null = null;
  let three = false;
  let atPrompt = false;
  let held: string | null = null;
  const emptied = (): boolean => { try { return input.discard?.() === true; } catch { return false; } };
  const keys = typing(terminal ? input.lines : NO_LINES, input.signal, () => open !== null && open.shownAt !== null ? open : null, now);
  let endSaid = !terminal;
  if (endSaid) out("This is not run in a terminal, so no request can be answered here: each is declined as it shows. Run this in a terminal to approve one (over ssh, run ssh -t).\n");
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  const sort = (): void => {
    let dropped: string | null = null;
    for (const line of keys.take()) {
      atPrompt = false;
      if (held !== null) {
        dropped = `${held}${open === null ? "" : " Answer again for the request shown now."}`;
        held = null;
        continue;
      }
      if (open !== null && line.under === open && open.shownAt !== null) {
        if (line.at - open.shownAt >= DWELL_MS) {
          if (reply !== null) continue;
          reply = answerOf(line.text, open.digits, open.whole);
          three = reply === "approve" && answerOf(line.text, open.digits, true) === null;
          if (reply === null) {
            const typed = line.text.normalize("NFKC").replace(/\s/g, "");
            dropped = SIX_DIGITS.test(open.digits) && /^(?:[0-9]{3}|[0-9]{6})$/.test(typed) && typed !== open.digits.slice(3)
              ? `${typed} are not this request's digits: ${open.label} shows ${open.digits.slice(0, 3)} ${open.digits.slice(3)}. If the device you are adding shows other digits than those, this request is not that device's: press Enter by itself to decline it, and do not type the digits below.`
              : `${!SIX_DIGITS.test(open.digits) ? "this request cannot be approved here" : open.whole ? "only all six digits shown approve this request" : "only the digits shown approve a request"}, and only Enter by itself declines it. Answer again.`;
          }
          continue;
        }
        if (reply === null) dropped = "it came as the request showed, too soon to have compared its digits. Compare them, then answer again.";
        continue;
      }
      dropped = open === null ? "no request is waiting for an answer."
        : "it was typed before the request shown now was asked about. Answer again for that one.";
    }
    if (dropped !== null) say(`That line answered nothing: ${dropped}\n`);
  };
  return {
    say,
    get open(): { readonly id: string; readonly label: string } | null { return open; },
    look(): void {
      sort();
      if (keys.failed !== undefined) throw keys.failed;
      if (keys.ended && !endSaid) {
        endSaid = true;
        say("The terminal's input ended (Ctrl+D): no request can be answered here any more, so each is declined as it shows. Run this again to answer them.\n");
      }
    },
    ask(device: WaitingDevice, waiting: readonly WaitingDevice[]): void {
      const others = [...waiting.filter((other) => other.id !== device.id).map((other) => other.digits), ...[...seen].filter(([id]) => id !== device.id).map(([, digits]) => digits)];
      const whole = SIX_DIGITS.test(device.digits) && others.some((digits) => SIX_DIGITS.test(digits) && digits.slice(3) === device.digits.slice(3));
      seen.set(device.id, device.digits);
      open = { id: device.id, label: plainLabel(device.label), digits: device.digits, device, whole, prompt: approvalPrompt(device, whole), shownAt: null };
      reply = null;
    },
    get byThree(): boolean { return open !== null && !open.whole && reply === "approve" && three; },
    beside(waiting: readonly WaitingDevice[]): void {
      if (open === null || open.whole || !SIX_DIGITS.test(open.digits)) return;
      const shown = open;
      if (!waiting.some((other) => other.id !== shown.id && SIX_DIGITS.test(other.digits) && other.digits.slice(3) === shown.digits.slice(3))) return;
      sort();
      shown.whole = true;
      shown.prompt = approvalPrompt(shown.device, true);
      const taken = reply === "approve" && three;
      if (taken) reply = null;
      if (reply !== null || shown.shownAt === null) return;
      const why = `nother request's digits end in ${shown.digits.slice(3)} too`;
      say(taken ? `That line answered nothing: a${why}, so only all six digits approve ${shown.label} now.\n` : `A${why}: only all six digits approve ${shown.label} now.\n`);
    },
    gone(): void {
      if (open === null) return;
      const shown = open;
      say(`${shown.label} is no longer waiting.\n`);
      open = null;
      reply = null;
      sort();
      if (shown.shownAt !== null) held = "a request went away while it may have been typed.";
    },
    lost(): void {
      held = "the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile.";
    },
    get ended(): boolean { return keys.ended; },
    show(): void {
      sort();
      if (open !== null && !atPrompt && reply === null) {
        if (open.shownAt === null) {
          if (terminal && !keys.ended && !emptied()) held ??= "this terminal's input could not be emptied as the request showed, so it may have been begun before that.";
          open.shownAt = now();
        }
        out(open.prompt);
        atPrompt = true;
      }
    },
    get answered(): boolean { return open !== null && open.shownAt !== null && (reply !== null || keys.ended); },
    answer(): { readonly id: string; readonly label: string; readonly decision: "approve" | "decline" } | null {
      if (open === null || open.shownAt === null || (reply === null && !keys.ended)) return null;
      const { id, label } = open;
      const decision = reply ?? "decline";
      open = null;
      reply = null;
      atPrompt = false;
      return { id, label, decision };
    },
    arrived: keys.arrived,
  };
}

export interface ApproveOptions extends AnswerInput {
  readonly decide: (id: string, decision: "approve" | "decline") => Promise<"taken" | "gone" | "away">;
  readonly list?: () => Promise<readonly WaitingDevice[]>;
}

export async function approveWaiting(pairings: readonly WaitingDevice[], options: ApproveOptions): Promise<number> {
  const { out, signal } = options;
  if (options.terminal !== true) {
    out("This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n");
    return 1;
  }
  const desk = asking(options);
  for (const pairing of pairings) {
    desk.ask(pairing, pairings);
    for (;;) {
      desk.look();
      if (desk.byThree && options.list !== undefined) {
        let waiting: readonly WaitingDevice[] | null = null;
        try { waiting = await options.list(); } catch {}
        if (waiting === null) {
          out(`The waiting requests could not be read again just now, so the last three digits approved nothing. ${plainLabel(pairing.label)} is asked about again.\n`);
          desk.ask(pairing, pairings);
          continue;
        }
        desk.beside(waiting);
      }
      const answer = desk.answer();
      if (answer !== null) {
        const sent = await options.decide(answer.id, answer.decision);
        if (sent === "taken") out(answer.decision === "approve" ? "Approved.\n" : "Declined.\n");
        else if (sent === "gone") out(`${answer.label} is no longer waiting.\n`);
        else {
          if (desk.ended) { out("Your answer may not have reached the Ovis on this PC. Run this again once it answers.\n"); return 1; }
          out(`Your answer may not have reached the Ovis on this PC. ${answer.label} is asked about again.\n`);
          desk.lost();
          desk.ask(pairing, pairings);
          continue;
        }
        break;
      }
      desk.show();
      if (desk.answered) continue;
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(signal.reason);
        if (signal.aborted) { stop(); return; }
        signal.addEventListener("abort", stop, { once: true });
        desk.arrived().then(() => { signal.removeEventListener("abort", stop); resolve(); });
      });
    }
  }
  return 0;
}

const groups = (id: string): string => id.match(/.{1,4}/g)?.join(" ") ?? id;

export function linkSettings(env: Readonly<Record<string, string | undefined>>): Pick<LinkOptions, "preview" | "cliName" | "app"> {
  const cliName = env["OVIS_CLI_NAME"];
  const app = env["OVIS_RELAY_APP_URL"];
  return { preview: fleetPreview(env), ...cliName ? { cliName } : {}, ...app ? { app } : {} };
}

function cli(options: LinkOptions): string {
  return (options.preview === true && options.cliName) || "ovis";
}

async function askLine(options: LinkOptions, prompt: string): Promise<string | null> {
  const now = options.now ?? Date.now;
  let held = (() => { try { return options.discard?.() !== true; } catch { return true; } })();
  let shownAt = now();
  options.out(prompt);
  for (;;) {
    const reply = await answer(options.lines, options.signal);
    if (reply.done) { options.out("\n"); return null; }
    if (held) {
      held = false;
      shownAt = now();
      options.out(`That line answered nothing: this terminal's input could not be emptied as the question showed, so it may have been typed before it. Answer again.\n${prompt}`);
      continue;
    }
    if (now() - shownAt >= DWELL_MS) return reply.value;
    shownAt = now();
    options.out(`That line answered nothing: it came before the question could be read. Answer again.\n${prompt}`);
  }
}

const PROVIDER_NAMES: Readonly<Record<AccountProvider, string>> = { github: "GitHub", google: "Google", apple: "Apple" };

function appHost(options: LinkOptions, url: string): string {
  if (options.preview !== true) return "app.ovis.sh";
  try { return new URL(url.includes("://") ? url : `https://${url}`).host; } catch { return url; }
}

const remaining = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

async function linkWithCode(options: LinkOptions, api: Api): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  await relayOnline(options, api);
  let asked = false;
  let shown: string | null = null;
  try {
    for (;;) {
      asked = true;
      shown = null;
      let code: { code: string; expires_at: string; server_id: string } | null = null;
      let refused = "";
      try { code = await api<{ code: string; expires_at: string; server_id: string }>("POST", "/api/relay/code"); } catch (error) {
        if (!(error instanceof LocalError)) throw error;
        refused = error.message;
      }
      const offer = await api<{ url: string; expires_at: string }>("POST", "/api/relay/offer");
      const decoded = decodeOffer(offer.url);
      if (decoded === null) throw new LocalError("The relay's pairing link did not parse.");
      shown = decoded.code ?? null;
      const until = Math.min(code === null ? Infinity : Date.parse(code.expires_at), Date.parse(offer.expires_at));
      const left = remaining(Math.max(0, until - now()));
      out([
        "",
        ...code !== null
          ? [`Code to type: ${code.code}   (works once, expires in ${left})`, `On the other device, open ${appHost(options, offer.url)}, choose Pair with a code and type it,`, "or scan this QR code with the phone's camera:"]
          : [`No code to type this time (${refused}).`, `Scan this QR code with the phone's camera (expires in ${left}):`],
        "",
        qr(offer.url),
        `That device then shows an ID: pair only if it matches this PC's ID, every group: ${groups(code?.server_id ?? decoded.server_id)}`,
        "A new one comes when this one runs out. Press Ctrl+C to stop.",
        "",
      ].join("\n"));
      await wait(Math.max(1_000, until - now()), signal);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (asked) await takeBack(api, out, shown);
  }
  return 0;
}

async function takeBack(api: Api, out: (text: string) => void, code: string | null): Promise<void> {
  const ended = await endCode(api, code);
  if (ended === "both") out("Stopped: the code and the QR code no longer work.\n");
  else if (ended === "typed") out("Stopped: the code no longer works. The QR code works until it runs out, as this Ovis cannot take it back.\n");
  else out(`Stopped, but the code could not be taken back (${ended.failed}): it works until it runs out.\n`);
}

async function endCode(api: Api, code: string | null): Promise<"both" | "typed" | { readonly failed: string }> {
  const signal = AbortSignal.timeout(5_000);
  try {
    await api("POST", "/api/devices/pair/cancel", { signal, ...code === null ? {} : { body: { code } } });
    return "both";
  } catch (error) {
    if (error instanceof LocalError && error.status === 404) {
      await api("POST", "/api/relay/code/cancel", { signal }).catch(() => undefined);
      return "typed";
    }
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

interface Listing { readonly serverId: string; readonly entry: { label: string; public_key: string; relay: string } }

async function listThisPc(api: Api, service: AccountService, now: () => number, unlisted: { listing: Listing | null }): Promise<Listing> {
  const listing = await openedListing(api);
  const listed = (await service.listPcs()).find((pc) => pc.server_id === listing.serverId);
  if (listed === undefined || now() - Date.parse(listed.added_at) < NEW_PC_MS - RELIST_MS) {
    await service.putPc(listing.serverId, listing.entry);
    unlisted.listing = null;
    await nameRelayAccount(api, service);
    return listing;
  }
  unlisted.listing = listing;
  await service.deletePc(listing.serverId);
  if (await putListing(service, listing)) unlisted.listing = null;
  await nameRelayAccount(api, service);
  return listing;
}

async function openedListing(api: Api): Promise<Listing> {
  const { url } = await api<{ url: string }>("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
  const offer = decodeOffer(url);
  if (offer === null) throw new LocalError("This PC's pairing link did not parse.");
  const label = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { serverId: offer.server_id, entry: { label, public_key: publicKey, relay: offer.relay } };
}

async function nameRelayAccount(api: Api, service: AccountService): Promise<void> {
  const session = await service.session();
  if (session) await api("POST", "/api/account/relay-account", { body: { account: session.account } }).catch(() => undefined);
}

async function putListing(service: AccountService, listing: Listing): Promise<boolean> {
  try { await service.putPc(listing.serverId, listing.entry); return true; } catch { return false; }
}

const shortId = (account: string): string => plainLabel(account).slice(0, 12);

interface Device {
  readonly id: string; readonly label: string; readonly created_at: string; readonly via_relay?: true; readonly account?: string;
  readonly added_by?: string;
}

function addedBy(devices: readonly Device[], known: ReadonlySet<string>, account: string): Device | null {
  const linked = devices.filter((device) => device.account === account && device.added_by === undefined);
  const came = linked.filter((device) => !known.has(device.id));
  const one = came.length > 0 ? came : linked;
  return one.length === 1 ? one[0]! : null;
}

const labels = (devices: readonly Device[]): string => devices.map((device) => plainLabel(device.label)).join(", ");

interface Outcome { readonly device: Device; readonly result: "removed" | "gone" | "joined" | { readonly failed: string } }

function removals(outcomes: readonly Outcome[], unkept: boolean): string {
  const removed = outcomes.filter(({ result }) => result === "removed").map(({ device }) => device);
  const one = removed.length === 1;
  return [
    ...removed.length === 0 ? [] : [` ${labels(removed)} paired with this PC since the code was shown and ${one ? "was" : "were"} removed${unkept ? `: nobody kept ${one ? "it" : "them"}` : ""}.`],
    ...outcomes.flatMap(({ device, result }) => typeof result === "string" ? [] : [` ${plainLabel(device.label)} could not be removed (${result.failed}): revoke it in Settings → Devices and PCs on this PC.`]),
  ].join("");
}

interface Joining {
  readonly signedIn: string;
  readonly status: () => Promise<{ account: string | null; enrolling?: boolean }>;
  readonly plain: boolean;
  readonly unlist: () => Promise<boolean>;
  readonly name: () => Promise<void>;
  readonly tend: () => Promise<void>;
}

async function addByQr(options: LinkOptions, api: Api, joining: Joining): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const devices = async (within?: AbortSignal): Promise<Device[]> => (await api<{ devices: Device[] }>("GET", "/api/devices", within === undefined ? {} : { signal: within })).devices;
  const startedAt = now();
  const stopAt = startedAt + WAITING_MS;
  await api("POST", "/api/relay/link/close").catch((error: unknown) => { if (signal.aborted || !(error instanceof LocalError || error instanceof AwayError)) throw error; });
  let known: ReadonlySet<string>;
  for (;;) {
    try { known = new Set((await devices()).map((device) => device.id)); break; } catch (error) {
      if (signal.aborted || !(error instanceof AwayError) || now() >= stopAt) throw error;
      await wait(POLL_MS, signal);
    }
  }
  let minted = 0;
  let live = false;
  let shown: string | null = null;
  let card: { readonly url: string; readonly typed: string | null; readonly refused: string; readonly serverId: string; readonly until: number } | null = null;
  let screen = false;
  let drawnFor = "";
  let atPrompt = false;
  const say = (text: string): void => { out(atPrompt ? `\n${text}` : text); atPrompt = false; };
  const sizeNow = () => joining.plain ? null : options.size?.() ?? null;
  const draw = (): void => {
    if (card === null) return;
    const size = sizeNow();
    drawnFor = size === null ? "" : `${size.columns}x${size.rows}`;
    const left = remaining(Math.max(0, card.until - now()));
    const code = qr(card.url).replace(/\n+$/, "").split("\n");
    const width = Math.max(...code.map((row) => row.length));
    const head = ["Scan this QR code with a device that is signed in to this Ovis account. It adds this PC to the account; there is no number to type.", ""];
    const tail = [
      ...card.typed !== null
        ? [`Code to type: ${card.typed}   (works once, expires in ${left})`, `Or, on that device, open ${appHost(options, card.url)}, choose Pair with a code and type it.`]
        : [`No code to type this time (${card.refused}). The QR code expires in ${left}.`],
      `That device then shows an ID: pair only if it matches this PC's ID, every group: ${groups(card.serverId)}`,
      "Anyone who can read this screen can pair with this PC while the code is shown.",
      `${minted < MAX_CODES ? "A new one comes when this one runs out. " : ""}Press Ctrl+C to stop.`,
    ];
    const rows = (lines: readonly string[], columns: number): number => lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
    // the other screen keeps nothing that scrolled off it: a code that does not fit is not drawn until the window grew
    const fits = size === null || (size.columns >= width && size.rows > rows(head, size.columns) + code.length + rows(tail, size.columns));
    const text = [...head, ...fits ? code : [`This window is too small for the QR code (it needs ${width} columns and ${code.length + head.length + tail.length + 1} rows). Make it larger and the code is drawn, or type the code.`, ""], ...tail];
    if (joining.plain) { out(["", ...text, ""].join("\n")); return; }
    out(`${screen ? "" : SCREEN_ON}${SCREEN_CLEAR}${text.join("\n")}\n`);
    screen = true;
  };
  const tell = (text: string): void => { try { say(text); } catch {} };
  const retract = async (): Promise<Awaited<ReturnType<typeof endCode>> | null> => {
    card = null;
    if (!live) return null;
    live = false;
    return await endCode(api, shown);
  };
  const leave = (ended: Awaited<ReturnType<typeof retract>>, used: boolean): void => {
    if (screen) {
      screen = false;
      try { out(SCREEN_OFF); } catch {}
    }
    if (ended === null) return;
    if (ended === "both") { if (!used) tell("The code and the QR code no longer work.\n"); }
    else if (ended === "typed") tell("The code no longer works. The QR code works until it runs out, as this Ovis cannot take it back.\n");
    else tell(`The code could not be taken back (${ended.failed}): it works until it runs out.\n`);
  };
  const end = async (used: boolean): Promise<void> => leave(await retract(), used);
  const mint = async (): Promise<void> => {
    minted++;
    live = true;
    shown = null;
    let typed: { code: string; expires_at: string; server_id: string } | null = null;
    let refused = "";
    try { typed = await api<{ code: string; expires_at: string; server_id: string }>("POST", "/api/relay/code"); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      refused = error.message;
      await api("POST", "/api/devices/pair/cancel").catch((failure: unknown) => { if (!(failure instanceof LocalError)) throw failure; });
    }
    const offer = await api<{ url: string; expires_at: string }>("POST", "/api/relay/offer");
    const decoded = decodeOffer(offer.url);
    if (decoded === null) throw new LocalError("The relay's pairing link did not parse.");
    shown = decoded.code ?? null;
    offered = true;
    card = { url: offer.url, typed: typed?.code ?? null, refused, serverId: typed?.server_id ?? decoded.server_id, until: Math.min(typed === null ? Infinity : Date.parse(typed.expires_at), Date.parse(offer.expires_at)) };
    draw();
  };
  let over = false;
  let offered = false;
  const seen = new Map<string, number>();
  const settled = new Set<string>();
  let unremoved = false;
  let account: string | null = null;
  let strays: Device[] = [];
  const unvouched = (list: readonly Device[]): Device[] => list.filter((device) => !known.has(device.id) && !settled.has(device.id) && device.account !== joining.signedIn);
  const remove = async (targets: readonly Device[], within?: AbortSignal): Promise<Outcome[]> => {
    const outcomes: Outcome[] = [];
    for (const device of targets) {
      try {
        await api("DELETE", `/api/devices/${encodeURIComponent(device.id)}`, { headers: { "x-ovis-unless-account": joining.signedIn }, ...within === undefined ? {} : { signal: within } });
        outcomes.push({ device, result: "removed" });
      } catch (error) {
        if (within === undefined && signal.aborted) throw error;
        if (error instanceof LocalError && error.status === 404) outcomes.push({ device, result: "gone" });
        else if (error instanceof LocalError && error.code === "account_member") outcomes.push({ device, result: "joined" });
        else outcomes.push({ device, result: { failed: error instanceof Error ? error.message : String(error) } });
      }
    }
    return outcomes;
  };
  const listed = async (within?: AbortSignal): Promise<Device[] | { readonly unread: string }> => {
    for (let attempt = 1; ; attempt++) {
      try { return await devices(within); } catch (error) {
        if (within === undefined && signal.aborted) throw error;
        const unread = error instanceof Error ? error.message : String(error);
        if (attempt >= CLEAR_READS) return { unread };
        try { await wait(CLEAR_RETRY_MS, within ?? signal); } catch (stopped) {
          if (within === undefined) throw stopped;
          return { unread };
        }
      }
    }
  };
  const clear = async (from: readonly Device[] | null, within?: AbortSignal): Promise<{ readonly outcomes: Outcome[]; readonly open: { readonly unread: string } | "more" | null }> => {
    const outcomes: Outcome[] = [];
    const tried = new Set<string>();
    let list = from;
    let open: { readonly unread: string } | "more" | null = null;
    for (let round = 0; ; round++) {
      if (list === null) {
        const read = await listed(within);
        if (Array.isArray(read)) {
          list = read;
          open = null;
        } else {
          open = read;
          if (round > 0) break;
          list = strays;
        }
      }
      const targets = unvouched(list).filter((device) => !tried.has(device.id));
      if (targets.length === 0) break;
      if (round >= CLEAR_ROUNDS) {
        open = "more";
        break;
      }
      for (const device of targets) tried.add(device.id);
      outcomes.push(...await remove(targets, within));
      list = null;
    }
    return { outcomes, open };
  };
  let asking = null as { readonly key: string; readonly devices: readonly Device[]; readonly prompt: string; readonly alone: boolean; shownAt: number | null } | null;
  let keys: ReturnType<typeof typing> | null = null;
  let reply = null as string | null;
  let added = false;
  let enrollingSaid = false;
  let parting: string | null = null;
  let away = false;
  let codeless = false;
  let held = false;
  const sort = (): void => {
    if (keys === null || asking === null || asking.shownAt === null) return;
    let dropped: string | null = null;
    for (const line of keys.take()) {
      atPrompt = false;
      if (held) {
        held = false;
        dropped = "the question changed while it may have been typed. Answer again for the question shown now.";
        continue;
      }
      if (line.under === asking && line.at - asking.shownAt >= DWELL_MS) reply ??= line.text;
      else if (reply === null) dropped = "it came before the question could be read. Answer again.";
    }
    if (dropped !== null) say(`That line answered nothing: ${dropped}\n`);
  };
  const sweep = async (): Promise<string> => {
    const { outcomes, open } = await clear(null, AbortSignal.timeout(SWEEP_MS));
    const left = open === null || !offered ? ""
      : `${open === "more" ? " More devices paired with this PC while these were removed" : ` The devices paired with this PC could not be read as the run ended (${open.unread})`}: one that paired since the code was shown may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours.`;
    return `${removals(outcomes, true)}${left}`;
  };
  const stop = async (text: string): Promise<number> => {
    const ended = await retract();
    const swept = await sweep();
    leave(ended, false);
    tell(`${text}${swept}\n`);
    return 1;
  };
  try {
    for (;;) {
      away = false;
      try {
        sort();
        if (keys !== null && keys.failed !== undefined) throw keys.failed;
        const joined = await joining.status();
        await joining.tend();
        const list = await devices();
        signal.throwIfAborted();
        if (keys !== null && keys.failed !== undefined) throw keys.failed;
        account = joined.account;
        const fresh = list.filter((device) => !known.has(device.id));
        if (fresh.length > 0 || account !== null) {
          over = true;
          await end(true);
        }
        for (const device of fresh) {
          if (seen.has(device.id)) continue;
          seen.set(device.id, now());
          if (account === null) say(device.via_relay === true ? `${plainLabel(device.label)} paired with this PC. Waiting for it to add this PC to your account…\n` : `${plainLabel(device.label)} paired with this PC at its own address, not through the relay.\n`);
        }
        strays = unvouched(list);
        const by = account === null ? null : addedBy(list, known, account);
        const label = by === null ? null : plainLabel(by.label);
        if (account !== null && account !== joining.signedIn) {
          const { outcomes, open } = await clear(list);
          const said = `This PC joined another Ovis account (${shortId(account)})${label === null ? "" : `, added by ${label}`}, not the one you signed in to (${shortId(joining.signedIn)}).${removals(outcomes, false)}`;
          let unread = open !== null && open !== "more" ? open.unread : null;
          let left: string | null = account;
          let rows: readonly Device[] = [];
          if (unread === null) {
            try {
              left = (await joining.status()).account;
              rows = await devices();
            } catch (error) {
              if (signal.aborted || !(error instanceof AwayError || error instanceof LocalError)) throw error;
              unread = error.message;
            }
          }
          if (unread !== null) {
            say(`${said} What is paired with this PC now could not be read (${unread}): devices of that account may still be paired. Open Settings → Devices and PCs on this PC and choose Revoke all if that account is not yours.\n`);
            return 1;
          }
          if (left === joining.signedIn) {
            say(`${said}\n`);
            continue;
          }
          if (left === null) {
            await joining.name();
            say(open === "more"
              ? `${said} This PC is in no account again, but more devices paired with it while these were removed, and one may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours, then run ${cli(options)} add again.\n`
              : `${said} This PC is in no account again. Run ${cli(options)} add again, and scan the code with a device signed in to the account you signed in to here.\n`);
            return 1;
          }
          const holders = rows.filter((device) => known.has(device.id) && device.account === left);
          const unlisted = await joining.unlist();
          say(`${said} This PC is still in that account${holders.length === 0 ? "" : `, by ${labels(holders)}, paired before this run`}. ${unlisted ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
          return 1;
        }
        if (parting !== null) {
          if (account !== null) parting = null;
          else if (strays.length === 0) {
            say(parting);
            return 1;
          }
        }
        added = account !== null;
        if (added && joined.enrolling === true && !enrollingSaid) {
          enrollingSaid = true;
          say(`Added${label === null ? "" : ` by ${label}`}. Bringing in your account's other devices…\n`);
        }
        const due = strays.some((device) => device.via_relay !== true || now() - (seen.get(device.id) ?? now()) >= ALONE_MS);
        const key = due ? `${account ?? ""} ${strays.map((device) => device.id).sort().join(" ")}` : null;
        if (asking !== null && asking.key !== key) {
          const was = asking;
          const sent = (keys !== null && keys.take().length > 0) || reply !== null;
          asking = null;
          reply = null;
          if (sent) {
            atPrompt = false;
            say("That line answered nothing: its question is no longer asked.\n");
          }
          if (was.shownAt !== null) held = true;
          if (atPrompt && key !== null) { out("\n"); atPrompt = false; }
        }
        if (asking === null && key !== null) {
          const alone = account === null && strays.every((device) => device.via_relay === true);
          const one = strays.length === 1;
          asking = {
            key, devices: strays, alone, shownAt: null,
            prompt: alone
              ? `${labels(strays)} paired with this PC but ${one ? "has" : "have"} not added this PC to an account yet, so this PC is in no account. Keep ${one ? "that device" : "those devices"}? Type keep to keep ${one ? "it" : "them"}, or press Enter to remove ${one ? "it" : "them"}: `
              : `${labels(strays)} paired with this PC while the code was shown and ${one ? "is" : "are"} not in your account. Keep ${one ? "that device" : "those devices"}? Type keep to keep ${one ? "it" : "them"}, or press Enter to remove ${one ? "it" : "them"}: `,
          };
          // read from here on, not sooner: a run in the background is stopped by its first read of the terminal.
          keys ??= typing(options.terminal === true ? options.lines : NO_LINES, signal, () => asking, now);
        } else if (asking !== null && keys !== null && asking.shownAt !== null && (reply !== null || keys.ended || now() >= stopAt)) {
          const asked = asking;
          // NFKC first: an input method left in its wide mode types it full-width (ｋｅｅｐ), and it is the same word
          const word = reply === null ? null : reply.normalize("NFKC").trim().toLowerCase();
          const keep = word === "keep";
          if (word !== null && !keep && /^y(es)?$/.test(word)) say(`Only the word keep keeps ${asked.devices.length === 1 ? "it" : "them"}, not y.\n`);
          if (reply === null) say(keys.ended ? `No answer can be typed here, so ${asked.devices.length === 1 ? "it is" : "they are"} not kept.\n` : `No answer came in time, so ${asked.devices.length === 1 ? "it is" : "they are"} not kept.\n`);
          atPrompt = false;
          asking = null;
          reply = null;
          const joined = new Set<string>();
          if (keep) out("Kept.\n");
          else {
            const outcomes = await remove(asked.devices);
            for (const { device, result } of outcomes) {
              const name = plainLabel(device.label);
              if (result === "gone") out(`${name} is no longer paired with this PC.\n`);
              else if (result === "joined") {
                joined.add(device.id);
                out(`${name} is in your account by now, so it stays.\n`);
              } else if (result !== "removed") {
                unremoved = true;
                out(`${name} could not be removed (${result.failed}): revoke it in Settings → Devices and PCs on this PC.\n`);
              }
            }
            if (outcomes.some(({ result }) => result === "removed")) out("Removed.\n");
          }
          for (const device of asked.devices) if (!joined.has(device.id)) settled.add(device.id);
          strays = unvouched(list);
          const parted = asked.alone ? `Sign in on ${asked.devices.length === 1 ? "that device" : "one of those devices"}, then run ${cli(options)} add again.\n` : `This PC is in no account yet. Run ${cli(options)} add again.\n`;
          if (!keep) {
            parting = account === null && joined.size === 0 ? parted : null;
            continue;
          }
          if (account === null) {
            out(parted);
            return 1;
          }
        }
        if (added && joined.enrolling !== true && strays.length === 0) {
          say(`This PC is in your account (${shortId(joining.signedIn)})${label === null ? "" : `, added by ${label}`}: every device of your account can use it.\n`);
          return unremoved ? 1 : 0;
        }
      } catch (error) {
        if (signal.aborted || !(error instanceof AwayError)) throw error;
        away = true;
      }
      if (now() >= stopAt) {
        return await stop(added
          ? `Stopped waiting after 30 minutes: this PC is in your account, but its other devices are not in yet. Open the Ovis app on the device that added it, then run ${cli(options)} add again.`
          : `Stopped after 30 minutes. Run ${cli(options)} add again.`);
      }
      if (!over && !away && (card === null || now() >= card.until)) {
        if (minted >= MAX_CODES) return await stop(`Stopped after ${Math.max(1, Math.round((now() - startedAt) / 60_000))} minutes. Run ${cli(options)} add again.`);
        try {
          await mint();
          codeless = false;
        } catch (error) {
          if (signal.aborted || !(error instanceof AwayError || (error instanceof LocalError && error.status === 409))) throw error;
          minted--;
          away = true;
          if (!codeless) {
            codeless = true;
            say("The Ovis on this PC gave no code just now (is it restarting?). Asking again…\n");
          }
        }
      }
      // a window that changed its size is drawn again: the other screen does not reflow what it cut off
      const size = sizeNow();
      if (screen && (size === null ? "" : `${size.columns}x${size.rows}`) !== drawnFor) draw();
      sort();
      if (asking !== null && !atPrompt && reply === null) {
        if (asking.shownAt === null) {
          if (options.terminal === true && keys !== null && !keys.ended) { try { options.discard?.(); } catch {} }
          asking.shownAt = now();
        }
        out(asking.prompt);
        atPrompt = true;
      }
      const answered = asking !== null && keys !== null && (reply !== null || keys.ended);
      if (asking !== null && keys !== null && !answered) {
        const early = new AbortController();
        const pause = wait(POLL_MS, AbortSignal.any([signal, early.signal]));
        const first = await Promise.race([pause.then(() => "waited" as const), keys.arrived().then(() => "typed" as const)]);
        if (first === "typed") { pause.catch(() => undefined); early.abort(); }
        signal.throwIfAborted();
      } else if (!answered || away) await wait(POLL_MS, signal);
    }
  } catch (error) {
    if (signal.aborted) return await stop(`Stopped. Run ${cli(options)} add again to add this PC.`);
    const ended = await retract();
    const swept = await sweep();
    leave(ended, false);
    if (swept !== "") tell(`${swept.trimStart()}\n`);
    throw error;
  } finally {
    await end(false);
  }
}

async function linkToAccount(options: LinkOptions, api: Api, forced: DeviceProvider | undefined, mode: { readonly approve: boolean; readonly print: boolean }): Promise<number> {
  const { out, signal } = options;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const status = () => api<{ account: string | null; enrolling?: boolean }>("GET", "/api/account/status");
  let first: { account: string | null; enrolling?: boolean };
  try { first = await status(); } catch (error) {
    if (!(error instanceof LocalError && error.status === 404)) throw error;
    out("The Ovis running on this PC is older than link needs. Update it in Settings → Updates (or reinstall the plugin), then run this again.\n");
    return 1;
  }
  if (first.account !== null) {
    if (first.enrolling !== true) {
      out(`This PC is already in an Ovis account (${shortId(first.account)}).\n`);
      return 0;
    }
    out(`This PC is already in an Ovis account (${shortId(first.account)}), but its account's other devices are not in yet. Open the Ovis app on the phone that added it. Waiting for them; press Ctrl+C to stop.\n`);
    const stopAt = now() + WAITING_MS;
    for (;;) {
      await wait(POLL_MS, signal);
      let again: { account: string | null; enrolling?: boolean } | null = null;
      try { again = await status(); } catch (error) {
        if (!(error instanceof AwayError)) throw error;
      }
      if (again !== null && again.account === null) {
        out("This PC is no longer in an account. Run this again to add it.\n");
        return 1;
      }
      if (again !== null && again.enrolling !== true) {
        out(`This PC is in an Ovis account (${shortId(again.account ?? first.account)}): every device of that account can use it.\n`);
        return 0;
      }
      if (now() >= stopAt) {
        out("Stopped waiting after 30 minutes: this PC is in the account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n");
        return 1;
      }
    }
  }
  if (options.accountService === null) {
    out("The account service is off on this PC (OVIS_ACCOUNT_SERVICE_URL=off). Link it with a code instead: run this again with --code.\n");
    return 1;
  }
  const preview = options.preview === true;
  if (preview && !mode.approve && (options.isTty !== true || options.terminal !== true)) {
    out(`Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ${cli(options)} add in a terminal (over ssh, run ssh -t).\n`);
    return 1;
  }
  if (!preview && !mode.approve && !mode.print && options.isTty !== true) {
    out("The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n");
    return 1;
  }
  await relayOn(options, api);
  const store = memoryAccountStore();
  const lock = memoryLock();
  const serviceFetch = options.serviceFetch ?? fetch;
  const offer = forced === undefined ? await offeredProviders(options.accountService, ["github"], { fetch: serviceFetch }) : null;
  const requester = { label: hostname(), os: accountOsOfPlatform(process.platform) };
  const startOptions = { service: options.accountService, store, lock, fetch: serviceFetch, now, wait, requester };
  const signIn = offer !== null && offer.page.length > 0 ? await startLinkPageSignIn(startOptions, offer.device[0] ?? "github") : await startDeviceSignIn({ ...startOptions, provider: forced ?? offer?.device[0] ?? "github" });
  const provider = signIn.provider;
  out((provider === "ovis"
    ? [
      "",
      "Sign in to your Ovis account:",
      `open ${signIn.verificationUri} on any device and enter the code: ${signIn.userCode}`,
      ...(signIn.verificationUriComplete === null ? [] : ["or scan this QR code with the phone's camera:", qr(signIn.verificationUriComplete)]),
      "Then continue with GitHub or Google there. Waiting for the sign-in…",
      "",
    ]
    : [
      "",
      `Sign in to your Ovis account with ${provider === "github" ? "GitHub" : "Google"}:`,
      `open ${signIn.verificationUri} on any device and enter the code: ${signIn.userCode}`,
      "Waiting for the sign-in…",
      "",
    ]).join("\n"));
  await signIn.finish(signal);
  const service = new AccountService({ store, lock, fetch: serviceFetch, now });
  const session = await service.session();
  const signedIn = session?.account ?? null;
  const pending: { listing: Listing | null } = { listing: null };
  const unlisted = "This PC could not be listed in your account again just now; it is tried again until it is.\n";
  try {
    if (session === undefined || signedIn === null) throw new LocalError("The sign-in did not last. Run this again.");
    if (preview && !mode.approve) {
      const line = await askLine(options, `Signed in as Ovis account ${signedIn} (signed in with ${PROVIDER_NAMES[session.provider]}). Press Enter to show the QR code for this account's phone, or press Ctrl+C if that is not your account: `);
      if (line === null || line.normalize("NFKC").trim() !== "") {
        out(`The QR code was not shown, and this PC was not listed in that account. Run ${cli(options)} add again and sign in with your own account.\n`);
        return 1;
      }
    }
    const first = await listThisPc(api, service, now, pending);
    if (pending.listing !== null) out(unlisted);
    if (pending.listing !== null && await putListing(service, pending.listing)) { pending.listing = null; await nameRelayAccount(api, service); }
    try { await relayOnline(options, api); } catch (error) {
      if (!(error instanceof LocalError)) throw error;
      throw new LocalError(`This PC stays listed in your account, but its Ovis relay is not online yet (${error.message}) Run this again once it is.`);
    }
    const name = first.entry.label;
    if (!mode.approve) {
      out(preview ? `This PC is listed in that account as ${name}.\n` : `Signed in. This PC is listed in your account as ${name}.\n`);
      return await addByQr(options, api, {
        signedIn, status, plain: mode.print || options.isTty !== true,
        unlist: () => { pending.listing = null; return service.deletePc(first.serverId).then(() => true, () => false); },
        name: () => nameRelayAccount(api, service),
        tend: async () => { if (pending.listing !== null && await putListing(service, pending.listing)) pending.listing = null; },
      });
    }
    let listedAt = now();
    let openedAt = listedAt;
    const stopAt = listedAt + WAITING_MS;
    const mayOpen = () => now() <= stopAt - WINDOW_MS;
    let enrollingSaid = false;
    let added = false;
    let away = false;
    out([
      `Signed in. This PC is listed in your account as ${name}.`,
      `On a device already signed in to this account (the Ovis app or ${appHost(options, options.app ?? "https://app.ovis.sh")}), choose Add on ${name}.`,
      "If it shows Join there instead, choose Join, then Ask to join or Type the number.",
      "Its request shows here to approve. Press Ctrl+C to stop.",
      "",
    ].join("\n"));
    // read from here on, not sooner: a run in the background is stopped by its first read of the terminal
    const desk = asking({ lines: options.lines, ...options.terminal === undefined ? {} : { terminal: options.terminal }, ...options.discard === undefined ? {} : { discard: options.discard }, out, signal, now });
    const { say } = desk;
    const elsewhere = async (account: string): Promise<number> => {
      pending.listing = null;
      const unlistedThere = await service.deletePc(first.serverId).then(() => true, () => false);
      await api("POST", "/api/account/relay-account", { body: { account } }).catch(() => undefined);
      say(`This PC joined another Ovis account (${shortId(account)}), not the one you signed in to (${shortId(signedIn)}). ${unlistedThere ? "It was taken off the list of the account you signed in to." : "It could not be taken off the list of the account you signed in to; remove it there."} If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n`);
      return 1;
    };
    let lastListed = false;
    const lastLooks = () => mayOpen() && now() >= stopAt - WINDOW_MS - LAST_MS;
    const asked = new Set<string>();
    for (;;) {
      try {
        if (away && !added && !mayOpen()) {
          let back: { account: string | null } | null = null;
          try { back = await status(); } catch (error) {
            if (!(error instanceof AwayError)) throw error;
          }
          if (back === null || back.account === null) {
            say("The Ovis on this PC stopped answering, too close to this run's 30 minutes to open its approval window again. Run this again once it is back.\n");
            return 1;
          }
          added = back.account === signedIn;
          if (!added) return await elsewhere(back.account);
        }
        desk.look();
        if (away) {
          if (!added) await api("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
          else await status();
          openedAt = now();
          away = false;
          say("The Ovis on this PC answers again.\n");
        }
        if (desk.byThree) desk.beside((await api<{ pairings: WaitingDevice[] }>("GET", "/api/relay/pairings")).pairings);
        const answer = desk.answer();
        if (answer !== null) {
          const { id, label, decision } = answer;
          try {
            await api("POST", "/api/relay/pairing", { body: { id, decision } });
            out(decision === "approve" ? "Approved.\n" : "Declined.\n");
          } catch (error) {
            if (error instanceof AwayError) {
              asked.delete(id);
              desk.lost();
              out(`Your answer may not have reached the Ovis on this PC. ${label} is asked about again if it is still waiting.\n`);
            }
            if (!(error instanceof LocalError)) throw error;
            out(`${label} is no longer waiting.\n`);
          }
        }
        const { pairings } = await api<{ pairings: WaitingDevice[] }>("GET", "/api/relay/pairings");
        const shown = desk.open;
        if (shown !== null && !pairings.some((pairing) => pairing.id === shown.id)) desk.gone();
        desk.beside(pairings);
        const next = desk.open === null ? pairings.find((pairing) => !asked.has(pairing.id)) : undefined;
        if (next !== undefined) {
          asked.add(next.id);
          desk.ask(next, pairings);
        }
        const joined = await status();
        if (joined.account !== null && joined.account !== signedIn) return await elsewhere(joined.account);
        if (joined.account !== null && joined.enrolling !== true) {
          say(`This PC is in your account (${shortId(joined.account)}): every device of your account can use it.\n`);
          return 0;
        }
        added = joined.account !== null;
        if (added && !enrollingSaid) {
          enrollingSaid = true;
          say("Added. Bringing in your account's other devices…\n");
        }
        if (pending.listing !== null && now() < stopAt && await putListing(service, pending.listing)) pending.listing = null;
        if (!added && now() < stopAt) {
          const last = lastLooks();
          let opened = false;
          if ((now() - listedAt >= RELIST_MS || (last && !lastListed)) && mayOpen()) {
            try { await listThisPc(api, service, now, pending); } catch (error) {
              if (pending.listing === null) throw error;
            }
            if (pending.listing !== null) say(unlisted);
            listedAt = now();
            openedAt = listedAt;
            opened = true;
            if (last) lastListed = true;
          }
          if (!opened && mayOpen() && (now() - openedAt >= REOPEN_MS || last)) {
            await api("POST", "/api/relay/link", { headers: { "x-ovis-local-only": "1" } });
            openedAt = now();
          }
        }
      } catch (error) {
        if (signal.aborted) { say("Stopped. Run this again to keep waiting.\n"); return 1; }
        if (!(error instanceof AwayError)) throw error;
        if (!away) {
          away = true;
          say("The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n");
        }
      }
      if (now() >= stopAt) {
        say(added
          ? "Stopped waiting after 30 minutes: this PC is in your account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n"
          : "Stopped waiting after 30 minutes. Run this again to keep waiting.\n");
        return 1;
      }
      desk.show();
      const answered = desk.answered;
      if (!away && answered) continue;
      try {
        if (desk.open === null || answered) await wait(POLL_MS, signal);
        else {
          const early = new AbortController();
          const pause = wait(POLL_MS, AbortSignal.any([signal, early.signal]));
          const first = await Promise.race([pause.then(() => "waited" as const), desk.arrived().then(() => "typed" as const)]);
          if (first === "typed") { pause.catch(() => undefined); early.abort(); }
          signal.throwIfAborted();
        }
      } catch (error) {
        if (signal.aborted) { say("Stopped. Run this again to keep waiting.\n"); return 1; }
        throw error;
      }
    }
  } finally {
    if (pending.listing !== null && !await putListing(service, pending.listing)) out("This PC dropped out of your account's list; run link again to list it.\n");
    await service.signOut().catch(() => out("The sign-in could not be ended at the account service; it ends by itself when it runs out.\n"));
  }
}

export async function link(args: readonly string[], options: LinkOptions): Promise<number> {
  let host: string;
  try { host = new URL(options.origin).host; } catch { host = ""; }
  if (!isLoopbackHost(host)) {
    options.out(`The server at ${options.origin} is not on a loopback address. Run link only on the PC itself, with Ovis listening on 127.0.0.1 (HOST unset).\n`);
    return 1;
  }
  const provider = DEVICE_PROVIDERS.find((name) => args.includes(`--${name}`));
  const api = localApi(options);
  try {
    return args.includes("--code") ? await linkWithCode(options, api) : await linkToAccount(options, api, provider, { approve: args.includes("--approve"), print: args.includes("--print") });
  } catch (error) {
    if (options.signal.aborted) { options.out("Stopped.\n"); return 1; }
    options.out(`Could not link this PC: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
