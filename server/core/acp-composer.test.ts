import { expect, it } from "bun:test";
import { dirname } from "node:path";
import { rmSync } from "node:fs";
import type { ServerMessage } from "../../shared/protocol.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { buildSnapshot } from "../herdr-core/snapshot.ts";
import { KeeperClient } from "../acp/client.ts";
import { keeperBuilt, keeperRoot, startKeeper, until } from "../acp/keeper.fake.ts";

it.skipIf(!keeperBuilt)("delivers duplicate composer frames once, and keeps a queued message off the wire after its sender leaves", async () => {
  const root = keeperRoot();
  const keeper = await startKeeper(root);
  const client = new KeeperClient(root);
  const answers: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0, send: (data: string) => { answers.push(JSON.parse(data)); return 1; } } as Client;
  owner.data.attached.set("t1", { keepSize: false });
  const child = { id: "child", terminal: "t1", harness: "codex", root, client };
  const clients = new Set([owner]);
  let queue = Promise.resolve<unknown>(null);
  const bridge = createPendingDelivery({
    options: { acp: { forPane: id => id === "t1" ? child : undefined } }, clients, attachments: new Map(), lastTyped: new Map(),
    serialize: (_pane, task) => { const next = queue.catch(() => {}).then(task); queue = next; return next; },
    authorizeSocket: () => {}, omo: { sessionOf: () => null },
    sight: () => ({ origin: null, pty: null, claim: null, facts: () => ({ attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 }), write: () => { throw new Error("unexpected terminal write"); } }),
    clientSnapshot: async () => buildSnapshot([{ address: "t1", cols: 80, rows: 24, cwd: root, state: "live", status: { app: "codex", state: client.status } }], null, "test"),
    submitText: async () => { throw new Error("unexpected terminal submit"); }, SUBMIT_DEADLINE_MS: 5000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const submit = (id: number, text: string, delivery: "immediate" | "queue") => bridge.pendingFrames.submit(owner, { type: "submit", id, pane_id: "t1", text, payload: text, delivery });
  try {
    await client.ready(); await until(client, "session", () => client.session !== null);
    const ask = client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "ask" }] });
    await until(client, "approval", () => client.status === "blocked");
    await submit(0, "must not answer the card", "immediate");
    expect(answers).toContainEqual(expect.objectContaining({ type: "submit-result", ok: false, code: "agent_blocked" }));
    const request = client.pending()[0];
    if (!request) throw new Error("missing approval card");
    await client.answer(request.keeperId, "reject"); await ask;
    await Promise.all([submit(1, "hold", "immediate"), submit(1, "hold", "immediate")]);
    expect(answers.filter(a => a.type === "submit-result" && a.id === 1)).toMatchObject([{ ok: true }, { ok: true }]);
    await submit(2, "unsent", "queue");
    expect(bridge.pending.list(owner, "t1")).toMatchObject([{ text: "unsent", state: "queued" }]);
    bridge.holdPending(owner); clients.delete(owner); bridge.closeConnection(owner);
    await client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text: "release" }] });
    bridge.pending.status("t1", "done"); bridge.drainPending("t1"); await queue;
    expect((await client.history.page({})).turns.filter(t => t.role === "user").map(t => t.parts)).toEqual([[{kind:"text",text:"ask"}],[{kind:"text",text:"hold"}],[{kind:"text",text:"release"}]]);
  } finally { client.close(); await keeper.stop(); rmSync(dirname(root), { recursive: true, force: true }); }
});
