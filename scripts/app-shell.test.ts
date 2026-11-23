import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appHome, appOrigin, writeNativeOrigin } from "../app/scripts/hosted-origin.ts";
// @ts-expect-error app/web is plain JavaScript the app carries as is, without types
import { APP_HOME, APP_ORIGIN, homeHost, knownLogins, listedProviders, loopbackHost, openFailure, parseAddress, relayLink, sshDetails, sshOrAddress, savedPcLabel, tabPcs, tailnetHost } from "../app/web/shell.js";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const offer = { v: 1 as const, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.sh", code: "123456", name: "Studio PC" };
const link = (text: string, appOrigin?: string) => relayLink(parseAddress(text), appOrigin);

describe("the sign-in buttons", () => {
  it("draws the sign-ins the account service names, in the app's order, and none it does not know", () => {
    expect(listedProviders({ providers: ["apple", "github"], device: ["github"] })).toEqual(["github", "apple"]);
    expect(listedProviders({ providers: ["google", "gitlab"], device: [] })).toEqual(["google"]);
    expect(listedProviders({ providers: [], device: [] })).toEqual([]);
  });

  it("reads nothing from an answer with no list, so the build's buttons stay", () => {
    for (const body of [null, "github", {}, { providers: "github" }, { providers: ["google"] }]) expect(listedProviders(body)).toBeNull();
  });
});

describe("the connect tabs", () => {
  const page = readFileSync(join(import.meta.dir, "../app/web/index.html"), "utf8");
  /** a tab's panel in the markup: from its own id to the next panel, or to what an open says under every tab */
  const panel = (name: string) => {
    const start = page.indexOf(`id="panel-${name}"`);
    const ends = [page.indexOf('id="panel-', start + 1), page.indexOf('<div id="feedback">', start)].filter((end) => end > start);
    return page.slice(start, Math.min(...ends));
  };

  it("are the Ovis relay, Tailscale and SSH, with no Direct tab", () => {
    expect([...page.matchAll(/role="tab" id="tab-(\w+)" data-tab="(\w+)"/g)].map(([, id, tab]) => [id, tab])).toEqual([["relay", "relay"], ["tailscale", "tailscale"], ["ssh", "ssh"]]);
    expect(page).not.toContain("panel-direct");
  });

  it("keep a scan of the PC's QR on the relay tab, outside what Tailscale turned off hides", () => {
    const relay = panel("relay");
    expect(relay).toMatch(/<button type="button" class="way" data-scan>[\s\S]*?data-ko="PC 화면의 QR 찍기">Scan the QR on the PC's screen</);
    // only #tailscale-on goes hidden with Tailscale off (connect.js checkTailscale): a scan stays outside it
    const tailscaleOn = page.slice(page.indexOf('<div id="tailscale-on">'), page.indexOf('id="panel-ssh"'));
    const scans = [...page.matchAll(/data-scan>/g)].map((match) => match.index!);
    expect(scans.some((at) => at < page.indexOf('<div id="tailscale-on">') || at > page.indexOf('<div id="tailscale-on">') + tailscaleOn.length)).toBe(true);
  });

  it("put on SSH user@host first, Add by address as a text link to an https address's field, then the PCs this phone is on", () => {
    const ssh = panel("ssh");
    const at = (needle: string) => ssh.indexOf(needle);
    // the PCs an SSH PC knows are suggestions to add, so with the controls, before the PCs this phone is on
    const order = ['id="address"', 'id="by-address"', 'id="web-address"', 'id="known-pcs"', 'id="ssh-pcs"'];
    for (const needle of order) expect(at(needle)).toBeGreaterThan(-1);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a: number, b: number) => a - b));
    expect(ssh).toMatch(/<button type="button" class="text-link" id="by-address"[^>]*data-ko="주소로 추가">Add by address</);
    expect(ssh).toMatch(/<form id="address-connect"[^>]*hidden>/);
  });

  it("ends each tab in exactly one list of the PCs this phone is on, under the tab's controls", () => {
    const heading = 'data-ko="이 폰이 연결한 PC">PCs this phone is on</h2>';
    for (const [tab, list, last] of [["relay", 'id="relay-pcs"', "data-scan"], ["tailscale", 'id="tailnet"', "data-scan"], ["ssh", 'id="ssh-pcs"', 'id="web-address"']] as const) {
      const shown = panel(tab);
      expect(shown.split(heading).length - 1).toBe(1);
      expect(shown.indexOf(list)).toBeGreaterThan(shown.lastIndexOf(last));
      // the last list of the tab
      expect(shown.lastIndexOf('class="card list"')).toBe(shown.indexOf(`${list} class="card list"`) + list.length + 1);
    }
  });
});

