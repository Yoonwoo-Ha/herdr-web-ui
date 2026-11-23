import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import type { HoldState } from "../../../shared/account-devices-api.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, encodeFrame, FrameType, MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { beginSignIn } from "../account/signin.ts";
import { isNewAccountPc } from "../account/myPcs.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { accountOpenPeer, accountOpenRefusalFrame } from "./accountOpenPeer.fixture.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { AccountOpenUnsupportedError } from "../../../shared/relay-channel.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { markRemovedPc, removedPcs } from "./shellState.ts";
import { openRelayTransport, RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.ovis.sh";
const store: ShellDeviceStore = {
  get: async () => undefined, list: async () => [], remove: async () => {},
  removeRow: async () => false, update: async (_id, change) => change(undefined),
};

let browser: ReturnType<typeof createShellTestPage>;
beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); });

async function accountPc({ release = true, loseRegistrationReply = false, newUntil = null, seen = true, label, phoneSheet = false, open }: {
  release?: boolean; loseRegistrationReply?: boolean; seen?: boolean;
  newUntil?: string | null; label?: string;
  /**
   * The page as a phone's browser runs it: the join sheet holds a history entry (sheetHistory.ts), and a link this page
   * takes while it is up pops that entry, which the sheet takes for Back (AddPcSheet's close: its Cancel, then the
   * front page). The tests' navigations do not run the sheet's component, so this is how they see that.
   */
  phoneSheet?: boolean;
  open: (...args: [...Parameters<NonNullable<RelayShellMount["open"]>>, ReturnType<typeof generateKeyPair>]) => Promise<RelayTransport>;
}) {
  const identity = generateKeyPair();
  const serverId = deriveServerId(identity.publicKey);
  const entry = { server_id: serverId, label: "Desk", public_key: Buffer.from(identity.publicKey).toString("hex"), relay: RELAY, added_at: new Date().toISOString(), last_seen_at: seen ? new Date().toISOString() : null, new_until: newUntil };
  const accountStore = memoryAccountStore();
  const service = new FakeAccountService();
  service.signInAs("github", "acct_1");
  const started = await beginSignIn("github", { store: accountStore, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = (await service.fetch(started)).headers.get("location");
  if (returned === null) throw new TypeError("Missing OAuth return");
  const requests: string[] = [];
  const registrationKeys: string[] = [];
  const registrationLabels: (string | undefined)[] = [];
  const navigations: string[] = [];
  const navigated = Promise.withResolvers<string>();
  const appOpened = Promise.withResolvers<void>();
  let props: RelayShellProps | undefined;
  let apps = 0;
  // woken by every screen drawn, navigation and app opened: `settled` looks again at each
  const waiting: (() => void)[] = [];
  const wake = (): void => { for (const resume of waiting.splice(0)) resume(); };
  const render = (node: ReactNode): void => {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell");
    if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; wake(); return; }
    render(node.props.children);
  };
  const settled = async (holds: () => boolean): Promise<void> => {
    for (;;) {
      const next = new Promise<void>((resolve) => { waiting.push(resolve); });
      if (holds()) return;
      await next;
    }
  };
  // each page's own fragment listeners, by the load that added them: `land` takes a link the way the browser does on
  // the same document, where the page keeps the account's PCs it read
  // the account service's answer for its PCs waits while a test holds it (holdDirectory)
  let directoryHeld: Promise<void> = Promise.resolve();
  const holdDirectory = (): (() => void) => {
    const held = Promise.withResolvers<void>();
    directoryHeld = held.promise;
    return () => { directoryHeld = Promise.resolve(); held.resolve(); };
  };
  const fragmentListeners: { readonly load: number; readonly listener: EventListener }[] = [];
  let loads = 0;
  const listen = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "hashchange" && typeof listener === "function") fragmentListeners.push({ load: loads, listener });
    listen(type, listener, options);
  }) as typeof window.addEventListener;
  const mountAt = (entryUrl: string) => { loads++; return mountRelayShell({
    container: Object.create(null), entryUrl, shellVersion: "1.0.0", store, accountStore, ...(label === undefined ? {} : { label }),
    // these read the account's rows on the front page: a launch that leaves it for the PC (shell.test.tsx) does not run
    ...(new URL(entryUrl).pathname === "/" ? { navigatedSinceEntry: () => true } : {}),
    accountService: SERVICE, accountFetch: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      requests.push(path);
      switch (path) {
        case "/v1/pcs": await directoryHeld; return Response.json({ pcs: [entry] });
        case "/v1/devices/challenge": return release
          ? Response.json({ challenge_id: "12".repeat(16), challenge: "register-this-sign-in" })
          : new Response(null, { status: 404 });
        case "/v1/devices": {
          const { key, label: named } = JSON.parse(String(init?.body)) as { key: string; label?: string };
          registrationKeys.push(key);
          registrationLabels.push(named);
          if (key !== registrationKeys[0]) return new Response(null, { status: 409 });
          if (loseRegistrationReply && registrationKeys.length === 1) throw new TypeError("Registration reply lost after commit");
          return Response.json({ no: 7, key });
        }
        default: return service.fetch(input, init);
      }
    },
    createRoot: () => ({ render, unmount() {} }),
    renderApp: () => { apps++; appOpened.resolve(); wake(); return { render() {}, unmount() {} }; },
    pendingPush: { get: async () => undefined, clear: async () => {} },
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    navigate: (path) => {
      navigations.push(path);
      navigated.resolve(path);
      const sheet = props?.sheetJoin != null && props.scoped && ["confirm", "connecting", "compare", "failed"].includes(props.state.kind);
      if (phoneSheet && sheet && path.startsWith("/s/")) { props!.onCancel(); props!.onBack(); }
      wake();
    },
    open: (offer, options) => { const opening = open(offer, options, identity); wake(); return opening; },
  }); };
  /** `path` taken by the last page loaded, as a fragment change of its own document (joinPc's replace in a browser). */
  const land = (path: string): void => {
    const url = new URL(path, APP);
    Object.assign(window.location, { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash });
    for (const { load, listener } of fragmentListeners) if (load === loads) listener(new Event("hashchange"));
  };
  await mountAt(`${APP}/${new URL(returned).hash}`);
  const current = (): RelayShellProps => { if (props === undefined) throw new TypeError("Missing shell props"); return props; };
  // what the account's row lets this device do with the PC: open it by the account's key, or ask to join it
  const action = (): "open" | "join" => {
    const { state } = current();
    if (state.kind !== "empty" || state.account?.kind !== "signed-in" || state.account.pcs === null) throw new TypeError("Missing signed-in directory");
    const row = state.account.pcs[0];
    return row?.accountOpen === true && !isNewAccountPc(row, Date.now()) ? "open" : "join";
  };
  /** The join sheet on screen once this page read the account's PCs: what a press acts on, as on the page the PC's own load put it up on. */
  const sheetRead = (): Promise<void> => settled(() => props?.state.kind === "confirm" && props.state.account === "listed");
  return { accountStore, serverId, requests, registrationKeys, registrationLabels, navigations, navigated: navigated.promise, appOpened: appOpened.promise, current, action, apps: () => apps, settled, sheetRead, land, holdDirectory, reload: () => mountAt(`${APP}/`), openPage: () => mountAt(`${APP}/s/${serverId}/`), follow: (path: string) => mountAt(`${APP}${path}`) };
}

