import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  channelBinding, exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel,
} from "../../shared/relay-e2ee.ts";
import type { KeyPair, SecureChannel, Transport } from "../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import type { MuxFrame } from "../../shared/relay-mux.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { fromBase64Url, PAIR_APPROVAL_MS, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { RelayPairingRequest } from "../../shared/machines.ts";
import { RelaySession } from "./session.ts";
import { bounded, deferred, relayFixture, TestClock } from "./test-helpers.ts";

type Fixture = ReturnType<typeof relayFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** A PC whose owner just copied a link without a code, so it takes comparisons. */
function fixture(): Fixture {
  const made = relayFixture();
  made.app.context.services.relay.approvals.openWindow();
  fixtures.push(made);
  return made;
}

/** Two transports joined back to back, delivering synchronously as the relay passes frames on. */
function duplex(): [Transport, Transport] {
  const make = (): Transport & { peer?: Transport; closed: boolean } => ({
    onmessage: null, onclose: null, onerror: null, closed: false,
    async send(data) {
      if (this.closed || !this.peer) throw new Error("Closed test transport");
      this.peer.onmessage?.({ data, isBinary: typeof data !== "string" });
    },
    close(code = 1000, reason = "") {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.(code, reason);
      this.peer?.close(code, reason);
    },
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Frames one end decrypted, in order, with a bounded wait for the next. */
class Inbox {
  private readonly frames: MuxFrame[] = [];
  private waiter: ((frame: MuxFrame) => void) | undefined;
  push(data: string | ArrayBuffer): void {
    if (typeof data === "string") throw new Error("Unexpected plaintext string");
    const frame = decodeFrame(new Uint8Array(data));
    // receipts are the mux's flow accounting, not part of the exchange under test
    if (frame.type === FrameType.RECEIVED) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(frame); }
    else this.frames.push(frame);
  }
  next(): Promise<MuxFrame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    const next = deferred<MuxFrame>();
    this.waiter = next.resolve;
    return bounded(next.promise);
  }
}

/** The PC's real session behind its Noise responder, on `transport`. */
async function pc(f: Fixture, transport: Transport, keys: KeyPair, clock?: MuxClock) {
  let session: RelaySession | undefined;
  const opening = openDaemonSecureChannel(transport, { daemonKeyPair: keys, events: { onmessage: (data) => session?.receive(data) } });
  return {
    async start() {
      session = new RelaySession({
        channel: await opening, services: f.app.context.services, port: f.app.port,
        serverId: "0123456789abcdef0123456789abcdef", serverVersion: "0.4.20", minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 256 * 1024, ...(clock ? { clock } : {}),
      });
      return session;
    },
  };
}

/** A phone that speaks the frames by hand over its own Noise initiator, holding `serverKey` as the PC's. */
async function phone(transport: Transport, serverKey: string) {
  const inbox = new Inbox();
  const opened = deferred<void>();
  const closed = deferred<void>();
  const channel = await openClientSecureChannel(transport, {
    daemonPublicKeyB64: serverKey,
    events: { onopen: () => opened.resolve(), onmessage: (data) => inbox.push(data), onclose: () => closed.resolve() },
  });
  await bounded(opened.promise);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  // the PC may close the channel while it reads a frame: the frame arrived, and the close is what the test asserts
  const send = (frame: MuxFrame) => channel.send(encodeFrame(frame).slice().buffer).catch(() => {});
  return {
    channel, inbox, publicKey, closed: closed.promise, send,
    binding: () => { const binding = channelBinding(channel); if (!binding) throw new Error("No binding"); return binding; },
    async hello(features = [PAIR_SAS_FEATURE]) {
      await send({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features, required_features: [] } });
      const welcome = await inbox.next();
      if (welcome.type !== FrameType.WELCOME) throw new Error(`Expected WELCOME, got ${welcome.type}`);
      return welcome.payload;
    },
  };
}

type Phone = Awaited<ReturnType<typeof phone>>;

/** Request, challenge and reveal as an honest phone does; the digits it shows. */
async function compare(p: Phone): Promise<string> {
  const nonce = randomPairNonce();
  const binding = p.binding();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(binding, p.publicKey, nonce)) } });
  const challenge = await p.inbox.next();
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`Expected PAIR_CHALLENGE, got ${challenge.type}`);
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  return pairDigits(binding, p.publicKey, nonce, fromBase64Url(challenge.payload.nonce));
}