describe("the SSH tab's one field", () => {
  it("takes user@host, with a port or ssh://, as SSH", () => {
    expect(sshOrAddress(" me@my-server.example.com ")).toEqual({ ssh: { user: "me", host: "my-server.example.com", port: 22 } });
    expect(sshOrAddress("pi@192.168.0.20:2222")).toEqual({ ssh: { user: "pi", host: "192.168.0.20", port: 2222 } });
    expect(sshOrAddress("ssh://dev@nas.tail1e211e.ts.net/")).toEqual({ ssh: { user: "dev", host: "nas.tail1e211e.ts.net", port: 22 } });
    expect(sshOrAddress("me@[fd7a:115c:a1e0::1]:22")).toEqual({ ssh: { user: "me", host: "fd7a:115c:a1e0::1", port: 22 } });
  });

  it("leaves every other text an address to open, an https PC's among them", () => {
    for (const text of ["https://my-pc.example.com", "https://my-pc.tailnet.ts.net", "http://me@my-pc:7317", "my-pc.local", "me@host:70000", "me@host/path", "demo"]) {
      expect(sshOrAddress(text)).toEqual({ address: text });
    }
  });
});

describe("each connect tab's saved PCs", () => {
  const relayPc = `https://app.ovis.sh/s/${SERVER_ID}/`;
  const saved = ["http://100.101.12.7:7317", "https://nas.tail1e211e.ts.net", "http://192.168.0.10:7317", relayPc, "https://app.ovis.sh", "http://127.0.0.1:41234", "not an address"];
  const names = { "http://100.101.12.7:7317": "home-server", "http://192.168.0.10:7317": "desk", [relayPc]: "Studio PC" };
  const ssh = { "http://127.0.0.1:41234": { label: "pi@nas" } };

  it("lists the PCs paired over the relay on the relay tab, under its sign-in, and not the app's own front page", () => {
    expect(tabPcs(saved, "relay", names, ssh)).toEqual([{ origin: relayPc, label: "Studio PC", way: "relay" }]);
  });

  it("names a PC by its saved name, else what its address says: a relay PC by its id, never the app's host", () => {
    expect(savedPcLabel(relayPc, {}, {})).toBe("0123456789ab");
    expect(savedPcLabel("https://nas.tail1e211e.ts.net", {}, {})).toBe("nas");
    expect(savedPcLabel("http://192.168.0.10:7317", {}, {})).toBe("192.168.0.10:7317");
    expect(savedPcLabel("http://127.0.0.1:41234", {}, ssh)).toBe("pi@nas");
    expect(savedPcLabel(relayPc, names, {})).toBe("Studio PC");
  });

  it("lists the PCs opened at a Tailscale address on the Tailscale tab, by their saved name or their host's first word", () => {
    expect(tabPcs(saved, "tailscale", names, ssh)).toEqual([
      { origin: "http://100.101.12.7:7317", label: "home-server", way: "tailscale" },
      { origin: "https://nas.tail1e211e.ts.net", label: "nas", way: "tailscale" },
    ]);
  });

  it("lists on the SSH tab, as one list, the PCs added over SSH and those opened at any other address, and one saved unreadable to forget", () => {
    expect(tabPcs(saved, "ssh", names, ssh)).toEqual([
      { origin: "http://192.168.0.10:7317", label: "desk", way: "address" },
      { origin: "http://127.0.0.1:41234", label: "pi@nas", way: "ssh" },
      { origin: "not an address", label: "not an address", way: "broken" },
    ]);
  });

  it("lists each PC in one list at most, and every saved one but the app's own front page in some list", () => {
    const listed = ["relay", "tailscale", "ssh"].flatMap((tab) => tabPcs(saved, tab, names, ssh).map((pc: { origin: string }) => pc.origin));
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(listed)).toEqual(new Set(saved.filter((origin) => origin !== "https://app.ovis.sh")));
  });
});

