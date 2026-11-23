// The connect screen: the app's first page until a PC is chosen. Opening a PC goes through the
// native HerdrShell plugin, which makes the PC's address the WebView's first page: navigating
// there from this page would cost every launch about 1.5 s (docs/native-app.md, Spike results).
import { ACCOUNT_SERVICE, ACCOUNT_SIGN_IN, APP_HOME, APP_ORIGIN, barsForScreen, followScheme, knownLogins, listedProviders, localize, openFailure, parseAddress, publicHttp, relayLink, shell, savedPcLabel, sshDetails, sshOrAddress, t, tabPcs } from "./shell.js";

localize();
followScheme();

const form = document.getElementById("connect");
const input = document.getElementById("address");
const byAddress = document.getElementById("by-address");
const addressForm = document.getElementById("address-connect");
const webInput = document.getElementById("web-address");
const sshAdd = document.getElementById("ssh-add");
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
/** The PCs added over SSH (the app's OvisSsh plugin), by their loopback origin on this phone. */
let sshPcs = {};

/** Calls the app's OvisSsh plugin (app/android/.../OvisSshPlugin.java, app/ios/App/App/OvisSshPlugin.swift). */
function ssh(method, options = {}) {
  return window.Capacitor.nativePromise("OvisSsh", method, options);
}

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
  // the bundled demo (build-web.ts), for a store review without a PC: the address "demo" opens it, with no button for it.
  // Where this page stands in for the hosted screen the app opens it (HerdrShell openDemo), so leaving the demo comes
  // back here with the PC this was opened from still current; a build whose first screen this is goes there itself
  if (String(text).trim().toLowerCase() === "demo") {
    if (APP_HOME !== "hosted") { location.href = "demo/index.html"; return; }
    error.textContent = "";
    try { await shell("openDemo"); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // an SSH PC whose host key was forgotten on purpose opens only through the setup screen, which shows the key to confirm
  const url = parseAddress(text);
  // looked up by origin, as each is saved, so the address typed with a path or a trailing slash finds it too
  const sshPc = url === null ? undefined : sshPcs[url.origin];
  if (sshPc && !sshDetails(sshPc).confirmed) {
    error.textContent = "";
    try { await ssh("setUp", { origin: sshPc.origin }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  if (url === null) { error.textContent = t("That is not an http or https address.", "http 또는 https 주소가 아닙니다."); focusField(); return; }
  // the hosted app itself, saved once it loaded (a sign-in opens it): picked from this list, it opens on its front page
  // (#pcs, which the hosted app takes as the app's own way there: Add a PC, or its sign-in), not straight into the PC it
  // opened last as a launch does (src/lib/relay/shell.tsx, launchOrder): a new web view starts a new session, so a bare
  // address would count as a launch and loop back to the PC just left. Where the hosted screen is the app's first
  // screen, the app takes this as an attempt at it (Home.homeStart): nothing becomes the current PC before it loaded
  if (url.origin === new URL(APP_ORIGIN).origin && url.pathname === "/" && url.hash === "") {
    error.textContent = "";
    try { await shell("open", { url: `${APP_ORIGIN}/#pcs`, name: "Ovis" }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // a PC paired over the Ovis relay opens at its scope on the app's origin, saved under that scope
  const relay = relayLink(url);
  if (relay?.error) { error.textContent = relayErrors[relay.error](); focusField(); return; }
  if (relay) {
    error.textContent = "";
    // #picked: the person chose this PC now, so the app does not move on to another one if it is off (src/lib/relay/shell.tsx);
    // a link that carries its own fragment (a pairing offer) is never a reopen, so it needs none
    const picked = new URL(relay.url);
    if (picked.hash === "") picked.hash = "picked";
    try { await shell("open", { url: picked.href, scope: relay.scope, ...(relay.name ? { name: relay.name } : {}) }); }
    catch (err) { error.textContent = String(err?.message ?? err); }
    return;
  }
  // an unreadable saved address (kept on disk for its Forget) is no saved origin, and never stops this one
  const savedOrigin = (saved) => { try { return new URL(saved).origin; } catch { return null; } };
  if (publicHttp(url) && !savedOrigins.some((saved) => savedOrigin(saved) === url.origin) && warned !== url.href) {
    warned = url.href;
    error.textContent = t(
      `${url.host} is not on a tailnet or a home network, so plain http would send the pairing code and everything you type across the internet unencrypted. Use its https address, or open it again to go ahead.`,
      `이 주소(${url.host})는 tailnet이나 집 네트워크의 주소가 아니어서, 일반 http로는 페어링 코드와 입력하는 모든 내용이 암호화되지 않은 채 인터넷으로 오갑니다. https 주소를 쓰거나, 그래도 열려면 한 번 더 여세요.`,
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

const tabs = [...document.querySelectorAll('[role="tab"]')];
const tailnetInput = document.getElementById("tailnet-address");
// a build without the account (OVIS_APP_ACCOUNT=0, build-web.ts) has no relay tab and opens on Tailscale
if (!ACCOUNT_SIGN_IN) document.getElementById("tab-relay").hidden = true;
let tab = ACCOUNT_SIGN_IN ? "relay" : "tailscale";

/** The field of the tab that is up, for an open that did not go: none on the relay's tab. */
function focusField() {
  // the SSH field only where it is drawn (an app without OvisSsh hides it), the address field once Add by address opened it
  if (tab === "ssh") (!addressForm.hidden ? webInput : sshAdd.hidden ? null : input)?.focus();
  else if (tab === "tailscale" && !tailnetInput.closest("[hidden]")) tailnetInput.focus();
}

/**
 * One tab at a time, picked rather than stepped to: no entry of the page's history, so the phone's Back leaves the app
 * from any tab (MainActivity's pageBack gives Back to the page only when it has history), as it does on the desktop's
 * Add a connection. What an open said goes with the tab it was said on.
 */
function pick(name, focus = false) {
  if (name !== tab) {
    stopPending();
    error.textContent = "";
  }
  tab = name;
  for (const each of tabs) {
    const on = each.dataset.tab === name;
    each.setAttribute("aria-selected", String(on));
    each.tabIndex = on ? 0 : -1;
    document.getElementById(each.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tabs.find((each) => each.dataset.tab === name)?.focus();
  if (name === "tailscale") void checkTailscale();
}

for (const each of tabs) each.addEventListener("click", () => pick(each.dataset.tab));
// a tab list's own keys: the arrows move between the tabs that are drawn, Home and End to the ends
document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
  const shown = tabs.filter((each) => !each.hidden);
  const at = shown.findIndex((each) => each.dataset.tab === tab);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: shown.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  pick(shown[(to + shown.length) % shown.length].dataset.tab, true);
});
pick(tab);

// a machine reached over SSH from this phone: the app's OvisSsh plugin asks the rest on a screen of its own. An app
// without it (an Android or iOS build before it) has no SSH to offer, so the SSH tab's field takes addresses alone
// the plugins the app announces to the page before its first script runs (src/lib/nativeApp.ts, hasNativePlugin)
const sshOffered = (window.Capacitor?.PluginHeaders ?? []).some((header) => header.name === "OvisSsh");
sshAdd.hidden = !sshOffered;

/** Add by address: the field for a PC's https address, behind its text link; open with `address` filled in. */
function showAddressForm(shown, address = "") {
  addressForm.hidden = !shown;
  byAddress.setAttribute("aria-expanded", String(shown));
  if (shown && address !== "") webInput.value = address;
}
byAddress.addEventListener("click", () => { showAddressForm(addressForm.hidden); if (!addressForm.hidden) webInput.focus(); });
addressForm.addEventListener("submit", (event) => { event.preventDefault(); void open(webInput.value); });

/** The SSH field: SSH's user@host goes to the SSH setup screen with it filled in; anything else opens as an address. */
async function connectField(text) {
  const target = sshOrAddress(text);
  if (!target.ssh) { await open(target.address); return; }
  if (!sshOffered) {
    error.textContent = t("SSH needs the latest version of this app. Update it, or type the PC's https address instead.", "SSH는 이 앱의 최신 버전에서 돼요. 앱을 업데이트하거나 PC의 https 주소를 넣으세요.");
    input.focus();
    return;
  }
  // an open still being checked must not take over while the setup screen is up
  stopPending();
  error.textContent = "";
  try { await ssh("add", target.ssh); }
  catch (err) { error.textContent = String(err?.message ?? err); }
}

cancel.addEventListener("click", () => {
  stopPending();
  focusField();
});

form.addEventListener("submit", (event) => { event.preventDefault(); void connectField(input.value); });
document.getElementById("tailnet-connect").addEventListener("submit", (event) => { event.preventDefault(); void open(tailnetInput.value); });

/**
 * Whether Tailscale is on on this phone, as Android tells (HerdrShell tailscale): off, the tab says so and offers its
 * app alone, since no Tailscale address opens meanwhile; it asks again when the app comes back (from Tailscale). An app
 * that cannot tell (iOS, an older Android build) draws the tab as on.
 */
async function checkTailscale() {
  if (!android) return;
  let on = true;
  try { on = (await shell("tailscale")).on !== false; }
  catch { /* an Android build without the check: as on */ }
  document.getElementById("tailscale-off").hidden = on;
  document.getElementById("tailscale-on").hidden = !on;
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tab === "tailscale") void checkTailscale(); });
document.getElementById("open-tailscale").addEventListener("click", async () => {
  error.textContent = "";
  try { await shell("openTailscale"); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});

const account = document.getElementById("account");
/** Draws a button for each sign-in named, in the build's order. */
function showProviders(providers) {
  for (const button of account.querySelectorAll("[data-provider]")) button.hidden = !providers.includes(button.dataset.provider);
}

if (ACCOUNT_SIGN_IN) {
  // the service names its sign-ins (GET /v1/providers), as the hosted app reads them; until it answers, GitHub alone
  // (the markup's), the hosted app's own fallback, so no button opens a sign-in the hosted app would not start
  fetch(new URL("/v1/providers", ACCOUNT_SERVICE)).then((response) => response.ok ? response.json() : null).then((body) => {
    const listed = listedProviders(body);
    if (listed !== null) showProviders(listed);
  }, () => undefined);
  // the sign-in itself runs on the hosted app, which this opens on that provider's sign-in (#sign-in=, boot.ts). One
  // press at a time, and none after one that went (Android answers before the page is replaced): a second open would
  // race the first for the page the app keeps. Where the hosted screen is the app's first screen, the app opens it as
  // that screen (Home.homeStart): the PC this was opened from stays current until a PC is picked there, and a sign-in
  // page that does not load comes back here
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

for (const scan of document.querySelectorAll("[data-scan]")) scan.addEventListener("click", async () => {
  error.textContent = "";
  try {
    // the Android app asks for the camera itself first (HerdrShell camera): the scanner's own refusal is in English alone
    const cameraCheck = (window.Capacitor?.PluginHeaders ?? []).some((header) => header.name === "HerdrShell" && (header.methods ?? []).some((each) => each.name === "camera"));
    if (cameraCheck && (await shell("camera")).granted !== true) {
      error.textContent = t("Ovis cannot use the camera. Allow it in the phone's Settings, under Apps, Ovis, Permissions.", "Ovis가 카메라를 쓸 수 없어요. 휴대폰 설정의 앱 → Ovis → 권한에서 허용하세요.");
      return;
    }
    // the plugin's own JS fills these defaults; this page calls the bridge without it
    const result = await window.Capacitor.nativePromise("CapacitorBarcodeScanner", "scanBarcode", { hint: 0, scanInstructions: t("Point at the QR code under Settings → Phone & devices on your PC", "PC의 설정 → 폰 및 기기에 있는 QR 코드를 비추세요"), scanButton: false, scanText: " ", cameraDirection: 1, scanOrientation: 3 });
    if (result?.ScanResult) await open(result.ScanResult);
  } catch (err) {
    error.textContent = String(err?.message ?? err);
  }
});

/** the way a row connects, on its second line */
const WAY_TAGS = { relay: () => t("Relay", "릴레이"), tailscale: () => "Tailscale", ssh: () => "SSH", address: () => t("Address", "주소"), broken: () => t("Unreadable", "읽을 수 없음") };

/**
 * A tab's list of the PCs this phone is already on (tabPcs), under its controls: each a compact row of its name, the way
 * it connects and, for the PC this screen was opened from, Connected, then its address. A tap on the row opens it; Forget
 * at its end (an SSH PC's Manage, as its keys live on this phone); an entry saved unreadable opens nothing.
 */
function renderPcs(which, list, section, state) {
  const pcs = tabPcs(savedOrigins, which, state.names ?? {}, sshPcs);
  list.replaceChildren(...pcs.flatMap(({ origin, label, way }) => {
    const item = document.createElement("li");
    const row = document.createElement(way === "broken" ? "span" : "button");
    row.className = "pc-open";
    if (way !== "broken") {
      row.type = "button";
      row.setAttribute("aria-label", t(`Open ${label}`, `${label} 열기`));
      row.addEventListener("click", () => void open(origin));
    }
    const title = document.createElement("span");
    title.className = "way-title pc-name";
    title.textContent = label;
    const sub = document.createElement("span");
    sub.className = "sub pc-sub";
    const tag = document.createElement("span");
    tag.className = "pc-tag";
    tag.textContent = WAY_TAGS[way]();
    sub.append(tag);
    if (state.choosing === true && origin === state.current) {
      const on = document.createElement("span");
      on.className = "pc-on";
      on.textContent = t("Connected", "연결됨");
      sub.append(on);
    }
    const address = way === "ssh" ? sshDetails(sshPcs[origin]).address : way === "broken" ? "" : new URL(origin).host;
    if (address !== "" && address !== label) {
      const where = document.createElement("span");
      where.className = "pc-address";
      where.textContent = address;
      sub.append(where);
    }
    row.append(title, sub);
    if (way !== "ssh") {
      const forget = button(t("Forget", "지우기"), async () => { await shell("forget", { url: origin }); await load(); }, "forget");
      forget.setAttribute("aria-label", t(`Forget ${label}`, `${label} 지우기`));
      item.append(row, forget);
      return [item];
    }
    const manage = button(t("Manage", "관리"), () => {
      const shown = item.nextElementSibling?.classList.contains("manage-row");
      if (shown) { item.nextElementSibling.remove(); manage.setAttribute("aria-expanded", "false"); return; }
      const panelRow = document.createElement("li");
      panelRow.className = "manage-row";
      panelRow.append(managePanel(origin, label));
      item.after(panelRow);
      manage.setAttribute("aria-expanded", "true");
    }, "forget");
    manage.setAttribute("aria-expanded", "false");
    manage.setAttribute("aria-label", t(`Manage ${label}`, `${label} 관리`));
    item.append(row, manage);
    return [item];
  }));
  section.hidden = pcs.length === 0;
  return pcs.length;
}

const KNOWN_SOURCES = { tailscale: () => "Tailscale", ssh_config: () => t("SSH config", "SSH 설정"), pc: () => t("Its PC", "그 PC의 PC") };

/**
 * After the first PC: the PCs an SSH PC on this phone knows (its ssh config's hosts, its Tailscale login's PCs, the PCs
 * it added), as its own Ovis answers over its tunnel (OvisSsh known), each with Add, which opens the SSH setup screen
 * filled in. Asked of the PC last opened (else the first saved), once per screen; one that does not answer shows nothing.
 */
async function showKnown(state) {
  const section = document.getElementById("known-section");
  const from = sshPcs[state.last] ?? Object.values(sshPcs).find((pc) => pc.fingerprint);
  section.hidden = true;
  if (!sshOffered || from === undefined || !from.fingerprint) return;
  let known;
  try { known = await ssh("known", { origin: from.origin }); }
  catch { return; }
  const logins = knownLogins(known, from, Object.values(sshPcs));
  const label = savedPcLabel(from.origin, state.names ?? {}, sshPcs);
  document.getElementById("known-title").textContent = t(`PCs found on ${label}`, `${label}에서 찾은 PC`);
  document.getElementById("known-pcs").replaceChildren(...logins.map((login) => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.className = "way-text";
    const title = document.createElement("span");
    title.className = "way-title pc-name";
    title.textContent = login.name;
    const sub = document.createElement("span");
    sub.className = "sub pc-sub";
    const tag = document.createElement("span");
    tag.className = "pc-tag";
    tag.textContent = KNOWN_SOURCES[login.source]();
    const address = document.createElement("span");
    address.className = "pc-address";
    address.textContent = `${login.user}@${login.host}${login.port === 22 ? "" : `:${login.port}`}`;
    sub.append(tag, address);
    text.append(title, sub);
    const add = button(t("Add", "추가"), async () => {
      error.textContent = "";
      try { await ssh("add", { user: login.user, host: login.host, port: login.port }); }
      catch (err) { error.textContent = String(err?.message ?? err); }
    }, "primary");
    add.setAttribute("aria-label", t(`Add ${login.name}`, `${login.name} 추가`));
    item.append(text, add);
    return item;
  }));
  section.hidden = logins.length === 0;
}

function button(text, onClick, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  if (className) element.className = className;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function paragraph(text, className = "") {
  const element = document.createElement("p");
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/**
 * Manage under an SSH PC in the list: what it is, and what can be done to it here. Each action says
 * what happened in the panel's own line, so nothing happens out of sight.
 */
function managePanel(origin, label) {
  const pc = sshPcs[origin];
  const details = sshDetails(pc);
  const panel = document.createElement("div");
  panel.className = "manage";
  panel.id = `manage-${origin.replace(/[^a-z0-9]/gi, "-")}`;
  const said = paragraph("", "said");
  said.setAttribute("role", "status");
  const say = (text) => { said.textContent = text; };
  const fail = (err) => { said.textContent = String(err?.message ?? err); };
  const actions = document.createElement("div");
  actions.className = "actions";
  const extra = document.createElement("div");

  const rename = button(t("Rename", "이름 바꾸기"), () => {
    const input = document.createElement("input");
    input.value = label;
    input.maxLength = 64;
    input.setAttribute("aria-label", t("Name in the list", "목록에 보일 이름"));
    const save = button(t("Save", "저장"), async () => {
      try { await ssh("rename", { origin, name: input.value }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(input, save);
    input.focus();
  });
  const phoneKey = button(t("Show this phone's key", "이 휴대폰의 키 보기"), async () => {
    try {
      const { line } = await ssh("phoneKey");
      const code = document.createElement("code");
      code.className = "key";
      code.textContent = line;
      const copy = button(t("Copy", "복사"), async () => { await ssh("copy", { text: line }); say(t("Copied.", "복사했습니다.")); });
      const share = button(t("Share", "공유"), async () => { await ssh("share", { text: line }); });
      extra.replaceChildren(paragraph(t("This phone signs in with this key. It goes in ~/.ssh/authorized_keys on the PC:", "이 휴대폰은 이 키로 로그인합니다. PC의 ~/.ssh/authorized_keys에 들어갑니다:")), code, copy, share);
    } catch (err) { fail(err); }
  });
  const setUp = button(t("Set up again", "다시 설정"), async () => {
    stopPending();
    try { await ssh("setUp", { origin }); }
    catch (err) { fail(err); }
  });
  const forgetKey = button(t("Forget host key", "호스트 키 지우기"), () => {
    const yes = button(t("Forget it", "지우기"), async () => {
      try { await ssh("forgetHostKey", { origin }); await load(); }
      catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(
      "Only when you know why the PC's SSH key changed (the machine was reinstalled, its keys replaced). Opening it then shows the key it has now, to check on the PC and confirm.",
      "PC의 SSH 키가 왜 바뀌었는지 알 때만 지우세요(기기를 다시 설치했거나 키를 바꾼 경우). 그 뒤 열면 지금의 키를 보여 주니, PC에서 확인하고 신뢰하세요.",
    )), yes);
  });
  const remove = button(t("Remove", "삭제"), () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `${panel.id}-clean`;
    box.checked = pc.auth === "phone-key";
    box.disabled = pc.auth !== "phone-key" || !details.confirmed;
    const boxLabel = document.createElement("label");
    boxLabel.className = "check";
    boxLabel.htmlFor = box.id;
    boxLabel.textContent = t("Also take this phone's key out of the PC's authorized_keys (the PC has to be reachable)", "PC의 authorized_keys에서도 이 휴대폰의 키를 빼기(PC에 닿아야 함)");
    boxLabel.prepend(box);
    const yes = button(t("Remove", "삭제"), async () => {
      try {
        const { remote, reason } = await ssh("remove", { origin, cleanRemote: box.checked });
        await load();
        if (remote === "failed") error.textContent = t(`${label} was removed from this phone, but its key could not be taken out of the PC (${reason}). Remove the line whose comment starts with ovis-phone: from ~/.ssh/authorized_keys there yourself.`, `이 PC(${label})를 이 휴대폰에서 지웠지만 PC에서 키를 빼지 못했습니다(${reason}). 그쪽 ~/.ssh/authorized_keys에서 주석이 ovis-phone:으로 시작하는 줄을 직접 지우세요.`);
      } catch (err) { fail(err); }
    }, "primary");
    extra.replaceChildren(paragraph(t(`Remove ${label} from this phone? Its host key and the key saved for it go too.`, `이 휴대폰에서 이 PC(${label})를 지울까요? 호스트 키와 이 PC용으로 저장한 키도 함께 지워집니다.`)), boxLabel, yes);
  });
  actions.append(rename, phoneKey, setUp, ...(details.confirmed ? [forgetKey] : []), remove);
  panel.append(paragraph(details.address), paragraph(details.how), paragraph(details.hostKey, "key"), actions, extra, said);
  return panel;
}

/** Where the back control leads: the PC this screen was opened from (backToCurrent), or the hosted screen (goHome). */
let backTo = "backToCurrent";

/**
 * The way back from this screen, where the app says it leads (getState's `back`, as the phone's Back goes). To a PC
 * ("current"): opened from that PC to choose another way (HerdrShell chooseAnother), or over it for a pairing link from
 * outside the app; it stays current until another is picked. To the hosted Connect a PC screen ("home"): opened by it
 * for what only this page takes (an SSH setup, a pairing link, an SSH PC to manage). An app that names no way says
 * `choosing` alone.
 */
function showBack(state) {
  const back = document.getElementById("back-to-pc");
  const to = state.back === "home" || state.back === "current" ? state.back : state.choosing === true ? "current" : "";
  back.hidden = to === "";
  if (back.hidden) return;
  const home = to === "home";
  backTo = home ? "goHome" : "backToCurrent";
  const name = home ? t("Back", "뒤로") : savedPcLabel(state.current, state.names ?? {}, sshPcs);
  back.textContent = `‹ ${name}`;
  back.setAttribute("aria-label", home ? t("Back to Connect a PC", "PC 연결로 돌아가기") : t(`Back to ${name}`, `${name} 화면으로 돌아가기`));
}

document.getElementById("back-to-pc").addEventListener("click", async () => {
  error.textContent = "";
  try { await shell(backTo); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});

/**
 * This page standing in for the hosted Connect a PC screen, which did not load (getState's `fallback`): one line says
 * so, and its Try again asks the app for that screen again. Nothing else here goes back to it, so a phone that stays
 * offline stays on this page, with all of it working.
 */
function showFallback(state) {
  document.getElementById("offline").hidden = state.fallback !== true;
}

document.getElementById("try-home").addEventListener("click", async () => {
  error.textContent = "";
  try { await shell("goHome"); }
  catch (err) { error.textContent = String(err?.message ?? err); }
});

async function load() {
  const state = await shell("getState");
  savedOrigins = state.saved ?? [];
  sshPcs = {};
  if (sshOffered) {
    try { for (const pc of (await ssh("list")).pcs ?? []) sshPcs[pc.origin] = pc; }
    catch { /* an app without the plugin lists its PCs as before */ }
  }
  showBack(state);
  showFallback(state);
  // Change PC where an SSH PC did not open (getState's `manage`): its Manage is on SSH
  if (state.manage === true && tab !== "ssh") pick("ssh");
  renderPcs("relay", document.getElementById("relay-pcs"), document.getElementById("relay-section"), state);
  const tailnet = renderPcs("tailscale", document.getElementById("tailnet"), document.getElementById("tailnet-section"), state);
  document.getElementById("tailnet-none").hidden = tailnet > 0;
  renderPcs("ssh", document.getElementById("ssh-pcs"), document.getElementById("ssh-section"), state);
  void showKnown(state);
  // an SSH PC whose address on this phone another app took first is not opened (OvisSshPlugin.listen)
  if (state.kind === "ssh-port") {
    error.textContent = t(
      `Another app on this phone took the address the SSH PC opens on (${state.failure}), so the app did not open it: that app would have answered in its place. Close or uninstall the app you do not know, or restart the phone, then open the PC again.`,
      `이 휴대폰의 다른 앱이 SSH PC가 열리는 주소(${state.failure})를 먼저 차지해서 열지 않았습니다. 그 앱이 대신 응답할 수 있기 때문입니다. 모르는 앱을 닫거나 지우거나 휴대폰을 다시 시작한 뒤 PC를 다시 여세요.`,
    );
  }
}

void load();

// a PC's link on the app's origin tapped outside the app (a message, the camera reading the PC's QR
// code), which Android hands to the app (MainActivity's app link): opened as a scanned QR code is
async function openAppLink() {
  if (window.Capacitor?.getPlatform?.() !== "android") return;
  const { url } = await shell("takeLink");
  if (!url) return;
  pick("ssh");
  showAddressForm(true, url);
  await open(url);
}

void openAppLink();

// SSH asked for on a PC's page (the hosted app's SSH tab, HerdrShell openSshSetup): only the app's own pages add an
// SSH PC, so it comes here, on SSH with the login filled in, and goes to the SSH setup screen as typed here would
async function openSshSetupAsked() {
  let asked;
  try { asked = await shell("takeSshSetup"); }
  catch { return; }
  if (!asked?.asked) return;
  pick("ssh");
  input.value = asked.target;
  if (sshOrAddress(asked.target).ssh) await connectField(asked.target);
  else input.focus();
}

void openSshSetupAsked();
