import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const now = Date.parse("2026-11-22T05:10:00.000Z");
const turnOf = (part: ConversationTurn["parts"][number]): ConversationTurn => ({ role: "user", ts: "2026-11-22T05:00:09.000Z", parts: [part] });
const element = (turn: ConversationTurn) => createElement(SettingsProvider, {
  children: createElement(Turn, { paneId: "p1", turn, rowKey: "r1", live: false, waiting: false, showThinking: false }),
});
const textOf = (node: ReactTestRenderer["root"]): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  for (const name of globals) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const style = { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "", backgroundColor: "" };
  const listen = { addEventListener: () => {}, removeEventListener: () => {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  jest.useFakeTimers();
  jest.setSystemTime(new Date(now));
});
afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});
const mount = (turn: ConversationTurn): ReactTestRenderer => {
  act(() => { renderer = create(element(turn)); });
  return renderer!;
};

test("a stop is a quiet line that says so, not a bubble in the person's name or a notice to open", () => {
  const row = mount(turnOf({ kind: "notice", text: "Stopped", source: "stopped" }));
  const lines = row.root.findAll((node) => node.props.className === "chat-goal-wait chat-stopped");
  expect(lines).toHaveLength(1);
  expect(textOf(lines[0]!)).toStartWith("Stopped · ");
  expect(row.root.findAll((node) => typeof node.props.className === "string" && /chat-turn-user|chat-notice/.test(node.props.className))).toHaveLength(0);
});

test("Claude Code's other notices still open as before", () => {
  const row = mount(turnOf({ kind: "notice", text: "Usage limit reached", source: "informational" }));
  expect(row.root.findAll((node) => node.props.className === "chat-goal-wait chat-stopped")).toHaveLength(0);
  expect(row.root.findAll((node) => node.props.className === "chat-compact chat-notice").length).toBeGreaterThan(0);
});