describe("relay pairing links", () => {
  it("opens an offer on the app's origin at its scope, the fragment kept, labelled from the offer", () => {
    const url = encodeOffer(offer, APP_ORIGIN);
    expect(APP_ORIGIN).toBe("https://app.ovis.sh");
    expect(link(url)).toEqual({ url, scope: `https://app.ovis.sh/s/${SERVER_ID}/`, name: "Studio PC" });
  });

  it("takes the configured app origin, and an offer without a name or a scope without its slash", () => {
    const origin = "https://shell.example.ts.net:18921";
    const { name: _, ...unnamed } = offer;
    const url = encodeOffer(unnamed, origin);
    const fragment = url.slice(url.indexOf("#"));
    expect(link(url, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(`${origin}/s/${SERVER_ID}${fragment}`, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(url)).toEqual({ error: "foreign-offer" });
  });

  it("reopens a saved relay PC by its scope", () => {
    const scope = `https://app.ovis.sh/s/${SERVER_ID}/`;
    expect(link(scope)).toEqual({ url: scope, scope, name: undefined });
  });

  it("opens a PC's page that asks for a provider's sign-in first, with that fragment kept, and no other fragment", () => {
    const scope = `https://app.ovis.sh/s/${SERVER_ID}/`;
    expect(link(`${scope}#sign-in=github`)).toEqual({ url: `${scope}#sign-in=github`, scope, name: undefined });
    for (const text of [`${scope}#sign-in=`, `${scope}#sign-in=github&pane=w1`, `${scope}#sign-in=GitHub`]) {
      expect([text, link(text)]).toEqual([text, { error: "not-a-pc" }]);
    }
  });

  it("refuses an offer on any other origin", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    for (const text of [
      `https://evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#${fragment}`,
      `http://app.ovis.sh/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh.evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh:8443/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#offer=`,
    ]) expect([text, link(text)]).toEqual([text, { error: "foreign-offer" }]);
  });

  it("refuses an offer that is malformed or names another PC, and the app's other pages", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    const other = "fedcba9876543210fedcba9876543210";
    const json = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const text of [
      `https://app.ovis.sh/s/${other}/#${fragment}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=not*base64`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json([1])}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, v: 2 })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, name: "x".repeat(65) })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${"A".repeat(2049)}`,
    ]) expect([text, link(text)]).toEqual([text, { error: "bad-offer" }]);
    for (const text of ["https://app.ovis.sh/", `https://app.ovis.sh/s/${SERVER_ID.toUpperCase()}/`, `https://app.ovis.sh/s/${SERVER_ID}/sw.js`, `https://app.ovis.sh/s/${SERVER_ID}/#pair`]) {
      expect([text, link(text)]).toEqual([text, { error: "not-a-pc" }]);
    }
  });

  it("leaves a PC's own address to open as before", () => {
    for (const text of ["https://pc.tail1234.ts.net", "100.64.0.1:7421/?pair=123456", "https://pc.example.com/#settings"]) {
      expect([text, link(text)]).toEqual([text, null]);
    }
  });
});

