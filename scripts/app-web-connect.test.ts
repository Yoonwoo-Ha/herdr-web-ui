import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

/** The phone app's own page (app/web), served as the app serves it. */
const WEB = new URL("../app/web/", import.meta.url);
// skipped, not failed, on a machine with no browser to drive (the browser lane always has one)
const noBrowser = !existsSync(chromePath());
// a page's own waits are 5 s each, and a test may wait twice
setDefaultTimeout(20_000);

let browser: Browser;
let page: Page;
/** what the page threw: none, in every test */
let thrown: string[] = [];
beforeAll(async () => { if (!noBrowser) browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] }); });
afterEach(async () => {
  await page?.close();
  expect(thrown).toEqual([]);
  thrown = [];
});
afterAll(async () => { await browser?.close(); });

const SCOPE = "https://app.ovis.sh/s/0123456789abcdef0123456789abcdef/";
const SSH_PC = { origin: "http://127.0.0.1:47320", label: "me@studio", user: "me", host: "studio.lan", port: 22, auth: "phone-key", keyType: "", hostKeyAlgorithm: "ssh-ed25519", fingerprint: "SHA256:abc" };

interface Options {
  /** the build's first screen (APP_HOME in shell.js): this page is one column only where it stands in for the hosted one */
  readonly home?: "hosted" | "bundled";
  readonly account?: boolean;
  readonly state?: Record<string, unknown>;
  readonly locale?: string;
  readonly platform?: "ios" | "android";
  /** the SSH PCs OvisSsh lists; undefined: an app without OvisSsh */
  readonly ssh?: readonly Record<string, unknown>[];
  /** what HerdrShell answers to the methods named (takeSshSetup, tailscale, …) */
  readonly answers?: Record<string, unknown>;
  /** what OvisSsh answers to the methods named (remove, …) */
  readonly sshAnswers?: Record<string, unknown>;
}

/**
 * The page with a stub of the app's bridge: HerdrShell's getState answers `state` with `saved`, and every call the page
 * makes is kept in `window.calls` as `<plugin>.<method> <args>`.
 */
async function chooser(saved: string[], options: Options = {}) {
  const { home = "hosted", account = true, state = {}, locale = "en-US", platform = "ios", ssh, answers = {}, sshAnswers = {} } = options;
  page = await browser.newPage({ locale });
  page.on("pageerror", (error) => thrown.push(error.message));
  await page.addInitScript(({ saved, state, platform, ssh, answers, sshAnswers }) => {
    const headers = [{ name: "HerdrShell", methods: [] }, ...(ssh ? [{ name: "OvisSsh", methods: [] }] : [])];
    const calls: string[] = [];
    Object.assign(window, { calls, Capacitor: { PluginHeaders: headers, getPlatform: () => platform, nativePromise: async (plugin: string, method: string, args: Record<string, unknown> = {}) => {
      calls.push(`${plugin}.${method} ${JSON.stringify(args)}`);
      if (plugin === "HerdrShell" && method === "getState") return { saved, names: {}, ...state };
      if (plugin === "HerdrShell" && method in answers) return answers[method];
      if (plugin === "OvisSsh" && method === "list") return { pcs: ssh ?? [] };
      if (plugin === "OvisSsh" && method in sshAnswers) return sshAnswers[method];
      if (plugin === "OvisSsh" && method === "known") throw new Error("no answer");
      return {};
    } } });
  }, { saved, state, platform, ssh, answers, sshAnswers });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // the account service names its sign-ins (GET /v1/providers): two of the three
    if (url.hostname !== "chooser.test") return route.fulfill({ json: { providers: ["github", "apple"], device: ["github"] } });
    if (url.pathname === "/demo/index.html") return route.fulfill({ contentType: "text/html", body: "<title>demo</title>" });
    const file = Bun.file(new URL(`.${url.pathname}`, WEB));
    if (!(await file.exists())) return route.fulfill({ status: 404 });
    let text = await file.text();
    if (url.pathname === "/shell.js") {
      if (!account) text = text.replace("ACCOUNT_SIGN_IN = true", "ACCOUNT_SIGN_IN = false");
      if (home !== "hosted") text = text.replace('APP_HOME = "hosted"', `APP_HOME = "${home}"`);
    }
    return route.fulfill({ contentType: file.type, body: text });
  });
  await page.goto("https://chooser.test/index.html");
  await page.locator("#connect-screen > *").first().waitFor({ timeout: 5_000 });
}