const confirm = (p: Phone) => p.send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });

/** The next list of waiting pairings the PC's windows are told of that satisfies `check`. */
function prompts(f: Fixture, check: (list: RelayPairingRequest[]) => boolean): Promise<RelayPairingRequest[]> {
  const found = deferred<RelayPairingRequest[]>();
  const stop = f.app.context.services.relay.approvals.subscribe((list) => { if (check(list)) found.resolve(list); });
  return bounded(found.promise).finally(stop);
}

async function direct(f: Fixture, clock?: MuxClock) {
  const keys = generateKeyPair();
  const [phoneSide, pcSide] = duplex();
  const end = await pc(f, pcSide, keys, clock);
  const p = await phone(phoneSide, exportPublicKey(keys.publicKey));
  const session = await end.start();
  return { p, session };
}

async function sessionError(p: Phone): Promise<string> {
  for (;;) {
    const frame = await p.inbox.next();
    if (frame.type === FrameType.SESSION_ERROR) return frame.payload.code;
  }
}

test("a phone that offers the feature gets it, and pairs once its digits match and the owner approves", async () => {
  const f = fixture();
  const { p } = await direct(f);
  expect((await p.hello()).features).toEqual([PAIR_SAS_FEATURE]);
  const waiting = prompts(f, (list) => list.length === 1);
  const digits = await compare(p);
  const [request] = await waiting;
  // the PC shows what the phone shows
  expect(request?.digits).toBe(digits);
  expect(digits).toMatch(/^[0-9]{6}$/);
  // the owner's approval alone does not finish it: the phone has to say they match too
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  const before = f.app.context.services.devices.list(null).length;
  await confirm(p);
  const admitted = await p.inbox.next();
  expect(admitted.type).toBe(FrameType.AUTH_OK);
  const devices = f.app.context.services.devices.list(null);
  expect(devices.length).toBe(before + 1);
  expect(devices.at(-1)).toMatchObject({ label: "New phone", role: "drive", via_relay: true });
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("an approved comparison leaves a pairing code that is still showing usable", async () => {
  const f = fixture();
  const code = f.app.context.services.devices.startPairing();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  await confirm(p);
  f.app.context.services.relay.approvals.decide(request!.id, true);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
  expect(f.app.context.services.devices.activePairing()?.code).toBe(code.code);
});

test("revoking every device ends a comparison under way, even one the owner already approved", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  f.app.context.services.devices.revokeAll();
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null)).toEqual([]);
});

test("revoking every device withdraws a prompt still waiting", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  f.app.context.services.devices.revokeAll();
  await cleared;
  expect(await sessionError(p)).toBe("auth_failed");
});

test("a phone that requires the feature is given it where this PC can bind the digits", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [PAIR_SAS_FEATURE], required_features: [PAIR_SAS_FEATURE] } });
  const welcome = await p.inbox.next();
  expect(welcome.type === FrameType.WELCOME && welcome.payload.features).toEqual([PAIR_SAS_FEATURE]);
});

test("an answer that lands after the comparison's deadline makes no device", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  f.app.context.services.relay.approvals.decide(request!.id, true);
  // the wall clock past the deadline while the session's own timer has not run yet
  setSystemTime(new Date(Date.now() + PAIR_APPROVAL_MS + 1_000));
  try {
    await confirm(p);
    expect(await sessionError(p)).toBe("timeout");
  } finally { setSystemTime(); }
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
});

test("a PC whose owner copied no link without a code refuses a comparison before any prompt, and counts no failure", async () => {
  const made = relayFixture();
  fixtures.push(made);
  const { p } = await direct(made);
  await p.hello();
  const nonce = randomPairNonce();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "Ovis update - click Approve", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } });
  expect(await sessionError(p)).toBe("auth_failed");
  expect(made.app.context.services.relay.approvals.list()).toEqual([]);
  // twenty refusals later a QR code still pairs: the closed window spent none of the budget
  for (let index = 0; index < 20; index++) {
    const again = await direct(made);
    await again.p.hello();
    await again.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
      payload: { label: "x", public_key: again.p.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
    await sessionError(again.p);
  }
  const devices = made.app.context.services.devices;
  expect(() => devices.assertRelayPairing()).not.toThrow();
});

