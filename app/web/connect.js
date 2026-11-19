// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { ACCOUNT_SERVICE, ACCOUNT_SIGN_IN, APP_ORIGIN, barsForScreen, followScheme, listedProviders, localize, openFailure, parseAddress, publicHttp, relayLink, shell, t } from "./shell.js";

localize();
followScheme();

const feedback = document.getElementById("feedback");
const form = document.getElementById("connect");
const input = document.getElementById("address");
const error = document.getElementById("error");
const spinner = document.getElementById("spinner");
const statusText = document.getElementById("status-text");
const cancel = document.getElementById("cancel");
const android = window.Capacitor?.getPlatform?.() === "android";
let attempt = 0;
let pending = false;

/**
 * Shows what opens, or nothing. The status text is a live region that stays in the page, empty when
 * nothing opens: one that appeared together with its text would not be announced.
 */
function showStatus(text) {
  pending = text !== "";
  statusText.textContent = text;
  spinner.hidden = !pending;
  cancel.hidden = !pending;
}

function stopPending() {
  if (!pending) return;
  attempt++;
  showStatus("");
  barsForScreen();
  if (android) void shell("cancelOpen");
}
/** PCs that loaded before (an origin, or a relay PC's scope), and the public http address the user was just warned about. */
let savedOrigins = [];
let warned = "";