/**
 * The first call the page makes to the app that starts with `prefix` (`<plugin>.<method>`) once `press` is done, or,
 * with no press, since the page loaded.
 */
async function called(prefix: string, press?: () => Promise<void>): Promise<string> {
  const from = press ? await page.evaluate(() => (window as unknown as { calls: string[] }).calls.length) : 0;
  await press?.();
  const found = await page.waitForFunction(([prefix, from]) => (window as unknown as { calls: string[] }).calls.slice(from).find((call) => call.startsWith(prefix)) ?? false, [prefix, from] as const, { timeout: 5_000 });
  return `call:${await found.jsonValue()}`;
}

/** The app's method the page asks for (`HerdrShell.<method>`) once `press` is done, its arguments left out. */
async function asked(press: () => Promise<void>): Promise<string> {
  const text = await called("HerdrShell.", press);
  return text.replace(/^call:HerdrShell\.(\w+).*$/, "asked:$1");
}

describe("standing in for the hosted screen (a hosted-home build)", () => {
  test.skipIf(noBrowser)("is one column: no tabs, no sign-in, the address field, QR and SSH, then every PC this phone saved", async () => {
    await chooser(["https://desk.example.ts.net", "http://192.168.0.12:7421", SCOPE, SSH_PC.origin], { state: { fallback: true, names: { [SCOPE]: "Studio PC" } }, ssh: [SSH_PC] });
    await page.locator("#pcs li").first().waitFor({ timeout: 5_000 });
    expect(await page.locator('[role="tab"]').count()).toBe(0);
    expect(await page.locator("[data-provider]").count()).toBe(0);
    expect(await page.getByText("Ovis relay").count()).toBe(0);
    // in the order of the page: the line, the address field, QR, SSH, the list
    const order = await page.evaluate(() => ["#offline", "#web-address", "[data-scan]", "#ssh-way", "#pcs"].map((selector) => document.querySelector(selector)).map((element, index, all) => index === 0 || (all[index - 1]!.compareDocumentPosition(element!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
    expect(order).toEqual([true, true, true, true, true]);
    const rows = await page.locator("#pcs > li:not(.manage-row) .pc-name").allTextContents();
    expect(rows).toEqual(["Studio PC", "desk", "192.168.0.12:7421", "me@studio"]);
    expect(await page.locator("#pcs .pc-tag").allTextContents()).toEqual(["Relay", "Tailscale", "Address", "SSH"]);
    // Forget where it is today, Manage on the SSH PC
    expect(await page.getByRole("button", { name: "Forget desk", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Forget Studio PC", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Manage me@studio", exact: true }).count()).toBe(1);
  });

  test.skipIf(noBrowser)("says it cannot reach the internet, and Try again asks for the hosted screen", async () => {
    await chooser([], { state: { fallback: true } });
    const line = page.locator("#offline");
    await line.waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator("#offline-title").textContent()).toBe("Can't connect to the internet");
    expect(await page.locator("#title").isVisible()).toBe(false);
    expect(await asked(() => page.getByRole("button", { name: "Try again", exact: true }).click())).toBe("asked:goHome");
  });

  test.skipIf(noBrowser)("is in Korean on a Korean phone, in the hosted page's words", async () => {
    await chooser([], { state: { fallback: true }, locale: "ko-KR" });
    await page.locator("#offline").waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator("#offline-title").textContent()).toBe("인터넷에 연결할 수 없어요");
    expect(await page.locator("#try-home").textContent()).toBe("다시 시도");
    expect(await page.locator("#direct-label").textContent()).toBe("주소로 직접 연결");
    expect(await page.locator("#ssh-way .way-title").textContent()).toBe("SSH로 연결");
  });

  test.skipIf(noBrowser)("opens a PC typed in its one address field, and warns once before a public http address", async () => {
    await chooser([], { state: { fallback: true } });
    await page.locator("#web-address").fill("http://desk.example.org:7317");
    await page.locator("#web-address").press("Enter");
    await page.locator("#error").filter({ hasText: "plain http" }).waitFor({ timeout: 5_000 });
    expect(await called("HerdrShell.open", () => page.locator("#web-address").press("Enter"))).toContain('"url":"http://desk.example.org:7317/"');
  });

  test.skipIf(noBrowser)("opens a saved relay PC, which the hosted page saves by its scope, from its row", async () => {
    await chooser([SCOPE], { state: { fallback: true } });
    const row = page.getByRole("button", { name: "Open 0123456789ab", exact: true });
    await row.waitFor({ timeout: 5_000 });
    expect(await called("HerdrShell.open", () => row.click())).toContain(`"url":"${SCOPE}#picked"`);
  });

  test.skipIf(noBrowser)("keeps the scan of a QR code, which works on a home network with no internet", async () => {
    await chooser([], { state: { fallback: true } });
    expect(await page.locator("[data-scan]").count()).toBe(1);
    expect(await page.locator("[data-scan] .way-title").textContent()).toBe("Scan a QR code");
  });

  test.skipIf(noBrowser)("leads its SSH row to the SSH field, which opens the SSH setup with the login typed", async () => {
    await chooser([], { state: { fallback: true }, ssh: [] });
    const way = page.locator("#ssh-way");
    expect(await way.getAttribute("aria-expanded")).toBe("false");
    await way.click();
    await page.locator("#address").fill("me@studio.lan:2222");
    expect(await called("OvisSsh.add", () => page.locator("#address").press("Enter"))).toBe('call:OvisSsh.add {"user":"me","host":"studio.lan","port":2222}');
  });

  test.skipIf(noBrowser)("takes no SSH setup over from another page: the app opens that setup over the page that asked", async () => {
    await chooser([], { state: { back: "home" }, ssh: [], answers: { takeSshSetup: { asked: true, target: "me@studio.lan" } } });
    await page.locator("#pcs-section").waitFor({ state: "attached", timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls.filter((call) => /takeSshSetup|OvisSsh\.add/.test(call)))).toEqual([]);
    expect(await page.locator("#ssh-add").isVisible()).toBe(false);
  });

  test.skipIf(noBrowser)("asked for to manage an SSH PC, opens that PC's Manage", async () => {
    await chooser([SSH_PC.origin], { state: { manage: true, back: "home", last: SSH_PC.origin }, ssh: [SSH_PC] });
    const panel = page.locator(".manage");
    await panel.waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.getByRole("button", { name: "Manage me@studio", exact: true }).getAttribute("aria-expanded")).toBe("true");
    for (const action of ["Rename", "Show this phone's key", "Set up again", "Forget host key", "Remove"]) {
      expect([action, await panel.getByRole("button", { name: action, exact: true }).count()]).toEqual([action, 1]);
    }
    expect(await page.locator("#back-to-pc").isVisible()).toBe(true);
  });

  test.skipIf(noBrowser)("says under the list, where Manage is, that a removed SSH PC kept this phone's key", async () => {
    // many PCs above it, so the list is far from the address field at the top
    const others = Array.from({ length: 12 }, (_, n) => `http://192.168.0.${n + 10}:7421`);
    await chooser([...others, SSH_PC.origin], { state: { manage: true, back: "home", last: SSH_PC.origin }, ssh: [SSH_PC], sshAnswers: { remove: { remote: "failed", reason: "no route" } } });
    const panel = page.locator(".manage");
    await panel.waitFor({ state: "visible", timeout: 5_000 });
    await panel.getByRole("button", { name: "Remove", exact: true }).click();
    await panel.getByRole("button", { name: "Remove", exact: true }).last().click();
    const error = page.locator("#error");
    await error.filter({ hasText: "could not be taken out of the PC" }).waitFor({ timeout: 5_000 });
    expect(await page.evaluate(() => document.getElementById("pcs-section")!.nextElementSibling?.id)).toBe("feedback");
    expect(await error.isVisible()).toBe(true);
  });

  test.skipIf(noBrowser)("keeps its live regions in the page while they are empty, so what they say later is announced", async () => {
    await chooser([SSH_PC.origin], { state: { manage: true, back: "home", last: SSH_PC.origin }, ssh: [SSH_PC] });
    await page.locator(".manage").waitFor({ state: "visible", timeout: 5_000 });
    const shown = await page.evaluate(() => ["#feedback", ".status", "#status-text", ".manage .said"].map((selector) => [selector, getComputedStyle(document.querySelector(selector)!).display]));
    for (const [selector, display] of shown) expect([selector, display]).not.toEqual([selector, "none"]);
  });

  test.skipIf(noBrowser)("opened to choose another PC, goes back to it and marks it in use now", async () => {
    const pc = "https://desk.example.ts.net";
    await chooser([pc], { state: { fallback: true, current: pc, choosing: true, back: "current" } });
    const back = page.locator("#back-to-pc");
    await back.waitFor({ state: "visible", timeout: 5_000 });
    expect(await back.textContent()).toBe("‹ desk");
    expect(await page.locator("#pcs .pc-on").textContent()).toBe("In use now");
    expect(await asked(() => back.click())).toBe("asked:backToCurrent");
  });

  test.skipIf(noBrowser)("opened by the hosted screen for what only it can take, leads back to that screen", async () => {
    await chooser([], { state: { back: "home" } });
    const back = page.locator("#back-to-pc");
    await back.waitFor({ state: "visible", timeout: 5_000 });
    expect(await back.getAttribute("aria-label")).toBe("Back to Connect a PC");
    expect(await page.locator("#offline").isVisible()).toBe(false);
    expect(await page.locator("#title").textContent()).toBe("Connect a PC");
    expect(await asked(() => back.click())).toBe("asked:goHome");
  });

  test.skipIf(noBrowser)("opened over a PC that stays current, with nobody choosing, leads back to that PC", async () => {
    // a pairing link from outside the app that this page refused: the app opens that PC next, so Back says so
    const pc = "https://desk.example.ts.net";
    await chooser([pc], { state: { current: pc, choosing: false, back: "current" } });
    const back = page.locator("#back-to-pc");
    await back.waitFor({ state: "visible", timeout: 5_000 });
    expect(await back.textContent()).toBe("‹ desk");
    expect(await back.getAttribute("aria-label")).toBe("Back to desk");
    expect(await asked(() => back.click())).toBe("asked:backToCurrent");
  });

  test.skipIf(noBrowser)("asks the app for its demo when the word demo is typed", async () => {
    await chooser([], { state: { fallback: true } });
    await page.locator("#web-address").fill("demo");
    expect(await asked(() => page.locator("#web-address").press("Enter"))).toBe("asked:openDemo");
    expect(new URL(page.url()).pathname).toBe("/index.html");
  });

  test.skipIf(noBrowser)("keeps the field with Tailscale off on Android, and says how to turn it on once a Tailscale address is in play", async () => {
    await chooser([], { state: { fallback: true }, platform: "android", answers: { tailscale: { on: false } } });
    await called("HerdrShell.tailscale");
    const off = page.locator("#tailscale-off");
    // a phone with no PC on Tailscale is not told about it until it types a Tailscale address
    expect(await off.isVisible()).toBe(false);
    await page.locator("#web-address").fill("desk.tail1234.ts.net");
    await off.waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator("#web-address").isVisible()).toBe(true);
    expect(await asked(() => off.getByRole("button", { name: "Open Tailscale", exact: true }).click())).toBe("asked:openTailscale");
  });

  test.skipIf(noBrowser)("says Tailscale is off at once where a PC on Tailscale is listed", async () => {
    await chooser(["https://desk.tail1234.ts.net"], { state: { fallback: true }, platform: "android", answers: { tailscale: { on: false } } });
    await page.locator("#tailscale-off").waitFor({ state: "visible", timeout: 5_000 });
  });

  test.skipIf(noBrowser)("a broken saved address does not prevent opening a later saved public HTTP PC", async () => {
    const pc = "http://desk.example.org:7317";
    await chooser(["not an address", pc], { state: { fallback: true } });
    const row = page.getByRole("button", { name: "Open desk.example.org:7317", exact: true });
    await row.waitFor({ timeout: 5_000 });
    expect(await called("HerdrShell.open", () => row.click())).toContain(`"url":"${pc}/"`);
  });
});