test("the window closes ten minutes after the link was copied", () => {
  const made = relayFixture();
  fixtures.push(made);
  const approvals = made.app.context.services.relay.approvals;
  approvals.openWindow(1_000);
  expect(approvals.windowOpen(1_000 + 10 * 60_000 - 1)).toBe(true);
  expect(approvals.windowOpen(1_000 + 10 * 60_000)).toBe(false);
});

test("the phone's word alone does not pair it: it waits for the owner", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  await confirm(p);
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
});

test("a phone that did not offer the feature is not given it, and a comparison without it is refused", async () => {
  const f = fixture();
  const { p } = await direct(f);
  expect((await p.hello([])).features).toEqual([]);
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
  expect(await sessionError(p)).toBe("protocol_error");
});

test("declining on the PC ends the pairing, makes no device and counts as a failed pairing", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  expect(f.app.context.services.relay.approvals.decide(request!.id, false)).toBe(true);
  expect(await sessionError(p)).toBe("auth_failed");
  await cleared;
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  // a decided pairing cannot be decided again, or approved after the fact
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(false);
});

test("an approval nobody asked for, or for a pairing already gone, approves nothing", async () => {
  const f = fixture();
  expect(f.app.context.services.relay.approvals.decide("0011223344556677", true)).toBe(false);
  const base = `http://127.0.0.1:${f.app.port}`;
  const response = await fetch(`${base}/api/relay/pairing`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-update": "1" },
    body: JSON.stringify({ id: "0011223344556677", decision: "approve" }),
  });
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("relay_pairing_gone");
  const malformed = await fetch(`${base}/api/relay/pairing`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-update": "1" },
    body: JSON.stringify({ id: "0011223344556677", decision: "yes" }),
  });
  expect(malformed.status).toBe(400);
});

test("a revealed nonce that is not the committed one is refused before any prompt", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, randomPairNonce())) } });
  expect((await p.inbox.next()).type).toBe(FrameType.PAIR_CHALLENGE);
  // a phone that waits for the PC's nonce and then picks its own cannot keep its commitment
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(randomPairNonce()) } });
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("replayed or out-of-order pairing frames end the session", async () => {
  const f = fixture();
  for (const replay of ["request-twice", "confirm-early", "reveal-early", "confirm-twice"] as const) {
    const { p } = await direct(f);
    await p.hello();
    const nonce = randomPairNonce();
    const request: MuxFrame = { type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
      payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } };
    if (replay === "reveal-early") {
      await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
    } else if (replay === "confirm-early") {
      await p.send(request);
      await p.inbox.next();
      await confirm(p);
    } else if (replay === "request-twice") {
      await p.send(request);
      await p.inbox.next();
      await p.send(request);
    } else {
      const waiting = prompts(f, (list) => list.length === 1);
      await compare(p);
      await waiting;
      await confirm(p);
      await confirm(p);
    }
    expect(await sessionError(p)).toBe("protocol_error");
    await bounded(p.closed);
  }
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a commitment and reveal replayed into another connection give other digits", async () => {
  const f = fixture();
  const first = await direct(f);
  await first.p.hello();
  const firstWaiting = prompts(f, (list) => list.length === 1);
  const nonce = randomPairNonce();
  const commitment = toBase64Url(pairCommitment(first.p.binding(), first.p.publicKey, nonce));
  await first.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "New phone", public_key: first.p.publicKey, commitment } });
  await first.p.inbox.next();
  await first.p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  await firstWaiting;
  // the same request and reveal in a second channel: its binding differs, so the commitment no longer holds
  const second = await direct(f);
  await second.p.hello();
  await second.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "New phone", public_key: first.p.publicKey, commitment } });
  await second.p.inbox.next();
  await second.p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  expect(await sessionError(second.p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list().length).toBe(1);
});

test("a comparison nobody finishes ends at its deadline and withdraws its prompt", async () => {
  const f = fixture();
  const clock = new TestClock();
  const { p } = await direct(f, clock);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  // well past the 10 s a code or a signature gets, the owner still has time
  clock.advance(15_000);
  expect(f.app.context.services.relay.approvals.list().length).toBe(1);
  const cleared = prompts(f, (list) => list.length === 0);
  // to the deadline exactly: further on, the mux's own 5 s teardown would beat its SESSION_ERROR
  clock.advance(PAIR_APPROVAL_MS - 15_000);
  expect(await sessionError(p)).toBe("timeout");
  await cleared;
});

test("a phone that leaves withdraws its prompt", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  p.channel.close();
  await cleared;
});

