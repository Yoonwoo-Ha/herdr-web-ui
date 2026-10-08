import { useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ChevronRight, Clock, TriangleAlert, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket, type SubmitResult } from "../lib/ws.ts";
import { disposeAfterPendingFrame } from "../lib/terminalDispose.ts";
import { clipboardKey, hasModifiers, physicalKey, terminalChord, navigationSequence, keyFromData, ctrlEnterSequence, modifyOtherKeysLevel, NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
import { keyBarInputSequence, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, restoreDraft, type InputDraft } from "../lib/draft.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { pendingMessages } from "../lib/pendingMessages.ts";
import { heldCountShown, heldOpenAtFold, heldOpenOnFocus, heldRefocusDue, heldRowError, heldRowsFold, heldRowsHidden, heldToggleShown, SHORT_PHONE_QUERY } from "../lib/heldRows.ts";
import { MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, agentDisplayLabel, composerDelivery, composerMessage, composerPayload, submitNote, submitNotTyped } from "../lib/compose.ts";
import { afterRead, afterSend, afterSettled, composerLift, greetingMemory, rememberGreeting, greetingFits, greetingFolder, roomOverComposer, showsGreeting, type ChatRead } from "../lib/greeting.ts";
import { answerFromText, answerHint, answerRefusal, needsConfirmation, type TypedAnswer } from "../lib/promptAnswer.ts";
import { ApiError, assertAttachable, fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { matchHerdrWidths } from "../lib/terminalWidths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { TerminalInput } from "./TerminalInput.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { ChatView } from "./ChatView.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Composer } from "./Composer.tsx";
import { PendingMessages } from "./PendingMessages.tsx";
import type { AgentStatus, ClientRole, ConversationMetadata, InteractivePrompt, ServerMessage } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { chatLaneLength, useSettings, terminalTheme, type Palette, type ResolvedTheme } from "../lib/settings.ts";
import { loadFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";
import { isAppShortcut } from "../lib/shortcuts.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { fileUriPath, isWebLink, terminalFileLinkProvider } from "../lib/terminalFileLinks.ts";
import { adjustTerminalGlyphs } from "../lib/terminalGlyphs.ts";
import { terminalLabel } from "../lib/terminalLabel.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;
/** How long a tab is out of use before it lets go of its pane: a glance at another window keeps it. */
const RELEASE_AFTER_MS = 1000;

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

export interface PaneTerminalProps {
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's own name (App's header shows it): the region around the grid announces it */
  title?: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** an OmO pane's running background tasks: the composer's status line offers their list */
  backgroundTasks?: number;
  /** the pane's turn ended on work still running in the background: the composer says BG */
  backgroundWait?: boolean;
  /** the pane's working directory and its PC's name: an empty chat's greeting names them */
  cwd?: string | null;
  machineName?: string;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** mouse reports sent per wheel event (settings): 1 is xterm's own one report */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in stack (settings); "" keeps the built-in one */
  terminalFontFamily: string;
  /** the resolved UI theme: the xterm theme object mirrors it */
  theme: ResolvedTheme;
  /** the chrome palette (settings.ts): the terminal cursor and selection follow it */
  palette: Palette;
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

export function PaneTerminal({
  paneId,
  restoreError = null,
  agent = null,
  title = null,
  agentStatus,
  backgroundTasks = 0,
  backgroundWait = false,
  cwd = null,
  machineName = "",
  view,
  autoSelected = false,
  terminalFontSize,
  terminalWheelSpeed,
  terminalFontFamily,
  theme,
  palette,
  role = "interact",
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const t = useT();
  const openFile = useContext(OpenFileContext);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const machineId = useMachineId();
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const chatView = view === "chat";
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  // what the grid's region announces: the pane's own name, or the grid's kind while none is open
  const terminalName = terminalLabel(paneId, title, t);
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelSpeedRef = useRef(terminalWheelSpeed);
  wheelSpeedRef.current = terminalWheelSpeed;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  const pendingScopeRef = useRef<string | null>(null);
  /** counts this terminal's disconnects: an answer belongs to the connection that was up when its request left */
  const pendingEpochRef = useRef(0);
  const [outputReady, setOutputReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // the server answered terminal_unsupported (a bridge too old to mirror): the lens is a notice, the chat still works
  const [unsupported, setUnsupported] = useState(false);
  // another web bridge has this pane's terminal: the server waits for it and says attach-resumed
  const [held, setHeldState] = useState(false);
  // what the socket handlers read mid-stream: stdin, onData and the composer's submit
  const heldRef = useRef(false);
  const setHeld = useCallback((next: boolean) => { heldRef.current = next; setHeldState(next); }, []);
  // The ref is what input handlers read; the state is what the key bar shows.
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  const compositionCommitPendingRef = useRef(false);
  const barKeyRef = useRef<{ key: string; chord: string | null } | null>(null);
  const modifiersRef = useRef<StickyModifiers>(NO_STICKY_MODIFIERS);
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const clearModifiers = useCallback(() => {
    modifiersRef.current = NO_STICKY_MODIFIERS;
    setModifiers(NO_STICKY_MODIFIERS);
    barKeyRef.current = null;
  }, []);
  useLayoutEffect(clearModifiers, [paneId, chatView, clearModifiers]);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  // out of use, the tab let go of its pane (no attach) so herdr's own TUI has it back; it attaches
  // again when the user is back. The ref is what the socket handlers and the pane switch read
  const releasedRef = useRef(false);
  const [released, setReleasedState] = useState(false);
  const setReleased = useCallback((next: boolean) => { releasedRef.current = next; setReleasedState(next); }, []);
  // released, the tab still shows the pane read-only (the server's "watch", herdr's observer), which
  // leaves the pane at the size herdr's own window gives it; false on a server without it: paused
  const watchingRef = useRef(false);
  const [watching, setWatchingState] = useState(false);
  const setWatching = useCallback((next: boolean) => { watchingRef.current = next; setWatchingState(next); }, []);
  // the mount effect's watch, for the pane switch: a released tab moving on to the next pane watches that one
  const watchRef = useRef<(pane: string) => void>(() => {});
  // the mount effect's release, for the queue below: a tab that kept its pane for a message lets go once it went
  const releaseRef = useRef<() => void>(() => {});
  // the mount effect's leave, for the pane switch: a tab out of use from the start (a reload behind
  // another app) or moving on to the next pane there lets go of it too
  const leaveRef = useRef<() => void>(() => {});
  const cancelLeaveRef = useRef<() => void>(() => {});
  const pendingSubmissionsRef = useRef(new Set<{ pane: string; socket: HerdrSocket; epoch: number }>());
  const endedRef = useRef(false);
  // the modifyOtherKeys level the pane's program asked for, as this pane's stream last said it
  const modifyOtherKeysRef = useRef(0);
  const [observing, setObserving] = useState(false);
  const [secret, setSecret] = useState<{ pane: string; prompt: string } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret !== null && secret.pane === paneId;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useMediaQuery("(pointer: coarse)");
  // A touch screen reads a pane before it answers: picking a pane or a lens there never raises the
  // keyboard by itself, only a tap on the message box or the grid does. A desktop has no keyboard
  // to raise, and the pane it picks takes the typing at once.
  const coarseRef = useRef(coarse); coarseRef.current = coarse;
  const { settings, update: updateSettings } = useSettings();
  const availableModifiers = settings.keyBarItems.reduce((mask, item) => item.type === "modifier"
    ? mask | { ctrl: 4, alt: 2, shift: 1 }[item.modifier] : mask, 0);
  useLayoutEffect(() => {
    const current = modifiersRef.current;
    const next = { ctrl: current.ctrl && !!(availableModifiers & 4), alt: current.alt && !!(availableModifiers & 2), shift: current.shift && !!(availableModifiers & 1) };
    if (next.ctrl === current.ctrl && next.alt === current.alt && next.shift === current.shift) return;
    modifiersRef.current = next;
    setModifiers(next);
  }, [availableModifiers]);
  const shortcutSettings = useRef(settings.shortcutOverrides);
  shortcutSettings.current = settings.shortcutOverrides;
  // what the terminal effect says in a banner, in the language chosen since it was set up
  const tRef = useRef(t);
  tRef.current = t;
  /** read by the OSC 52 handler, which is attached once for the terminal's life */
  const osc52AllowedRef = useRef(settings.paneClipboard);
  osc52AllowedRef.current = settings.paneClipboard;
  // Settings → Use alongside herdr's own window: off (the default), a tab out of use keeps its pane and its size
  const releaseAwayRef = useRef(settings.releasePaneAway);
  releaseAwayRef.current = settings.releasePaneAway;
  // Settings → Chat width, Default: the lane follows this pane. One length on the stack, which
  // the transcript, the composer column, the held list and the menus all inherit: a percentage
  // would resolve against each one's own box and leave them a gutter apart. The other steps are
  // fixed and stay with the stylesheet (styles.css). The lane's ceiling stays 60rem inside the
  // length, so a change of the browser's font size moves it at once, as it moves Wide's 72rem
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    if (settings.chatWidth !== "default") {
      stack.style.removeProperty("--chat-w");
      return;
    }
    const apply = (): void => stack.style.setProperty("--chat-w", chatLaneLength(stack.clientWidth));
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [settings.chatWidth]);
  const directTyping = settings.terminalInputMode === "direct" || (settings.terminalInputMode === "auto" && (!coarse || storedDirectTyping()));
  const inputLine = !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // input typed while disconnected, held for the user to review and send
  const [draftState, setDraftState] = useState<{ owner: string | null; value: InputDraft }>({ owner: null, value: EMPTY_DRAFT });
  const draft = draftState.value;
  const setDraft = useCallback((value: InputDraft | ((previous: InputDraft) => InputDraft)) => {
    const owner = paneRef.current ? paneStorageId(machineId, paneRef.current) : null;
    setDraftState((previous) => ({ owner, value: typeof value === "function" ? value(previous.owner === owner ? previous.value : EMPTY_DRAFT) : value }));
  }, [machineId]);
  const draftPaneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!paneId || draftState.owner !== paneStorageId(machineId, paneId)) return;
    const key = `herdr-web-ui:terminal-draft:${draftState.owner}`;
    try { if (draftIsEmpty(draft)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({ ...draft, at: Date.now() })); } catch {}
  }, [draftState, paneId, machineId, draft]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the composer's send bumps this so the chat lens refetches without waiting a poll beat
  const [chatRefresh, setChatRefresh] = useState(0);
  // bumped as a composer message goes out: the chat must not title the turn before it as running
  const [chatSent, setChatSent] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  // What each pane's chat last read, and whether a message went out since: kept per pane here,
  // not in the chat, so a message sent ends the greeting at once and neither another lens, another
  // pane nor a failed read brings it back before the conversation shows a turn or a new history.
  // It lives in lib/greeting.ts, over this component, which another PC's pane mounts again.
  const [, redrawGreeting] = useReducer((count: number) => count + 1, 0);
  const onChatRead = useCallback((pane: string, read: ChatRead | null) => {
    const owner = paneStorageId(machineId, pane);
    const memory = greetingMemory(owner);
    const next = afterRead(memory, read);
    if (next === memory) return;
    rememberGreeting(owner, next); redrawGreeting();
  }, [machineId]);
  // the stack (stackRef, above) holds the composer and the greeting over it (measured below)
  const [greetingRoom, setGreetingRoom] = useState(true);
  const greetingRef = useRef<HTMLDivElement | null>(null);
  // The prompt the chat shows: while it waits, a message from the composer answers it.
  const [chatPrompt, setChatPrompt] = useState<{ pane: string; value: InteractivePrompt } | null>(null);
  const [promptRefresh, setPromptRefresh] = useState(0);
  // what the agent suggests typing next (Claude's grey input text), for the composer's placeholder
  const [chatSuggestion, setChatSuggestion] = useState<{ pane: string; value: string } | null>(null);
  const onChatSuggestion = useCallback((pane: string, value: string | null) => {
    setChatSuggestion((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  // a typed pick of an approval's option, shown in the card until Confirm or Cancel
  const [pendingAnswer, setPendingAnswer] = useState<{ pane: string; promptId: string; answer: TypedAnswer } | null>(null);
  // where the chat draws its prompt card: on the composer's column, between the held messages and
  // the input card (the stack's order is written once, in the JSX below)
  const [promptDock, setPromptDock] = useState<HTMLDivElement | null>(null);
  // Answered from the card, the card goes and would take the keyboard's focus with it: the message
  // box is the next thing to type in. Not after a tap, which would raise the keyboard: the card
  // tells a key, a mouse and a tap by the press itself (lib/promptAnswer.ts), so a key on a
  // tablet hands the focus on and a tap on a touch-screen laptop does not.
  const onPromptAnswered = useCallback((toMessageBox: boolean) => {
    if (toMessageBox) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
  }, []);
  // only the pick of that pane and prompt: an answer that comes back late must not take another's
  const clearPendingAnswer = useCallback((pane: string, promptId?: string) => {
    setPendingAnswer((current) => current?.pane === pane && (promptId === undefined || current.promptId === promptId) ? null : current);
  }, []);
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
  const pending = useSyncExternalStore(pendingMessages.subscribe, () => pendingMessages.read(queueOwner ?? ""));
  const sendingRef = useRef(false);
  const [queueSending, setQueueSending] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<{ owner: string; id: string; text: string } | null>(null);

  paneRef.current = paneId;
  endedRef.current = ended;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  // also when the callback itself changes: the other half of a split, made active, hands its
  // connection to callbacks that were no-ops and would otherwise hear of it only at a change
  // a stalled output this terminal reported while its callbacks were no-ops, told to the live ones
  const stalledRef = useRef<ServerMessage | null>(null);
  useEffect(() => {
    // a connection made again has its output back: the stall it reported is over
    if (connected) stalledRef.current = null;
    onConnectionChangeRef.current?.(connected);
  }, [connected, onConnectionChange]);
  useEffect(() => {
    if (stalledRef.current !== null) onServerMessageRef.current?.(stalledRef.current);
  }, [onServerMessage]);
  const lastRoleAckRef = useRef<ClientRole | null>(null);
  useEffect(() => {
    if (lastRoleAckRef.current !== null) onRoleAckRef.current?.(lastRoleAckRef.current);
  }, [onRoleAck]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // Install before the pane layout effect so resets cancel pending input before the next task.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // xterm activates a link whenever a press and its release land on it: a drag that selects
    // part of a path and a right click do too, and neither means "open this"
    const linkPressed = (event: MouseEvent): boolean => event.button === 0 && !term.hasSelection();
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
      // a chosen family follows in the font effect below, once its faces have loaded
      fontFamily: TERMINAL_FONT_STACK,
      theme: terminalTheme(theme, palette),
      linkHandler: {
        activate: (event, uri) => {
          if (!linkPressed(event)) return;
          const path = fileUriPath(uri);
          if (path !== null) openFileRef.current?.(path);
          else if (isWebLink(uri)) window.open(uri, "_blank", "noopener,noreferrer");
        },
        allowNonHttpProtocols: true,
      },
      // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    matchHerdrWidths(term);
    // the same policy as the linkHandler above: an http(s) address or nothing (S10)
    term.loadAddon(new WebLinksAddon((_event, uri) => { if (isWebLink(uri)) window.open(uri, "_blank", "noopener,noreferrer"); }));
    term.registerLinkProvider(terminalFileLinkProvider(() => term.buffer.active, (path, event) => { if (linkPressed(event)) openFileRef.current?.(path); }));
    term.open(host);
    let compositionEndTimer: number | null = null;
    compositionCommitPendingRef.current = false;
    const compositionStart = () => {
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
      compositionCommitPendingRef.current = false;
      setComposing(true);
    };
    const compositionEnd = () => {
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      // xterm's textarea listener queues its commit before this bubbling host listener.
      // Keep that commit on the text path; a new composition cancels this clear.
      compositionCommitPendingRef.current = true;
      setComposing(false);
      compositionEndTimer = window.setTimeout(() => {
        compositionEndTimer = null;
        compositionCommitPendingRef.current = false;
      }, 0);
    };
    host.addEventListener("compositionstart", compositionStart);
    host.addEventListener("compositionend", compositionEnd);
    const stopGlyphs = adjustTerminalGlyphs(term);
    // Let the browser emit a paste event, which xterm already handles (including
    // bracketed paste). Otherwise Ctrl+V becomes 0x16, triggering the agent's
    // image-paste shortcut against the server's clipboard and canceling text paste.
    // Returning false skips xterm's key handling without preventing browser defaults.
    // With text selected, Ctrl+C (and Ctrl+Shift+C) copies it instead of interrupting the pane.
    // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
    // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
    // An app shortcut is the app's alone: xterm would still type it, and Ctrl+Shift+↓ reached the
    // pane it had just switched to as ESC[1;6B.
    let typedChord: string | null = null;
    term.attachCustomKeyEventHandler((event) => {
      if (isAppShortcut(event, shortcutSettings.current)) return false;
      if (hasModifiers(modifiersRef.current) && !term.options.disableStdin && !composingRef.current && !compositionCommitPendingRef.current
          && !event.isComposing && event.keyCode !== 229 && !event.metaKey) {
        const combined = {
          ctrl: modifiersRef.current.ctrl || event.ctrlKey,
          alt: modifiersRef.current.alt || event.altKey,
          shift: modifiersRef.current.shift || event.shiftKey,
        };
        // the chord names the key by its position on a non-Latin layout (ㅊ on KeyC is Ctrl+C)
        const chord = terminalChord(physicalKey(event.key, event.code), combined);
        const navigation = navigationSequence(event.key, combined);
        if (navigation !== null) {
          if (event.type === "keydown") { event.preventDefault(); term.input(navigation); }
          return false;
        }
        // A real clipboard shortcut still belongs to the browser. Soft Ctrl+V
        // (the held button plus a typed v) is a terminal chord, not a paste.
        const letter = clipboardKey(event.key, event.code);
        const clipboard = event.ctrlKey && !event.altKey && /^(c|v)$/.test(letter)
          && (letter === "v" || term.hasSelection());
        if (chord !== null && !clipboard) {
          if (event.type === "keydown") {
            event.preventDefault();
            typedChord = chord;
            // Go through the same readiness/role/secret checks as other input.
            term.input(event.key);
            typedChord = null;
          }
          return false;
        }
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = clipboardKey(event.key, event.code);
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
    // xterm sends one mouse report per wheel event whatever its delta, so herdr scrolls
    // the same few lines per notch: at a wheel speed above 1 a real wheel is replayed to send
    // that many reports. The replays and the touch translation below are untrusted, so neither
    // repeats. A replay is the same event, keys held included: xterm ignores a wheel with
    // Shift down, and a replay without it scrolled where the wheel itself did not.
    term.attachCustomWheelEventHandler((event) => {
      if (drag) {
        dragWheel(event);
        return false;
      }
      // an adopted grid sends herdr nothing: the wheel is the browser's, and pans the mount
      if (adopted()) return false;
      if (term.hasSelection()) term.clearSelection();
      const reporting = term.modes.mouseTrackingMode !== "none";
      // a trackpad pinch arrives as a wheel with Ctrl down: it is not scrolling, and goes once as before
      if (reporting && event.isTrusted && event.target && !event.ctrlKey) {
        for (let sent = 1; sent < wheelSpeedRef.current; sent += 1) {
          event.target.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          }));
        }
      }
      return reporting;
    });
    termRef.current = term;
    fitRef.current = fit;

    // A grid that is not this browser's own (observing, or mirrored from a PC that cannot
    // attach) may be larger than the mount. The mount then scrolls (PaneTerminal.css) and a
    // drag pans it. Until the user pans, the view keeps the cursor's row in sight: the top of
    // the grid while the row fits there, else the bottom rows, where a prompt sits. A mirror
    // has no cursor; xterm's own rests on the last row with text, which serves the same.
    const adopted = (): boolean => observeRef.current || fixedGridRef.current;
    let panned = false;
    const followCursor = (): void => {
      host.toggleAttribute("data-adopted-grid", adopted());
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!adopted() || panned || !screen) return;
      const row = screen.offsetHeight / term.rows;
      const cursorBottom = screen.offsetTop + (term.buffer.active.cursorY + 1) * row;
      const max = host.scrollHeight - host.clientHeight;
      host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
    };

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
    // pty and selects only with Shift (Option on macOS) held. Selection lives in herdr's
    // own TUI client, not in `herdr terminal attach`, so a left drag here selects as if the
    // modifier were held, and letting go copies, as the herdr TUI does; a press let go in
    // place is a click and goes to the program (forwardClick). Touch keeps its drag-to-scroll.
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
      /** a press the program would have had but for the forced selection, with the keys the user held: let go in place, it is a click */
      click: ClickKeys | null;
    }
    interface ClickKeys { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
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
      // a click handed on to the program (forwardClick) is not a new drag
      if (event.button !== 0 || !event.isTrusted) return;
      if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      if (!term.element?.contains(event.target as Node)) return;
      // with reporting off xterm already selects on a plain drag; only the history tracking is ours
      const reporting = term.modes.mouseTrackingMode !== "none";
      // the modifier that asks xterm for a selection, held by the user rather than added here
      const selecting = isMac ? event.altKey : event.shiftKey;
      // a press that clears a selection, or opens a link, is not the program's click
      const onLink = term.element?.querySelector(".xterm-screen")?.classList.contains("xterm-cursor-pointer") === true;
      const click: ClickKeys | null = reporting && !selecting && !onLink && !term.hasSelection()
        ? { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey } : null;
      if (reporting) Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { value: true });
      copiedText = null;
      selectionGeneration++;
      const pane = paneRef.current;
      const { cell } = cellAt(event);
      const d: Drag = {
        pane: pane ?? "", anchor: cell, cursor: cell, top: null, anchorRow: 0, offset: 0, maxOffset: 0,
        scrolled: false, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false, click,
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
      // a press that left its cell is a drag, even one that comes back: it is no click (cellAt clamps
      // a pointer beside the grid to the edge column, so leaving sideways counts too)
      const grid = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
      const beside = grid !== undefined && (event.clientX < grid.left || event.clientX >= grid.right);
      if (beside || edge !== 0 || cell.row !== d.anchor.row || cell.col !== d.anchor.col) d.click = null;
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
    // A press that became no selection was a click, and a program that reads the mouse (a
    // close button in Claude Code's diff, a TUI's menu) expects it: herdr's attach forwards
    // left clicks to it, as a phone's tap already showed (#621). The press and release are
    // replayed without the selection modifier so xterm encodes them in the reporting mode
    // herdr asked for; xterm sends nothing while stdin is disabled (observing, a held pane).
    const forwardClick = (event: MouseEvent, keys: ClickKeys): void => {
      const target = event.target;
      if (!(target instanceof Element) || !term.element?.contains(target)) return;
      const init = { ...keys, bubbles: true, cancelable: true, view: window, button: 0, detail: 1, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
      target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
      target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
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
      const released = cellAt(event).cell;
      // released on the pane it was pressed on: a pane switched meanwhile gets no click of this press
      if (d.click && d.pane !== "" && d.pane === paneRef.current && !d.scrolled && !term.hasSelection()
        && released.row === d.anchor.row && released.col === d.anchor.col) {
        forwardClick(event, d.click);
        return;
      }
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
    // cannot reach the browser clipboard by itself, so xterm hands us the sequence and
    // navigator.clipboard completes the hop (text only; queries are ignored).
    // On unless turned off in Settings -> Terminal -> Clipboard from a pane: vim, tmux and Claude Code
    // copy this way, but any process in the pane, an agent's tool calls included, can plant text the
    // user then pastes somewhere else.
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      if (osc52AllowedRef.current) {
        const text = parseOsc52(payload);
        if (text !== null) {
          void navigator.clipboard?.writeText(text).then(
            () => noteClipboard("copied to clipboard"),
            () => noteClipboard("clipboard write blocked by the browser"),
          );
        }
      }
      return true;
    });
    // modifyOtherKeys (CSI > 4 ; level m): xterm.js has no handler for it, so this one only
    // listens, and Ctrl+Enter is sent as the program asked (see onModifiedEnter)
    const modifyOtherKeys = (final: "m" | "n") => term.parser.registerCsiHandler({ prefix: ">", final }, (params) => {
      modifyOtherKeysRef.current = modifyOtherKeysLevel(modifyOtherKeysRef.current, final, params);
      return false;
    });
    const modifyOtherKeysSet = modifyOtherKeys("m");
    const modifyOtherKeysOff = modifyOtherKeys("n");

    const socket = new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    socketRef.current = socket;
    let outputGeneration = 0;
    const off = socket.on((message) => {
      if (message.type === "error" && message.code === "output_stalled") stalledRef.current = message;
      onServerMessageRef.current?.(message);
      if (message.type === "snapshot" && pendingScopeRef.current === null) pendingScopeRef.current = `${Date.now()}-${Math.random()}`;
      if (message.type === "pending-messages" && pendingScopeRef.current !== null) {
        const owner = paneStorageId(machineId, message.pane_id);
        const scope = pendingScopeRef.current;
        const known = new Set(pendingMessages.read(owner).filter((item) => pendingMessages.isOwned(owner, item.id, scope)).map((item) => item.id));
        pendingMessages.publish(owner, message.messages, message.removed ?? [], scope);
        if (message.removed?.some((item) => item.outcome === "sent" && known.has(item.id))) {
          const memory = greetingMemory(owner);
          rememberGreeting(owner, afterSettled(afterSend(memory), true, memory.history)); redrawGreeting();
          if (message.pane_id === paneRef.current) {
            onChatSuggestion(message.pane_id, null);
            setChatSent((current) => current + 1);
            setChatRefresh((current) => current + 1);
          }
        }
      }
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current || releasedRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        const acknowledge = socket.outputAcknowledgement(message);
        const owner = message.pane_id;
        const generation = outputGeneration;
        term.write(message.data, () => {
          acknowledge?.();
          if (disposed) return;
          if (paneRef.current !== owner || generation !== outputGeneration) {
            // output of a pane left behind, or of a dropped connection, was still queued in xterm
            // when the switch reset the level: whatever its parse just set, the level is off again
            // (writes are parsed in order, so no newer output has been read yet)
            modifyOtherKeysRef.current = 0;
            return;
          }
          setOutputReady(true);
          followCursor();
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
      } else if (message.type === "watch-data") {
        // a read-only view drawn for this grid: written as it comes, never acknowledged
        if (message.pane_id !== paneRef.current || !releasedRef.current || !watchingRef.current) return;
        term.write(message.data);
      } else if (message.type === "watch-end") {
        // the view ended: the last screen stays, and the banner says the tab is paused
        if (message.pane_id === paneRef.current) setWatching(false);
      } else if (message.type === "attach-resumed") {
        if (message.pane_id === paneRef.current) {
          setHeld(false);
          term.options.disableStdin = observeRef.current || secretRef.current !== null;
        }
      } else if (message.type === "pty-exit") {
        // an ended pane takes no input: a file dropped on it must not upload and paste either
        if (message.pane_id === paneRef.current) { setEnded(true); term.options.disableStdin = true; }
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning (a tab out of use
        // reclaims it when the user comes back: the refit below)
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        setObserving(nowObserving);
        term.options.disableStdin = nowObserving || secretRef.current !== null || heldRef.current;
        lastRoleAckRef.current = message.mode;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving && !fixedGridRef.current && !chatViewRef.current && inUse()) {
          try {
            fit.fit();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane) socket.resize(pane, term.cols, term.rows, true);
        }
        panned = false;
        followCursor();
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this,
        // unless the grid is fixed: then nobody here drives it
        if (message.pane_id !== paneRef.current) return;
        if (message.fixed) fixedGridRef.current = true;
        // kept while the terminal lens ignores it: another device may drive the grid, and the
        // chat lens entered later must draw its hidden screen for that grid, not this device's
        sharedGridRef.current = { cols: message.cols, rows: message.rows };
        // the chat lens adopts the shared grid too: the screen it reads (a masked prompt) is drawn for it
        if (!observeRef.current && !fixedGridRef.current && !chatViewRef.current) return;
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        panned = false;
        followCursor();
      } else if (message.type === "error") {
        if (message.code === "input_not_ready" || message.code === "input_failed") {
          if (message.pane_id === paneRef.current) setInputError(message.message);
          return;
        }
        if (message.code === "attach_held") {
          // a pane this terminal already left: its wait is not this pane's
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // not an end: the server attaches as soon as the other bridge lets go
          setHeld(true);
          term.options.disableStdin = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "terminal_unsupported") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          setUnsupported(true);
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
      clearModifiers();
      if (pendingScopeRef.current !== null) pendingMessages.suspendScope(pendingScopeRef.current);
      pendingScopeRef.current = null;
      pendingEpochRef.current++;
      outputGeneration++;
      setOutputReady(false);
      setInputReady(false);
      setConnected(false);
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      setHeld(false);
      // and its stream says the keyboard modes again, from the start or in the replay
      modifyOtherKeysRef.current = 0;
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    // onKey runs after xterm drains a pending IME commit, immediately before the
    // key's onData. Remap only that CR, preserving composition text and its order.
    // xterm.js types Shift+Enter and Ctrl+Enter as plain Enter: Shift+Enter becomes the Alt+Enter
    // newline chord, Ctrl+Enter what modifyOtherKeys makes it (Claude Code's "send now") while
    // the program has asked for that, and stays Enter otherwise.
    let enterAs: string | null = null;
    const onModifiedEnter = term.onKey(({ key, domEvent: event }) => {
      enterAs = null;
      if (term.options.disableStdin || key !== "\r" || event.key !== "Enter" || event.altKey || event.metaKey
        || event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey && !event.ctrlKey) enterAs = "\x1b\r";
      else if (event.ctrlKey && !event.shiftKey) enterAs = ctrlEnterSequence(modifyOtherKeysRef.current);
    });
    // Let xterm finish pending IME text before remapping the key's following data.
    // Cmd+Backspace uses the terminal's Ctrl+U line-deletion shortcut on macOS.
    let commandBackspace = false;
    const onCommandBackspace = term.onKey(({ key, domEvent: event }) => {
      commandBackspace = !term.options.disableStdin && isMac && key === "\x7f" && event.type === "keydown"
        && event.key === "Backspace" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && !event.isComposing && event.keyCode !== 229;
    });
    // A paste is text, even when it happens to contain just one letter. xterm
    // handles the DOM paste synchronously after this capture-phase listener.
    let pasting = false;
    const onPaste = () => { pasting = true; queueMicrotask(() => { pasting = false; }); };
    host.addEventListener("paste", onPaste, true);
    // File paths and dropped text use xterm's programmatic paste without a DOM paste event.
    const pasteText = (text: string): void => {
      const previous = pasting;
      pasting = true;
      try { term.paste(text); } finally { pasting = previous; }
    };
    // xterm ignores Cmd+arrows. Handle them on the bubble phase, after its textarea
    // keydown listener drains pending IME text, so movement never precedes that text.
    const onCommandArrow = (event: KeyboardEvent): void => {
      if (!isMac || event.target !== term.textarea || event.defaultPrevented || term.options.disableStdin
        || composingRef.current || event.isComposing || event.keyCode === 229
        || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const sequence = event.key === "ArrowLeft" ? "\x01" : event.key === "ArrowRight" ? "\x05" : null;
      if (sequence === null) return;
      event.preventDefault();
      term.input(sequence);
    };
    host.addEventListener("keydown", onCommandArrow);
    const onData = term.onData((data) => {
      const barKey = barKeyRef.current;
      barKeyRef.current = null;
      const physicalChord = typedChord;
      typedChord = null;
      if (enterAs !== null && data === "\r") data = enterAs;
      enterAs = null;
      if (commandBackspace && data === "\x7f") data = "\x15";
      commandBackspace = false;
      const current = paneRef.current;
      if (!current || observeRef.current || secretRef.current !== null || heldRef.current) return;
      const input = data;
      const key = keyFromData(data);
      const chord = !pasting && !composingRef.current && !compositionCommitPendingRef.current
        ? barKey !== null ? barKey.chord
          : physicalChord ?? (hasModifiers(modifiersRef.current) && key !== null ? terminalChord(key, modifiersRef.current) : null)
        : null;
      // Herdr, rather than xterm's legacy encoder, preserves all modifier bits
      // in the keyboard protocol requested by the program in this pane.
      // herdr's attach stream never tells xterm that the program asked for application cursor
      // keys (DECCKM), so xterm's `ESC [ A` misses in less, git log and other full-screen
      // programs. herdr encodes a named key in the program's own mode (#621). A key the socket
      // cannot take now goes the way typing does below, as an arrow always did.
      const arrow = chord === null && !pasting && !composingRef.current && !compositionCommitPendingRef.current && key?.startsWith("Arrow")
        ? terminalChord(key, NO_STICKY_MODIFIERS) : null;
      if (arrow !== null && socket.sendKeys(current, [arrow])) return;
      if (chord !== null) {
        // Shortcuts are never retained as offline text or replayed later: a chord the
        // terminal cannot take now (not ready, disconnected) is told, not dropped in silence
        if (!socket.sendKeys(current, [chord])) {
          const t = tRef.current; // the language of now, not of the attach
          setInputError(t("Not sent: the terminal is not ready for keys."));
        }
        return;
      }
      if (socket.sendInput(current, input)) return;
      // A closed socket, an attachment still opening, or a failed synchronous send:
      // keep printable input for explicit review, never replay it automatically.
      if (draftPaneRef.current !== current) {
        draftPaneRef.current = current;
        setDraft(EMPTY_DRAFT);
      }
      setDraft((prev) => applyToDraft(prev, input));
    });

    // Browsers expose dropped files as bytes, not local paths. Save them beside
    // the pane and paste the returned paths; never send Enter with a drop.
    // Batches upload one after another, so overlapping drops paste their paths in the order dropped.
    let fileQueue: Promise<void> = Promise.resolve();
    const uploadFiles = (files: File[]): void => {
      const pane = paneRef.current;
      if (!pane || !socket.connected || term.options.disableStdin) return;
      fileQueue = fileQueue.then(() => uploadBatch(pane, files));
    };
    const uploadBatch = async (pane: string, files: File[]): Promise<void> => {
      if (paneRef.current !== pane || !socket.connected || term.options.disableStdin) return;
      try {
        // the paths of a batch are pasted together: one file too large and none is uploaded
        for (const file of files) assertAttachable(file);
        const paths: string[] = [];
        for (const file of files) paths.push(await uploadFileRef.current(pane, file));
        // An upload can finish after the user has switched panes or lost input access.
        if (paneRef.current !== pane || chatViewRef.current || !socket.connected || term.options.disableStdin) return;
        pasteText(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ");
        term.focus();
      } catch (error) {
        if (paneRef.current === pane) noteClipboard(error instanceof Error ? error.message : String(error));
      }
    };
    const onFilePaste = (event: ClipboardEvent): void => {
      // xterm handles text (and bracketed paste) itself. A file-only clipboard
      // needs the upload route instead; copied paths must remain native text.
      if (event.clipboardData?.getData("text/plain")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      if (!event.dataTransfer.types.some((type) => type === "Files" || type === "text/plain")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = term.options.disableStdin ? "none" : "copy";
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      if (!event.dataTransfer || !socket.connected || term.options.disableStdin) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        uploadFiles(files);
        return;
      }
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        pasteText(text);
        term.focus();
      }
    };
    host.addEventListener("paste", onFilePaste, { capture: true });
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
    // reflow the pane and the program in it redraw (Claude Code repaints its whole
    // conversation), so a drag of a long session sent over a hundred resizes and the app
    // lagged: fit once the size has settled.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        // the grid belongs to the pty while observing, and to herdr when fixed: only the view moves
        // (a soft keyboard opening must not leave the prompt under it)
        if (adopted()) {
          panned = false;
          followCursor();
          return;
        }
        // the chat lens covers the grid: a phone's viewport or keyboard must not resize the
        // shared pty under another device (#361); the switch back to the terminal refits
        if (chatViewRef.current) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        // a window the system moves or resizes in the background fits its own grid only
        const current = paneRef.current;
        if (current && inUse()) socket.resize(current, term.cols, term.rows);
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
    // An adopted grid has no history to send a wheel to (an observer's reports are dropped, a
    // mirror reports nothing): there the drag pans the mount, both ways, to the cells past its edge.
    let touchX = 0;
    let touchY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent): void => {
      tracking = event.touches.length === 1;
      const first = event.touches[0];
      if (tracking && first) {
        touchX = first.clientX;
        touchY = first.clientY;
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      if (!first) return;
      // finger moving down (y > touchY) shows older lines: a wheel scrolling up, negative deltaY
      const delta = touchY - first.clientY;
      const across = touchX - first.clientX;
      touchX = first.clientX;
      touchY = first.clientY;
      if (adopted()) {
        panned = true;
        host.scrollBy(across, delta);
        return;
      }
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
    // device's size. Re-assert our geometry whenever the user comes back to this
    // tab: its window takes the focus, or it turns visible with the focus. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      socket.resize(current, term.cols, term.rows, true);
    };
    // herdr holds a pane at the size of a `terminal attach` for as long as one is attached, and its
    // own TUI cannot take it back (0.9.3): this window, left open behind it, kept the pane at the
    // window's size, and the TUI drew it cut off at its split's edge with its bottom rows out of
    // reach. So a tab out of use lets go of its pane: once the last attach ends, herdr gives the
    // pane back to its TUI. The tab attaches again when the user is back. A message queued here
    // goes out through this tab's attach, so the tab keeps the pane until the message has gone; a
    // mirrored pane holds no attach, and a page inside another page (the site's demo) has the
    // focus only while it is clicked into.
    const embedded = window.self !== window.top;
    const queueWaits = (pane: string): boolean => {
      if ([...pendingSubmissionsRef.current].some((submission) => submission.pane === pane
        && submission.socket === socket && submission.epoch === pendingEpochRef.current)) return true;
      const owner = paneStorageId(machineId, pane);
      return pendingMessages.read(owner).some((message) => pendingMessages.isOwned(owner, message.id, pendingScopeRef.current)
        && (message.state === "queued" || message.state === "sending"));
    };
    let releaseTimer: number | null = null;
    // the release waits for a message this tab queued: the queue's next change tries it again
    let queueHeld = false;
    const cancelLeave = (): void => {
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseTimer = null;
      queueHeld = false;
    };
    cancelLeaveRef.current = cancelLeave;
    const release = (): void => {
      cancelLeave();
      const current = paneRef.current;
      if (!current || !releaseAwayRef.current || releasedRef.current || inUse() || embedded || fixedGridRef.current || endedRef.current) return;
      if (queueWaits(current)) {
        queueHeld = true;
        return;
      }
      socket.detach(current);
      if (pendingScopeRef.current !== null) pendingMessages.suspend(paneStorageId(machineId, current), pendingScopeRef.current);
      setReleased(true);
      watch(current);
    };
    // the pane's screen starts again from the view, as on a pane switch; the view's first frame is whole
    const watch = (pane: string): void => {
      const generation = ++outputGeneration;
      // Reset in stream order: the attach's queued writes must not draw over the view.
      term.write("\x1bc", () => {
        if (disposed || paneRef.current !== pane || generation !== outputGeneration) return;
        modifyOtherKeysRef.current = 0;
      });
      modifyOtherKeysRef.current = 0;
      setWatching(socket.watch(pane, term.cols, term.rows));
    };
    releaseRef.current = () => { if (queueHeld) release(); };
    watchRef.current = watch;
    // a window resized while watched: the view is drawn for a grid, so it starts again at the new one
    const onWatchedResize = term.onResize(({ cols, rows }) => {
      const current = paneRef.current;
      if (current && releasedRef.current && watchingRef.current) socket.watch(current, cols, rows);
    });
    const resume = (): void => {
      setReleased(false);
      const current = paneRef.current;
      if (!current) return;
      if (watchingRef.current) {
        socket.unwatch(current);
        setWatching(false);
      }
      // A fresh attach says attach_held again if needed; success does not send attach-resumed.
      setHeld(false);
      // the pane's screen starts again from the new attach, as on a pane switch
      const generation = ++outputGeneration;
      // Reset in stream order: synchronous reset would let old queued writes draw afterward.
      term.write("\x1bc", () => {
        if (disposed || paneRef.current !== current || generation !== outputGeneration) return;
        modifyOtherKeysRef.current = 0;
      });
      modifyOtherKeysRef.current = 0;
      setOutputReady(false);
      if (!observeRef.current && !chatViewRef.current) {
        try {
          fit.fit();
        } catch {
          /* not laid out yet; the ResizeObserver will follow up */
        }
      }
      const away = !inUse();
      socket.attach(current, term.cols, term.rows, chatViewRef.current || away);
      if (away) leave();
    };
    // out of use, a reconnect attaches at the size the pane has instead of taking it
    // (keepSize, as under the chat lens), until the tab lets go of the pane
    const leave = (): void => {
      const current = paneRef.current;
      if (current && !observeRef.current && !fixedGridRef.current) socket.keepSize(current);
      if (releaseAwayRef.current && releaseTimer === null && !releasedRef.current) releaseTimer = window.setTimeout(() => {
        if (paneRef.current === current) release();
      }, RELEASE_AFTER_MS);
    };
    leaveRef.current = leave;
    const back = (): void => {
      cancelLeave();
      if (releasedRef.current) resume();
      else refit();
    };
    const onVisibility = (): void => {
      if (inUse()) back();
      else leave();
    };
    // a click or a tap is the user here, whatever the window says about its focus
    const onPointer = (): void => {
      if (releasedRef.current) back();
    };
    window.addEventListener("focus", back);
    window.addEventListener("blur", leave);
    window.addEventListener("pointerdown", onPointer, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      term.options.disableStdin = true;
      if (pendingScopeRef.current !== null) pendingMessages.suspendScope(pendingScopeRef.current);
      pendingScopeRef.current = null;
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
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseRef.current = () => {};
      leaveRef.current = () => {};
      cancelLeaveRef.current = () => {};
      watchRef.current = () => {};
      onWatchedResize.dispose();
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", leave);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      onModifiedEnter.dispose();
      onCommandBackspace.dispose();
      host.removeEventListener("keydown", onCommandArrow);
      onData.dispose();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("paste", onFilePaste, { capture: true });
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      offDisconnect();
      osc52.dispose();
      modifyOtherKeysSet.dispose();
      modifyOtherKeysOff.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      socket.close();
      stopGlyphs();
      host.removeEventListener("compositionstart", compositionStart);
      host.removeEventListener("compositionend", compositionEnd);
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      compositionCommitPendingRef.current = false;
      // A replacement mount must not share its host with the retiring terminal.
      term.element?.remove();
      disposeAfterPendingFrame(term);
      termRef.current = null;
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // the theme follows the settings without a remount
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme, palette);
  }, [theme, palette]);

  // the font follows too, and a font change moves the grid. xterm measures the cell (and the DOM
  // renderer its glyph widths) when fontFamily or fontSize changes, and setting the same value
  // again changes nothing: so a chosen family is set only once its faces loaded, or the cell would
  // stay measured from a fallback
  const fontFamily = terminalFontStack(terminalFontFamily);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let superseded = false;
    const apply = (): void => {
      // a newer font, or an unmounted terminal, took over while the faces loaded
      if (superseded || termRef.current !== term) return;
      if (term.options.fontSize === terminalFontSize && term.options.fontFamily === fontFamily) return;
      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = fontFamily;
      if (observeRef.current || fixedGridRef.current || chatViewRef.current) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      // a chosen font loads after every attach: out of use (a reload behind another app), only
      // this grid fits, and the refit takes the pane once the user is here
      const pane = paneRef.current;
      if (pane && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    if (fontFamily === TERMINAL_FONT_STACK) apply();
    else void loadFontStack(fontFamily, terminalFontSize).then(apply);
    return () => { superseded = true; };
  }, [terminalFontSize, fontFamily]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView) {
      const pane = paneRef.current;
      if (pane) socketRef.current?.keepSize(pane);
      // the grid another device left the pty at while this one showed the terminal
      const shared = sharedGridRef.current;
      const hidden = termRef.current;
      if (shared && hidden && !observeRef.current && (hidden.cols !== shared.cols || hidden.rows !== shared.rows)) hidden.resize(shared.cols, shared.rows);
      return;
    }
    if (observeRef.current || fixedGridRef.current) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
    } catch {
      return;
    }
    // this runs on every load too, right after the attach: out of use (a reload behind another
    // app), only this grid fits, and the refit takes the pane once the user is here
    const pane = paneRef.current;
    if (pane && term && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (!autoSelected && !coarseRef.current) term?.focus();
  }, [chatView]);

  // Reset synchronously on pane changes: old composition timers must never see the new pane.
  useLayoutEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setInputReady(false);
    setInputError(null);
    setComposing(false);
    setOutputReady(false);
    setOutputError(null);
    setHeld(false);
    setUnsupported(false);
    fixedGridRef.current = false;
    sharedGridRef.current = null;
    // the next pane's grid is this browser's again unless it says otherwise (pane-geometry)
    hostRef.current?.toggleAttribute("data-adopted-grid", observeRef.current);
    secretRef.current = null;
    setSecret(null);
    term.options.disableStdin = observeRef.current;
    // a record past its TTL, an undated one, and a hand-edited one all restore as nothing held
    let saved = EMPTY_DRAFT;
    try {
      saved = paneId ? restoreDraft(localStorage.getItem(`herdr-web-ui:terminal-draft:${paneStorageId(machineId, paneId)}`), Date.now()) : EMPTY_DRAFT;
    } catch {}
    setDraft(saved);
    draftPaneRef.current = paneId;
    term.reset();
    modifyOtherKeysRef.current = 0;
    if (!paneId) return;
    const leavePane = (): void => {
      cancelLeaveRef.current();
      // a released pane was detached already
      if (!releasedRef.current) socket.detach(paneId);
      if (watchingRef.current) {
        socket.unwatch(paneId);
        setWatching(false);
      }
      if (pendingScopeRef.current !== null) pendingMessages.suspend(paneStorageId(machineId, paneId), pendingScopeRef.current);
    };
    // a tab that let go of its pane while out of use watches the next one, and attaches it when the user is back
    if (releasedRef.current) {
      watchRef.current(paneId);
      return leavePane;
    }
    try {
      fit?.fit();
    } catch {
      /* not laid out yet; the ResizeObserver will follow up */
    }
    // out of use (the pane closed in herdr and the app moved on to the next one, or a reload behind
    // another app), the attach adopts the pane's size; the refit takes it once the user is here
    const away = !inUse();
    socket.attach(paneId, term.cols, term.rows, chatViewRef.current || away);
    // no blur or hidden comes for a tab already out of use: it lets go of this pane after a moment too
    if (away) leaveRef.current();
    // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
    // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
    if (!chatViewRef.current && !autoSelected && !coarseRef.current) term.focus();
    return leavePane;
  }, [paneId]);

  // the message the tab kept its pane for has gone (or was held): out of use, it lets go now
  useEffect(() => { releaseRef.current(); }, [pending]);


  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (wasAuto && !autoSelected && !chatViewRef.current && !coarseRef.current) termRef.current?.focus();
  }, [autoSelected]);

  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((item: KeyBarKeyItem) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current || compositionCommitPendingRef.current) return;
    const active = item.modifiers ?? modifiersRef.current;
    // A saved combination is exact; an ordinary key inherits the held modifiers.
    // The built-in interrupt remains its dedicated Ctrl+C action.
    const modified = (item.key !== "ctrl-c" || item.modifiers !== undefined) && (hasModifiers(active) || item.modifiers !== undefined);
    const chord = modified ? terminalChord(item.key, active) : null;
    const input = (modified ? navigationSequence(item.key, active) : null)
      ?? keyBarInputSequence(item.key, term.modes.applicationCursorKeysMode);
    if (input === null) return;
    barKeyRef.current = { key: item.key, chord };
    try { term.input(input); } finally { barKeyRef.current = null; }
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid
    if (!inputLineRef.current) term.focus();
  }, []);

  const toggleModifier = useCallback((modifier: keyof StickyModifiers) => {
    if (composingRef.current) return;
    const next = { ...modifiersRef.current, [modifier]: !modifiersRef.current[modifier] };
    modifiersRef.current = next;
    setModifiers(next);
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
    // a frame the socket refuses (input not ready yet) keeps the draft, on screen and on disk, for
    // another try or Discard; it is never queued
    if (socket.sendInput(pane, draft.text)) setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the composer goes straight to the socket, not through onData: an armed key-bar Ctrl
  // must not turn a one-letter message into a control key. Offline it sends nothing and
  // keeps its text (never-queue); a message the server could not deliver keeps it too,
  // with the reason. Bracketed-paste wrapping follows the pane program's mode.
  const submitComposerMessage = useCallback((text: string, delivery: "queue" | "immediate" = "immediate"): Promise<SubmitResult> | null => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null || heldRef.current) return null;
    // not the scope itself: a message sent right after a reconnect leaves before the snapshot that names it
    const epoch = pendingEpochRef.current;
    const sent = socket.submit(pane, composerMessage(text), composerPayload(text, term.modes.bracketedPasteMode), false, delivery);
    if (sent === null) return null;
    const submission = delivery === "queue" ? { pane, socket, epoch } : null;
    if (submission) pendingSubmissionsRef.current.add(submission);
    term.scrollToBottom();
    if (delivery === "immediate") setChatSent((current) => current + 1);
    const owner = paneStorageId(machineId, pane);
    const history = greetingMemory(owner).history;
    if (delivery === "immediate") { rememberGreeting(owner, afterSend(greetingMemory(owner))); redrawGreeting(); }
    // a message went out, from the box or a queued one: the agent's suggestion was for the turn before it
    onChatSuggestion(pane, null);
    return sent.then((result) => {
      // a message refused before anything was typed leaves the greeting as it was; each answer
      // settles its own message only, so one on its way beside it (a queued "Send now") is not undone
      const typed = result.ok ? result.pending === undefined : !submitNotTyped(result.code);
      if (delivery === "immediate") {
        rememberGreeting(owner, afterSettled(greetingMemory(owner), typed, history)); redrawGreeting();
      } else if (typed) {
        rememberGreeting(owner, afterSettled(afterSend(greetingMemory(owner)), true, history)); redrawGreeting();
      }
      if (!result.ok) return result;
      if (result.pending) {
        pendingMessages.accept(owner, result.pending, socketRef.current === socket && socket.connected && pendingEpochRef.current === epoch && paneRef.current === pane ? pendingScopeRef.current : null);
      } else {
        if (paneRef.current === pane) {
          if (delivery === "queue") setChatSent((current) => current + 1);
          setChatRefresh((current) => current + 1);
        }
      }
      return result;
    }, (error: unknown) => {
      // the send broke with no answer: it may have been typed, and it is no longer on its way
      rememberGreeting(owner, afterSettled(delivery === "immediate" ? greetingMemory(owner) : afterSend(greetingMemory(owner)), true, history)); redrawGreeting();
      throw error;
    }).finally(() => {
      if (!submission) return;
      pendingSubmissionsRef.current.delete(submission);
      if (paneRef.current === pane && socketRef.current === socket && pendingEpochRef.current === epoch) releaseRef.current();
    });
  }, [onChatSuggestion, machineId]);

  const sendComposerText = useCallback((text: string, delivery: "queue" | "immediate" = "immediate"): false | Promise<true | string> => {
    const result = submitComposerMessage(text, delivery);
    return result === null ? false : result.then((answer) => answer.ok ? true : submitNote(answer.code, answer.message));
  }, [submitComposerMessage]);

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
    const sent = hasModifiers(modifiersRef.current)
      ? socket.sendKeys(pane, [terminalChord("Enter", modifiersRef.current)!]) : socket.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current) return;
    updateSettings({ terminalInputMode: directTyping ? "line" : "direct" });
  }, [directTyping, updateSettings]);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it
  // back. Only turning direct typing on raises it: a pane or lens picked with it on does not.
  const directTypingRef = useRef(directTyping);
  useEffect(() => {
    const turnedOn = directTyping && !directTypingRef.current;
    directTypingRef.current = directTyping;
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      if (coarse && !chatView && turnedOn) termRef.current?.focus();
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
  // a fallback card is answered with its own buttons: what the user types still goes to the agent
  const answering = chatView && chatPrompt !== null && chatPrompt.pane === paneId && !chatPrompt.value.queued && !chatPrompt.value.fallback ? chatPrompt.value : null;
  // ...and while it is open in the terminal it holds the input: nothing is sent into it
  const heldByOpenQueue = chatView && chatPrompt !== null && chatPrompt.pane === paneId && chatPrompt.value.queued === "open";
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;
  // The held rows fold into their caption while a prompt card needs the room, or a phone's
  // window is short. They stay mounted; the caption is then the button that opens them
  const shortPhone = useMediaQuery(SHORT_PHONE_QUERY);
  const heldFold = heldRowsFold({ promptOpen: chatView && chatPrompt !== null && chatPrompt.pane === paneId, shortPhone, ready: readyForQueue });
  const heldListRef = useRef<HTMLOListElement | null>(null);
  const heldToggleRef = useRef<HTMLButtonElement | null>(null);
  const [heldOpened, setHeldOpened] = useState(false);
  // Each fold starts closed, and so does another pane's or a list that was empty, unless the
  // user is in one of this pane's rows right now: a phone's keyboard comes up for the message
  // being edited and must not fold it away. (During this render the DOM is still the last one.)
  const heldAny = queued.length > 0;
  const [heldSeen, setHeldSeen] = useState({ owner: queueOwner, fold: heldFold, any: heldAny });
  if (heldSeen.owner !== queueOwner || heldSeen.fold !== heldFold || heldSeen.any !== heldAny) {
    setHeldSeen({ owner: queueOwner, fold: heldFold, any: heldAny });
    setHeldOpened(heldOpenAtFold({
      fold: heldFold && heldAny,
      sameOwner: heldSeen.owner === queueOwner,
      focusInRows: heldListRef.current?.contains(document.activeElement) === true,
    }));
  }
  // a row's error is for the user to read: it opens the rows too, and the caption is then no button.
  // Rows it opened are the user's own once focus is in one (the list's onFocus), whatever ends the error
  const heldRowFailed = heldRowError(queueError, queueOwner, queued.map((message) => message.id));
  const heldHidden = heldRowsHidden(heldFold, heldOpened, heldRowFailed);
  const heldToggle = heldToggleShown(heldFold, heldRowFailed);
  // The button goes when the fold ends (the agent is ready, the prompt was answered). Focus on it
  // would fall to the page, so it moves to the list the button stood for: Tab goes on from there.
  // The list, not a message box: on a phone that would raise the keyboard unasked.
  // React detaches the button's ref just before it removes the node, while focus is still on it:
  // that is read in the commit, never in a render React may discard.
  // The button names its list (aria-controls) and that is what is kept: a button that goes because
  // the user moved to another pane stood for another list, and this pane's is not focused for it.
  const heldRefocusRef = useRef<string | null>(null);
  const setHeldToggle = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && heldToggleRef.current !== null && document.activeElement === heldToggleRef.current) heldRefocusRef.current = heldToggleRef.current.getAttribute("aria-controls");
    heldToggleRef.current = node;
  }, []);
  // every commit, so a flag set as the whole list went is dropped with it
  useLayoutEffect(() => {
    const left = heldRefocusRef.current;
    if (left === null) return;
    heldRefocusRef.current = null;
    if (heldRefocusDue(left, heldListRef.current?.id ?? null)) heldListRef.current?.focus({ preventScroll: true });
  });
  // an empty chat: one greeting line over the composer, which a mouse-driven window centres
  const folder = greetingFolder(cwd);
  const greetingDue = chatView && paneId !== null && agent !== null && !secretActive && !observing && !ended
    && showsGreeting({ memory: greetingMemory(paneStorageId(machineId, paneId)), agentStatus, queued: queued.length + pending.length, folder });
  // a stack too short for the composer and the greeting keeps the chat's own empty line
  const greeted = greetingDue && greetingRoom;
  // Only the composer moves (Composer.css): the surface under it keeps its box, so the xterm
  // mount is never resized by a greeting coming or going. Measured before paint, so the composer
  // is never seen docked first. The greeting stays mounted while it does not fit, so that it is
  // measured when the stack grows again.
  useLayoutEffect(() => {
    const stack = stackRef.current;
    const greeting = greetingRef.current;
    const composer = greeting?.parentElement;
    if (!greetingDue || !stack || !greeting || !composer) return;
    const place = (): void => {
      const lift = composerLift(stack.clientHeight, composer.offsetHeight, greeting.offsetHeight);
      const card = composer.querySelector(".composer-surface");
      // a difference of two boxes of the same composer: the lift moves both
      const cardOffset = card === null ? 0 : card.getBoundingClientRect().top - composer.getBoundingClientRect().top;
      stack.style.setProperty("--composer-lift", `${lift}px`);
      stack.style.setProperty("--composer-room", `${roomOverComposer(stack.clientHeight, composer.offsetHeight, lift, cardOffset)}px`);
      setGreetingRoom(greetingFits(stack.clientHeight, composer.offsetHeight, greeting.offsetHeight));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(stack); observer.observe(composer); observer.observe(greeting);
    return () => { observer.disconnect(); stack.style.removeProperty("--composer-lift"); stack.style.removeProperty("--composer-room"); setGreetingRoom(true); };
  }, [greetingDue, paneId]);

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
      if (!socketRef.current?.connected || heldRef.current || secretRef.current !== null) return false;
      // an older bridge is told apart by the socket, once this connection's snapshot has said what it supports
      return sendComposerText(text, composerDelivery(agent, agentStatus));
    },
    [agent, agentStatus, answerPanePrompt, answering, heldByOpenQueue, sendComposerText, queueStore, machineId],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard"): Promise<void> => {
    const owner = queueOwner, pane = paneId;
    const socket = socketRef.current, scope = pendingScopeRef.current;
    if (owner === null || pane === null || paneRef.current !== pane) return;
    // what another tab saved since: a copy it is sending again is not confirmed here either
    pendingMessages.refresh(owner);
    const message = pendingMessages.read(owner).find((item) => item.id === id);
    if (!message || message.state === "sending") return;
    if (action === "steer" && (message.state === "uncertain" || !socket?.connected || heldRef.current || secretRef.current !== null || observeRef.current || ended || heldByOpenQueue || answering !== null)) return;
    if (message.serverOwned && !pendingMessages.isOwned(owner, id, scope)) return;
    if (!pendingMessages.begin(owner, id)) return;
    try {
      if (message.serverOwned) {
        const result = socket?.pendingAction(pane, id, action);
        if (!result) {
          pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
          return;
        }
        const answer = await result;
        if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, answer.code === "pending_not_found" || !submitNotTyped(answer.code));
        // Only the matching server removal receipt removes an authoritative item.
      } else if (action === "discard") {
        pendingMessages.removeCopy(owner, id);
      } else if (message.state === "held") {
        if (!pendingMessages.unconfirm(owner, id)) {
          pendingMessages.fail(owner, id, { code: "unsaved", message: t("Queue could not be saved. Keep this tab open or copy the messages before reloading.") }, false);
          return;
        }
        const result = submitComposerMessage(message.text, "immediate");
        if (!result) {
          pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not sent. Reconnect and try again.") }, false);
          return;
        }
        const answer = await result;
        if (answer.ok) pendingMessages.removeCopy(owner, id);
        else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code));
      }
    } catch {
      pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
    } finally { pendingMessages.end(owner, id); }
  }, [answering, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage]);


  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: File) => uploadPaneImage(paneId ?? "", file), [paneId]);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    <div ref={stackRef} className={`terminal-stack${chatView ? " is-chat" : ""}${greeted ? " is-greeted" : ""}`} data-pane-owner={paneId === null ? undefined : paneStorageId(machineId, paneId)} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}>
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
            {!observing && socketRef.current?.canTakeOver() && (
              <button type="button" className="btn terminal-banner-action" title={t("Take this pane from another web app or terminal attach. That connection will close.")} onClick={() => { if (paneId !== null) socketRef.current?.takeOver(paneId); }}>{t("Open here")}</button>
            )}
          </div>
        )}
        {paneId !== null && !chatView && unsupported && (
          <div className="terminal-banner terminal-banner-soon" role="status">
            <span>{t("Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet. The chat lens works now.")}</span>
          </div>
        )}
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <a className="btn" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>{t("Reconnect")}</a>
          </div>
        )}
        {!chatView && inputError && <div className="terminal-banner" role="status">{inputError}<button type="button" className="btn terminal-banner-action" onClick={() => setInputError(null)}>{t("Dismiss")}</button></div>}
        {!chatView && !observing && connected && !inputReady && !held && !ended && !released && <div className="terminal-banner" role="status">{t("Waiting for terminal input…")}</div>}
        {paneId !== null && !chatView && released && <div className="terminal-banner" role="status">{t(watching ? "View only while you use another window · click to type" : "Paused while you use another window")}</div>}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            terminal ended{!draftIsEmpty(draft) ? " — held input discarded" : ""}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            reconnecting to herdr web ui…
            {draft.text.length > 0 && <span className="draft-held"> input held: “{draft.text}”</span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="draft-label">{t("Input held until the terminal is ready:")}</span>
            {draft.text.length > 0 && <code className="draft-text">{draft.text}</code>}
            {/* the preview shows the start of the text: without this, a draft that lost its end looks whole */}
            {draft.truncated && <span className="draft-truncated">{t("Some input was too long to hold and was left out.")}</span>}
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
        {/* xterm hides its rendered rows from assistive technology, so the region around the
            visible grid carries the pane's name: a screen reader announces which pane
            this is. No tabIndex: xterm's helper textarea takes the keyboard here on attach, so a
            stop on the wrapper would only be an empty one ahead of it. */}
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} role={chatView ? undefined : "region"} aria-roledescription={chatView ? undefined : t("Terminal")} aria-label={chatView ? undefined : terminalName} />
        {paneId !== null && chatView && (
          <RenderBoundary resetKey={paneId} fallback={(retry) => (
            <div className="chat-view"><div className="chat-empty" role="alert">
              <p>{t("The chat can't be shown. The terminal still works.")}</p>
              <button type="button" className="btn" onClick={retry}>{t("Try again")}</button>
            </div></div>
          )}>
          {/* a pane's chat never commits another pane's turns: a new pane is a new ChatView.
              The session herdr reports is left out of the key: it can change while the
              conversation stays (a shared Codex daemon), and the chat follows history_id itself */}
          <ChatView
            key={paneId}
            paneId={paneId}
            refreshKey={chatRefresh}
            sentKey={chatSent}
            connected={connected}
            ended={ended}
            agent={agent}
            agentStatus={agentStatus}
            onMetadata={onChatMetadata}
            onRead={onChatRead}
            greeted={greeted}
            onPrompt={onChatPrompt}
            onSuggestion={onChatSuggestion}
            promptRefreshKey={promptRefresh}
            pendingAnswer={pendingAnswer !== null && pendingAnswer.pane === paneId ? pendingAnswer : null}
            onPendingAnswerDone={clearPendingAnswer}
            promptDock={promptDock}
            onPromptAnswered={onPromptAnswered}
          />
          </RenderBoundary>
        )}
      </div>
      {/* the queue is the composer's, so it shows under the chat lens only: there alone is an open
          Codex question known (heldByOpenQueue), and Send now must not type into one */}
      {paneId !== null && chatView && !observing && !ended && queueOwner !== null && queued.length > 0 && (
        <section className={`composer-queue${readyForQueue ? " is-ready" : ""}${heldHidden ? " is-folded" : ""}`} aria-label={t("Queued messages")}>
          {(() => {
            // one caption line: the sentence says the state
            const caption = <>
              <span className="composer-queue-mark" aria-hidden="true"><Clock /></span>
              <span className="composer-queue-caption">
                {t(readyForQueue ? "Held message — review and send" : "Held until the agent is ready")}
                {heldCountShown(queued.length, heldFold) && <> · {queued.length === 1 ? t("{n} message", { n: 1 }) : t("{n} messages", { n: queued.length })}</>}
              </span>
            </>;
            return <div className="composer-queue-heading">
              {/* the count stays for assistive tech, beside the button and not in its name */}
              <strong className="visually-hidden">{t("Queued messages ({n})", { n: queued.length })}</strong>
              {heldToggle
                ? <button type="button" className="composer-queue-toggle" ref={setHeldToggle} aria-expanded={!heldHidden} aria-controls={`queued-list-${queueOwner}`}
                    onClick={() => { setHeldOpened(heldHidden); }}>
                    {caption}
                    <span className="composer-queue-toggle-caret" aria-hidden="true"><ChevronRight /></span>
                  </button>
                : caption}
            </div>;
          })()}
          {queueStore.isUnsaved(queueOwner) && <p className="composer-queue-error" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</p>}
          <ol className="composer-queue-list" id={`queued-list-${queueOwner}`} ref={heldListRef} tabIndex={-1}
            onFocus={() => { setHeldOpened((opened) => heldOpenOnFocus(heldFold, opened)); }}>
          {queued.map((message, index) => <li className="composer-queue-item" key={message.id}>
            <label className="visually-hidden" htmlFor={`queued-${message.id}`}>{t("Message {n}", { n: index + 1 })}</label>
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
                onClick={() => { queueStore.remove(queueOwner, message.id); }}>
                {/* a phone draws the X; the word stays the button's name */}
                <span className="composer-queue-discard-text">{t("Discard")}</span><X aria-hidden="true" />
              </button>
            </div>
            {queueError?.owner === queueOwner && queueError.id === message.id && <p className="composer-queue-error" role="status">{queueError.text}</p>}
          </li>)}
          </ol>
        </section>
      )}
      {paneId !== null && chatView && !observing && queueOwner !== null && pending.length > 0 && <PendingMessages
        key={`pending-${queueOwner}`}
        messages={pending.map((message) => !message.serverOwned || pendingMessages.isOwned(queueOwner, message.id, pendingScopeRef.current)
          ? message : { ...message, serverOwned: false, state: "uncertain" as const })}
        connected={connected}
        blocked={held || secretActive || ended || heldByOpenQueue || answering !== null}
        unsaved={pendingMessages.isUnsaved(queueOwner)}
        isBusy={(id) => pendingMessages.isBusy(queueOwner, id)}
        onSendNow={(id) => actOnPending(id, "steer")}
        onDiscard={(id) => actOnPending(id, "discard")}
      />}
      {/* The prompt card's place: under the held messages (which fold to their caption while it is
          open), directly over the input card, on the same column. ChatView renders the card into
          it. It is a live region of its own, since the card is no longer inside the transcript's
          log: a prompt that arrives is announced, as it was there. */}
      {paneId !== null && chatView && <div className="prompt-dock" ref={setPromptDock} aria-live="polite" />}
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
          autoFocus={!autoSelected && !coarse}
          agent={agent}
          agentStatus={agentStatus}
          backgroundTasks={backgroundTasks}
          backgroundWait={backgroundWait}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected && !held}
          answerHint={answering === null ? null
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          // no suggestion under any card, a fallback or queued one included
          suggestion={chatPrompt?.pane !== paneId && chatSuggestion?.pane === paneId ? chatSuggestion.value : null}
          greeting={greetingDue ? (
            <div className={`composer-greeting${greeted ? "" : " is-out"}`} ref={greetingRef} aria-hidden={greeted ? undefined : true}>
              <p className="composer-greeting-title">{t("What should {agent} do in {folder}?", { agent: agentDisplayLabel(agent), folder })}</p>
              {/* each part keeps its own direction: a right-to-left PC name does not reorder the path */}
              <p className="composer-greeting-where">{machineName && <bdi>{machineName}</bdi>}{machineName && cwd ? " · " : ""}{cwd && <bdi>{cwd}</bdi>}</p>
            </div>
          ) : null}
          onSend={composerSend}
          onAbort={abortTurn}
          onUploadImage={uploadImage}
        />
      )}
      {paneId !== null && !secretActive && !observing && !ended && inputLine && <TerminalInput key={paneId} owner={paneStorageId(machineId, paneId)} onComposing={setComposing} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} />}
      {paneId !== null && !secretActive && !observing && !chatView && <KeyBar disabled={composing || !connected || !inputReady || held || ended} onKey={pressKey}
        modifiers={modifiers} onToggleModifier={toggleModifier} items={settings.keyBarItems}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect } : {})} />}
    </div>
  );
}