class Admitted extends RelayTransport {
  override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
}
const inADay = (): string => new Date(Date.now() + 23 * 60 * 60_000).toISOString();

it.each([
  ["a newly added account PC", inADay],
  // a window that does not parse may still be open: condition 3 fails closed (security-triage)
  ["an account PC whose new window does not parse", () => "garbage"],
])("A3: %s is marked New, its page waits for a press, and the press signs in with the account key", async (_case, newUntil) => {
  const attempts: boolean[] = [];
  const pressed = Promise.withResolvers<void>();
  const run = await accountPc({
    newUntil: newUntil(),
    open: async (_offer, options) => {
      attempts.push(options?.accountOpensAll === true);
      pressed.resolve();
      throw new RangeError("Stop after observing the requested connection");
    },
  });
  const action = run.action();
  await run.openPage();
  expect(attempts).toEqual([]);
  const path = run.navigations[0];
  if (path === undefined) throw new TypeError("Missing the PC's join screen");
  await run.follow(path);
  expect(run.current().state.kind).toBe("confirm");
  await run.sheetRead();
  expect(attempts).toEqual([]);
  expect(run.apps()).toBe(0);
  run.current().onPair();
  await pressed.promise;
  expect(attempts).toEqual([true]);
  // the account's row offers no quick Open
  expect(action).toBe("join");
});

