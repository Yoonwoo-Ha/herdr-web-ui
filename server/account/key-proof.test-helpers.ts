import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { FrameType, KEY_PROOF_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { pairingPc, phone, SERVER_ID, type Pc } from "./pairing.test-helpers.ts";

export async function keyProofPc(accountOpensAll: boolean, platform: NodeJS.Platform = "linux") {
  const told: { pending: { id: string; action: { kind: string; pending?: string; fingerprint?: string } }[] }[] = [];
  const sender = Promise.withResolvers<(line: string) => void>();
  const input = new ReadableStream<Uint8Array>({ start(controller) { sender.resolve((line) => controller.enqueue(new TextEncoder().encode(line))); } });
  const push = await sender.promise;
  const made = await pairingPc({ server: { accountOpensAll, platform, desktopOwner: { input, write: (line) => { told.push(JSON.parse(line)); } } } });
  const screen = {
    told,
    approve: (id: string) => push(`${JSON.stringify({ approve: id })}\n`),
    decline: (id: string) => push(`${JSON.stringify({ decline: id })}\n`),
    keyConfirm: () => told.at(-1)?.pending.find((entry) => entry.action.kind === "approve_key"),
  };
  return Object.assign(made, { screen });
}

/** A device that offers the proof: it pairs, answers the challenge, and reports what it saw. */
export async function provingDevice(made: Pc, code: string, options?: Parameters<typeof relayConnection>[1]) {
  const device = await phone();
  const link = await relayConnection(made, options);
  const challenge = deferred<string>();
  const pending = deferred<MuxFrame>();
  link.onFrame = (frame) => {
    if (frame.type === FrameType.KEY_CHALLENGE) challenge.resolve(frame.payload.challenge);
    if (frame.type === FrameType.KEY_PENDING) pending.resolve(frame);
  };
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  const sent = await bounded(challenge.promise);
  link.mux.sendSession({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature: await signPairProof(SERVER_ID, sent, device.spki, device.keys.privateKey) } });
  return { device, link, challenge: sent, pending: bounded(pending.promise), fingerprint: await pairFingerprint(SERVER_ID, sent, device.spki) };
}
