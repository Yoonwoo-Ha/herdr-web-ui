import { describe, expect, it } from "bun:test";
import { coreModel } from "./core-model.ts";

/** A model as the adapter makes one: each terminal's first turn is the one it had when first seen. */
function model() {
  const firstTurns = new Map<string, number>();
  return coreModel({
    firstTurn: (terminal) => {
      if (!firstTurns.has(terminal.address)) firstTurns.set(terminal.address, terminal.turn ?? 0);
      return firstTurns.get(terminal.address)!;
    },
    host: "linux",
  });
}

const working = { app: "claude-code", state: "working" };
const idle = { app: "claude-code", state: "idle" };

describe("coreModel", () => {
  it("events before the snapshot wait", () => {
    const core = model();
    expect(core.event({ type: "status", terminal: "t1", data: { status: idle } })).toEqual([]);
    expect(core.event({ type: "turn", terminal: "t1", data: { turn: 2 } })).toEqual([]);
    expect(core.event({ type: "created", terminal: "t2", data: { address: "t2", turn: 0 } })).toEqual([]);
    // the snapshot answers them in the order they came, as if they came after it
    expect(core.seed([{ address: "t1", status: working, turn: 1, labels: { "herdr.seen": "1" } }])).toEqual([
      { type: "status", terminal: "t1", status: idle, shown: "done", agent: "claude" },
      { type: "created", terminal: "t2" },
    ]);
  });

  it("a turn decides done, not the status before it", () => {
    const core = model();
    expect(core.seed([{ address: "t1", status: working, turn: 3, labels: { "herdr.seen": "3" } }])).toEqual([]);
    expect(core.event({ type: "status", terminal: "t1", data: { status: idle } })).toEqual([]);
    expect(core.event({ type: "turn", terminal: "t1", data: { turn: 4 } })).toEqual([
      { type: "status", terminal: "t1", status: idle, shown: "done", agent: "claude" },
    ]);
  });

  it("another machine's events are dropped", () => {
    const core = model();
    expect(core.seed([{ address: "vps/t2", status: idle, turn: 0 }, { address: "t1", turn: 0 }])).toEqual([]);
    expect(core.event({ type: "created", terminal: "vps/t3", data: { address: "vps/t3", turn: 0 } })).toEqual([]);
    expect(core.event({ type: "status", terminal: "vps/t2", data: { status: working } })).toEqual([]);
    expect(core.event({ type: "finished", terminal: "vps/t2", data: { reason: "exited", exit_code: 0 } })).toEqual([]);
    // the other machine's own Herdr app document: its machine, no terminal
    expect(core.event({ type: "doc", machine: "vps", data: { name: "herdr-app", version: 1 } })).toEqual([]);
    expect(core.event({ type: "created", terminal: "t4", data: { address: "t4", turn: 0 } })).toEqual([{ type: "created", terminal: "t4" }]);
  });

  it("a kill is a close without an exit", () => {
    const core = model();
    expect(core.seed([{ address: "t1", turn: 0 }, { address: "t2", turn: 0 }])).toEqual([]);
    expect(core.event({ type: "finished", terminal: "t1", data: { reason: "killed", signal: 1 } })).toEqual([{ type: "closed", terminal: "t1" }]);
    expect(core.event({ type: "finished", terminal: "t2", data: { reason: "exited", exit_code: 3 } })).toEqual([{ type: "exited", terminal: "t2" }, { type: "closed", terminal: "t2" }]);
  });
});