/** A new PC's own page, then the join sheet it put up on that same page, read and waiting for its press. */
async function newPcSheet(run: Awaited<ReturnType<typeof accountPc>>): Promise<string> {
  await run.openPage();
  const path = run.navigations.at(-1);
  if (path === undefined || !path.startsWith(`/s/${run.serverId}/#offer=`)) throw new TypeError("Missing the PC's join sheet");
  run.land(path);
  await run.sheetRead();
  return path;
}

it("a press on a new PC's sheet opens it by the account key when the PC lets this device in; a reload asks for the press again", async () => {
  const attempts: boolean[] = [];
  const run = await accountPc({ newUntil: inADay(), open: async (offer, options) => { attempts.push(options?.accountOpensAll === true); return new Admitted(offer); } });
  const sheet = await newPcSheet(run);
  expect({ attempts, apps: run.apps() }).toEqual({ attempts: [], apps: 0 });
  run.current().onPair();
  await run.appOpened;
  expect({ attempts, apps: run.apps(), navigations: run.navigations }).toEqual({ attempts: [true], apps: 1, navigations: [sheet] });
  expect(browser.sessionStore.has("ovis-confirmed-pc")).toBe(false);
  // nothing was saved for it here: a reload of its page puts the sheet up again, and opens nothing by itself
  await run.openPage();
  expect({ attempts, apps: run.apps(), navigations: run.navigations.length }).toEqual({ attempts: [true], apps: 1, navigations: 2 });
  await run.follow(run.navigations[1]!);
  await run.sheetRead();
  expect({ attempts, apps: run.apps(), screen: run.current().state.kind }).toEqual({ attempts: [true], apps: 1, screen: "confirm" });
});

it("a launch's join card for a new PC asks the PC by a join and never by the account key", async () => {
  const attempts: boolean[] = [];
  const asked = Promise.withResolvers<void>();
  const run = await accountPc({ newUntil: inADay(), open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    asked.resolve();
    throw new RangeError("Stop at the join");
  } });
  // the card's mark, as the launch leaves for the PC (shell.tsx showFront): its page asks by itself, on a reload too
  browser.sessionStore.set("ovis-launch-join", run.serverId);
  await run.openPage();
  await run.follow(run.navigations[0]!);
  await asked.promise;
  expect({ attempts, apps: run.apps() }).toEqual({ attempts: [false], apps: 0 });
});

const refusals = [
  ["not_listed, twice", () => refused("not_listed"), 2],
  ["admission", () => refused("admission"), 1],
  // what a PC answers a key it does not list (server/relay/session.ts): never a removal here, since this device was never in
  ["auth_failed (a key the PC does not list)", () => new MuxProtocolError("auth_failed", ""), 1],
  ["a PC without the account's way in", () => new AccountOpenUnsupportedError(), 1],
] as const;

it.each(refusals)("a new PC that refuses the pressed account sign-in (%s) gets the join the press asked for, on the same sheet, with no second press", async (_case, refusal, tries) => {
  const attempts: boolean[] = [];
  const run = await accountPc({ newUntil: inADay(), phoneSheet: true, open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    if (options?.accountOpensAll === true) throw refusal();
    throw new RangeError("Stop at the join");
  } });
  const sheet = await newPcSheet(run);
  run.current().onPair();
  await run.settled(() => attempts.length === tries + 1);
  // no link taken on the way: on a phone, one would pop the sheet's entry and end the press on the front page
  expect({ attempts, navigations: run.navigations, apps: run.apps(), removed: removedPcs()[run.serverId], confirmed: browser.sessionStore.has("ovis-confirmed-pc") }).toEqual({
    attempts: [...Array(tries).fill(true), false], navigations: [sheet], apps: 0, removed: undefined, confirmed: false,
  });
});

