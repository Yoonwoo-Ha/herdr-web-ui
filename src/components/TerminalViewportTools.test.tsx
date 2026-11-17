import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Terminal } from "@xterm/xterm";
import type { PaneScrollInfo } from "../../shared/protocol.ts";
import * as machineContext from "../lib/machineContext.tsx";
import * as settingsModule from "../lib/settings.ts";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { TerminalViewportTools } from "./TerminalViewportTools.tsx";

const ROWS = 24;
/** a page moves the viewport less one overlap row (pageScrollDistance) */
const PAGE = ROWS - 1;
const metrics = (max: number, offset = 0): PaneScrollInfo => ({ offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: ROWS });

// React, the component and its viewport gate are real; herdr's scroll API, the xterm terminal and the DOM are stand-ins.
describe("a page held for a scroll read on stale zero-history metrics", () => {
  const globals = ["document", "getComputedStyle", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let saved: (PropertyDescriptor | undefined)[] = [];
  let spies: { mockRestore(): void }[] = [];
  let renderer: ReactTestRenderer | null = null;
  /** each metrics read waits for the test to answer it */
  let reads: ((scroll: PaneScrollInfo) => void)[] = [];
  let scrolledTo: number[] = [];
  let applicationPages: number[] = [];
  let output: () => void = () => {};
  const pageScroll: { current: ((direction: -1 | 1) => void) | null } = { current: null };

  beforeEach(async () => {
    jest.useFakeTimers();
    reads = []; scrolledTo = []; applicationPages = []; pageScroll.current = null;
    saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const listen = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { visibilityState: "visible", ...listen } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, writable: true, value: () => ({ visibility: "visible" }) });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, writable: true, value: class { observe() {} disconnect() {} } });
    spies = [
      spyOn(machineContext, "useMachineApi").mockReturnValue({
        fetchPaneScroll: () => new Promise<PaneScrollInfo>((resolve) => { reads.push(resolve); }),
        scrollPane: async (_pane: string, offset: number) => { scrolledTo.push(offset); return metrics(273, offset); },
      } as unknown as ReturnType<typeof machineContext.useMachineApi>),
      spyOn(settingsModule, "useSettings").mockReturnValue({
        settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en",
      } as ReturnType<typeof settingsModule.useSettings>),
    ];
    const disposable = { dispose() {} };
    const terminal = {
      cols: 80, rows: ROWS,
      element: { getClientRects: () => [{}], querySelector: () => null, parentElement: null, dispatchEvent: () => true, ...listen },
      buffer: { active: { viewportY: 0, baseY: 0, getLine: () => undefined } },
      onWriteParsed: (listener: () => void) => { output = listener; return disposable; },
      onScroll: () => disposable, onRender: () => disposable, onResize: () => disposable,
    } as unknown as Terminal;
    await act(async () => {
      renderer = create(createElement(TerminalViewportTools, {
        viewportIntent: new ViewportIntentGate(), terminal, paneId: "w1:p1", pageScroll,
        onApplicationPage: (direction) => { applicationPages.push(direction); },
        enabled: true, interactive: true, search: null, onError: (message) => { throw new Error(message); },
      }));
    });
    // a program owned the screen: no history to scroll; then it quits and hands the screen back to the shell
    await answer(metrics(0));
    await act(async () => { output(); });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    for (const spy of spies) spy.mockRestore();
    globals.forEach((name, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
    jest.useRealTimers();
  });

  /** Answers the oldest pending read and lets its promise chain (and a scroll write it starts) finish. */
  async function answer(scroll: PaneScrollInfo) {
    const resolve = reads.shift();
    expect(resolve).toBeDefined();
    await act(async () => { resolve!(scroll); for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
  }
  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  /** Lets the poll run on for a few seconds, every read answered with the scrolled view of `max` rows of history. */
  async function drain(max = 273) {
    for (let step = 0; step < 20; step++) {
      await advance(250);
      while (reads.length) await answer(metrics(max, scrolledTo.at(-1) ?? 0));
    }
  }

  it("scrolls the shell's history once when the read began in time but returns after the hold", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // the read began at the press and takes longer than the hold to come back
    await advance(1100);
    await answer(metrics(273));
    expect(scrolledTo).toEqual([PAGE]);
    await drain();
    expect(scrolledTo).toEqual([PAGE]);
    expect(applicationPages).toEqual([]);
  });

  it("does not scroll the history when the read that began in time returns seconds later", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    await advance(3100);
    await answer(metrics(273));
    expect(scrolledTo).toEqual([]);
    await drain();
    expect(scrolledTo).toEqual([]);
    expect(applicationPages).toEqual([]);
  });

  it("sends the page to the program once when the read began in time but returns after the hold", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // still the program's screen: no history, so the page goes to the program as a key
    await advance(1100);
    await answer(metrics(0));
    expect(applicationPages).toEqual([-1]);
    await drain(0);
    expect(applicationPages).toEqual([-1]);
    expect(scrolledTo).toEqual([]);
  });

  it("sends nothing to the program when the read that began in time returns seconds later", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    await advance(3100);
    await answer(metrics(0));
    expect(applicationPages).toEqual([]);
    await drain(0);
    expect(applicationPages).toEqual([]);
    expect(scrolledTo).toEqual([]);
  });

  it("drops the page when the read that answers it began after the hold expired", async () => {
    await act(async () => { pageScroll.current!(-1); });
    await advance(0);
    expect(reads).toHaveLength(1);
    // output during the read: its metrics are stale, so the page waits for the next read, 1350 ms after the press
    await act(async () => { output(); });
    await advance(1100);
    await answer(metrics(273));
    await advance(250);
    expect(reads).toHaveLength(1);
    await answer(metrics(273));
    await drain();
    expect(scrolledTo).toEqual([]);
    expect(applicationPages).toEqual([]);
  });
});
