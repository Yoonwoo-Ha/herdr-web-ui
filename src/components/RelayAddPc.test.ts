import { describe, expect, it } from "bun:test";

import { translate, type Vars } from "../lib/i18n.ts";
import { tailnetHost } from "../lib/phone.ts";
import { addressOf, openFailureText, publicHttp, scanQr } from "./RelayAddPc.tsx";

describe("a QR scan in the phone app", () => {
  async function scan(granted: boolean | null): Promise<{ calls: string[]; failed: number }> {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
    const calls: string[] = [];
    let failed = 0;
    const methods = granted === null ? [] : [{ name: "camera" }];
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "HerdrShell", methods }, { name: "CapacitorBarcodeScanner", methods: [{ name: "scanBarcode" }] }],
      nativePromise: async (plugin: string, method: string) => { calls.push(`${plugin}.${method}`); return method === "camera" ? { granted } : { ScanResult: "https://pc.example/" }; },
    } });
    try {
      await new Promise<void>((done) => {
        scanQr((key: string) => key, () => done(), () => { failed += 1; done(); });
      });
    } finally {
      if (saved) Object.defineProperty(globalThis, "Capacitor", saved); else Reflect.deleteProperty(globalThis, "Capacitor");
    }
    return { calls, failed };
  }

  it("asks the app for the camera first, and with it refused opens no scanner, whose own refusal is in English", async () => {
    expect(await scan(false)).toEqual({ calls: ["HerdrShell.camera"], failed: 1 });
    expect(await scan(true)).toEqual({ calls: ["HerdrShell.camera", "CapacitorBarcodeScanner.scanBarcode"], failed: 0 });
    // an app built before the check scans as before
    expect(await scan(null)).toEqual({ calls: ["CapacitorBarcodeScanner.scanBarcode"], failed: 0 });
  });
});

describe("an address typed on Add a PC", () => {
  it("reads it as people write it: http for a bare IPv4 address, https for a name, a whole URL as it is", () => {
    const read = (text: string) => addressOf(text)?.href ?? null;
    expect(read("192.168.0.12:7421")).toBe("http://192.168.0.12:7421/");
    expect(read(" 100.101.102.103 ")).toBe("http://100.101.102.103/");
    expect(read("my-pc.tailnet.ts.net")).toBe("https://my-pc.tailnet.ts.net/");
    expect(read("my-pc.tailnet.ts.net:8443")).toBe("https://my-pc.tailnet.ts.net:8443/");
    expect(read("http://my-pc.local:7421")).toBe("http://my-pc.local:7421/");
  });

  it("takes nothing that is not an http or https address", () => {
    for (const text of ["", "   ", "javascript:alert(1)", "ftp://pc.example", "https://", "http:/desk.local", "https:desk.local"]) expect(addressOf(text)).toBeNull();
    expect(addressOf("my-pc:7421")?.href).toBe("https://my-pc:7421/");
  });

  it("warns before plain http leaves this device, a home network or a tailnet", () => {
    for (const text of ["http://203.0.113.9:7421", "http://pc.example.com"]) expect(publicHttp(addressOf(text)!)).toBe(true);
    for (const text of ["192.168.0.12:7421", "http://10.0.0.2", "http://100.101.102.103", "http://pc.local:7421", "http://pc:7421", "https://pc.example.com", "http://my-pc.tailnet.ts.net"]) expect(publicHttp(addressOf(text)!)).toBe(false);
  });
});