test("at most three phones wait for approval at once", async () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const { p } = await direct(f);
    await p.hello();
    const waiting = prompts(f, (list) => list.length === index + 1);
    await compare(p);
    await waiting;
  }
  const { p } = await direct(f);
  await p.hello();
  await compare(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list().length).toBe(3);
});

/**
 * A relay that hands the phone a key of its own and opens its own channel to the PC: the phone's
 * Noise ends at the relay, and the relay's at the PC, so the two ends hold different bindings.
 */
async function intercepted(f: Fixture, rewrite: boolean) {
  const pcKeys = generateKeyPair();
  const relayKeys = generateKeyPair();
  const [phoneSide, relayFront] = duplex();
  const [relayBack, pcSide] = duplex();
  const end = await pc(f, pcSide, pcKeys);
  let toPc: SecureChannel | undefined;
  let toPhone: SecureChannel | undefined;
  const fromPc = new Inbox();
  let relayChallenge: Uint8Array | undefined;
  const fromPhone: MuxFrame[] = [];
  const relayPhoneNonce = randomPairNonce();
  const relayDeviceKey = await (async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    return Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  })();
  const pcOpened = deferred<void>();
  const back = await openClientSecureChannel(relayBack, {
    daemonPublicKeyB64: exportPublicKey(pcKeys.publicKey),
    events: {
      onopen: () => pcOpened.resolve(),
      onmessage: (data) => {
        if (rewrite) { fromPc.push(data); return; }
        void toPhone?.send(data).catch(() => {});
      },
    },
  });
  toPc = back;
  const front = openDaemonSecureChannel(relayFront, {
    daemonKeyPair: relayKeys,
    events: {
      onmessage: (data) => {
        if (!rewrite) { void toPc?.send(data).catch(() => {}); return; }
        if (typeof data !== "string") fromPhone.push(decodeFrame(new Uint8Array(data)));
        void relay(data).catch(() => {});
      },
    },
  });
  // the rewriting relay runs the comparison with the PC as a phone of its own, committed before it sees anything
  const relay = async (data: string | ArrayBuffer) => {
    if (typeof data === "string") return;
    const frame = decodeFrame(new Uint8Array(data));
    const binding = channelBinding(back)!;
    if (frame.type === FrameType.PAIR_REQUEST) {
      await back.send(encodeFrame({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
        payload: { label: frame.payload.label, public_key: relayDeviceKey, commitment: toBase64Url(pairCommitment(binding, relayDeviceKey, relayPhoneNonce)) } }).slice().buffer);
      const challenge = await fromPc.next();
      if (challenge.type === FrameType.PAIR_CHALLENGE) relayChallenge = fromBase64Url(challenge.payload.nonce);
      await toPhone!.send(encodeFrame(challenge).slice().buffer);
    } else if (frame.type === FrameType.PAIR_REVEAL) {
      await back.send(encodeFrame({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(relayPhoneNonce) } }).slice().buffer);
    } else {
      await back.send(data);
      const answer = await fromPc.next();
      await toPhone!.send(encodeFrame(answer).slice().buffer);
    }
  };
  const p = await phone(phoneSide, exportPublicKey(relayKeys.publicKey));
  toPhone = await front;
  await bounded(pcOpened.promise);
  await end.start();
  // what the relay's own comparison with the PC is made of, to work out the digits the PC shows
  const relaySide = () => ({ binding: channelBinding(back)!, deviceKey: relayDeviceKey, phoneNonce: relayPhoneNonce, pcNonce: relayChallenge! });
  return { p, relaySide };
}

test("a relay in the middle that passes the comparison on unchanged is refused: the commitment is bound to the phone's channel", async () => {
  const f = fixture();
  const { p } = await intercepted(f, false);
  expect((await p.hello()).features).toEqual([PAIR_SAS_FEATURE]);
  await compare(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a relay in the middle that runs its own comparison with the PC shows the owner digits bound to another channel than the phone's", async () => {
  const f = fixture();
  const { p, relaySide } = await intercepted(f, true);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  const relay = relaySide();
  // the PC shows the relay's comparison, made over the relay's own handshake with it, never the phone's
  expect(request?.digits).toBe(pairDigits(relay.binding, relay.deviceKey, relay.phoneNonce, relay.pcNonce));
  expect(Buffer.from(relay.binding).equals(Buffer.from(p.binding()))).toBe(false);
});
