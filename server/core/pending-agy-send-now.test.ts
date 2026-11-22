// Send now on a working agy (#4325): the queue's paste and Enter put the message in agy's own queue, drawn as
// `▸ <text> (alt+m to send immediately)` above its input box, and alt+m sends it into the turn at work. The real
// createPendingDelivery, PendingInputs and interruptCodexSteering, with herdr's client faked as in
// pending-turn-gate.test.ts. `on.keys` is what herdr and agy do as a key lands; `on.read` runs at each screen read.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { connectionData } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => { mock.restore(); });

type Row = { id: string; state: string; text: string; error?: { code: string } };
const BAR = "─".repeat(52);
const agyScreen = (queued: string[]) => `● Running (sleep 15; echo two) (ctrl+o to expand)\n⣷  Running command...\n${queued.join("\n")}\n${BAR}\n>\n${BAR}\n  Press up to edit queued messages\n`;
const queuedRow = (text: string) => `▸ ${text} (alt+m to send immediately)`;

function pane() {
  const typed: string[] = [];
  const now = { status: "working", screen: agyScreen([]) };
  const on: { keys?: (keys: string[]) => void; read?: (count: number) => void } = {};
  let reads = 0;
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => 1000);
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "agy", argv: ["agy"] }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(herdr, "paneRead").mockImplementation(async () => { on.read?.(++reads); return { text: now.screen } as Awaited<ReturnType<typeof herdr.paneRead>>; });
  // as herdrRpc does: the guard is asked right before the write, and a refused write sends nothing
  const refused = (guard?: () => boolean): void => { if (guard && !guard()) throw new herdr.HerdrError("cancelled", "the write was withheld"); };
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text, _socket, guard) => { refused(guard); typed.push(text.replace("\u001b[200~", "paste:").replace("\u001b[201~", "")); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys, _socket, guard) => { refused(guard); typed.push(keys.join(",")); on.keys?.(keys); });
  const page = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: () => 1 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set<unknown>([page]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => ({ facts: () => ({ attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true,
      ready: true, held: false, currentHeld: false, mirror: false, cols: 52 }), write: () => {} }),
    submitText: async () => { typed.push("immediate"); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "agy", agent_status: now.status, focused: false, revision: 0 }] }),
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  const settled = async () => {
    for (let turn = 0; turn < 20; turn++) {
      for (let before: unknown; before !== tail;) { before = tail; await tail.catch(() => {}); }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  page.data.attached.set("p", { keepSize: false });
  /** what status.ts does with a status event of herdr's: pending.status, then drainPending */
  const event = (status: "working" | "idle"): void => { delivery.pending.status("p", status); delivery.drainPending("p"); };
  let id = 0;
  const queue = async (text: string): Promise<void> => { await delivery.pendingFrames.submit(page as never, { type: "submit", id: ++id, pane_id: "p", text, payload: text, delivery: "queue" } as never); };
  const rows = (): string[] => (delivery.pending.list(page as never, "p") as Row[]).map((row) => `${row.text} ${row.state}`);
  const results: { ok: boolean; code?: string }[] = [];
  page.send = ((raw: string) => {
    const frame = JSON.parse(raw) as { type?: string; ok?: boolean; code?: string };
    if (frame.type === "pending-result") results.push({ ok: frame.ok!, ...(frame.code ? { code: frame.code } : {}) });
    return 1;
  }) as never;
  const sendNow = (text: string): Promise<void> => {
    const row = (delivery.pending.list(page as never, "p") as Row[]).find((candidate) => candidate.text === text);
    if (!row) throw new Error(`no row ${text}`);
    return delivery.pendingFrames["pending-action"](page as never, { type: "pending-action", id: ++id, pane_id: "p", pending_id: row.id, action: "steer" } as never);
  };
  /** agy after the queue's Enter: the message waits in its own queue until alt+m; `status`, herdr's reading from then on */
  const queuesOnEnter = (text: string, status?: string): void => {
    on.keys = (keys) => {
      if (keys.includes("Enter")) { now.screen = agyScreen([queuedRow(text)]); if (status) now.status = status; }
      if (keys.includes("alt+m")) now.screen = agyScreen([]);
    };
  };
  /** the screen reads after the Send now's Enter: the first is the steering read's pendingContext, the second its noMaskedPrompt */
  const afterEnter = (run: (read: number) => void): void => {
    let entered = 0;
    const keys = on.keys;
    on.keys = (pressed) => { keys?.(pressed); if (pressed.includes("Enter")) entered = reads; };
    on.read = (count) => { if (entered > 0) run(count - entered); };
  };
  return { delivery, page, typed, now, on, settled, event, queue, rows, results, sendNow, queuesOnEnter, afterEnter };
}

describe("Send now on a working agy (#4325)", () => {
  it("types the message, its Enter, then alt+m once its queued row shows, and the next queued message waits for the turn", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    await d.queue("Y");
    d.queuesOnEnter("X");
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "alt+m"]);
    expect(d.results.at(-1)).toEqual({ ok: true });
    expect(d.rows()).toEqual(["Y queued"]);
    // a ready right after the Send now may be the end of a turn that X's Enter did not join: the queue waits for X's own turn
    d.on.keys = undefined;
    d.now.status = "idle"; d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "alt+m"]);
    d.now.status = "working"; d.event("working");
    d.now.status = "idle"; d.event("idle");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter", "alt+m", "paste:Y", "Enter"]);
  });

  it("withholds alt+m when the pane's status moved during the read before it", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    d.queuesOnEnter("X");
    // herdr's status event lands during the loop's last screen read: agy's turn ended, or a dialog came up
    d.afterEnter((read) => { if (read === 2) d.delivery.pending.status("p", "idle"); });
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)).toEqual({ ok: false, code: "submit_changed" });
    expect(d.rows()).toEqual(["X uncertain"]);
  });

  it("withholds alt+m once the page left the pane during the read before it", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    d.queuesOnEnter("X");
    d.afterEnter((read) => { if (read === 2) d.delivery.holdPending(d.page as never, "p"); });
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)?.ok).toBe(false);
  });

  it("presses nothing on an agy that shows a dialog after the Enter", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    d.queuesOnEnter("X", "blocked");
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)).toEqual({ ok: false, code: "submit_changed" });
  });

  it("presses nothing on an agy at rest after the Enter (herdr-core reads its plan review as done)", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    d.queuesOnEnter("X", "done");
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)).toEqual({ ok: true });
    expect(d.rows()).toEqual([]);
  });

  it("presses nothing while a draft sits in agy's input box, which alt+m would send at once too", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    // someone types into agy's own terminal right after the Enter
    d.on.keys = (keys) => { if (keys.includes("Enter")) d.now.screen = agyScreen([queuedRow("X")]).replace("\n>\n", "\n> not finished yet\n"); };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)).toEqual({ ok: true });
  });

  it("presses nothing for a row of another message, and settles the send once no row of its own shows", async () => {
    const d = pane();
    d.event("working");
    await d.queue("X");
    d.on.keys = (keys) => { if (keys.includes("Enter")) d.now.screen = agyScreen([queuedRow("something else")]); };
    await d.sendNow("X");
    await d.settled();
    expect(d.typed).toEqual(["paste:X", "Enter"]);
    expect(d.results.at(-1)).toEqual({ ok: true });
  });
});