describe("an address the phone app could not open", () => {
  const en = (key: string, vars?: Vars) => translate("en", key, vars);
  const ko = (key: string, vars?: Vars) => translate("ko", key, vars);
  const said = (address: string, code: string | undefined, message = "", t = en) => openFailureText(t, new URL(address), code, message);
  const tailscale = "This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.";

  it("says why from the app's own reason, and nothing for a Cancel", () => {
    expect(said("https://desk.example.com/", "cancelled")).toBe("");
    expect(said("http://192.168.0.5:7317/", "not-ovis", "HTTP 404")).toBe("192.168.0.5:7317 answered (HTTP 404), but it is not Ovis: another web server, or herdr itself, which the app cannot open. Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.");
    expect(said("http://192.168.0.5:7317/", "not-ovis", "It answered, but not as Ovis.")).toContain("192.168.0.5:7317 answered, but it is not Ovis");
    expect(said("http://192.168.0.5:7317/", "refused")).toBe("192.168.0.5:7317 refused the connection: nothing listens there. Ovis has to run on the PC (herdr alone is not enough), and by default it listens only on the PC itself (127.0.0.1). Open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC.");
    expect(said("http://127.0.0.1:7421/", "refused")).toMatch(/ On a phone, localhost and 127\.0\.0\.1 are the phone itself, not your PC\.$/);
  });

  it("tells a home network address that did not answer from a public one, and adds the Tailscale hint for a tailnet address", () => {
    expect(said("http://192.168.0.5:7317/", "timeout")).toBe("192.168.0.5:7317 did not answer within 20 seconds. The PC may be off, or out of this phone's reach: a home network address does not open over mobile data or another Wi-Fi, and a firewall on the PC can block the port.");
    expect(said("https://pc.example.com/", "timeout")).toBe("Nothing came back from pc.example.com within 20 seconds. The server may be down, or this phone's connection (or a VPN on it) may not reach it.");
    expect(said("https://desk.tail1e211e.ts.net/", "timeout")).toMatch(new RegExp(` ${tailscale.replace(/[.:]/g, "\\$&")}$`));
    expect(said("https://desk.tail1e211e.ts.net/", "unknown-host")).toBe(`desk.tail1e211e.ts.net was not found. Check the name, or open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC. ${tailscale}`);
    expect(said("https://pc.example.com/", "unknown-host")).not.toContain("Tailscale");
    // a Tailscale address written as its IPv6 is one too
    expect(said("http://[fd7a:115c:a1e0::1234]:7317/", "timeout")).toMatch(new RegExp(` ${tailscale.replace(/[.:]/g, "\\$&")}$`));
  });

  it("explains a network that has no way to the PC (Android's no-answer), and never prints the app's own words for a reason it does not know", () => {
    expect(said("https://office.example/", "no-answer", "ENETUNREACH")).toBe("This phone has no way to office.example right now: the PC may be off, or this phone's network (mobile data, another Wi-Fi, or a VPN) does not reach it.");
    expect(said("https://desk.tail1e211e.ts.net/", "no-answer", "ENETUNREACH")).toBe(`This phone has no way to desk.tail1e211e.ts.net right now: the PC may be off, or this phone's network (mobile data, another Wi-Fi, or a VPN) does not reach it. ${tailscale}`);
    for (const [code, message] of [[undefined, "No route"], ["tls", "javax.net.ssl.SSLHandshakeException: chain"], [undefined, ""]] as const) {
      const text = said("https://office.example/", code, message);
      expect(text).toBe("office.example could not be opened. Check the address, and that Ovis runs on that PC.");
      expect(text).not.toContain(message === "" ? "\u0000" : message);
    }
    const ja = (key: string, vars?: Vars) => translate("ja", key, vars);
    expect(said("https://office.example/", "no-answer", "ENETUNREACH", ja)).not.toContain("ENETUNREACH");
  });

  it("says it in the page's language", () => {
    expect(said("https://desk.tail1e211e.ts.net/", "unknown-host", "", ko)).toContain("Tailscale 앱에서 연결을 켜세요");
    expect(said("http://192.168.0.5:7317/", "refused", "", ko)).toContain("연결을 거부했어요");
  });
});

describe("a Tailscale address", () => {
  it("is a MagicDNS name, a 100.64.0.0/10 address or an address of fd7a:115c:a1e0::/48", () => {
    for (const host of ["desk.tail1e211e.ts.net", "100.101.1.2", "fd7a:115c:a1e0::1234", "[fd7a:115c:a1e0::1234]", "FD7A:115C:A1E0:AB12::1"]) expect(tailnetHost(host)).toBe(true);
    for (const host of ["192.168.0.5", "fd7a:115c:a1e1::1", "fe80::1", "office.example"]) expect(tailnetHost(host)).toBe(false);
  });
});
