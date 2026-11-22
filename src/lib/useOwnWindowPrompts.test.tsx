import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { RelayPairingRequest } from "../../shared/machines.ts";
import { TAILNET_NODE_ROUTES } from "../../shared/tailnet-nodes.ts";
import type { PromptPairing } from "../components/RelayPairingPrompt.tsx";
import { nativeTransport, setTransport } from "./transport.ts";
import { useOwnWindowPrompts } from "./useOwnWindowPrompts.ts";

const JOINS = [{ id: "join-1", label: "Phone", digits: "123456", left_ms: 60_000 }, { id: "join-2", label: "Galaxy", left_ms: 60_000 }];
const TAILNET = { pending: { id: "nPhone1CNTRL", hostname: "pixel", login: "owner@example.com", asked_at: "2026-11-21T00:00:00.000Z" }, nodes: [] };
// the real useOwnJoins and useTailnetNodes read these through the app's transport: no module of theirs is replaced, so
// another file in the same process (OwnJoins.test.tsx, DevicesPanel's) still gets the real ones
let joinReads = 0;
const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
  joinReads = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  setTransport({ ...nativeTransport, fetch: (async (input: string | URL | Request) => {
    const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
    if (path === "/api/relay/joins") { joinReads++; return Response.json({ joins: JOINS }); }
    if (path === TAILNET_NODE_ROUTES.list) return Response.json(TAILNET);
    return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  }) as typeof nativeTransport.fetch });
});
const settle = (): Promise<void> => act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });

let renderer: ReactTestRenderer | undefined;
let prompts: readonly PromptPairing[] = [];
let joins: readonly { id: string }[] = [];
function Probe({ pairings, ownWindow = true, unlocked = true }: { pairings: readonly RelayPairingRequest[]; ownWindow?: boolean; unlocked?: boolean }) {
  ({ prompts, joins } = useOwnWindowPrompts(pairings, [], ownWindow, unlocked));
  return null;
}

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  jest.useRealTimers();
  setTransport(nativeTransport);
  if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore); else Reflect.deleteProperty(globalThis, "document");
});

it("keeps a first join's deadline when an unrelated update rebuilds the prompts", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  const first = prompts.find((prompt) => prompt.id === "join-1")?.expires_at;
  expect(first).toBe("2026-11-21T00:01:00.000Z");
  jest.setSystemTime(new Date("2026-11-21T00:00:02Z"));
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [] })); });
  expect(prompts.find((prompt) => prompt.id === "join-1")?.expires_at).toBe(first);
});

it("puts a removed Tailscale device on this PC's own window alone, with its node id and login", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  expect(prompts.find((prompt) => prompt.own_window === "tailnet")).toMatchObject({ id: "nPhone1CNTRL", label: "pixel", digits: "nPhone1CNTRL", login: "owner@example.com" });
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], ownWindow: false })); });
  expect(prompts.filter((prompt) => prompt.own_window === "tailnet")).toEqual([]);
});

it("#16: a members join (no digits) goes to the own window's card, not the tap prompts; a locked PC is not asked", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window !== "tailnet").map((prompt) => prompt.id)).toEqual(["join-1"]);
  expect(joins.map((join) => join.id)).toEqual(["join-1", "join-2"]);
  const reads = joinReads;
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], unlocked: false })); });
  await settle();
  expect(joinReads).toBe(reads);
  expect(joins).toEqual([]);
});
