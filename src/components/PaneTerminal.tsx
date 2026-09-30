import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TriangleAlert } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { controlCode, isPrintable, keySequence, type KeyBarKey } from "../lib/keys.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, type InputDraft } from "../lib/draft.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, composerMessage, composerPayload, submitNote } from "../lib/compose.ts";
import { answerFromText, answerHint, answerRefusal, needsConfirmation, type TypedAnswer } from "../lib/promptAnswer.ts";
import { ApiError, fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { TerminalInput } from "./TerminalInput.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { ChatView } from "./ChatView.tsx";
import { Composer } from "./Composer.tsx";
import type { AgentStatus, ClientRole, ConversationMetadata, InteractivePrompt, ServerMessage, UnreadablePrompt } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { terminalTheme, type ResolvedTheme } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";

// xterm sizes every cell from the first matching font, so a proportional one (Malgun Gothic)
// must never win it: it stays behind the generic monospace as a per-glyph Hangul fallback
const FONT_STACK =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Cascadia Mono", Consolas, "Noto Sans Mono CJK KR", monospace, "Malgun Gothic"';

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;

export interface PaneTerminalProps {
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** the resolved UI theme: the xterm theme object mirrors it */
  theme: ResolvedTheme;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). */
  onConnectionChange?: (connected: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}


/** Whether this device types in the terminal's input line or straight into the grid: remembered per device. */
const DIRECT_TYPING_KEY = "herdr-web-ui:direct-typing";

function storedDirectTyping(): boolean {
  try { return window.localStorage.getItem(DIRECT_TYPING_KEY) === "1"; } catch { return false; }
}

/** A touch screen as the main pointer: its soft keyboard is what the input line is for. */
function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = (): void => setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
export function PaneTerminal({
  paneId,
  restoreError = null,
  agent = null,
  agentStatus,
  view,
  autoSelected = false,
  terminalFontSize,
  theme,
  role = "interact",
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const t = useT();
  const machineId = useMachineId();
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const chatView = view === "chat";
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  const [outputReady, setOutputReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // another web bridge has this pane's terminal: the server waits for it and says attach-resumed
  const [held, setHeldState] = useState(false);
  // what the socket handlers read mid-stream: stdin, onData and the composer's submit
  const heldRef = useRef(false);
  const setHeld = useCallback((next: boolean) => { heldRef.current = next; setHeldState(next); }, []);
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  const [observing, setObserving] = useState(false);
  const [secret, setSecret] = useState<{ pane: string; prompt: string } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret?.pane === paneId;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useCoarsePointer();
  const [directTyping, setDirectTyping] = useState(storedDirectTyping);
  const inputLine = coarse && !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // input typed while disconnected, held for the user to review and send
  const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);
  const draftPaneRef = useRef<string | null>(null);
  const draftOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!paneId) return;
    const owner = paneStorageId(machineId, paneId);
    if (draftOwner.current !== owner) { draftOwner.current = owner; return; }
    try { if (draftIsEmpty(draft)) localStorage.removeItem(`herdr-web-ui:terminal-draft:${owner}`); else localStorage.setItem(`herdr-web-ui:terminal-draft:${owner}`, JSON.stringify(draft)); } catch {}
  }, [draft, paneId]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the composer's send bumps this so the chat lens refetches without waiting a poll beat
  const [chatRefresh, setChatRefresh] = useState(0);
  // bumped as a composer message goes out: the chat must not title the turn before it as running
  const [chatSent, setChatSent] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  // The prompt the chat shows: while it waits, a message from the composer answers it.
  const [chatPrompt, setChatPrompt] = useState<{ pane: string; value: InteractivePrompt } | null>(null);
  const [promptRefresh, setPromptRefresh] = useState(0);
  // a dialog no parser reads, while the chat shows its card: a typed option number answers it
  const [chatUnreadable, setChatUnreadable] = useState<{ pane: string; value: UnreadablePrompt } | null>(null);
  const onChatUnreadable = useCallback((pane: string, value: UnreadablePrompt | null) => {
    setChatUnreadable((current) => value !== null ? { pane, value } : current?.pane === pane ? null : current);
  }, []);
  // a typed pick of an approval's option, shown in the card until Confirm or Cancel
  const [pendingAnswer, setPendingAnswer] = useState<{ pane: string; promptId: string; answer: TypedAnswer } | null>(null);
  const clearPendingAnswer = useCallback(() => setPendingAnswer(null), []);
  const onChatPrompt = useCallback((pane: string, value: InteractivePrompt | null) => {
    setChatPrompt((current) => value !== null ? { pane, value } : current?.pane === pane ? null : current);
    // a typed pick belongs to the prompt it was typed for: once that prompt changes or goes
    // away (a tap in the card, an answer in the terminal), the same question asked again
    // later opens clean, not with the old pick waiting one tap from Confirm
    setPendingAnswer((current) => current?.pane === pane && current.promptId !== value?.id ? null : current);
  }, []);
  // back at work, the agent has had its answer, maybe from the terminal: the same prompt asked
  // again before the chat's next read must not bring the pick back either
  useEffect(() => {
    if (agentStatus === "working") setPendingAnswer(null);
  }, [agentStatus]);
  const onChatMetadata = useCallback((pane: string, value: ConversationMetadata | null) => {
    // the same settings keep the same object: every 2 s poll would otherwise re-render the composer
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort
      && previous.value?.context?.used === value?.context?.used
      && previous.value?.context?.window === value?.context?.window ? previous : { pane, value });
  }, []);
  const queueStore = messageQueues;
  const queueOwner = paneId === null ? null : paneStorageId(machineId, paneId);
  const queued = useSyncExternalStore(queueStore.subscribe, () => queueStore.read(queueOwner ?? ""));
  const sendingRef = useRef(false);
  const [queueSending, setQueueSending] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<{ owner: string; id: string; text: string } | null>(null);

  paneRef.current = paneId;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    onConnectionChangeRef.current?.(connected);
  }, [connected]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // one terminal + one socket for the lifetime of the component
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // xterm keeps no scrollback: the attach stream lives in the alternate screen and herdr
      // owns scrollback (wheel and touch go to it). With scrollback on, the fit addon reserves
      // a scrollbar column - 15px by fallback wherever scrollbars are overlays - and the last
      // columns of the hero surface go dead.
      scrollback: 0,
      allowProposedApi: true,
      fontSize: terminalFontSize,
      fontFamily: FONT_STACK,
      theme: terminalTheme(theme),
      // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // an address in the terminal opens in a new tab; the page never navigates away from the pane
    term.loadAddon(new WebLinksAddon((_event, uri) => { window.open(uri, "_blank", "noopener,noreferrer"); }));
    term.open(host);
    // Let the browser emit a paste event, which xterm already handles (including
    // bracketed paste). Otherwise Ctrl+V becomes 0x16, triggering the agent's
    // image-paste shortcut against the server's clipboard and canceling text paste.
    // Returning false skips xterm's key handling without preventing browser defaults.
    // With text selected, Ctrl+C (and Ctrl+Shift+C) copies it instead of interrupting the pane.
    // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
    // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const typed = event.key.toLowerCase();
      const key = /^[a-z]$/.test(typed) ? typed : /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? typed;
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          copySelection();
          term.clearSelection();
        }
        return false;
      }
      return true;
    });
    // herdr reads the wheel as mouse reports. Were reporting ever off, xterm would turn
    // a wheel into arrow keys, which walk an agent's prompt history instead of scrolling.
    // A selecting drag takes the wheel itself (see below); after one, a wheel scrolls the
    // highlight's text away, so the highlight goes with it.
    term.attachCustomWheelEventHandler((event) => {
      if (drag) {
        dragWheel(event);
        return false;
      }
      if (term.hasSelection()) term.clearSelection();
      return term.modes.mouseTrackingMode !== "none";
    });
    termRef.current = term;
    fitRef.current = fit;

    /** herdr's text for the last drag, while its highlight is still the selection */
    let copiedText: string | null = null;
    let selectionGeneration = 0;
    let disposed = false;
    // Run after xterm's own copy listener, including for Cmd+C and context-menu
    // Copy. Its buffer contains only the visible part of a scrolled selection.
    const onCopy = (event: ClipboardEvent): void => {
      if (!term.hasSelection() || copiedText === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copiedText);
      event.preventDefault();
    };
    host.addEventListener("copy", onCopy);
    const copySelection = (): void => {
      const text = copiedText ?? term.getSelection();
      if (!text) return;
      // Native copy still works in a user gesture when a Chromium/PWA site has
      // denied the async clipboard permission, or plain HTTP has no clipboard API.
      if (document.execCommand("copy")) {
        noteClipboard("copied to clipboard");
        return;
      }
      if (!navigator.clipboard) {
        noteClipboard("clipboard write blocked by the browser");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => { if (!disposed) noteClipboard("copied to clipboard"); },
        () => { if (!disposed) noteClipboard("clipboard write blocked by the browser"); },
      );
    };
    const selectionChange = term.onSelectionChange(() => {
      if (!term.hasSelection()) {
        copiedText = null;
        selectionGeneration++;
      }
    });

    // herdr's attach stream turns mouse reporting on, so xterm hands every click to the
    // pty and selects only with Shift (Option on macOS) held. `herdr terminal attach`
    // ignores left clicks and drags - selection lives in herdr's own TUI client - so a
    // left drag here selects as if the modifier were held, and letting go copies, as the
    // herdr TUI does. Touch keeps its drag-to-scroll.
    //
    // xterm keeps no scrollback (herdr owns it), so a drag that outlives one screen is
    // tracked in herdr's history rows: a wheel, or dragging past the top or bottom edge,
    // scrolls the pane through the API, the highlight is repainted over the visible part,
    // and letting go copies herdr's own text for the range, soft-wrapped lines joined.
    // Without the API (plain HTTP, observe mode, an older remote bridge, a failed read)
    // only the visible selection is copied, as xterm has it.
    interface Cell { row: number; col: number }
    interface Drag {
      pane: string;
      /** the pressed cell on screen */
      anchor: Cell;
      /** the cell under the pointer on screen, its row clamped to the screen */
      cursor: Cell;
      /** the history row at the top of the screen, once herdr has told us */
      top: number | null;
      /** the pressed cell's history row */
      anchorRow: number;
      offset: number;
      maxOffset: number;
      /** the drag left the first screen: it is painted here, not by xterm */
      scrolled: boolean;
      /** pointer beyond the top (-1) or bottom (1) edge, which keeps scrolling */
      edge: -1 | 0 | 1;
      wheelPixels: number;
      sentOffset: number;
      sending: boolean;
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    let drag: Drag | null = null;
    let edgeTimer: number | null = null;
    const cellAt = (event: MouseEvent): { cell: Cell; edge: -1 | 0 | 1 } => {
      const rect = (term.element?.querySelector(".xterm-screen") ?? host).getBoundingClientRect();
      const col = Math.floor((event.clientX - rect.left) / (rect.width / term.cols));
      const row = Math.floor((event.clientY - rect.top) / (rect.height / term.rows));
      return {
        cell: { row: Math.max(0, Math.min(term.rows - 1, row)), col: Math.max(0, Math.min(term.cols - 1, col)) },
        edge: row < 0 ? -1 : row >= term.rows ? 1 : 0,
      };
    };
    const ordered = (a: Cell, b: Cell): [Cell, Cell] =>
      a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    /** the drag's range in history rows, both ends inclusive */
    const historyRange = (d: Drag): [Cell, Cell] =>
      ordered({ row: d.anchorRow, col: d.anchor.col }, { row: d.top! + d.cursor.row, col: d.cursor.col });
    const repaint = (d: Drag): void => {
      const [start, end] = historyRange(d);
      const first = d.top!;
      const last = first + term.rows - 1;
      if (end.row < first || start.row > last) {
        term.clearSelection();
        return;
      }
      const from = start.row < first ? { row: 0, col: 0 } : { row: start.row - first, col: start.col };
      const to = end.row > last ? { row: term.rows - 1, col: term.cols - 1 } : { row: end.row - first, col: end.col };
      term.select(from.col, from.row, to.row * term.cols + to.col + 1 - (from.row * term.cols + from.col));
    };
    /** one request at a time; the latest wanted offset wins */
    const sendScroll = (d: Drag): void => {
      if (d.sending || d.sentOffset === d.offset) return;
      d.sending = true;
      const target = d.offset;
      void scrollPane(d.pane, target, machineId).catch(() => {}).finally(() => {
        d.sending = false;
        d.sentOffset = target;
        sendScroll(d);
      });
    };
    /** positive lines show older text */
    const scrollDrag = (d: Drag, lines: number): void => {
      if (d.top === null) return;
      const offset = Math.max(0, Math.min(d.maxOffset, d.offset + lines));
      if (offset === d.offset) return;
      d.offset = offset;
      d.top = d.maxOffset - offset;
      d.scrolled = true;
      repaint(d);
      sendScroll(d);
    };
    const dragWheel = (event: WheelEvent): void => {
      const d = drag;
      if (!d || d.top === null) return;
      const lineHeight = (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? term.rows) / term.rows;
      d.wheelPixels += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY;
      const lines = Math.trunc(d.wheelPixels / lineHeight);
      if (lines === 0) return;
      d.wheelPixels -= lines * lineHeight;
      scrollDrag(d, -lines);
    };
    const stopEdge = (): void => {
      if (edgeTimer !== null) window.clearInterval(edgeTimer);
      edgeTimer = null;
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      if (!term.element?.contains(event.target as Node)) return;
      // with reporting off xterm already selects on a plain drag; only the history tracking is ours
      if (term.modes.mouseTrackingMode !== "none") Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { value: true });
      copiedText = null;
      selectionGeneration++;
      const pane = paneRef.current;
      const { cell } = cellAt(event);
      const d: Drag = {
        pane: pane ?? "", anchor: cell, cursor: cell, top: null, anchorRow: 0, offset: 0, maxOffset: 0,
        scrolled: false, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false,
      };
      drag = d;
      if (!pane || !navigator.clipboard || observeRef.current) return;
      void fetchPaneScroll(pane, machineId).then((scroll) => {
        if (!scroll || drag !== d || d.scrolled) return;
        d.offset = d.sentOffset = scroll.offset_from_bottom;
        d.maxOffset = scroll.max_offset_from_bottom;
        d.top = d.maxOffset - d.offset;
        d.anchorRow = d.top + d.anchor.row;
      }, () => {});
    };
    // capture on window: ahead of xterm's own document listener, which would repaint a
    // scrolled drag from its stale screen anchor
    const onMouseMove = (event: MouseEvent): void => {
      const d = drag;
      if (!d) return;
      const { cell, edge } = cellAt(event);
      // past an edge the edge row is taken whole, as xterm does
      d.cursor = edge < 0 ? { row: 0, col: 0 } : edge > 0 ? { row: term.rows - 1, col: term.cols - 1 } : cell;
      if (d.top === null) return;
      if (edge !== d.edge) {
        d.edge = edge;
        stopEdge();
        if (edge !== 0) edgeTimer = window.setInterval(() => scrollDrag(d, -d.edge), 60);
      }
      if (d.scrolled || edge !== 0) {
        event.stopPropagation();
        // painted here from now on, even where herdr has no further to scroll
        d.scrolled = true;
        repaint(d);
      }
    };
    // a release outside the window never arrives: stop scrolling the shared pane
    const onBlur = (): void => {
      stopEdge();
      drag = null;
    };
    const onMouseUp = (event: MouseEvent): void => {
      const d = drag;
      if (!d || event.button !== 0) return;
      drag = null;
      stopEdge();
      // Window bubble runs after xterm's document listener, still inside the
      // release gesture. A timer here loses clipboard permission in some browsers.
      if (d.scrolled) repaint(d);
      if (!term.hasSelection()) return;
      const visibleText = term.getSelection();
      copiedText = visibleText;
      copySelection();
      const generation = selectionGeneration;
      const current = (): boolean => !disposed && paneRef.current === d.pane && generation === selectionGeneration;
      let range: [Cell, Cell] | null = null;
      if (d.scrolled) range = historyRange(d);
      else if (d.top !== null) {
        const position = term.getSelectionPosition();
        if (position) {
          // xterm's end column is exclusive, herdr's inclusive
          const end = position.end.x > 0
            ? { row: d.top + position.end.y, col: position.end.x - 1 }
            : { row: d.top + position.end.y - 1, col: term.cols - 1 };
          range = [{ row: d.top + position.start.y, col: position.start.x }, end];
        }
      }
      if (!range) return;
      const text = fetchPaneSelection(d.pane, range[0], range[1], machineId).catch(() => {
        if (current() && d.scrolled) noteClipboard("could not read the selection from herdr");
        return visibleText;
      }).then((value) => {
        if (!current()) throw new Error("selection changed");
        // A redraw can remove the range before herdr reads it. Keep what the user
        // actually selected instead of replacing a successful copy with nothing.
        copiedText = value || visibleText;
        return copiedText;
      });
      // Reserve the write NOW, supplying the server text when it arrives. Never
      // start a fresh clipboard write from a delayed response or an older drag.
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
        void blob.catch(() => {});
        // Denied (the case native copy covers), the clipboard keeps only the visible rows of a
        // scrolled drag: say so, since the whole text waits for an explicit Copy or Ctrl+C
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        });
      } else {
        // Native copy already captured the visible text; the full text stays
        // available for the next explicit Copy where delayed items are unsupported.
        void text.then(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        }, () => {});
      }
    };
    host.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", onMouseUp);

    // OSC 52: the pane program asked the terminal to set the clipboard - the pty
    // cannot reach the browser clipboard, so xterm hands us the sequence and
    // navigator.clipboard completes the hop (text only; queries are ignored)
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload);
      if (text !== null) {
        void navigator.clipboard?.writeText(text).then(
          () => noteClipboard("copied to clipboard"),
          () => noteClipboard("clipboard write blocked by the browser"),
        );
      }
      return true;
    });

    const socket = new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    socketRef.current = socket;
    let outputGeneration = 0;
    const off = socket.on((message) => {
      onServerMessageRef.current?.(message);
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        const acknowledge = socket.outputAcknowledgement(message);
        const owner = message.pane_id;
        const generation = outputGeneration;
        term.write(message.data, () => {
          acknowledge?.();
          if (paneRef.current !== owner || generation !== outputGeneration) return;
          setOutputReady(true);
          const lines: string[] = [];
          const buffer = term.buffer.active;
          for (let row = 0; row < buffer.length; row++) {
            const line = buffer.getLine(row);
            const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped) ?? "";
            if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
            else lines.push(text);
          }
          const prompt = secretPrompt(lines.join("\n"), term.cols);
          secretRef.current = prompt;
          term.options.disableStdin = observeRef.current || prompt !== null || heldRef.current;
          setSecret((previous) => previous?.pane === owner && previous.prompt === prompt ? previous : prompt ? { pane: owner, prompt } : null);
        });
      } else if (message.type === "attach-resumed") {
        if (message.pane_id === paneRef.current) {
          setHeld(false);
          term.options.disableStdin = observeRef.current || secretRef.current !== null;
        }
      } else if (message.type === "pty-exit") {
        if (message.pane_id === paneRef.current) setEnded(true);
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        setObserving(nowObserving);
        term.options.disableStdin = nowObserving || secretRef.current !== null || heldRef.current;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving) {
          try {
            fit.fit();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane) socket.resize(pane, term.cols, term.rows, true);
        }
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this
        if (!observeRef.current || message.pane_id !== paneRef.current) return;
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
      } else if (message.type === "error") {
        if (message.code === "attach_held") {
          // a pane this terminal already left: its wait is not this pane's
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // not an end: the server attaches as soon as the other bridge lets go
          setHeld(true);
          term.options.disableStdin = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          setOutputError(message.message);
          setEnded(true);
          setConnected(false);
          term.options.disableStdin = true;
          return;
        }
        term.writeln(`\r\n\u001b[31m[herdr-web-ui] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
    });
    const offDisconnect = socket.onDisconnect(() => {
      outputGeneration++;
      setOutputReady(false);
      setConnected(false);
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      setHeld(false);
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    const onData = term.onData((data) => {
      const current = paneRef.current;
      if (!current || observeRef.current || secretRef.current !== null || heldRef.current) return;
      if (!socket.connected) {
        // policy: commands typed into a dead connection are never auto-sent on
        // reconnect - they wait in a draft the user reviews (see the banner below)
        if (draftPaneRef.current !== current) {
          draftPaneRef.current = current;
          setDraft(EMPTY_DRAFT);
        }
        setDraft((prev) => applyToDraft(prev, data));
        return;
      }
      if (ctrlRef.current && isPrintable(data)) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        socket.sendInput(current, controlCode(data) ?? data);
        return;
      }
      socket.sendInput(current, data);
    });

    // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
    // reflow the pane and the program in it redraw (Claude Code repaints its whole
    // conversation), so a drag of a long session sent over a hundred resizes and the app
    // lagged: fit once the size has settled.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        if (observeRef.current) return; // the grid belongs to the pty while observing
        try {
          fit.fit();
        } catch {
          return;
        }
        const current = paneRef.current;
        if (current) socket.resize(current, term.cols, term.rows);
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(host);

    // Touch screens never emit wheel events and xterm.js has no touch scrolling:
    // translate a single-finger drag on the terminal into wheel events, so the
    // normal buffer scrolls its own viewport and the alternate buffer (with mouse
    // reporting on) forwards the gesture to herdr, exactly like a mouse wheel.
    // The text follows the finger, as everywhere on a phone: dragging down brings
    // older lines in. Each event carries the finger's position, since xterm reports
    // a wheel at the cell under it (without one, every report said row 1, column 1).
    let touchY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent): void => {
      tracking = event.touches.length === 1;
      const first = event.touches[0];
      if (tracking && first) touchY = first.clientY;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      if (!first) return;
      // finger moving down (y > touchY) shows older lines: a wheel scrolling up, negative deltaY
      const delta = touchY - first.clientY;
      touchY = first.clientY;
      if (delta !== 0) {
        const target = term.element ?? host;
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: delta, clientX: first.clientX, clientY: first.clientY }));
      }
    };
    const onTouchEnd = (): void => {
      tracking = false;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });

    // The pty is shared per pane: a client on another device (typically a phone)
    // resizes it to its own geometry, and this tab's viewport never changed, so
    // the ResizeObserver above stays silent and the pane is left at the other
    // device's size. Re-assert our geometry whenever this tab comes back. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      socket.resize(current, term.cols, term.rows, true);
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refit();
    };
    window.addEventListener("focus", refit);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("copy", onCopy);
      stopEdge();
      selectionChange.dispose();
      window.removeEventListener("focus", refit);
      document.removeEventListener("visibilitychange", onVisible);
      onData.dispose();
      offDisconnect();
      osc52.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      socket.close();
      term.dispose();
      termRef.current = null;
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // theme and font size follow the settings without a remount; a font change moves the grid
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    if (term.options.fontSize !== terminalFontSize) {
      term.options.fontSize = terminalFontSize;
      if (observeRef.current) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const pane = paneRef.current;
      if (pane) socketRef.current?.resize(pane, term.cols, term.rows, true);
    }
  }, [theme, terminalFontSize]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView || observeRef.current) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && term) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (!autoSelected) term?.focus();
  }, [chatView]);

  // follow the selected pane
  useEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setOutputReady(false);
    setOutputError(null);
    setHeld(false);
    secretRef.current = null;
    setSecret(null);
    term.options.disableStdin = observeRef.current;
    draftOwner.current = null;
    let saved = EMPTY_DRAFT;
    try {
      const value = paneId ? JSON.parse(localStorage.getItem(`herdr-web-ui:terminal-draft:${paneStorageId(machineId, paneId)}`) ?? "null") : null;
      if (value && typeof value.text === "string" && Number.isInteger(value.droppedSpecial)) saved = value;
    } catch {}
    setDraft(saved);
    draftPaneRef.current = paneId;
    term.reset();
    if (!paneId) return;
    try {
      fit?.fit();
    } catch {
      /* not laid out yet; the ResizeObserver will follow up */
    }
    socket.attach(paneId, term.cols, term.rows);
    // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
    // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
    if (!chatViewRef.current && !autoSelected) term.focus();
    return () => {
      socket.detach(paneId);
    };
  }, [paneId]);


  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (wasAuto && !autoSelected && !chatViewRef.current) termRef.current?.focus();
  }, [autoSelected]);

  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((key: KeyBarKey) => {
    const term = termRef.current;
    if (!term) return;
    term.input(keySequence(key, term.modes.applicationCursorKeysMode));
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid
    if (!inputLineRef.current) term.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    const armed = !ctrlRef.current;
    ctrlRef.current = armed;
    setCtrlArmed(armed);
    if (!inputLineRef.current) termRef.current?.focus();
  }, []);

  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>(role);
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    socketRef.current?.setMode(role);
  }, [role]);

  const sendDraft = useCallback(() => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || !pane || draft.text.length === 0 || !socket.connected || secretRef.current !== null || heldRef.current) return;
    socket.sendInput(pane, draft.text);
    setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the composer goes straight to the socket, not through onData: an armed key-bar Ctrl
  // must not turn a one-letter message into a control key. Offline it sends nothing and
  // keeps its text (never-queue); a message the server could not deliver keeps it too,
  // with the reason. Bracketed-paste wrapping follows the pane program's mode.
  const sendComposerText = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null || heldRef.current) return false;
    const sent = socket.submit(pane, composerMessage(text), composerPayload(text, term.modes.bracketedPasteMode));
    if (sent === null) return false;
    term.scrollToBottom();
    setChatSent((current) => current + 1);
    return sent.then((result) => {
      if (!result.ok) return submitNote(result.code, result.message);
      // the chat lens refetches at once so the sent prompt appears without a poll beat
      setChatRefresh((current) => current + 1);
      return true;
    });
  }, []);

  // the terminal's input line: the text typed like the keyboard would, into an agent's open
  // menu too, then Enter after the server's gap; several lines go as one paste
  const sendTerminalLine = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    const message = composerMessage(text);
    const payload = message.includes("\n") ? composerPayload(text, term.modes.bracketedPasteMode) : message;
    const sent = socket.submit(pane, message, payload, true);
    if (sent === null) return false;
    term.scrollToBottom();
    return sent.then((result) => (result.ok ? true : submitNote(result.code, result.message)));
  }, []);

  const pressEnter = useCallback((): boolean => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || pane === null || !socket.connected) return false;
    socket.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return true;
  }, []);

  const toggleDirect = useCallback(() => {
    setDirectTyping((direct) => {
      const next = !direct;
      try { window.localStorage.setItem(DIRECT_TYPING_KEY, next ? "1" : "0"); } catch { /* private mode: this page only */ }
      return next;
    });
  }, []);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it back
  useEffect(() => {
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      if (coarse && !chatView && directTyping && !autoSelected) termRef.current?.focus();
    }
  }, [inputLine, coarse, chatView, directTyping, paneId]);

  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    term.input("\u001b");
  }, []);

  // While the agent runs, append to its held messages. Each requires an explicit send.
  // a question in Codex's queue leaves the composer alone: Codex keeps working, and a
  // message ("stop, don't touch prod") must reach it, not become the answer; its card answers it
  const answering = chatView && chatPrompt !== null && chatPrompt.pane === paneId && !chatPrompt.value.queued ? chatPrompt.value : null;
  // ...and while it is open in the terminal it holds the input: nothing is sent into it
  const heldByOpenQueue = chatView && chatPrompt !== null && chatPrompt.pane === paneId && chatPrompt.value.queued === "open";
  const unreadable = chatView && answering === null && chatUnreadable !== null && chatUnreadable.pane === paneId ? chatUnreadable.value : null;
  const unreadableOptions = useMemo(() => unreadable?.actions.filter((action) => action.id.startsWith("option-")) ?? [], [unreadable]);
  // Escape in the empty composer presses the fallback card's Esc, when the dialog names one
  const unreadableEscape = unreadable !== null && unreadable.actions.some((action) => action.id === "esc");
  // one Escape at a time: a second one while the first is on its way would check against the
  // same unchanged screen, and reach the agent after the dialog closed
  const escapeInFlight = useRef(false);
  const pressUnreadableEscape = useCallback((): boolean => {
    const pane = paneRef.current;
    if (pane === null || unreadable === null || !unreadableEscape) return false;
    if (escapeInFlight.current) return true;
    escapeInFlight.current = true;
    void answerPanePrompt({ pane_id: pane, prompt_id: unreadable.id, action: "esc" })
      .catch(() => undefined)
      .finally(() => { escapeInFlight.current = false; setPromptRefresh((key) => key + 1); });
    return true;
  }, [answerPanePrompt, unreadable, unreadableEscape]);
  // a card waiting (parsed or not) means the pane waits on an answer, whatever status arrived last
  const busy = agent !== null && agentStatus === "working" && answering === null && unreadable === null;
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;

  const composerSend = useCallback(
    (text: string): boolean | string | Promise<boolean | string> => {
      const pane = paneRef.current;
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      if (pane !== null && answering !== null) {
        // never typed into the agent's menu: only as one of its options, or its own reply row
        const choice = answerFromText(answering, text);
        if (choice === null) return answerRefusal(answering);
        if (needsConfirmation(answering, choice)) {
          setPendingAnswer({ pane, promptId: answering.id, answer: choice });
          return true;
        }
        setPendingAnswer(null);
        return answerPanePrompt({ pane_id: pane, prompt_id: answering.id, ...choice }).then(
          () => { setPromptRefresh((key) => key + 1); return true; },
          (cause: unknown) => {
            setPromptRefresh((key) => key + 1);
            return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : String(cause instanceof Error ? cause.message : cause);
          },
        );
      }
      // an option's number, typed while the fallback card shows, is that option's key press
      const picked = unreadable === null ? undefined : unreadableOptions.find((option) => option.text === text.trim());
      if (pane !== null && unreadable !== null && picked !== undefined) {
        return answerPanePrompt({ pane_id: pane, prompt_id: unreadable.id, action: picked.id }).then(
          () => { setPromptRefresh((key) => key + 1); return true; },
          (cause: unknown) => {
            setPromptRefresh((key) => key + 1);
            return cause instanceof ApiError && cause.status === 409 ? t("The screen changed; check it and press again.") : String(cause instanceof Error ? cause.message : cause);
          },
        );
      }
      if (pane !== null && agent !== null && agentStatus === "working") {
        queueStore.add(paneStorageId(machineId, pane), text);
        return true; // the composer may clear its box: the text lives in the queue card
      }
      return sendComposerText(text);
    },
    [agent, agentStatus, answerPanePrompt, answering, heldByOpenQueue, sendComposerText, queueStore, machineId, unreadable, unreadableOptions],
  );


  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: File) => uploadPaneImage(paneId ?? "", file), [paneId]);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    <div className={`terminal-stack${chatView ? " is-chat" : ""}`} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}>
      {paneId === null && restoreError !== null && (
        <div className="terminal-placeholder is-restore-error" role="status">
          <div className="terminal-placeholder-inner">
            <TriangleAlert aria-hidden="true" />
            <span>{t("herdr could not restore this pane")}</span>
            <span className="terminal-placeholder-detail">{restoreError}</span>
          </div>
        </div>
      )}
      {paneId === null && restoreError === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>{t("Select a pane to open its terminal")}</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && held && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            <span>{t("Another app has this pane open. It connects here as soon as that app lets go.")}</span>
          </div>
        )}
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <a className="btn" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>{t("Reconnect")}</a>
          </div>
        )}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            terminal ended{!draftIsEmpty(draft) ? " — held input discarded" : ""}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            reconnecting to herdr web ui…
            {!draftIsEmpty(draft) && <span className="draft-held"> input held: “{draft.text}”</span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="draft-label">{t("input held while disconnected:")}</span>
            <code className="draft-text">{draft.text.length > 0 ? draft.text : "—"}</code>
            {draft.droppedSpecial > 0 && (
              <span className="draft-dropped">{t(draft.droppedSpecial === 1 ? "{count} special key dropped" : "{count} special keys dropped", { count: draft.droppedSpecial })}</span>
            )}
            <span className="draft-actions">
              <button type="button" className="draft-send" disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                {t("Send")}
              </button>
              <button type="button" className="draft-discard" onClick={discardDraft}>
                {t("Discard")}
              </button>
            </span>
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            view only — the operator’s screen size is untouched
          </div>
        )}
        {clipboardNote && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      <div className="terminal-surface">
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} />
        {paneId !== null && chatView && (
          <ChatView
            paneId={paneId}
            refreshKey={chatRefresh}
            sentKey={chatSent}
            connected={connected}
            ended={ended}
            agent={agent}
            agentStatus={agentStatus}
            onMetadata={onChatMetadata}
            onPrompt={onChatPrompt}
            onUnreadable={onChatUnreadable}
            promptRefreshKey={promptRefresh}
            pendingAnswer={pendingAnswer !== null && pendingAnswer.pane === paneId ? pendingAnswer : null}
            onPendingAnswerDone={clearPendingAnswer}
          />
        )}
      </div>
      {paneId !== null && !observing && !ended && queueOwner !== null && queued.length > 0 && (
        <section className="composer-queue" aria-label={t("Queued messages")}>
          <div className="composer-queue-heading">
            <strong>{t("Queued messages ({n})", { n: queued.length })}</strong>
            <span className="composer-queue-label">{t(readyForQueue ? "Held message — review and send" : "Held until the agent is ready")}</span>
          </div>
          {queueStore.isUnsaved(queueOwner) && <p className="composer-queue-error" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</p>}
          <ol className="composer-queue-list">
          {queued.map((message, index) => <li className="composer-queue-item" key={message.id}>
            <label className="composer-queue-label" htmlFor={`queued-${message.id}`}>{t("Message {n}", { n: index + 1 })}</label>
            <textarea
              id={`queued-${message.id}`}
              className="composer-queue-text"
              value={message.text}
              rows={Math.min(4, message.text.split("\n").length)}
              aria-label={t("Queued message {n}", { n: index + 1 })}
              maxLength={MAX_COMPOSER_CHARS}
              disabled={queueStore.isSending(message.id)}
              spellCheck={false} autoCapitalize="off" autoCorrect="off"
              onChange={(event) => { queueStore.edit(queueOwner, message.id, event.target.value); }}
            />
            <div className="composer-queue-actions">
              <button type="button" className="composer-queue-send"
                disabled={!connected || held || secretActive || queueSending !== null || queued.some((item) => queueStore.isSending(item.id)) || heldByOpenQueue || message.text.trim().length === 0}
                title={heldByOpenQueue ? t("Codex has a question open in the terminal: answer it above first") : undefined}
                onClick={() => {
                  if (sendingRef.current || !queueStore.beginSend(queueOwner, message.id)) return;
                  sendingRef.current = true;
                  setQueueSending(message.id); setQueueError(null);
                  const owner = queueOwner;
                  void Promise.resolve(sendComposerText(message.text))
                    .then((result) => {
                      if (result === true) { queueStore.remove(owner, message.id); }
                      else setQueueError({ owner, id: message.id, text: typeof result === "string" ? result : t("Not sent. Reconnect and try again.") });
                    })
                    .catch(() => setQueueError({ owner, id: message.id, text: t("Not confirmed. Check the terminal before sending again.") }))
                    .finally(() => { queueStore.endSend(owner, message.id); sendingRef.current = false; setQueueSending(null); });
                }}>{t("Send now")}</button>
              <button type="button" className="composer-queue-discard" disabled={queueStore.isSending(message.id)}
                onClick={() => { queueStore.remove(queueOwner, message.id); }}>{t("Discard")}</button>
            </div>
            {queueError?.owner === queueOwner && queueError.id === message.id && <p className="composer-queue-error" role="status">{queueError.text}</p>}
          </li>)}
          </ol>
        </section>
      )}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
      {paneId !== null && secretActive && !observing && !ended && connected && outputReady && <SecretInput
        key={`${paneId}:${secret.prompt}`} prompt={secret.prompt}
        onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value) ?? null}
        onCancel={() => { if (socketRef.current?.connected) socketRef.current.sendInput(paneId, "\u0003"); }}
      />}
      {paneId !== null && chatView && !secretActive && !observing && !ended && (
        <Composer
          key={paneId}
          paneId={paneId}
          autoFocus={!autoSelected}
          agent={agent}
          agentStatus={agentStatus}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected && !held}
          queueMode={busy}
          answerHint={answering === null ? (unreadableOptions.length > 0 ? t("Tap an option above, or type its number…") : null)
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          onEscape={unreadableEscape ? pressUnreadableEscape : undefined}
          onSend={composerSend}
          onAbort={abortTurn}
          onUploadImage={uploadImage}
        />
      )}
      {paneId !== null && !secretActive && !observing && !ended && inputLine && <TerminalInput key={paneId} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} />}
      {paneId !== null && !secretActive && !observing && !chatView && <KeyBar onKey={pressKey} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect } : {})} />}
    </div>
  );
}
