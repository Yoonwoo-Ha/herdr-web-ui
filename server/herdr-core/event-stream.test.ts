import { describe, expect, it } from "bun:test";
import type { ChannelHandlers } from "./connection.ts";
import type { HcEvent } from "./core-model.ts";
import { EVENT_LINE_BYTES, type MissedSnapshot, openEventStream } from "./event-stream.ts";

/** The stream's reader on a channel the test feeds by hand, and everything it told its reader. */
async function stream() {
  let channel: ChannelHandlers | null = null;
  const told: (string | [string, unknown, unknown?])[] = [];
  await openEventStream({
    open: (_method, _params, handlers) => {
      channel = handlers;
      return Promise.resolve({ result: { channel: 1, seq: 0, terminals: [] }, channel: {} as never });
    },
  } as Parameters<typeof openEventStream>[0], {
    event: (event: HcEvent, seq: number | null) => told.push(["event", event, seq]),
    resync: (missed?: MissedSnapshot) => told.push(missed === undefined ? "resync" : ["resync", missed]),
    tooLong: () => told.push("tooLong"),
    heard: () => told.push("heard"),
  });
  const line = (message: unknown) => channel!.onData(new TextEncoder().encode(`${typeof message === "string" ? message : JSON.stringify(message)}\n`));
  return { told, line, close: () => channel!.onClose({ reason: "connection_lost" }), bytes: (bytes: Uint8Array) => channel!.onData(bytes) };
}

describe("openEventStream", () => {
  it("hands each event its seq, and null when the line carries none", async () => {
    const { told, line } = await stream();
    line({ jsonrpc: "2.0", method: "event", params: { seq: 7, type: "status", terminal: "t1", data: { status: null } } });
    line({ jsonrpc: "2.0", method: "event", params: { type: "doc", data: { name: "ovis-layout", version: 2 } } });
    expect(told).toEqual([
      "heard", ["event", { type: "status", terminal: "t1", data: { status: null } }, 7],
      "heard", ["event", { type: "doc", data: { name: "ovis-layout", version: 2 } }, null],
    ]);
  });

  it("passes the snapshot of a missed that carries one, and a bare resync for one of another shape", async () => {
    const { told, line } = await stream();
    line({ jsonrpc: "2.0", method: "missed", params: { seq: 9, terminals: [{ address: "t1" }] } });
    line({ jsonrpc: "2.0", method: "missed", params: { seq: "9", terminals: [] } });
    line({ jsonrpc: "2.0", method: "missed", params: { seq: 9, terminals: {} } });
    line({ jsonrpc: "2.0", method: "missed" });
    expect(told).toEqual(["heard", ["resync", { seq: 9, terminals: [{ address: "t1" }] }], "heard", "resync", "heard", "resync", "heard", "resync"]);
  });

  it("hears a heartbeat as a line and nothing more; a line that is not JSON and the stream's end are a bare resync", async () => {
    const { told, line, close } = await stream();
    line({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 3 } });
    line("not json");
    close();
    expect(told).toEqual(["heard", "heard", "resync", "resync"]);
  });

  it("tells a line past EVENT_LINE_BYTES as too long, without hearing it", async () => {
    const { told, bytes } = await stream();
    bytes(new Uint8Array(EVENT_LINE_BYTES + 1).fill(0x61));
    expect(told).toEqual(["tooLong"]);
  });
});