it("a device its new PC removed gets only the join a press sent before, once: the PC's refusal of it ends the press, and nothing asks again by itself", async () => {
  const attempts: ("account" | "join")[] = [];
  let shownForApproval = 0;
  const run = await accountPc({ newUntil: inADay(), phoneSheet: true, open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll === true ? "account" : "join");
    // a removed key's account sign-in: no row stands for it on the PC (server/relay/session.ts)
    if (options?.accountOpensAll === true) throw new MuxProtocolError("auth_failed", "");
    // its join: the digits go up for a person to approve, and the PC turns it down (devices.ts pairRelayApproved)
    await options?.compare?.("123456");
    shownForApproval++;
    throw new MuxProtocolError("auth_failed", "");
  } });
  // the PC ended this device's session as a removed device's, which this page keeps (failed: markRemovedPc)
  markRemovedPc(run.serverId, "removed");
  const sheet = await newPcSheet(run);
  jest.useFakeTimers();
  run.current().onPair();
  await run.settled(() => { const { state } = run.current(); return state.kind === "failed" && state.failure === "pair-declined"; });
  expect(browser.sessionStore.has("ovis-confirmed-pc")).toBe(false);
  // past every hold and retry this page keeps: the account way is not tried again, nor the join
  jest.advanceTimersByTime(30 * 60_000);
  for (let turn = 0; turn < 500; turn++) await Promise.resolve();
  expect({ attempts, shownForApproval, apps: run.apps(), navigations: run.navigations, removed: removedPcs()[run.serverId] }).toEqual({
    attempts: ["account", "join"], shownForApproval: 1, apps: 0, navigations: [sheet], removed: "removed",
  });
  // a reload asks for the press again and sends nothing
  await run.openPage();
  expect(attempts).toHaveLength(2);
});

it("wire: a new PC that does not list this device's key answers auth_failed, and the press goes on to the join", async () => {
  let auths = 0, joins = 0;
  const run = await accountPc({ newUntil: inADay(), phoneSheet: true, open: (offer, options, identity) => {
    if (options?.accountOpensAll !== true) { joins++; throw new RangeError("Stop at the join"); }
    return openRelayTransport(offer, { ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: () => {
      auths++;
      return encodeFrame({ type: FrameType.SESSION_ERROR, stream_id: 0, flags: 0, payload: { code: "auth_failed", message: "" } });
    } }) });
  } });
  const sheet = await newPcSheet(run);
  run.current().onPair();
  await run.settled(() => joins === 1);
  expect({ auths, joins, navigations: run.navigations, removed: removedPcs()[run.serverId] }).toEqual({ auths: 1, joins: 1, navigations: [sheet], removed: undefined });
});

it("a new PC that holds the pressed account sign-in shows its hold, then opens when the PC lets this device in", async () => {
  const delay = 3_000;
  let until = "";
  const attempts: boolean[] = [];
  const run = await accountPc({ newUntil: inADay(), open: async (offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    if (attempts.length === 1) throw refused("held", { reason: "join_hold", until });
    return new Admitted(offer);
  } });
  await newPcSheet(run);
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  run.current().onPair();
  await run.settled(() => { const { state } = run.current(); return state.kind === "connecting" && state.hold !== undefined; });
  expect(attempts).toEqual([true]);
  jest.advanceTimersByTime(delay);
  await run.appOpened;
  expect({ attempts, apps: run.apps(), navigations: run.navigations.length }).toEqual({ attempts: [true, true], apps: 1, navigations: 1 });
});

it("a PC past its 24 hours that answers its page's account sign-in with auth_failed says this device was removed, as before: only a press on a new PC's sheet goes on to the join", async () => {
  let attempts = 0;
  const run = await accountPc({ open: async () => { attempts++; throw new MuxProtocolError("auth_failed", ""); } });
  await run.openPage();
  expect({ attempts, state: run.current().state, navigations: run.navigations, removed: removedPcs()[run.serverId] }).toEqual({
    attempts: 1, state: expect.objectContaining({ kind: "failed", failure: "revoked", server_id: run.serverId }), navigations: [], removed: "removed",
  });
});