const appHost = new URL(APP_ORIGIN).host;
const relayErrors = {
  "foreign-offer": () => t(
    `This pairing link is not on the Ovis app's address (${appHost}), so the app does not open it. Scan the QR code your PC shows.`,
    `이 페어링 링크는 Ovis 앱 주소(${appHost})가 아니어서 열지 않습니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
  "bad-offer": () => t(
    "This pairing link is damaged or names another PC. Show the QR code on your PC again and scan it.",
    "이 페어링 링크가 손상되었거나 다른 PC를 가리킵니다. PC에서 QR 코드를 다시 띄워 스캔하세요.",
  ),
  "not-a-pc": () => t(
    `That is a page of the Ovis app (${appHost}), not a PC. Scan the QR code your PC shows.`,
    `Ovis 앱(${appHost})의 페이지이지 PC가 아닙니다. PC에 표시된 QR 코드를 스캔하세요.`,
  ),
};

async function open(text) {
  stopPending();
  // the bundled demo (build-web.ts), for a store review without a PC: the address "demo" opens it, with no button for it
  if (String(text).trim().toLowerCase() === "demo") { location.href = "demo/index.html"; return; }
  const url = parseAddress(text);
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); if (!addressScreen.hidden) input.focus(); return; }
  // the hosted app itself, saved once it loaded (a sign-in opens it): picked from this list, it opens on its list of PCs
  // (#pcs), not straight into the PC it opened last as a launch does (src/lib/relay/shell.tsx, launchPc): a new web view
  // starts a new session, so a bare address would count as a launch and loop back to the PC just left
  if (url.origin === new URL(APP_ORIGIN).origin && url.pathname === "/" && url.hash === "") {
    error.textContent = "";
    try { await shell("open", { url: `${APP_ORIGIN}/#pcs`, name: "Ovis" }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // a PC paired over the Ovis relay opens at its scope on the app's origin, saved under that scope
  const relay = relayLink(url);
  if (relay?.error) { error.textContent = relayErrors[relay.error](); if (!addressScreen.hidden) input.focus(); return; }
  if (relay) {
    error.textContent = "";
    try { await shell("open", { url: relay.url, scope: relay.scope, ...(relay.name ? { name: relay.name } : {}) }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (publicHttp(url) && !savedOrigins.some((saved) => new URL(saved).origin === url.origin) && warned !== url.href) {
    warned = url.href;
    error.textContent = t(
      `${url.host} is not on a tailnet or a home network, so plain http would send the pairing code and everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.`,
      `${url.host}은(는) tailnet이나 집 네트워크의 주소가 아니어서, 일반 http로는 페어링 코드와 입력하는 모든 내용이 암호화되지 않은 채 인터넷으로 오갑니다. https 주소를 쓰거나, 그래도 열려면 한 번 더 여세요.`,
    );
    return;
  }
  // the Android app first asks the address whether it is Ovis (PCStore.check), for up to 20 s:
  // until it answers the screen says what it opens, with Cancel. The iOS app opens it at once.
  error.textContent = "";
  const mine = ++attempt;
  showStatus(t(`Opening ${url.host}…`, `${url.host} 여는 중…`));
  try { await shell("open", { url: url.href, check: true }); }
  catch (err) { if (mine === attempt) error.textContent = openFailure(url, err?.code, String(err?.message ?? err)); }
  finally { if (mine === attempt) showStatus(""); }
}

const screens = { "sign-in": document.getElementById("sign-in"), add: document.getElementById("add"), address: document.getElementById("address-screen") };
const addressScreen = screens.address;
// a build without the account (OVIS_APP_ACCOUNT=0, build-web.ts) starts on Add a PC, with nothing to go back to
const first = ACCOUNT_SIGN_IN ? "sign-in" : "add";

/**
 * One screen at a time; what an open says goes with the screen that is up, above the PCs opened before so a long list
 * never pushes it out of sight. `focus`: what gets the focus on it, none for false.
 */
function show(name, focus) {
  stopPending();
  error.textContent = "";
  for (const [key, screen] of Object.entries(screens)) screen.hidden = key !== name;
  screens[name].insertBefore(feedback, screens[name].querySelector("#saved-section"));
  if (focus !== false) (focus ?? screens[name].querySelector("button:not([hidden])"))?.focus();
}

/**
 * A step forward is an entry of the page's history, so the phone's own Back steps back as the round Back does (Android
 * gives Back to a page with history of the app's own, MainActivity.syncBack).
 */
function go(name, focus) {
  history.pushState({ screen: name }, "", `#${name}`);
  show(name, focus);
}

history.replaceState({ screen: first }, "", location.pathname);
addEventListener("popstate", (event) => { show(screens[event.state?.screen] ? event.state.screen : first); });
for (const screen of [screens.add, screens.address]) screen.querySelector("[data-back]").addEventListener("click", () => history.back());
document.getElementById("no-account").addEventListener("click", () => go("add"));
document.getElementById("address-way").addEventListener("click", () => go("address", input));

// a machine reached over SSH from this phone: Android's OvisSsh plugin asks the rest on a screen of its own. An app
// without it (iOS, or an Android build before it) has no SSH to offer, so the way is left out rather than drawn dead
const sshWay = document.getElementById("ssh-way");
// the plugins the app announces to the page before its first script runs (src/lib/nativeApp.ts, hasNativePlugin)
if ((window.Capacitor?.PluginHeaders ?? []).some((header) => header.name === "OvisSsh")) sshWay.addEventListener("click", async () => {
  error.textContent = "";
  try { await window.Capacitor.nativePromise("OvisSsh", "add", {}); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});
else sshWay.hidden = true;

cancel.addEventListener("click", () => {
  stopPending();
  if (!addressScreen.hidden) input.focus();
});

form.addEventListener("submit", (event) => { event.preventDefault(); void open(input.value); });

const account = document.getElementById("account");
/** Draws a button for each sign-in named, in the build's order. */
function showProviders(providers) {
  for (const button of account.querySelectorAll("[data-provider]")) button.hidden = !providers.includes(button.dataset.provider);
}

if (!ACCOUNT_SIGN_IN) {
  screens.add.querySelector("[data-back]").hidden = true;
  show("add", false);
}
else {
  show("sign-in", false);
  // the service names its sign-ins (GET /v1/providers), as the hosted app reads them; until it answers, GitHub alone
  // (the markup's), the hosted app's own fallback, so no button opens a sign-in the hosted app would not start
  fetch(new URL("/v1/providers", ACCOUNT_SERVICE)).then((response) => response.ok ? response.json() : null).then((body) => {
    const listed = listedProviders(body);
    if (listed !== null) showProviders(listed);
  }, () => undefined);
  // the sign-in itself runs on the hosted app, which this opens on that provider's sign-in (#sign-in=, boot.ts). One
  // press at a time, and none after one that went (Android answers before the page is replaced): a second open would
  // race the first for the page the app keeps
  const buttons = [...account.querySelectorAll("[data-provider]")];
  for (const button of buttons) button.addEventListener("click", async () => {
    error.textContent = "";
    for (const each of buttons) each.disabled = true;
    try { await shell("open", { url: `${APP_ORIGIN}/#sign-in=${button.dataset.provider}`, name: "Ovis" }); }
    catch (err) {
      error.textContent = String(err?.message ?? err);
      for (const each of buttons) each.disabled = false;
    }
  });
}

document.getElementById("scan").addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code under Settings → Phone & devices on your PC", "PC의 설정 → 폰 및 기기에 있는 QR 코드를 비추세요"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

function renderSaved(saved, current, names) {
  const list = document.getElementById("saved");
  list.replaceChildren();
  for (const origin of saved) {
    const item = document.createElement("li");
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "open";
    const label = names[origin] ? `${names[origin]} (${new URL(origin).host})` : origin;
    openButton.textContent = origin === current ? `${label} ${t("(last opened)", "(마지막으로 연 PC)")}` : label;
    openButton.addEventListener("click", () => void open(origin));
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "forget";
    forget.textContent = t("Forget", "지우기");
    forget.setAttribute("aria-label", t(`Forget ${label}`, `${label} 지우기`));
    forget.addEventListener("click", async () => { await shell("forget", { url: origin }); await load(); });
    item.append(openButton, forget);
    list.append(item);
  }
  document.getElementById("saved-section").hidden = saved.length === 0;
}

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  renderSaved(savedOrigins, state.last ?? "", state.names ?? {});
}

void load();

// a PC's link on the app's origin tapped outside the app (a message, the camera reading the PC's QR
// code), which Android hands to the app (MainActivity's app link): opened as a scanned QR code is
async function openAppLink() {
  if (window.Capacitor?.getPlatform?.() !== "android") return;
  const { url } = await shell("takeLink");
  if (!url) return;
  go("address", false);
  input.value = url;
  await open(url);
}

void openAppLink();
