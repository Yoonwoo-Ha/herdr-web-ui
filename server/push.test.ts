import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { createPushService, parseSubscription, type PushService } from "./push.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

/**
 * The server half of web push, end to end against a fake push service that decrypts
 * and verifies like a real device would. No herdr needed: panes are handed in the way
 * the collector hands them (seed) and status changes the way it reports them.
 */

function pane(paneId: string, status: AgentStatus, title: string): HerdrPane {
  return {
    pane_id: paneId,
    agent_status: status,
    terminal_title: title,
    focused: false,
    revision: 0,
    tab_id: "t1",
    terminal_id: "term_1",
    workspace_id: "w1",
  };
}

let stateDir: string;
let fake: FakePushService;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-push-"));
  fake = await startFakePushService();
});

afterEach(() => {
  fake.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

function subscribed(options: Partial<Parameters<typeof createPushService>[0]> = {}): PushService {
  const push = createPushService({ stateDir, ...options });
  push.subscribe(fake.subscription);
  return push;
}

describe("parseSubscription", () => {
  it("accepts what a browser's PushSubscription.toJSON() produces", () => {
    const browserJson = { ...fake.subscription, expirationTime: null };
    expect(parseSubscription(browserJson)).toEqual(fake.subscription);
  });

  it("rejects endpoints and keys a push service could never have issued", () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: "ftp://push.example/x", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", keys })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: "AAAA" } })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription("subscription")).toBeNull();
  });
});

describe("push state", () => {
  it("keeps one owner-only VAPID key pair across restarts", () => {
    const key = createPushService({ stateDir }).publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    expect(createPushService({ stateDir }).publicKey()).toBe(key);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed key file instead of rotating the key under every device", () => {
    writeFileSync(join(stateDir, "vapid.json"), "{}\n");
    expect(() => createPushService({ stateDir }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("keeps subscriptions across restarts", async () => {
    subscribed();
    expect(statSync(join(stateDir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
    const restarted = createPushService({ stateDir });
    expect(await restarted.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
  });
});

describe("push delivery", () => {
  it("sends a status alert the device can decrypt, signed with the server's key", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");

    expect(fake.received).toHaveLength(1);
    const [received] = fake.received;
    expect(received!.payload).toEqual({
      pane_id: "w1:p1",
      title: "claude: fix the build",
      body: "waiting for your input",
      tag: "herdr-pane-w1:p1",
    });
    expect(received!.urgency).toBe("high");
    expect(received!.ttl).toBe(12 * 60 * 60);
    expect(received!.vapidValid).toBe(true);
    expect(received!.vapidKey).toBe(push.publicKey());
    expect(received!.vapidClaims.aud).toBe(new URL(fake.subscription.endpoint).origin);
    expect(received!.vapidClaims.sub).toBe("https://github.com/devswha/herdr-web-ui");
  });

  it("measures the first change after a restart against the seeded baseline", async () => {
    const push = subscribed();
    // never seeded: the first report is a first sighting, not news (same rule as the tab)
    await push.onStatus("w1:p9", "blocked");
    expect(fake.received).toHaveLength(0);
    // seeded from the collector's snapshot: the very first event is already a transition
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.pane_id)).toEqual(["w1:p1"]);
    expect(fake.received[0]!.urgency).toBe("normal");
  });

  it("does not let a later snapshot overwrite a status an event already reported", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // a reconcile that raced the event still says working; blocked -> blocked is not news
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
  });

  it("names the pane by its current title, falling back to the seeded one", async () => {
    let fresh: string | Error = "claude: new task";
    const push = subscribed({
      lookupTitle: async () => {
        if (fresh instanceof Error) throw fresh;
        return fresh;
      },
    });
    push.seed([pane("w1:p1", "working", "claude: old task")]);
    await push.onStatus("w1:p1", "blocked");
    fresh = new Error("herdr busy");
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["claude: new task", "claude: old task"]);
  });

  it("tells the device a pane's terminal ended, under its last known title", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "vim notes.md")]);
    await push.onEnded("w1:p1");
    expect(fake.received[0]!.payload).toEqual({
      pane_id: "w1:p1",
      title: "vim notes.md",
      body: "terminal ended",
      tag: "herdr-pane-w1:p1",
    });
  });

  it("forgets a device its push service reports gone", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
  });

  it("keeps a device through a failure that is not a goodbye", async () => {
    const push = subscribed();
    fake.answerWith(500);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 500, gone: false });
    fake.answerWith(201);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});