it("a new PC opened by the press that later ends its session with auth_failed says this device was removed, and asks to join by nothing", async () => {
  let fatal: ((error: Error) => void) | undefined;
  const attempts: boolean[] = [];
  const run = await accountPc({ newUntil: inADay(), open: async (offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    fatal = options?.onFatal;
    return new Admitted(offer);
  } });
  const sheet = await newPcSheet(run);
  run.current().onPair();
  await run.appOpened;
  if (fatal === undefined) throw new TypeError("the open session was given no way to end");
  fatal(new MuxProtocolError("auth_failed", ""));
  await run.settled(() => run.current().state.kind === "failed");
  for (let turn = 0; turn < 500; turn++) await Promise.resolve();
  expect({ attempts, state: run.current().state, navigations: run.navigations, removed: removedPcs()[run.serverId] }).toEqual({
    attempts: [true], state: expect.objectContaining({ kind: "failed", failure: "revoked", server_id: run.serverId }), navigations: [sheet], removed: "removed",
  });
});

it("a press made while the sheet's page still reads the account's PCs waits for them, then signs in by the account key", async () => {
  const attempts: boolean[] = [];
  const run = await accountPc({ newUntil: inADay(), open: async (offer, options) => { attempts.push(options?.accountOpensAll === true); return new Admitted(offer); } });
  await run.openPage();
  const release = run.holdDirectory();
  run.land(run.navigations[0]!);
  // the sheet is up, and its page's read of the account's PCs (arrived) is not back yet
  await run.settled(() => { const { state } = run.current(); return state.kind === "confirm" && state.account === "checking"; });
  run.current().onPair();
  for (let turn = 0; turn < 500; turn++) await Promise.resolve();
  expect(attempts).toEqual([]);
  release();
  await run.appOpened;
  expect({ attempts, apps: run.apps(), navigations: run.navigations.length }).toEqual({ attempts: [true], apps: 1, navigations: 1 });
});

it("a press on a new PC's sheet with no registered key here sends the join, as before", async () => {
  const attempts: boolean[] = [];
  const asked = Promise.withResolvers<void>();
  const run = await accountPc({ release: false, newUntil: inADay(), open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    asked.resolve();
    throw new RangeError("Stop at the join");
  } });
  await newPcSheet(run);
  run.current().onPair();
  await asked.promise;
  expect(attempts).toEqual([false]);
});

it("a PC past its 24 hours whose account sign-in was refused at its load keeps asking for the press, which sends the join alone", async () => {
  const attempts: boolean[] = [];
  const run = await accountPc({ open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll === true);
    if (options?.accountOpensAll === true) throw refused("admission");
    throw new RangeError("Stop at the join");
  } });
  await run.openPage();
  expect({ attempts, navigations: run.navigations, confirmed: browser.sessionStore.has("ovis-confirmed-pc") }).toEqual({
    attempts: [true], navigations: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], confirmed: false,
  });
  run.land(run.navigations[0]!);
  await run.sheetRead();
  expect(attempts).toEqual([true]);
  run.current().onPair();
  await run.settled(() => attempts.length === 2);
  expect(attempts).toEqual([true, false]);
});

it("T34, P18: a normal sign-in opens a listed unpaired PC as its registered account row", async () => {
  const admissions: { feature: boolean | undefined; row: string | null | undefined; key: string | undefined }[] = [];
  class Admitted extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }
  const run = await accountPc({ open: async (offer, options) => {
    const row = await options?.store?.get(offer.server_id);
    admissions.push({ feature: options?.accountOpensAll, row: row?.device_id, key: row?.public_spki });
    return new Admitted(offer);
  } });
  const key = await run.accountStore.get("signin_key");
  const action = run.action();
  await run.openPage();
  expect({
    number: key?.no, action,
    admissions, apps: run.apps(), navigations: run.navigations,
  }).toEqual({
    number: 7, action: "open",
    admissions: key ? [{ feature: true, row: accountDeviceId(run.serverId, key.key.public_spki), key: key.key.public_spki }] : [],
    apps: 1, navigations: [],
  });
});