describe("why an address did not open", () => {
  it("tells this phone's own addresses, which never reach the PC", () => {
    for (const text of ["localhost:17531", "http://127.0.0.1:17531", "http://127.1.2.3/", "http://[::1]:7317", "https://app.localhost"]) {
      expect([text, loopbackHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["192.168.0.10:7317", "https://my-pc.tail1234.ts.net", "http://128.0.0.1/"]) {
      expect([text, loopbackHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("tells Tailscale addresses as error.html does", () => {
    for (const text of ["100.64.0.1:7317", "100.127.255.1", "https://pc.tail1234.ts.net", "http://[fd7a:115c:a1e0::1]:7317"]) {
      expect([text, tailnetHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["100.63.0.1", "100.128.0.1", "192.168.0.10", "https://ts.net.example.com"]) {
      expect([text, tailnetHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("tells home network and tailnet addresses from public servers, as error.html does", () => {
    for (const text of ["192.168.0.10:7317", "10.0.2.2:7317", "172.20.1.1", "169.254.1.2", "100.64.0.1", "localhost:17531", "http://[fd00::1]:7317", "http://[fe80::1]/", "http://studio:7317", "https://pc.local", "https://pc.home.arpa", "https://pc.tail1234.ts.net"]) {
      expect([text, homeHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["https://herdr.theworld.codes", "8.8.8.8", "172.32.0.1", "100.128.0.1", "http://[2001:db8::1]/", "https://local.example.com"]) {
      expect([text, homeHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("has error.html's own copy of homeHost agree with shell.js", () => {
    const page = readFileSync(join(import.meta.dir, "../app/web/error.html"), "utf8");
    const source = page.match(/function homeHost\(hostname\) \{[\s\S]*?\n {4}\}\n/)?.[0];
    expect(source).toBeDefined();
    const pageHomeHost = new Function(`${source}; return homeHost;`)() as (hostname: string) => boolean;
    const hosts = ["192.168.0.10", "10.0.2.2", "172.16.0.1", "172.32.0.1", "169.254.1.2", "127.0.0.1", "100.64.0.1", "100.127.255.1", "100.128.0.1", "8.8.8.8",
      "localhost", "app.localhost", "[::1]", "[fd00::1]", "[fe80::1]", "[fd7a:115c:a1e0::1]", "[2001:db8::1]", "studio", "pc.local", "pc.lan", "pc.home.arpa", "pc.internal",
      "pc.tail1234.ts.net", "herdr.theworld.codes", "local.example.com"];
    for (const host of hosts) expect([host, pageHomeHost(host)]).toEqual([host, homeHost(host)]);
  });

  it("explains a timeout differently for a home network address and a public server", () => {
    const home = openFailure(parseAddress("192.168.77.20:7317"), "timeout", "x").replace("192.168.77.20:7317", "HOST");
    const server = openFailure(parseAddress("https://herdr.example.com"), "timeout", "x").replace("herdr.example.com", "HOST");
    expect(server).not.toBe(home);
  });

  it("keeps the loading spinner the native apps wait on in index.html's root", () => {
    // MainActivity (PAGE_SCRIPT) lifts its cover once #root no longer holds .boot: a page whose
    // root starts without it would lift the cover before the client is up
    const page = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
    expect(page).toMatch(/<div id="root">\s*<div class="boot"/);
  });

  it("says nothing for a cancelled open and something for every other refusal", () => {
    const url = parseAddress("192.168.77.20:7317");
    expect(openFailure(url, "cancelled", "Cancelled")).toBe("");
    for (const code of ["not-ovis", "refused", "timeout", "unknown-host", "no-answer", undefined]) {
      expect([code, openFailure(url, code, "x").length > 0]).toEqual([code, true]);
    }
  });
});

describe("the PCs an SSH PC knows", () => {
  const from = { origin: "http://127.0.0.1:47320", user: "me", host: "desk.tail1e211e.ts.net", port: 22 };
  const known = {
    candidates: { pcs: [
      { name: "desk", destination: "desk.tail1e211e.ts.net", detail: "desk.tail1e211e.ts.net", source: "tailscale" },
      { name: "nas", destination: "nas.tail1e211e.ts.net", detail: "nas.tail1e211e.ts.net", source: "tailscale" },
      { name: "lab", destination: "lab", detail: "root@lab.example", source: "ssh_config" },
      { name: "bare", destination: "bare", detail: "bare.example", source: "ssh_config" },
      { name: "alias", destination: "alias", detail: null, source: "ssh_config" },
    ] },
    machines: { machines: [
      { kind: "ssh", name: "vps", target: { destination: "can@10.0.0.7", port: 2222 } },
      { kind: "ssh", name: "aliased", target: { destination: "vps" } },
      { kind: "relay", name: "far" },
      { kind: "ssh", name: "again", target: { destination: "root@lab.example" } },
    ] },
  };

  it("offers each as a login the phone can reach: a Tailscale PC as the same user, an ssh config host by its user@hostname, a PC it added by its target", () => {
    expect(knownLogins(known, from)).toEqual([
      { user: "me", host: "nas.tail1e211e.ts.net", port: 22, name: "nas", source: "tailscale" },
      { user: "root", host: "lab.example", port: 22, name: "lab", source: "ssh_config" },
      { user: "can", host: "10.0.0.7", port: 2222, name: "vps", source: "pc" },
    ]);
  });

  it("leaves out the PCs already on this phone, and reads nothing from an answer that is not one", () => {
    expect(knownLogins(known, from, [{ user: "root", host: "LAB.example", port: 22 }]).map((login: { name: string }) => login.name)).toEqual(["nas", "vps"]);
    expect(knownLogins({ candidates: null, machines: { error: "x" } }, from)).toEqual([]);
    expect(knownLogins(undefined, from)).toEqual([]);
  });
});

describe("an SSH PC under Manage", () => {
  const pc = { origin: "http://127.0.0.2:47317", host: "studio.lan", port: 22, user: "me", auth: "phone-key", keyType: "", hostKeyAlgorithm: "ssh-ed25519", fingerprint: "SHA256:abc" };

  it("names its address, the pasted key's type, and its confirmed host key", () => {
    const details = sshDetails(pc);
    expect(details.address).toBe("me@studio.lan");
    expect(details.confirmed).toBe(true);
    expect(details.hostKey).toContain("ssh-ed25519 SHA256:abc");
    const pasted = sshDetails({ ...pc, port: 2222, auth: "imported", keyType: "rsa 3072" });
    expect(pasted.address).toBe("me@studio.lan:2222");
    expect(pasted.how).toContain("rsa 3072");
    expect(pasted.how).not.toBe(details.how);
    const tailscale = sshDetails({ ...pc, auth: "tailscale" });
    expect([details.how, pasted.how]).not.toContain(tailscale.how);
  });

  it("is not confirmed once its host key was forgotten", () => {
    const forgotten = sshDetails({ ...pc, hostKeyAlgorithm: "", fingerprint: "" });
    expect(forgotten.confirmed).toBe(false);
    expect(forgotten.hostKey).not.toContain("SHA256:");
  });
});

describe("the hosted origin a build gives the native apps", () => {
  const app = join(import.meta.dir, "../app");
  const preview = "https://relay-0510.ovis-app.pages.dev";

  it("takes OVIS_APP_URL only as an https origin with no path", () => {
    expect(appOrigin(undefined)).toBeNull();
    expect(appOrigin("")).toBeNull();
    expect(appOrigin(preview)).toBe(preview);
    expect(appOrigin("https://shell.example.ts.net:8443")).toBe("https://shell.example.ts.net:8443");
    for (const text of ["http://relay-0510.ovis-app.pages.dev", `${preview}/`, `${preview}/s/`, "https://Relay.example", "https://app.ovis.sh:443", "relay-0510.ovis-app.pages.dev"]) {
      expect(() => appOrigin(text)).toThrow("OVIS_APP_URL must be an https origin with no path");
    }
  });

  it("refuses a host that would read differently in the files the native builds take it from", () => {
    // a quote ends the Java string gradle writes; "$(...)" is a build setting an xcconfig expands
    for (const text of ['https://stage"blue.example', "https://stage$(channel).example", "https://[::1]", "https://stage_blue.example"]) {
      expect(() => appOrigin(text)).toThrow("OVIS_APP_URL's host must be a DNS name or an IPv4 address");
    }
    expect(appOrigin("https://100.64.0.1:8443")).toBe("https://100.64.0.1:8443");
  });

  it("fails an iOS build whose bundled pages name another hosted origin than the native code trusts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-origin-check-"));
    const check = (shellJs: string, origin: string, home = "hosted") => spawnSync("sh", [join(app, "ios/check-hosted-origin.sh"), shellJs, origin, home], { encoding: "utf8" });
    try {
      const shellJs = join(dir, "shell.js");
      writeFileSync(shellJs, `export const ACCOUNT_SIGN_IN = true;\nexport const APP_ORIGIN = ${JSON.stringify(preview)};\nexport const APP_HOME = "hosted";\n`);
      expect(check(shellJs, preview).status).toBe(0);
      const mismatch = check(shellJs, "https://app.ovis.sh");
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toContain(`error: ${shellJs} names ${preview} and OVIS_APP_ORIGIN is https://app.ovis.sh`);
      const missing = check(join(dir, "none.js"), "https://app.ovis.sh");
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain("names no hosted origin");
      // and the first screen the pages were built for is the one the native code opens (OVIS_APP_HOME)
      const otherHome = check(shellJs, preview, "bundled");
      expect(otherHome.status).toBe(1);
      expect(otherHome.stdout).toContain(`error: ${shellJs} was built for the hosted first screen and OVIS_APP_HOME is bundled`);
      const bundled = join(dir, "bundled.js");
      writeFileSync(bundled, `export const APP_ORIGIN = ${JSON.stringify(preview)};\nexport const APP_HOME = "bundled";\n`);
      expect(check(bundled, preview, "bundled").status).toBe(0);
      expect(check(bundled, preview, "hosted").status).toBe(1);
      const older = join(dir, "older.js");
      writeFileSync(older, `export const APP_ORIGIN = ${JSON.stringify(preview)};\n`);
      const noHome = check(older, preview);
      expect(noHome.status).toBe(1);
      expect(noHome.stdout).toContain("was built for no first screen");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes it where the Android and iOS builds read it, and removes it for a build without one", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-origin-"));
    try {
      mkdirSync(join(dir, "android/app"), { recursive: true });
      mkdirSync(join(dir, "ios"), { recursive: true });
      writeNativeOrigin(dir, preview);
      expect(readFileSync(join(dir, "android/app/hosted-origin.properties"), "utf8")).toBe(`appOrigin=${preview}\n`);
      expect(readFileSync(join(dir, "ios/hosted-origin.generated.xcconfig"), "utf8")).toBe("OVIS_APP_ORIGIN = https:/$()/relay-0510.ovis-app.pages.dev\n");
      writeNativeOrigin(dir, null);
      expect(existsSync(join(dir, "android/app/hosted-origin.properties"))).toBe(false);
      expect(existsSync(join(dir, "ios/hosted-origin.generated.xcconfig"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes OVIS_APP_HOME as the first screen: the hosted one unless it says bundled, or the build has no account", () => {
    expect(appHome(undefined, true)).toBe("hosted");
    expect(appHome("", true)).toBe("hosted");
    expect(appHome("hosted", true)).toBe("hosted");
    expect(appHome("bundled", true)).toBe("bundled");
    // OVIS_APP_ACCOUNT=0: no account, so no hosted screen to open first, unless the build asks for it by name
    expect(appHome(undefined, false)).toBe("bundled");
    expect(appHome("hosted", false)).toBe("hosted");
    for (const text of ["Bundled", "local", "0", "true"]) expect(() => appHome(text, true)).toThrow("OVIS_APP_HOME must be hosted or bundled");
  });

  it("writes the first screen beside the origin, and nothing for a build that takes both defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosted-home-"));
    try {
      mkdirSync(join(dir, "android/app"), { recursive: true });
      mkdirSync(join(dir, "ios"), { recursive: true });
      writeNativeOrigin(dir, preview, "bundled");
      expect(readFileSync(join(dir, "android/app/hosted-origin.properties"), "utf8")).toBe(`appOrigin=${preview}\nappHome=bundled\n`);
      expect(readFileSync(join(dir, "ios/hosted-origin.generated.xcconfig"), "utf8")).toBe("OVIS_APP_ORIGIN = https:/$()/relay-0510.ovis-app.pages.dev\nOVIS_APP_HOME = bundled\n");
      writeNativeOrigin(dir, null, "bundled");
      expect(readFileSync(join(dir, "android/app/hosted-origin.properties"), "utf8")).toBe("appHome=bundled\n");
      expect(readFileSync(join(dir, "ios/hosted-origin.generated.xcconfig"), "utf8")).toBe("OVIS_APP_HOME = bundled\n");
      writeNativeOrigin(dir, preview, "hosted");
      expect(readFileSync(join(dir, "android/app/hosted-origin.properties"), "utf8")).toBe(`appOrigin=${preview}\n`);
      writeNativeOrigin(dir, null, "hosted");
      expect(existsSync(join(dir, "android/app/hosted-origin.properties"))).toBe(false);
      expect(existsSync(join(dir, "ios/hosted-origin.generated.xcconfig"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is the hosted screen in the native builds unless the build says bundled", () => {
    const gradle = readFileSync(join(app, "android/app/build.gradle"), "utf8");
    expect(gradle).toContain('getProperty("appHome", "hosted") != "bundled"');
    expect(gradle).toContain('buildConfigField "boolean", "HOME_HOSTED", "${homeHosted}"');
    const xcconfig = readFileSync(join(app, "ios/hosted-origin.xcconfig"), "utf8");
    expect(xcconfig).toMatch(/^OVIS_APP_HOME = hosted\n#include\? "hosted-origin\.generated\.xcconfig"/m);
    expect(readFileSync(join(app, "ios/App/App/Info.plist"), "utf8")).toMatch(/<key>OvisAppHome<\/key>\s*<string>\$\(OVIS_APP_HOME\)<\/string>/);
  });

  it("is what the native builds read, each with the pages' own default", () => {
    expect(APP_ORIGIN).toBe("https://app.ovis.sh");
    const gradle = readFileSync(join(app, "android/app/build.gradle"), "utf8");
    expect(gradle).toContain('file("hosted-origin.properties")');
    expect(gradle).toContain('getProperty("appOrigin", "https://app.ovis.sh")');
    const xcconfig = readFileSync(join(app, "ios/hosted-origin.xcconfig"), "utf8");
    expect(xcconfig).toContain("OVIS_APP_ORIGIN = https:/$()/app.ovis.sh\n");
    expect(xcconfig).toContain("\n#include? \"hosted-origin.generated.xcconfig\"");
    expect(readFileSync(join(app, "ios/App/App/Info.plist"), "utf8")).toMatch(/<key>OvisAppOrigin<\/key>\s*<string>\$\(OVIS_APP_ORIGIN\)<\/string>/);
    // the App target's Debug and Release configurations both build on it
    const project = readFileSync(join(app, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
    const reference = /(\w+) \/\* hosted-origin\.xcconfig \*\/ = \{isa = PBXFileReference;[^}]*path = \.\.\/hosted-origin\.xcconfig;/.exec(project)?.[1];
    expect(reference).toBeDefined();
    expect(project.split(`baseConfigurationReference = ${reference} /* hosted-origin.xcconfig */;`).length - 1).toBe(2);
    // and packaging checks the copied pages against it: the App target's build phase, Android's merge of assets
    const phase = /(\w+) \/\* Check the hosted origin \*\/ = \{\s*isa = PBXShellScriptBuildPhase;[^}]*check-hosted-origin\.sh/.exec(project)?.[1];
    expect(phase).toBeDefined();
    expect(/504EC3031FED79650016851F \/\* App \*\/ = \{[^}]*buildPhases = \(([^)]*)\)/.exec(project)?.[1]).toContain(`${phase} /* Check the hosted origin */`);
    expect(gradle).toContain('file("src/main/assets/public/shell.js")');
    // both checks take the first screen too: the pages say which one they were built for (APP_HOME in shell.js)
    expect(APP_HOME).toBe("hosted");
    expect(gradle).toContain("export const APP_HOME = ");
    expect(project).toContain('check-hosted-origin.sh\\" \\"$SRCROOT/App/public/shell.js\\" \\"$OVIS_APP_ORIGIN\\" \\"$OVIS_APP_HOME\\"');
  });
});
