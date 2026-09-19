import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensurePushSubscription } from "./push.ts";

/**
 * The device-side subscription flow against a stand-in browser whose PushManager, like
 * real Chrome (observed through FCM in .omo/evidence/push-qa/real-fcm.ts), issues a NEW
 * subscription on every subscribe() call and keeps only the latest one.
 */

const SERVER_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
const OTHER_KEY = new Uint8Array(65).fill(7).buffer;

interface StandInSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  unsubscribed: boolean;
  unsubscribe(): Promise<boolean>;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
}

let live: StandInSubscription | null;
let issued: number;
let registered: string[];
const saved = {
  fetch: globalThis.fetch,
  PushManager: (globalThis as { PushManager?: unknown }).PushManager,
  Notification: (globalThis as { Notification?: unknown }).Notification,
};

function standIn(endpoint: string, key: ArrayBuffer): StandInSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribed: false,
    async unsubscribe() {
      this.unsubscribed = true;
      return true;
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

beforeEach(() => {
  live = null;
  issued = 0;
  registered = [];
  const pushManager = {
    getSubscription: async () => live,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      issued += 1;
      const key = options.applicationServerKey;
      live = standIn(`https://push.example/${issued}`, key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer);
      return live;
    },
  };
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/push") return Response.json({ public_key: SERVER_KEY });
    if (url === "/api/push/subscribe" && init?.method === "POST") {
      registered.push((JSON.parse(String(init.body)) as { subscription: { endpoint: string } }).subscription.endpoint);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
  Object.assign(globalThis, { PushManager: saved.PushManager, Notification: saved.Notification, fetch: saved.fetch });
});

describe("ensurePushSubscription", () => {
  it("gives overlapping callers one subscription, not two where only the later survives", async () => {
    // the bell's first tap: its own call plus the load-time registration the grant starts
    const [fromClick, fromEffect] = await Promise.all([ensurePushSubscription(), ensurePushSubscription()]);
    expect(issued).toBe(1);
    expect(fromClick).toBe(fromEffect);
    expect(fromClick).toBe(live!.endpoint);
    expect(registered).toEqual([live!.endpoint]);
  });

  it("reuses the live subscription on a later load and registers it again", async () => {
    const first = await ensurePushSubscription();
    const again = await ensurePushSubscription();
    expect(issued).toBe(1);
    expect(again).toBe(first);
    expect(registered).toEqual([first!, first!]);
  });

  it("replaces a subscription made for another server key", async () => {
    const stale = standIn("https://push.example/stale", OTHER_KEY);
    live = stale;
    const endpoint = await ensurePushSubscription();
    expect(stale.unsubscribed).toBe(true);
    expect(endpoint).toBe("https://push.example/1");
    expect(registered).toEqual(["https://push.example/1"]);
  });

  it("does nothing until notifications are allowed", async () => {
    Object.assign(globalThis, { Notification: { permission: "default" } });
    expect(await ensurePushSubscription()).toBeNull();
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });
});