it("T34: a sign-in on the hosted page registers its key under this device's name, which the PC's notice and lists then show", async () => {
  const run = await accountPc({ label: "Chrome (Android)", open: () => { throw new TypeError("no PC opens in this test"); } });
  expect(run.registrationLabels).toEqual(["Chrome (Android)"]);
});

it("C3: a reload of the join card a launch put up, not pressed yet, asks again and opens nothing by the account's key", async () => {
  const run = await accountPc({ open: () => { throw new TypeError("nothing may open before the press"); } });
  browser.sessionStore.set("ovis-launch-join", run.serverId);
  await run.openPage();
  expect({ apps: run.apps(), navigations: run.navigations }).toEqual({ apps: 0, navigations: [expect.stringContaining(`/s/${run.serverId}/#offer=`)] });
  expect(browser.sessionStore.get("ovis-launch-join")).toBe(run.serverId);
  // back on the front page (Back, Forward or a reload into the card keep it), only a press on that PC's link ends it
  await run.reload();
  expect(browser.sessionStore.get("ovis-launch-join")).toBe(run.serverId);
  const click = new Event("click");
  Object.defineProperty(click, "target", { value: { closest: () => ({ getAttribute: () => `/s/${run.serverId}/` }) } });
  browser.page.dispatchEvent(click);
  expect(browser.sessionStore.has("ovis-launch-join")).toBe(false);
});

it("a PC just added to the account that no device is in yet opens on its own page as a new PC, typing the number it shows", async () => {
  const run = await accountPc({ release: false, seen: false, open: () => { throw new TypeError("nothing opens before the number"); } });
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#offer=`)]);
  expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "new", server_id: run.serverId, alone: true });
  expect(browser.sessionStore.get("ovis-typed-join")).toBe(run.serverId);
});

it("a just-added PC that does not take the account's way in falls back to the new-PC pairing, typing its number", async () => {
  const run = await accountPc({ seen: false, open: async () => { throw new AccountOpenUnsupportedError(); } });
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#offer=`)]);
  expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "new", server_id: run.serverId, alone: true });
  expect(browser.sessionStore.get("ovis-typed-join")).toBe(run.serverId);
});

it("P18: an account service without the release only receives the challenge probe and still offers Join", async () => {
  const run = await accountPc({ release: false, open: () => { throw new TypeError("Join must wait for confirmation"); } });
  expect(run.action()).toBe("join");
  expect(run.requests.filter((path) => path.startsWith("/v1/devices"))).toEqual(["/v1/devices/challenge"]);
  expect(await run.accountStore.get("signin_key")).toBeUndefined();
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#`)]);
});

const refused = (code: string, hold?: HoldState) =>
  Object.assign(new MuxProtocolError("protocol_error", "PC refused"), { code, ...(hold === undefined ? {} : { hold }) });

it.each([
  ["account_unreachable", "account-unreachable", "Desk could not reach your Ovis account"],
  ["account_readd_required", "account-readd", "Add Desk to your account again"],
] as const)("listing confirmation: %s says why on the PC's page, with Try again, and starts no pairing", async (code, failure, title) => {
  let attempts = 0;
  const run = await accountPc({ open: async () => { attempts++; throw refused(code); } });
  await run.openPage();
  expect(run.current().state).toMatchObject({ kind: "failed", failure });
  const screen = renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayShell, run.current())));
  expect(screen).toContain(title);
  expect(screen).toContain("Try again");
  expect({ attempts, navigations: run.navigations, key: (await run.accountStore.get("signin_key"))?.no }).toEqual({ attempts: 1, navigations: [], key: 7 });
});

it.each([
  ["account_unreachable", "account-unreachable"],
  ["account_readd_required", "account-readd"],
] as const)("listing confirmation wire: %s in answer to AUTH reaches a client that offered the feature", async (code, failure) => {
  const offered: boolean[] = [];
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true,
      hello: (frame) => { offered.push(frame.payload.features.includes("account-listing-errors-1")); },
      auth: () => accountOpenRefusalFrame(code, code) }),
  }) });
  await run.openPage();
  const state = run.current().state;
  expect<object>({ offered, screen: state.kind === "failed" ? state.failure : state.kind, navigations: run.navigations }).toEqual({ offered: [true], screen: failure, navigations: [] });
});

