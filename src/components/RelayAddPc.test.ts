import { describe, expect, it } from "bun:test";

import { addressOf, publicHttp, scanQr } from "./RelayAddPc.tsx";

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