describe("a build without the account that still opens the hosted screen first", () => {
  test.skipIf(noBrowser)("keeps the tabs, without the relay tab, and says it cannot reach the internet with Try again", async () => {
    await chooser([], { account: false, state: { fallback: true } });
    const line = page.locator("#offline");
    await line.waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator('[role="tab"]:visible').count()).toBe(2);
    expect(await page.locator("#tab-tailscale").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#offline-title").textContent()).toBe("Can't connect to the internet");
    expect(await asked(() => page.locator("#try-home").click())).toBe("asked:goHome");
  });
});

describe("a bundled-home build's first screen", () => {
  test.skipIf(noBrowser)("names its sign-ins in the hosted screen's Korean", async () => {
    await chooser([], { home: "bundled", locale: "ko-KR" });
    await page.getByRole("button", { name: "Apple로 계속하기", exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.getByRole("button", { name: "GitHub로 계속하기", exact: true }).isVisible()).toBe(true);
  });

  test.skipIf(noBrowser)("keeps the three tabs, the sign-in buttons and every list", async () => {
    await chooser([], { home: "bundled" });
    expect(await page.locator('[role="tab"]:visible').count()).toBe(3);
    // the sign-ins the account service names, and no other
    // in the hosted screen's words (Continue with …)
    await page.getByRole("button", { name: "Continue with Apple", exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.getByRole("button", { name: "Continue with GitHub", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Continue with Google", exact: true }).isVisible()).toBe(false);
    expect(await page.locator("#offline").isVisible()).toBe(false);
    for (const list of ["#relay-pcs", "#tailnet", "#ssh-pcs"]) expect([list, await page.locator(list).count()]).toEqual([list, 1]);
  });

  test.skipIf(noBrowser)("has no relay tab in a build without the account", async () => {
    await chooser([], { home: "bundled", account: false });
    expect(await page.locator('[role="tab"]:visible').count()).toBe(2);
    expect(await page.locator("#tab-tailscale").getAttribute("aria-selected")).toBe("true");
  });

  test.skipIf(noBrowser)("opens a PC from the SSH tab's list, a broken saved address before it", async () => {
    const pc = "http://desk.example.org:7317";
    await chooser(["not an address", pc], { home: "bundled" });
    await page.locator("#tab-ssh").click();
    expect(await called("HerdrShell.open", () => page.getByRole("button", { name: "Open desk.example.org:7317", exact: true }).click())).toContain(`"url":"${pc}/"`);
  });

  test.skipIf(noBrowser)("marks the PC it was opened from as in use now, and goes back to it", async () => {
    const pc = "https://desk.example.ts.net";
    await chooser([pc], { home: "bundled", state: { current: pc, choosing: true, back: "current" } });
    await page.locator("#tab-tailscale").click();
    expect(await page.locator("#tailnet .pc-on").textContent()).toBe("In use now");
    expect(await asked(() => page.locator("#back-to-pc").click())).toBe("asked:backToCurrent");
  });

  test.skipIf(noBrowser)("asked for to manage an SSH PC, it opens on SSH", async () => {
    await chooser([], { home: "bundled", state: { manage: true, back: "home" } });
    await page.locator("#panel-ssh").waitFor({ state: "visible", timeout: 5_000 });
    expect(await page.locator("#tab-ssh").getAttribute("aria-selected")).toBe("true");
    expect(await page.locator("#back-to-pc").isVisible()).toBe(true);
  });

  test.skipIf(noBrowser)("goes to the demo itself when the word demo is typed", async () => {
    await chooser([], { home: "bundled" });
    await page.locator("#tab-ssh").click();
    await page.locator("#by-address").click();
    await page.locator("#web-address").fill("demo");
    await page.locator("#web-address").press("Enter");
    await page.waitForURL("https://chooser.test/demo/index.html", { timeout: 5_000 });
  });
});

/** error.html as the iPhone app shows it, its state from HerdrShell getState (`state`). */
async function errorPage(state: Record<string, unknown>, locale = "en-US") {
  page = await browser.newPage({ locale });
  page.on("pageerror", (error) => thrown.push(error.message));
  await page.addInitScript((state) => {
    Object.assign(window, { Capacitor: { PluginHeaders: [{ name: "HerdrShell", methods: [] }], getPlatform: () => "ios", nativePromise: async (_plugin: string, method: string) => method === "getState" ? state : {} } });
  }, state);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const file = Bun.file(new URL(`.${url.pathname}`, WEB));
    if (url.hostname !== "chooser.test" || !(await file.exists())) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: file.type, body: await file.text() });
  });
  await page.goto("https://chooser.test/error.html");
  // the page has read its state: it names what did not open, or says the phone is offline
  await page.waitForFunction(() => !document.getElementById("offline")!.hidden || !/^(The app could not open it\.|앱이 PC를 열지 못했어요\.)$/.test(document.getElementById("what")!.textContent ?? ""), null, { timeout: 5_000 });
}

/** the words a person reads on the page (hidden elements left out) */
async function shownText(): Promise<string> {
  return await page.evaluate(() => document.body.innerText);
}

describe("the error page", () => {
  const HOSTED = "https://app.ovis.sh";

  test.skipIf(noBrowser)("says the phone has no internet when its own connection failed, not that the PC is off, and shows no raw error", async () => {
    await errorPage({ last: HOSTED, current: HOSTED, failure: "net::ERR_INTERNET_DISCONNECTED", kind: "", app: HOSTED });
    expect(await page.locator("#title").textContent()).toBe("Can't connect to the internet");
    const text = await shownText();
    for (const words of ["net::", "this PC", "Check that the PC is on", "Tailscale"]) expect([words, text.includes(words)]).toEqual([words, false]);
    expect(await page.getByRole("button", { name: "Try again", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Change PC", exact: true }).isVisible()).toBe(true);
  });

  test.skipIf(noBrowser)("takes the iPhone's own word that it is offline (kind offline), in Korean too", async () => {
    await errorPage({ last: "https://desk.tail1234.ts.net", current: "https://desk.tail1234.ts.net", failure: "인터넷 연결이 오프라인 상태입니다.", kind: "offline", app: HOSTED }, "ko-KR");
    expect(await page.locator("#title").textContent()).toBe("인터넷에 연결할 수 없어요");
    const text = await shownText();
    expect(text).toContain("이 휴대폰이 인터넷에 연결되어 있지 않아요");
    expect(text).not.toContain("오프라인 상태입니다");
    expect(text).not.toContain("Tailscale");
  });

  test.skipIf(noBrowser)("says what a raw network error means instead of showing it", async () => {
    for (const [failure, said] of [
      ["net::ERR_NAME_NOT_RESOLVED", "desk.example.com was not found."],
      ["net::ERR_CONNECTION_RESET", "The connection to desk.example.com broke off."],
      ["net::ERR_CERT_AUTHORITY_INVALID", "desk.example.com's secure connection (its HTTPS certificate) is not one this phone trusts."],
      ["net::ERR_BLOCKED_BY_RESPONSE", "desk.example.com could not be opened."],
    ] as const) {
      await errorPage({ last: "https://desk.example.com", current: "https://desk.example.com", failure, kind: "", app: HOSTED });
      expect([failure, await page.locator("#reason").textContent()]).toEqual([failure, said]);
      expect([failure, (await shownText()).includes("net::")]).toEqual([failure, false]);
      await page.close();
    }
  });

  test.skipIf(noBrowser)("does not call the hosted app a PC when it is what did not open", async () => {
    await errorPage({ last: HOSTED, current: HOSTED, failure: "HTTP 502 Bad Gateway", kind: "", app: HOSTED });
    expect(await page.locator("#title").textContent()).toBe("Can't reach Ovis");
    expect(await page.locator("#what").textContent()).toBe("The app could not open Ovis (app.ovis.sh).");
    expect(await shownText()).not.toContain("Check that the PC is on");
  });

  test.skipIf(noBrowser)("still names a PC it could not open", async () => {
    await errorPage({ last: "https://desk.example.com", current: "https://desk.example.com", failure: "HTTP 502 Bad Gateway", kind: "", app: HOSTED });
    expect(await page.locator("#title").textContent()).toBe("Can't reach your PC");
    expect(await page.locator("#what").textContent()).toBe("The app could not open https://desk.example.com.");
  });
});