it("P18, T34: reloading after a lost registration reply opens the PC with the same sign-in key", async () => {
  const run = await accountPc({ loseRegistrationReply: true, open: async (offer) => new class extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }(offer) });
  const pending = await run.accountStore.get("signin_key");
  if (pending === undefined) throw new TypeError("Missing pending registration");
  expect(pending.no).toBeNull();
  await run.reload();
  expect(run.action()).toBe("open");
  await run.openPage();
  expect(run.apps()).toBe(1);
  expect(run.registrationKeys).toEqual([pending.key.public_spki, pending.key.public_spki]);
});

it("P18, T34: refreshing the same shell after a lost registration reply opens the PC with the same key", async () => {
  const run = await accountPc({ loseRegistrationReply: true, open: async (offer) => new class extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }(offer) });
  const pending = await run.accountStore.get("signin_key");
  if (pending === undefined) throw new TypeError("Missing pending registration");
  expect(pending.no).toBeNull();

  await run.current().onRefreshAccount?.();

  expect(run.action()).toBe("open");
  expect(run.registrationKeys).toEqual([pending.key.public_spki, pending.key.public_spki]);
});

it.each([false, true])("G5: an old PC (provisional WELCOME: %s) gets no account AUTH and offers pairing", async (provisional) => {
  let auths = 0;
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [], provisional, auth: () => {
      auths++;
      return encodeFrame({ type: FrameType.SESSION_ERROR, stream_id: 0, flags: 0, payload: { code: "auth_failed", message: "" } });
    } }),
  }) });
  await run.openPage();
  expect({ auths, navigation: run.navigations, state: run.current().state.kind }).toEqual({
    auths: 0, navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], state: "connecting",
  });
});

it.each([
  ["not_listed", [true, true]],
  ["admission", [true]],
] as const)("T34, G5: %s offers the same PC's pairing path after the allowed account attempts", async (code, expected) => {
  const attempts: (boolean | undefined)[] = [];
  const run = await accountPc({ open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll);
    throw refused(code);
  } });
  await run.openPage();
  expect({ attempts, navigation: run.navigations, apps: run.apps() }).toEqual({
    attempts: [...expected], navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], apps: 0,
  });
});

it("T34, T53, P17: the held device shows the PC's deadline and retries when it expires", async () => {
  const delay = 4_321;
  const expired = Promise.withResolvers<boolean | undefined>();
  let attempts = 0;
  let until = "";
  const run = await accountPc({ open: async (_offer, options) => {
    if (++attempts === 1) throw refused("held", { reason: "join_hold", until });
    expired.resolve(options?.accountOpensAll);
    throw refused("admission");
  } });
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  await run.openPage();
  expect(run.current().state.kind).toBe("connecting");
  const screen = renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayShell, run.current())));
  expect(screen).toContain('class="join-wait"');
  expect(screen).toContain("opens in 5 s");
  jest.advanceTimersByTime(delay - 1);
  expect(attempts).toBe(1);
  jest.advanceTimersByTime(1);
  expect(await expired.promise).toBe(true);
});

it.each<HoldState>([{ reason: "catching_up" }, { reason: "join_hold", until: null }])("P7, T53: a temporary hold without a deadline retries: $reason", async (hold) => {
  let attempts = 0;
  const run = await accountPc({ open: async (offer) => {
    if (++attempts === 1) throw refused("held", hold);
    return new class extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
    }(offer);
  } });
  jest.useFakeTimers();
  await run.openPage();
  jest.advanceTimersByTime(999);
  expect({ kind: run.current().state.kind, attempts }).toEqual({ kind: "connecting", attempts: 1 });
  jest.advanceTimersByTime(1);
  await run.appOpened;
  expect({ attempts, apps: run.apps(), navigations: run.navigations }).toEqual({ attempts: 2, apps: 1, navigations: [] });
});

it("T53: a hold deadline already past on this clock backs off rather than reconnecting immediately", async () => {
  let attempts = 0;
  let until = "";
  const run = await accountPc({ open: async () => {
    if (++attempts <= 2) throw refused("held", { reason: "join_hold", until });
    throw refused("admission");
  } });
  jest.useFakeTimers();
  until = new Date(Date.now() - 1_000).toISOString();
  await run.openPage();

  for (const [advance, expected] of [[999, 1], [1, 2], [1_999, 2], [1, 3]] as const) {
    jest.advanceTimersByTime(advance);
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    expect(attempts).toBe(expected);
  }
});

it.each([
  { code: "not_listed", auths: 2, screen: "connecting", pair: true },
  { code: "admission", auths: 1, screen: "connecting", pair: true },
  { code: "held", hold: { reason: "catching_up" }, auths: 1, screen: "connecting", pair: false },
  { code: "held", hold: { reason: "frozen", block: "b".repeat(64) }, auths: 1, screen: "connecting", pair: false },
  { code: "auth_revoked", auths: 1, screen: "revoked", pair: false },
] as const)("T34, G5, P7 wire: $code follows the decoded code, not the message 'held'", async (scenario) => {
  let auths = 0;
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: () => {
      auths++;
      return accountOpenRefusalFrame(scenario.code, "held", "hold" in scenario ? scenario.hold : undefined);
    } }),
  }) });
  jest.useFakeTimers();
  await run.openPage();
  const state = run.current().state;
  expect({ auths, screen: state.kind === "failed" ? state.failure : state.kind, navigation: run.navigations }).toEqual({
    auths: scenario.auths, screen: scenario.screen,
    navigation: scenario.pair ? [expect.stringContaining(`/s/${run.serverId}/#offer=`)] : [],
  });
});

it("T53, P17 wire: a held refusal whose notice is not published yet reaches the shell as a hold with no deadline", async () => {
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: () => accountOpenRefusalFrame("held", "", { reason: "join_hold", until: null }) }),
  }) });
  jest.useFakeTimers();
  await run.openPage();
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until: null } });
});

it("OD3, T53, P17 wire: a held device asks again within a second, so when the PC lets it in early (It's me) the app opens before the deadline", async () => {
  const rows: string[] = [];
  let until = "";
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: (frame) => {
      const device_id = frame.payload.device_id;
      rows.push(device_id);
      return rows.length === 1
        ? accountOpenRefusalFrame("held", "", { reason: "join_hold", until })
        : encodeFrame({ type: FrameType.AUTH_OK, stream_id: 0, flags: 0, payload: { device_id, session_id: "cd".repeat(16), role: "drive" } });
    } }),
  }) });
  const key = await run.accountStore.get("signin_key");
  if (key === undefined) throw new TypeError("Missing registered key");
  const row = accountDeviceId(run.serverId, key.key.public_spki);
  jest.useFakeTimers();
  until = new Date(Date.now() + 10_000).toISOString();
  await run.openPage();
  expect({ rows, apps: run.apps() }).toEqual({ rows: [row], apps: 0 });
  jest.advanceTimersByTime(999);
  expect({ rows, apps: run.apps() }).toEqual({ rows: [row], apps: 0 });
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until } });
  jest.advanceTimersByTime(1);
  await run.appOpened;
  expect({ rows, apps: run.apps(), navigations: run.navigations }).toEqual({ rows: [row, row], apps: 1, navigations: [] });
});

it("T34 wire: the shell stays Connecting until the decoded hold deadline, then retries AUTH", async () => {
  const delay = 900;
  let until = "";
  const rows: string[] = [];
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: (frame) => {
      rows.push(frame.payload.device_id);
      return rows.length === 1
        ? accountOpenRefusalFrame("held", "", { reason: "join_hold", until })
        : accountOpenRefusalFrame("admission", "");
    } }),
  }) });
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  await run.openPage();
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until } });
  jest.advanceTimersByTime(delay - 1);
  expect(rows).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(await run.navigated).toContain(`/s/${run.serverId}/#offer=`);
  const key = await run.accountStore.get("signin_key");
  if (key === undefined) throw new TypeError("Missing registered key");
  expect(rows).toEqual(Array(2).fill(accountDeviceId(run.serverId, key.key.public_spki)));
});
