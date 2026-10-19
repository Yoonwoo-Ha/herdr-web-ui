import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ArrowUp, ChevronRight, ClipboardCheck, Clock, Eye, Quote, SendHorizontal, Trash2, TriangleAlert, Unplug, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket, type SubmitDelivery, type SubmitResult } from "../lib/ws.ts";
import { MachineSession } from "../lib/machineSession.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { ViewportIntentGate } from "../lib/viewportIntent.ts";
import { PaneCachedContext, PanePresentedContext, PaneFollowContext, PaneShownContext, PaneSubmitContext } from "../lib/paneSubmitContext.ts";
import { disposeAfterPendingFrame } from "../lib/terminalDispose.ts";
import { clipboardKey, hasModifiers, physicalKey, terminalChord, navigationSequence, keyFromData, ctrlEnterSequence, mirroredCtrlEnterKey, modifyOtherKeysLevel, NO_STICKY_MODIFIERS, type StickyModifiers } from "../lib/keys.ts";
import { keyBarInputSequence, type KeyBarKeyItem } from "../lib/keyBar.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, restoreDraft, type InputDraft } from "../lib/draft.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { pendingMessages } from "../lib/pendingMessages.ts";
import { heldCountShown, heldOpenAtFold, heldOpenOnFocus, heldRefocusDue, heldRowError, heldRowsFold, heldRowsHidden, heldToggleShown, SHORT_PHONE_QUERY } from "../lib/heldRows.ts";
import { arrangeNotices, dismissNotice, NO_DISMISSALS, settleDismissed, type DismissedNotices } from "../lib/composerNotices.ts";
import { hermesCtrlCTooSoon, stopKey } from "../lib/hermesStop.ts";
import { type DraftRefusal, MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, agentDisplayLabel, composerDelivery, composerMessage, composerPayload, pendingActionUncertain, submitNote, submitNotTyped, submitRefusal } from "../lib/compose.ts";
import { afterRead, afterSend, afterSettled, composerLift, greetingMemory, rememberGreeting, greetingFits, greetingFolder, roomOverComposer, showsGreeting, type ChatRead } from "../lib/greeting.ts";
import { DETACHED, usePaneBranch } from "../lib/paneBranch.ts";
import { answerFromText, answerHint, answerRefusal, needsConfirmation, type TypedAnswer } from "../lib/promptAnswer.ts";
import { ApiError, AttachmentTooLargeError, assertAttachable, fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { userErrorMessage } from "../lib/userError.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { appendQuote, formatTerminalQuote } from "../lib/terminalQuote.ts";
import { matchHerdrWidths } from "../lib/terminalWidths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { TerminalInput } from "./TerminalInput.tsx";
import { FindBar } from "./FindBar.tsx";
import { TerminalViewportTools, type TerminalSearchState } from "./TerminalViewportTools.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { ChatView } from "./ChatView.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Composer } from "./Composer.tsx";
import { ComposerNotices, type ComposerNoticeRow } from "./ComposerNotices.tsx";
import { PendingMessages } from "./PendingMessages.tsx";
import type { AgentStatus, ClientRole, ConversationMetadata, InteractivePrompt, PlanSummary, ServerMessage } from "../../shared/protocol.ts";
import type { PaneControls, PaneView } from "../lib/actions.ts";
import { usePaneLane } from "../lib/chatLane.ts";
import { useSettings, terminalTheme, type Palette, type ResolvedTheme } from "../lib/settings.ts";
import { loadFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";
import { isAppShortcut } from "../lib/shortcuts.ts";
import { plainPageDirection } from "../lib/pageScroll.ts";
import { keyboardHoldsGrid, keyboardUp } from "../lib/keyboard.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { WebPanelContext } from "../lib/webPanel.ts";
import { fileUriPath, hyperlinkFilter, isWebLink, openWebLink, terminalFileLinkProvider } from "../lib/terminalFileLinks.ts";
import { adjustTerminalGlyphs } from "../lib/terminalGlyphs.ts";
import { keepDeleteRepeatText, keyboardNeedsText, restoreDeleteRepeatCaret } from "../lib/deleteRepeat.ts";
import { terminalLabel } from "../lib/terminalLabel.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { modalOpen } from "../lib/focus.ts";
import { pinchFontSize } from "../lib/pinchFontSize.ts";
import { narrowPaneFontSize } from "../lib/narrowPaneFont.ts";
import { finalStep, HERDR_MOUSE_SCROLL_LINES, wheelSteps } from "../lib/wheelSteps.ts";
import { attachTerminalWheel } from "../lib/terminalWheel.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;
/** How long a tab is out of use before it lets go of its pane: a glance at another window keeps it. */
const RELEASE_AFTER_MS = 1000;

// Only a tab the user is in drives the shared grid. A window left open behind another app
// still turns visible when the screen wakes, and reconnects, reloads or moves on to the next pane
// in the background: taking the pane then sized it for nobody, and herdr's own TUI drew it cut
// off at its split's edge
const inUse = (): boolean => document.visibilityState === "visible" && document.hasFocus();

/** The PC sockets this page has been connected to (lib/machineSession.ts keeps one per PC, across pane
    views and terminal mounts): not connected on one of them, a terminal is reconnecting; on any other, it
    is connecting for the first time. The words say which (here, ChatView and the header's chip). */
const connectedSockets = new WeakSet<HerdrSocket>();

/** A failure as one line: the plain sentence, then what the server or the browser said. */
const plainError = (cause: unknown): string => {
  const failure = userErrorMessage(cause);
  return failure.detail === null ? failure.message : `${failure.message} (${failure.detail})`;
};

export interface PaneTerminalProps {
  /** App's content lifetime, including the current finish identity. */
  presentationKey?: string;
  finishEpoch?: string;
  finishId?: number;
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /** A restored pane keeps its ID but gets a new terminal after herdr restarts. */
  terminalId?: string | null;
  /** null while the PC identity loads, before the first attach's fixed-grid frame arrives. */
  mirrored?: boolean | null;
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
  /** the plan the pane's agent keeps (null on an offline PC): the composer's chip opens it */
  plan?: PlanSummary | null;
  /** the pane's turn ended on work still running in the background: the composer says BG */
  backgroundWait?: boolean;
  /** the pane's working directory and its PC's name: an empty chat's greeting names them */
  cwd?: string | null;
  /** the pane's workspace: its checkout's branch stands beside the folder under the composer */
  workspaceId?: string | null;
  /** that workspace is a linked worktree of this repository (its name, as herdr gives it); null: it is not one */
  worktreeRepo?: string | null;
  machineName?: string;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  findRequest?: number;
  controls?: { current: PaneControls | null };
  /** Only the selected tile may take keyboard focus after async work or a lens change. */
  active?: boolean;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** one of several panes drawn side by side: under 80 columns its font shrinks to reach them */
  split?: boolean;
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
  /** Fires on every change of the socket's connected state (the header shows it). `connectedBefore`: the
   *  socket has been connected on this page before, so a connection it waits for is a reconnect, not the first. */
  onConnectionChange?: (connected: boolean, connectedBefore: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}


/** The last refused Send now note per pane, kept across that pane's mounts (see queueError). */
const heldRowNotes = new Map<string, { owner: string; id: string; text: string }>();

export function PaneTerminal({
  presentationKey,
  finishEpoch,
  finishId,
  paneId,
  terminalId = null,
  mirrored = false,
  restoreError = null,
  agent = null,
  title = null,
  agentStatus,
  backgroundTasks = 0,
  plan = null,
  backgroundWait = false,
  cwd = null,
  workspaceId = null,
  worktreeRepo = null,
  machineName = "",
  view,
  findRequest = 0,
  controls,
  active = true,
  autoSelected = false,
  terminalFontSize,
  split = false,
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
  const activeRef = useRef(active);
  activeRef.current = active;
  const openFile = useContext(OpenFileContext);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const openWebPage = useContext(WebPanelContext);
  const machineId = useMachineId();
  const openWebRef = useRef((uri: string, shiftKey: boolean) => openWebPage?.(uri, shiftKey, machineId) ?? false);
  openWebRef.current = (uri, shiftKey) => openWebPage?.(uri, shiftKey, machineId) ?? false;
  const branchWord = usePaneBranch(machineId, workspaceId);
  const machineSessions = useMachineSessions();
  const sessionRef = useRef<MachineSession | null>(null);
  const submitRetention = useContext(PaneSubmitContext);
  const presented = useContext(PanePresentedContext);
  const presentedRef = useRef(presented); presentedRef.current = presented;
  const cached = useContext(PaneCachedContext);
  const cachedRef = useRef(cached); cachedRef.current = cached;
  // a split tab's pane a phone keeps behind the one it shows sizes nothing: the pty is shared with
  // every device, and a PC drawing the split would see it at the phone's size (#819)
  const shown = useContext(PaneShownContext);
  const shownRef = useRef(shown); shownRef.current = shown;
  // the split half following the other half's grid of the same tab sizes nothing either
  const follow = useContext(PaneFollowContext);
  const followRef = useRef(follow); followRef.current = follow;
  const sizesPty = (): boolean => presentedRef.current && shownRef.current && !followRef.current;
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const chatView = view === "chat";
  const [findOpen, setFindOpen] = useState(false);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [searchState, setSearchState] = useState<TerminalSearchState | null>(null);
  const viewportIntent = useMemo(() => new ViewportIntentGate(), [machineId, paneId]);
  const viewportSearching = useSyncExternalStore(viewportIntent.subscribe, viewportIntent.isSearching, viewportIntent.isSearching);
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const lastFindRequest = useRef(findRequest);
  useLayoutEffect(() => { findOpenRef.current = false; setFindOpen(false); }, [paneId]);
  useLayoutEffect(() => {
    if (findRequest !== lastFindRequest.current) {
      lastFindRequest.current = findRequest;
      if (findRequest > 0 && activeRef.current) {
        findOpenRef.current = true;
        setFindOpen(true);
      }
    }
  }, [findRequest]);
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  // what the grid's region announces: the pane's own name, or the grid's kind while none is open
  const terminalName = terminalLabel(paneId, title, t);
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelStateRef = useRef({ speed: terminalWheelSpeed, omoQuestion: false });
  wheelStateRef.current = { speed: terminalWheelSpeed, omoQuestion: agent === "omo" && agentStatus === "blocked" };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const pinchBadgeRef = useRef<HTMLSpanElement | null>(null);
  const pinchStatusRef = useRef<HTMLSpanElement | null>(null);
  /** the user's font size (settings, or a pinch in progress); a narrow split pane may draw smaller */
  const baseFontRef = useRef(terminalFontSize);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const pageScroll = useRef<((direction: -1 | 1) => void) | null>(null);
  const lineScroll = useRef<((lines: number) => void) | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** OSC 8 links this app cannot open are not drawn (#739); its state ends with `term.reset()` */
  const hyperlinksRef = useRef(hyperlinkFilter());
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  /** the socket has been connected on this page before (connectedSockets): not connected, this terminal, its
   *  chat and the header say Reconnecting; before the first connection they say Connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  const pendingScopeRef = useRef<string | null>(null);
  /** The PC session's epoch: a receipt belongs to the connection on which its request left. */
  const pendingEpochRef = useRef(0);
  const [outputReady, setOutputReady] = useState(false);
  const outputTarget = JSON.stringify([paneId, terminalId]);
  const outputTargetRef = useRef(outputTarget); outputTargetRef.current = outputTarget;
  const [parsedTarget, setParsedTarget] = useState<string>();
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // a 4008 overload close stopped this PC's shared connection: cleared when it comes back
  const stalledRef = useRef(false);
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
  // a composition in the input line keeps the key bar live but blocks the switch to direct typing:
  // unmounting the line mid-composition could drop the word or replay it into the pane
  const lineComposingRef = useRef(false);
  const [lineComposing, setLineComposingState] = useState(false);
  const setLineComposing = useCallback((active: boolean) => { lineComposingRef.current = active; setLineComposingState(active); }, []);
  const compositionCommitPendingRef = useRef(false);
  const barKeyRef = useRef<{ key: string; chord: string | null } | null>(null);
  /** set while the composer's Stop types its ESC, so it goes out as a Stop (ClientMessage `input.stop`) */
  const stopKeyRef = useRef(false);
  const modifiersRef = useRef<StickyModifiers>(NO_STICKY_MODIFIERS);
  const [modifiers, setModifiers] = useState<StickyModifiers>(NO_STICKY_MODIFIERS);
  const clearModifiers = useCallback(() => {
    modifiersRef.current = NO_STICKY_MODIFIERS;
    setModifiers(NO_STICKY_MODIFIERS);
    barKeyRef.current = null;
  }, []);
  useLayoutEffect(clearModifiers, [paneId, chatView, active, clearModifiers]);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(false);
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  const mirroredRef = useRef(mirrored); mirroredRef.current = mirrored;
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  // takes the pty back to this grid when another device left it at its own (the effect below sets it)
  const reassertIfStaleRef = useRef<() => void>(() => undefined);
  // draws the grid again as adopted or not (data-adopted-grid), keeping the cursor's row in sight
  const followCursorRef = useRef<() => void>(() => undefined);
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
  // the mount effect's initial-attach decision, also used for a replacement pane
  const deferAttachRef = useRef<(pane: string) => boolean>(() => false);
  // the mount effect's release, for the queue below: a tab that kept its pane for a message lets go once it went
  const releaseRef = useRef<() => void>(() => {});
  const presentationRef = useRef<() => void>(() => {});
  // A cache release resumes from the existing screen, not the observer's replacement screen.
  const cachedReleaseRef = useRef(false);
  // the mount effect's leave, for the pane switch: a tab out of use from the start (a reload behind
  // another app) or moving on to the next pane there lets go of it too
  const leaveRef = useRef<() => void>(() => {});
  const cancelLeaveRef = useRef<() => void>(() => {});
  // the mount effect's in-place re-attach after the output stopped, for the banner's Reconnect
  const reattachRef = useRef<() => void>(() => {});
  // the mount effect's keyboard hold, for the fits outside it: before a fit, whether the soft keyboard
  // holds the grid (the fit then waits for the keyboard to go; `force` says it was to re-assert the
  // grid), and after one, that the grid is the host's again
  const keyboardHoldsRef = useRef<(force: boolean) => boolean>(() => false);
  const fittedRef = useRef<() => void>(() => {});
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
  const narrowFont = split;
  const narrowFontRef = useRef(narrowFont);
  narrowFontRef.current = narrowFont;
  const narrowFontFitted = useRef(narrowFont);
  // Settings → Chat width, Default: the lane follows this pane, on the stack its columns share
  usePaneLane(stackRef);
  // every device starts typing straight into the grid; the input line is a choice (key bar or Settings)
  const directTyping = settings.terminalInputMode !== "line";
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
  // The pane whose held draft takes all later typing until Send or Discard: keys sent beside it would
  // reach the pty without the start the draft holds (`echo ` held, `rm -rf build` and Enter typed).
  // Set here on each render, and at once by onData when it holds a key, before that render comes.
  const draftHeldForRef = useRef<string | null>(null);
  draftHeldForRef.current = paneId !== null && draftState.owner === paneStorageId(machineId, paneId) && !draftIsEmpty(draft) ? paneId : null;
  useEffect(() => {
    if (!paneId || draftState.owner !== paneStorageId(machineId, paneId)) return;
    const key = `herdr-web-ui:terminal-draft:${draftState.owner}`;
    try { if (draftIsEmpty(draft)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({ ...draft, at: Date.now() })); } catch {}
  }, [draftState, paneId, machineId, draft]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the notices the user put away over the input card (lib/composerNotices.ts)
  const [dismissedNotices, setDismissedNotices] = useState<DismissedNotices>(NO_DISMISSALS);
  // the text of the last drag, offered to the chat draft while its highlight stays (herdr's rows when it gave them)
  const [selectionQuote, setSelectionQuote] = useState<{ pane: string; text: string; range: { start: number; end: number } | null } | null>(null);
  // Explicit sends refresh immediately; continuous transcript invalidations are rate-limited.
  const [chatRefresh, setChatRefresh] = useState(0);
  const [chatInvalidation, setChatInvalidation] = useState(0);
  // an older bridge pushes no transcript changes: the chat reads at the former 2s cadence
  const [conversationPushes, setConversationPushes] = useState(false);
  const onConversationWatch = useCallback((pane: string, enabled: boolean) => {
    socketRef.current?.watchConversation(pane, enabled);
  }, []);
  /** A scrollback stand-in's listener; a ref, so terminal output never re-renders the pane. */
  const chatOutputRef = useRef<(() => void) | null>(null);
  const onTerminalOutput = useCallback((listener: (() => void) | null) => {
    chatOutputRef.current = listener;
  }, []);
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
  // a cancelled send the agent put back in its input box, for the composer to take again
  const [chatRestored, setChatRestored] = useState<{ pane: string; value: string } | null>(null);
  const onChatRestored = useCallback((pane: string, value: string | null) => {
    setChatRestored((current) => value !== null
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
    if (activeRef.current && toMessageBox && (chatViewRef.current || !findOpenRef.current)) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
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
    // the same settings keep the same object: every conversation read would otherwise re-render the composer
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort
      && previous.value?.context?.used === value?.context?.used
      && previous.value?.context?.window === value?.context?.window ? previous : { pane, value });
  }, []);
  const queueStore = messageQueues;
  const queueOwner = paneId === null ? null : paneStorageId(machineId, paneId);
  const queued = useSyncExternalStore(queueStore.subscribe, () => queueStore.read(queueOwner ?? ""));
  const pending = useSyncExternalStore(pendingMessages.subscribe, () => pendingMessages.read(queueOwner ?? ""));
  useEffect(() => {
    if (!paneId || !queueOwner || !submitRetention) return;
    let release: (() => void) | undefined;
    const retainPending = (): void => {
      const scope = sessionRef.current?.scope ?? null;
      const waits = pendingMessages.read(queueOwner).some((message) => pendingMessages.isOwned(queueOwner, message.id, scope)
        && (message.state === "queued" || message.state === "sending"));
      if (waits) release ??= submitRetention.retain(paneId);
      else { release?.(); release = undefined; }
    };
    // Transfer retention before the submit promise releases its receipt claim. A React
    // render/effect after that release would let navigation unmount the pane in between.
    const off = pendingMessages.subscribe(retainPending);
    retainPending();
    return () => { off(); release?.(); };
  }, [paneId, queueOwner, submitRetention]);
  const sendingRef = useRef(false);
  const [queueSending, setQueueSending] = useState<string | null>(null);
  // a refused Send now's note outlives this mount: a pane left for another workspace unmounts, and
  // the note must still be there when the user comes back (it is never a retry, only the words)
  const [queueError, setQueueErrorState] = useState<{ owner: string; id: string; text: string } | null>(() => (queueOwner === null ? null : heldRowNotes.get(queueOwner) ?? null));
  // the note is kept at once, not in the state update: a Send now answered after this pane
  // unmounted (the user went to another workspace) runs no update here, and the note must stay
  const setQueueError = useCallback((note: { owner: string; id: string; text: string } | null): void => {
    if (note) heldRowNotes.set(note.owner, note);
    setQueueErrorState(note);
  }, []);

  paneRef.current = paneId;
  endedRef.current = ended;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    if (connected && socketRef.current !== null) connectedSockets.add(socketRef.current);
    if (connected && !connectedBefore) setConnectedBefore(true);
    if (active) onConnectionChangeRef.current?.(connected, connectedBefore || connected);
  }, [connected, connectedBefore, active]);

  useEffect(() => {
    if (active) onRoleAckRef.current?.(observing ? "observe" : "interact");
    else {
      termRef.current?.blur();
      if (stackRef.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [active, observing]);

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
      // a program's own DECSCUSR still changes the cursor
      cursorStyle: "block",
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
      // a program's own colors suit one background (Claude Code's question titles are #ffffff, near
      // 1:1 on a light palette): xterm moves a foreground under 4.5:1 toward black or white. Dim text
      // needs half that, and box, block and powerline glyphs keep their color.
      minimumContrastRatio: 4.5,
      linkHandler: {
        activate: (event, uri) => {
          if (!linkPressed(event)) return;
          const path = fileUriPath(uri);
          if (path !== null) openFileRef.current?.(path);
          else if (isWebLink(uri) && !openWebRef.current(uri, event.shiftKey)) openWebLink(uri);
        },
        allowNonHttpProtocols: true,
      },
      // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    // Every fit first settles the font: a split pane under 80 columns draws smaller to reach
    // them (btop refuses a narrower screen), and returns to the user's size once it is wide enough.
    const fitGrid = fit.fit.bind(fit);
    fit.fit = (): void => {
      // Every local fit (lens, font, resume or initial attach) shares this entry point.
      // A following half keeps the adopted PTY grid, even when its viewport changes.
      if (followRef.current) return;
      const base = baseFontRef.current;
      const colsAt = (size: number): number | null => {
        term.options.fontSize = size;
        const cols = fit.proposeDimensions()?.cols;
        return cols !== undefined && Number.isFinite(cols) ? cols : null;
      };
      // a grid this client does not drive gains no columns from a smaller font
      term.options.fontSize = narrowFontRef.current && !observeRef.current && !fixedGridRef.current ? narrowPaneFontSize(base, colsAt) : base;
      fitGrid();
    };
    term.loadAddon(fit);
    matchHerdrWidths(term);
    // the same policy as the linkHandler above: an http(s) address or nothing (S10)
    term.loadAddon(new WebLinksAddon((event, uri) => { if (isWebLink(uri) && !openWebRef.current(uri, event.shiftKey)) openWebLink(uri); }));
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
    // iOS repeats a held ⌫ only while the field has text and wraps (#862). These run after
    // xterm's own capturing listeners on its textarea, so they refill it once xterm emptied it.
    const textarea = term.textarea;
    const keepText = (event: Event): void => {
      if (!textarea || composingRef.current) return;
      if ((event instanceof KeyboardEvent || event instanceof InputEvent) && event.isComposing) return;
      if (event.type === "focus" || event.type === "keydown") restoreDeleteRepeatCaret(textarea);
      if (event instanceof KeyboardEvent && event.keyCode === 229) return;
      keepDeleteRepeatText(textarea);
    };
    const keepTextOn = textarea && keyboardNeedsText(navigator) ? ["focus", "keydown", "input"] : [];
    for (const type of keepTextOn) textarea?.addEventListener(type, keepText, true);
    if (textarea && keepTextOn.length) textarea.style.whiteSpace = "pre-wrap";
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
    attachTerminalWheel(term, wheelStateRef, {
      drag: (event) => { if (!drag) return false; dragWheel(event); return true; },
      adopted: () => adopted(),
      scroll: (lines) => lineScroll.current?.(lines),
    });
    termRef.current = term;
    setTerminal(term);
    fitRef.current = fit;

    // A grid that is not this browser's own (observing, or mirrored from a PC that cannot
    // attach) may be larger than the mount. The mount then scrolls (PaneTerminal.css) and a
    // drag pans it. Until the user pans, the view keeps the cursor's row in sight: the top of
    // the grid while the row fits there, else the bottom rows, where a prompt sits. A mirror
    // has no cursor; xterm's own rests on the last row with text, which serves the same.
    // the split's other half drawing the active half's tab follows the grid that half gives the pty
    const adopted = (): boolean => observeRef.current || fixedGridRef.current || followRef.current;
    // The soft keyboard takes the bottom of the screen, not the pane: a fit to what is left above
    // it would size the shared pty to that strip, and every other viewer of the pane, herdr's own
    // window included, would reflow twice per keyboard (#1045). While the keyboard is up, a host
    // that only lost height keeps its grid and the view pans to the cursor as an adopted grid's
    // does; the fit it held back runs once the keyboard goes (the host grows, the observer fits).
    let keyboardHeld = false;
    /** the host's width at its last fit: a width that changed (a rotation) refits under the keyboard too */
    let fittedWidth: number | null = null;
    /** a fit the keyboard held back was to re-assert the grid (force): the catch-up fit does so */
    let heldForce = false;
    let panned = false;
    const followCursor = (): void => {
      host.toggleAttribute("data-adopted-grid", adopted());
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!(adopted() || keyboardHeld) || panned || !screen) return;
      const row = screen.offsetHeight / term.rows;
      const cursorBottom = screen.offsetTop + (term.buffer.active.cursorY + 1) * row;
      const max = host.scrollHeight - host.clientHeight;
      host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
    };
    followCursorRef.current = () => { panned = false; followCursor(); };
    /** before a fit: true when the keyboard holds the grid, and the fit waits (`force`: it was to re-assert the grid) */
    const keyboardHolds = (force: boolean): boolean => {
      if (!keyboardHoldsGrid(keyboardUp(), host.clientWidth, fittedWidth)) return false;
      keyboardHeld = true;
      heldForce ||= force;
      // the pane may be at another device's grid: drawn as it is until the keyboard goes, when the
      // catch-up fit takes the pane back (as a tap or key in the grid would)
      const shared = sharedGridRef.current;
      if (shared && !adopted() && (term.cols !== shared.cols || term.rows !== shared.rows)) {
        term.resize(shared.cols, shared.rows);
        heldForce = true;
      }
      panned = false;
      followCursor();
      return true;
    };
    /** after a fit: the grid is the host's again, with nothing left to pan to */
    const fitted = (): void => {
      fittedWidth = host.clientWidth;
      keyboardHeld = false;
      heldForce = false;
      // xterm's helper textarea can sit at the old grid's cursor row for a while and keep the host
      // scrollable: a view panned under the keyboard would stay panned past the grid's top
      host.scrollTop = 0;
    };
    keyboardHoldsRef.current = keyboardHolds;
    fittedRef.current = fitted;

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
        setSelectionQuote(null);
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
    /** one row's height on screen, in CSS pixels (a selecting drag's wheel and a finger's travel) */
    const cellHeight = (): number =>
      (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? term.rows) / term.rows;
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
      const lineHeight = cellHeight();
      const { steps: lines, rest } = wheelSteps(
        d.wheelPixels + (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY), lineHeight);
      d.wheelPixels = rest;
      if (lines === 0) return;
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
      setSelectionQuote(null);
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
      // offered to the chat draft at once with what is on screen; herdr's text and rows replace it below
      if (d.pane !== "") setSelectionQuote({ pane: d.pane, text: visibleText, range: null });
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
      // herdr's text covers the whole range; the visible text in its place does not, so the quote
      // then names no line range rather than one its text does not hold
      let fromHerdr = true;
      const text = fetchPaneSelection(d.pane, range[0], range[1], machineId).catch(() => {
        if (current() && d.scrolled) noteClipboard("could not read the selection from herdr");
        fromHerdr = false;
        return visibleText;
      }).then((value) => {
        if (!current()) throw new Error("selection changed");
        // A redraw can remove the range before herdr reads it. Keep what the user
        // actually selected instead of replacing a successful copy with nothing.
        copiedText = value || visibleText;
        setSelectionQuote({ pane: d.pane, text: copiedText, range: fromHerdr && value ? { start: range[0].row, end: range[1].row } : null });
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
    // OSC 8: a hyperlink this app cannot open (OmO's `omo-panel:` rows) is not drawn as one (#739)
    const osc8 = term.parser.registerOscHandler(8, (payload) => hyperlinksRef.current.handler(payload));
    // modifyOtherKeys (CSI > 4 ; level m): xterm.js has no handler for it, so this one only
    // listens, and Ctrl+Enter is sent as the program asked (see onModifiedEnter)
    const modifyOtherKeys = (final: "m" | "n") => term.parser.registerCsiHandler({ prefix: ">", final }, (params) => {
      modifyOtherKeysRef.current = modifyOtherKeysLevel(modifyOtherKeysRef.current, final, params);
      return false;
    });
    const modifyOtherKeysSet = modifyOtherKeys("m");
    const modifyOtherKeysOff = modifyOtherKeys("n");

    // The authenticated app owns the PC connection; this mount owns only one pane's attach.
    const session = machineSessions?.get(machineId) ?? new MachineSession(machineId);
    const socket = session.socket;
    sessionRef.current = session;
    pendingScopeRef.current = session.scope;
    pendingEpochRef.current = session.epoch;
    socketRef.current = socket;
    // a socket this page was connected to before this mount (a switch back to the PC): a wait is a reconnect
    setConnectedBefore(connectedSockets.has(socket));
    let outputGeneration = 0;
    // Bumped by readiness receipts: revokes only the proof that queued output is current, never
    // the parse itself (a masked prompt must still keep typing out of every draft).
    let outputLifetime = 0;
    let outputRecovering = false;
    let deferredAttach = false;
    const off = session.on((message, sent) => {
      onServerMessageRef.current?.(message);
      pendingScopeRef.current = session.scope;
      pendingEpochRef.current = session.epoch;
      // Every pane-addressed frame, errors included, belongs only to that pane's renderer.
      if ("pane_id" in message && message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
      // the PC's shared connection came back after an overload close (another pane's mount, or an
      // explicit pick, reconnected it): its replayed attach serves this pane again
      if (message.type === "snapshot" && stalledRef.current) {
        stalledRef.current = false;
        setOutputError(null);
        setEnded(false);
        term.options.disableStdin = observeRef.current || heldRef.current;
      }
      // A provisional watch must not strand an initial/reconnected pane on an older bridge.
      // An ordinary opt-in release still keeps its existing paused fallback.
      if (message.type === "snapshot" && deferredAttach && !socket.canWatch()) resume();
      if (message.type === "pending-messages" && sent) {
        redrawGreeting();
        onChatSuggestion(message.pane_id, null);
        setChatSent((current) => current + 1);
        setChatRefresh((current) => current + 1);
      }
      // Ignore late invalidations for a detached pane or a chat no longer on screen.
      if (message.type === "conversation-changed" && message.pane_id === paneRef.current
        && chatViewRef.current && document.visibilityState !== "hidden") {
        setChatInvalidation((current) => current + 1);
      }
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
      if (message.type === "input-ready") {
        if (message.ready === false) {
          outputRecovering = true;
          outputLifetime++;
          setOutputReady(false);
          setParsedTarget(undefined);
        } else if (outputRecovering) {
          // Recovery revokes parses queued before this receipt too. The new stream, not
          // input permission (which observers never have), proves the screen is current.
          outputRecovering = false;
          outputLifetime++;
        }
      }
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current || releasedRef.current) return;
        // A chat showing herdr's scrollback has no native file to watch: output invalidates it.
        if (chatViewRef.current) chatOutputRef.current?.();
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        const acknowledge = socket.outputAcknowledgement(message);
        const owner = message.pane_id;
        const generation = outputGeneration;
        const lifetime = outputLifetime;
        const target = outputTargetRef.current;
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
          if (lifetime === outputLifetime && !outputRecovering) {
            setOutputReady(true);
            setParsedTarget(target);
          }
          followCursor();
          const lines: string[] = [];
          const buffer = term.buffer.active;
          for (let row = 0; row < buffer.length; row++) {
            const line = buffer.getLine(row);
            const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped) ?? "";
            if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
            else lines.push(text);
          }
          // A masked prompt does not close the grid: a desktop answers it there, as in any terminal,
          // and the masked input stands by for a phone (#1031). onData keeps what is typed then out
          // of every draft.
          const prompt = secretPrompt(lines.join("\n"), term.cols);
          secretRef.current = prompt;
          term.options.disableStdin = observeRef.current || heldRef.current;
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
          term.options.disableStdin = observeRef.current;
        }
      } else if (message.type === "pty-exit") {
        // an ended pane takes no input: a file dropped on it must not upload and paste either
        // held input stays: the server also says pty-exit when herdr restarts or an attach fails,
        // and the same pane comes back; only the user sends or discards it
        if (message.pane_id === paneRef.current) { setEnded(true); term.options.disableStdin = true; }
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning (a tab out of use
        // reclaims it when the user comes back: the refit below)
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        // no fit runs while observing: a font shrunk for this client's own grid would stay
        if (nowObserving) term.options.fontSize = baseFontRef.current;
        setObserving(nowObserving);
        term.options.disableStdin = nowObserving || heldRef.current;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving && !fixedGridRef.current && !chatViewRef.current && inUse() && !keyboardHolds(true)) {
          try {
            fit.fit();
            fitted();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane && sizesPty()) socket.resize(pane, term.cols, term.rows, true);
        }
        panned = false;
        followCursor();
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this,
        // unless the grid is fixed: then nobody here drives it
        if (message.pane_id !== paneRef.current) return;
        if (message.fixed) {
          fixedGridRef.current = true;
          // nor while the grid is fixed (a mirrored pane): back to the user's size
          term.options.fontSize = baseFontRef.current;
        }
        // kept while the terminal lens ignores it: another device may drive the grid, and the
        // chat lens entered later must draw its hidden screen for that grid, not this device's
        sharedGridRef.current = { cols: message.cols, rows: message.rows };
        // the chat lens adopts the shared grid too: the screen it reads (a masked prompt) is drawn for it
        if (!observeRef.current && !fixedGridRef.current && !followRef.current && !chatViewRef.current) {
          if (!keyboardHeld) return;
          // a grid held under the keyboard draws the pane's own grid (an attach made under it adopted
          // the pane's size, another device may have sized it): the catch-up fit takes the pane back
          heldForce = true;
        }
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
          setOutputReady(false);
          term.options.disableStdin = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "attach_failed") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // the server could not start herdr: nothing is coming, so say why instead of waiting
          setOutputError(t("herdr could not be started on the server, so this terminal cannot attach. Put herdr on the server's PATH or set HERDR_WEB_HERDR_BIN to its full path."));
          setEnded(true);
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
          if (message.code === "output_stalled") stalledRef.current = true;
          setOutputError(message.message);
          setEnded(true);
          setConnected(false);
          term.options.disableStdin = true;
          // a frozen page reads the close after it is shown again, often after back() ran: the
          // stop belongs to the time it was put away, so attach again now (see back())
          if (message.code === "output_stalled" && socket.stoppedWhileHidden && inUse()) {
            queueMicrotask(() => {
              if (!disposed && stalledRef.current && socket.stoppedWhileHidden && inUse()) reattachRef.current();
            });
          }
          return;
        }
        term.writeln(`\r\n\u001b[31m[herdr-web-ui] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
      setConversationPushes(socket.conversationPushes());
    });
    const offDisconnect = session.onDisconnect(() => {
      clearModifiers();
      pendingScopeRef.current = session.scope;
      pendingEpochRef.current = session.epoch;
      outputGeneration++;
      outputRecovering = false;
      setOutputReady(false);
      setInputReady(false);
      setConnected(false);
      setConversationPushes(false);
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      setHeld(false);
      // and its stream says the keyboard modes again, from the start or in the replay
      modifyOtherKeysRef.current = 0;
    });
    session.connect();

    // input readiness too: a liveness probe refuses input without a frame to say so
    const poll = window.setInterval(() => {
      setConnected(socket.connected);
      setConversationPushes(socket.conversationPushes());
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
    }, 1000);

    // onKey runs after xterm drains a pending IME commit, immediately before the
    // key's onData. Remap only that CR, preserving composition text and its order.
    // xterm.js types Shift+Enter and Ctrl+Enter as plain Enter: Shift+Enter becomes the Alt+Enter
    // newline chord, Ctrl+Enter what modifyOtherKeys makes it (Claude Code's "send now") while
    // the program has asked for that, and stays Enter otherwise. A mirrored pane never hears that
    // request, so its Ctrl+Enter goes as herdr's key, which herdr encodes as the program asked.
    let enterAs: string | null = null;
    let enterKey: string | null = null;
    const onModifiedEnter = term.onKey(({ key, domEvent: event }) => {
      enterAs = null;
      enterKey = null;
      if (term.options.disableStdin || key !== "\r" || event.key !== "Enter" || event.altKey || event.metaKey
        || event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey && !event.ctrlKey) enterAs = "\x1b\r";
      else if (event.ctrlKey && !event.shiftKey) {
        enterKey = mirroredCtrlEnterKey(fixedGridRef.current, modifyOtherKeysRef.current);
        enterAs = enterKey !== null ? "\r" : ctrlEnterSequence(modifyOtherKeysRef.current);
      }
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
      // the split half following the other half's grid of the same tab draws it only: the active
      // half's terminal answers the program's queries (a second answer would reach it as typing),
      // and a press or key here makes this half the active one before anything is typed
      if (followRef.current) return;
      const barKey = barKeyRef.current;
      barKeyRef.current = null;
      const stopKey = stopKeyRef.current;
      stopKeyRef.current = false;
      const physicalChord = typedChord;
      typedChord = null;
      // a modified Enter (Shift+Enter's newline, Ctrl+Enter's "send now") is decided on before its
      // rewrite: its sequence may carry no line break at all
      const modifiedEnter = enterAs !== null && data === "\r";
      const enterChord = modifiedEnter ? enterKey : null;
      if (modifiedEnter) data = enterAs!;
      enterAs = null;
      enterKey = null;
      if (commandBackspace && data === "\x7f") data = "\x15";
      commandBackspace = false;
      const current = paneRef.current;
      // Hiding a cached pane blurs xterm, which may commit its pending IME text.
      // That abandoned input must reach neither the old PTY nor its held draft.
      if (!current || !presentedRef.current || !shownRef.current || observeRef.current || heldRef.current) return;
      // while a masked prompt is on screen, what is typed goes to the program or nowhere: never
      // into a draft, which is kept in the clear and offered back for review
      const secret = secretRef.current !== null;
      const input = data;
      const key = keyFromData(data);
      const chord = enterChord ?? (!pasting && !composingRef.current && !compositionCommitPendingRef.current
        ? barKey !== null ? barKey.chord
          : physicalChord ?? (hasModifiers(modifiersRef.current) && key !== null ? terminalChord(key, modifiersRef.current) : null)
        : null);
      if (draftHeldForRef.current === current) {
        // A chord or a modified Enter is never held, and never sent beside held text either
        // (Ctrl+J, or Ctrl+Enter under modifyOtherKeys, would run the line).
        // A paste the draft cannot take (an unbracketed tab or control character) is refused too, never sent
        // ahead of the held start.
        const pasted = pasting || input.startsWith("\x1b[200~");
        if (chord !== null || modifiedEnter || (pasted && applyToDraft(EMPTY_DRAFT, input) === EMPTY_DRAFT)) {
          const t = tRef.current;
          setInputError(t("Not sent: send or discard the held input first."));
          return;
        }
        // Text, a paste, Backspace and anything with a line break go to the draft, which leaves
        // Enter out, so a partial command never runs. Other control keys (Ctrl+C, Escape, Tab,
        // arrows) still reach the program below: an interrupt must not wait on the draft.
        if (pasted || /[\r\n\x7f\b]/.test(input) || applyToDraft(EMPTY_DRAFT, input) !== EMPTY_DRAFT) {
          if (secret) {
            const t = tRef.current;
            setInputError(t("Not sent: send or discard the held input first."));
            return;
          }
          setDraft((prev) => applyToDraft(prev, input));
          return;
        }
      }
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
      if (socket.sendInput(current, input, stopKey && input === "\u001b")) return;
      if (secret) {
        const t = tRef.current;
        setInputError(t("Not sent: the terminal is not ready, and a password is never held for later."));
        return;
      }
      // A closed socket, an attachment still opening, or a failed synchronous send:
      // keep printable input for explicit review, never replay it automatically.
      if (draftPaneRef.current !== current) {
        draftPaneRef.current = current;
        setDraft(EMPTY_DRAFT);
      }
      setDraft((prev) => applyToDraft(prev, input));
      if (!draftIsEmpty(applyToDraft(EMPTY_DRAFT, input))) draftHeldForRef.current = current;
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
        if (paneRef.current !== pane || !activeRef.current || chatViewRef.current || !socket.connected || term.options.disableStdin) return;
        pasteText(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ");
        if (activeRef.current && !findOpenRef.current) term.focus();
      } catch (error) {
        // a file over the limit already says which file and the limit, in the UI language
        if (paneRef.current === pane) noteClipboard(error instanceof AttachmentTooLargeError ? error.message : plainError(error));
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
        if (activeRef.current) term.focus();
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
        if (chatViewRef.current || !sizesPty()) return;
        // the keyboard took the bottom of the screen, not the pane: the grid stays, the view pans
        if (keyboardHolds(false)) return;
        // a fit the keyboard held back re-asserts the grid as it would have (a lens or role return)
        const force = heldForce;
        try {
          fit.fit();
          fitted();
        } catch {
          return;
        }
        // a window the system moves or resizes in the background fits its own grid only
        const current = paneRef.current;
        if (current && inUse()) socket.resize(current, term.cols, term.rows, force);
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
    // Two fingers pinch the font size: the font follows them locally, and the shared pty resizes once when one lifts.
    let touchX = 0;
    let touchY = 0;
    /** finger travel of this gesture not yet sent as a wheel report */
    let touchPixels = 0;
    let tracking = false;
    let pinch: { first: number; second: number; startSize: number; startDistance: number; size: number } | null = null;
    // from a second finger until every finger lifts: the stroke is a pinch, never a scroll
    let pinchStroke = false;
    let pinchWatchPending = false;
    let pinchStatusFrame: number | null = null;
    const spread = (a: Touch, b: Touch): number => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const hidePinchBadge = (): void => {
      if (pinchBadgeRef.current) pinchBadgeRef.current.hidden = true;
    };
    const applyLiveFont = (size: number): void => {
      if (baseFontRef.current === size) return;
      baseFontRef.current = size;
      term.options.fontSize = size;
      if (adopted() || chatViewRef.current) return;
      // a pinch under the keyboard fits what the finger sees: the keyboard going refits the rows
      try {
        fit.fit();
        fitted();
      } catch {
        return;
      }
    };
    const finishPinch = (save: boolean): void => {
      const finished = pinch;
      if (finished && (!save || finished.size === finished.startSize)) applyLiveFont(finished.startSize);
      pinch = null;
      const current = paneRef.current;
      if (pinchWatchPending && current && releasedRef.current && watchingRef.current) socket.watch(current, term.cols, term.rows);
      pinchWatchPending = false;
      if (finished && save && finished.size !== finished.startSize) {
        // a pinch can end after the pane went behind a sibling of its split: it saves the size, sizing no pty
        if (current && inUse() && !adopted() && !chatViewRef.current && sizesPty()) socket.resize(current, term.cols, term.rows, true);
        updateSettings({ terminalFontSize: finished.size });
        // said once, for the size kept: the badge that follows the fingers is not read out
        const t = tRef.current; // the language of now, not of the attach
        if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
        if (pinchStatusRef.current) pinchStatusRef.current.textContent = "";
        pinchStatusFrame = requestAnimationFrame(() => {
          pinchStatusFrame = null;
          if (pinchStatusRef.current) pinchStatusRef.current.textContent = t("Terminal text size {px} px", { px: finished.size });
        });
      }
      hidePinchBadge();
    };
    const claimPinch = (event: Event): void => {
      event.preventDefault();
      // the host listens in the capture phase: xterm's own touch listeners on its element must not
      // scroll its viewport with the first finger of a pinch
      event.stopPropagation();
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (chatViewRef.current) return;
      if (event.touches.length === 1 && pinchStroke) {
        finishPinch(false);
        pinchStroke = false;
      }
      if (pinchStroke) {
        claimPinch(event);
        return;
      }
      if (event.touches.length >= 2) {
        if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
        pinchStatusFrame = null;
        tracking = false;
        pinchStroke = true;
        claimPinch(event);
        const a = event.touches[0];
        const b = event.touches[1];
        if (event.touches.length !== 2 || !a || !b ||
            !host.contains(a.target as Node) || !host.contains(b.target as Node) ||
            spread(a, b) <= 0) return;
        const startSize = baseFontRef.current;
        pinch = { first: a.identifier, second: b.identifier, startSize, startDistance: spread(a, b), size: startSize };
        if (pinchBadgeRef.current) {
          pinchBadgeRef.current.textContent = `${startSize}px`;
          pinchBadgeRef.current.hidden = false;
        }
        return;
      }
      tracking = event.touches.length === 1;
      touchPixels = 0;
      const first = event.touches[0];
      if (tracking && first) {
        touchX = first.clientX;
        touchY = first.clientY;
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!pinchStroke && event.touches.length > 1) {
        tracking = false;
        pinchStroke = true;
      }
      if (pinchStroke) {
        claimPinch(event);
        if (pinch && event.touches.length === 2) {
          let first: Touch | undefined;
          let second: Touch | undefined;
          for (let i = 0; i < event.touches.length; i++) {
            const touch = event.touches[i]!;
            if (touch.identifier === pinch.first) first = touch;
            if (touch.identifier === pinch.second) second = touch;
          }
          if (first && second) {
            const size = pinchFontSize(pinch.startSize, pinch.startDistance, spread(first, second));
            if (size !== pinch.size) {
              pinch.size = size;
              applyLiveFont(size);
              if (pinchBadgeRef.current) pinchBadgeRef.current.textContent = `${size}px`;
            }
          }
        }
        return;
      }
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
      // xterm sends herdr one report per wheel event however far it went, and herdr scrolls a
      // few lines per report: one line-mode wheel per that many rows of finger travel keeps a
      // swipe as far as a slow drag, and the text under the finger
      const { steps, rest } = wheelSteps(touchPixels + delta, cellHeight() * HERDR_MOUSE_SCROLL_LINES);
      touchPixels = rest;
      sendTouchWheels(steps);
    };
    /** `steps` line-mode wheel reports at the finger, each one herdr scroll step in the sign's direction */
    const sendTouchWheels = (steps: number): void => {
      if (wheelStateRef.current.omoQuestion) {
        lineScroll.current?.(-steps * HERDR_MOUSE_SCROLL_LINES);
        return;
      }
      const target = term.element ?? host;
      for (let sent = 0; sent < Math.abs(steps); sent += 1) {
        target.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true, cancelable: true, deltaY: Math.sign(steps), deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: touchX, clientY: touchY,
        }));
      }
    };
    const onTouchEnd = (event: TouchEvent): void => {
      // a lifted one-finger drag sends what is left once it reaches half a step: a flick shorter
      // than one step still scrolls, and a long drag loses at most half a step at its end
      if (tracking && event.type === "touchend" && !pinchStroke && !adopted()) {
        sendTouchWheels(finalStep(touchPixels, cellHeight() * HERDR_MOUSE_SCROLL_LINES));
      }
      touchPixels = 0;
      tracking = false;
      if (!pinchStroke) return;
      claimPinch(event);
      if (event.type === "touchcancel" || event.touches.length < 2) finishPinch(event.type === "touchend");
      if (event.touches.length === 0) pinchStroke = false;
    };
    // Safari zooms inside an overflow region (xterm's viewport) despite touch-action: none
    const onGesture = (event: Event): void => { if (!chatViewRef.current) event.preventDefault(); };
    host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    host.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    host.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: false });
    host.addEventListener("gesturestart", onGesture, { passive: false });
    host.addEventListener("gesturechange", onGesture, { passive: false });

    // The pty is shared per pane: a client on another device (typically a phone)
    // resizes it to its own geometry, and this tab's viewport never changed, so
    // the ResizeObserver above stays silent and the pane is left at the other
    // device's size. Re-assert our geometry whenever the user comes back to this
    // tab: its window takes the focus, or it turns visible with the focus. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current || fixedGridRef.current || chatViewRef.current || !sizesPty() || keyboardHolds(true)) return;
      try {
        fit.fit();
        fitted();
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
      if (submitRetention?.has(pane)) return true;
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
      if (!current || embedded || mirroredRef.current || fixedGridRef.current) return;
      if (cachedRef.current && releasedRef.current) {
        if (watchingRef.current) { socket.unwatch(current); setWatching(false); }
        // Caching stops the watch, but does not turn an away release into a cache-only release.
        return;
      }
      if (releasedRef.current || (!cachedRef.current
        && (!(releaseAwayRef.current || hiddenOnTouch()) || inUse() || endedRef.current))) return;
      if (queueWaits(current)) {
        queueHeld = true;
        return;
      }
      socket.detach(current);
      // The server's detach receipt holds pending input on this still-live PC connection.
      setReleased(true);
      cachedReleaseRef.current = cachedRef.current;
      if (!cachedRef.current) watch(current);
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
    // keep_size prevents resizing an existing attach, but a fresh sidecar still sizes the pane.
    // The client cannot distinguish those cases atomically, so both watch until the user returns.
    const deferAttach = (pane: string): boolean => {
      deferredAttach = false;
      if (inUse() || embedded || mirroredRef.current || fixedGridRef.current || queueWaits(pane) || !socket.canWatch()) return false;
      cancelLeave();
      deferredAttach = true;
      setReleased(true);
      cachedReleaseRef.current = false;
      // The local roster can arrive before /api/health identifies a mirror. Wait for that
      // identity rather than briefly starting an observer on a PC with no attach sidecar.
      if (!cachedRef.current && mirroredRef.current !== null) watch(pane);
      return true;
    };
    deferAttachRef.current = deferAttach;
    const offBeforeReplay = socket.onBeforeReplay(() => {
      const pane = paneRef.current;
      if (!pane || releasedRef.current) return;
      if (deferAttach(pane)) socket.detach(pane);
    });
    releaseRef.current = () => { if (queueHeld) release(); };
    // a window resized while watched: the view is drawn for a grid, so it starts again at the new one
    const onWatchedResize = term.onResize(({ cols, rows }) => {
      const current = paneRef.current;
      if (!current || !releasedRef.current || !watchingRef.current) return;
      if (pinch) pinchWatchPending = true;
      else socket.watch(current, cols, rows);
    });
    const resume = (): void => {
      if (!presentedRef.current) return;
      deferredAttach = false;
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
      // A new attach owns a new output lifetime. The server's readiness receipt precedes
      // replay, so a recovering attach will revoke this again before any retained bytes.
      outputRecovering = false;
      // Reset in stream order: synchronous reset would let old queued writes draw afterward.
      if (!cachedReleaseRef.current) {
        term.write("\x1bc", () => {
          if (disposed || paneRef.current !== current || generation !== outputGeneration) return;
          modifyOtherKeysRef.current = 0;
        });
        modifyOtherKeysRef.current = 0;
      }
      cachedReleaseRef.current = false;
      setInputReady(false);
      setOutputReady(false);
      if (!observeRef.current && !chatViewRef.current && shownRef.current && !keyboardHolds(true)) {
        try {
          fit.fit();
          fitted();
        } catch {
          /* not laid out yet; the ResizeObserver will follow up */
        }
      }
      const away = !inUse();
      // under the keyboard the attach adopts the pane's size (keep_size) and the catch-up fit takes it
      socket.attach(current, term.cols, term.rows, chatViewRef.current || away || !shownRef.current || followRef.current || keyboardHeld);
      if (away) leave();
    };
    // Existing attaches keep their grid while away. New connections watch instead, except
    // for queued input, mirrors, embedded pages and bridges without watch support.
    const leave = (): void => {
      if (cachedRef.current) { release(); return; }
      const current = paneRef.current;
      // A visible but unfocused window still shows the terminal and can receive its grid back.
      // Blur changes only reconnect policy; hiding the document also releases its server grid.
      if (current && !observeRef.current && !fixedGridRef.current) socket.keepSize(current, document.visibilityState === "hidden");
      if (releaseAwayRef.current && releaseTimer === null && !releasedRef.current) releaseTimer = window.setTimeout(() => {
        if (paneRef.current === current) release();
      }, RELEASE_AFTER_MS);
      // already put away on a phone (a pane that replaced a closed one while away): let go now
      if (hiddenOnTouch()) release();
    };
    leaveRef.current = leave;
    // The PC's connection stopped on an overload close (4008), or an attach conflicted: attach again
    // in place, as a pane pick does. The attach reconnects, and the connection's open replays every
    // pane this PC has attached; their snapshot clears what is left of the notice.
    const reattach = (): void => {
      if (!presentedRef.current || !paneRef.current) return;
      stalledRef.current = false;
      setOutputError(null);
      setEnded(false);
      resume();
      term.options.disableStdin = observeRef.current || heldRef.current;
    };
    reattachRef.current = reattach;
    const back = (): void => {
      if (!presentedRef.current) return;
      cancelLeave();
      // A pane that kept its attach while put away (a queued message, a mirror) stopped because its
      // frozen page sent no ACKs, not because this device is too slow: coming back attaches again,
      // once. A stop while the page stays in use is final (no reconnect loop).
      if (stalledRef.current && socket.stoppedWhileHidden && inUse()) reattach();
      else if (releasedRef.current) resume();
      else refit();
    };
    presentationRef.current = () => {
      if (cachedRef.current) release();
      else if (presentedRef.current && releasedRef.current) {
        if (inUse() || mirroredRef.current) back();
        else if ((cachedReleaseRef.current || deferredAttach && !watchingRef.current) && paneRef.current) {
          if (!deferAttach(paneRef.current)) back();
        }
        else if (paneRef.current && !watchingRef.current) watch(paneRef.current);
      }
    };
    // A phone or tablet put away lets go of the pane at once, whatever the setting: its page can
    // freeze before a timer runs, and its attach would keep herdr's own window at the phone's size.
    const hiddenOnTouch = (): boolean => coarseRef.current && document.visibilityState === "hidden";
    const onVisibility = (): void => {
      if (inUse()) back();
      else {
        leave();
        if (hiddenOnTouch()) release();
      }
    };
    // Another device can size the pty while this window keeps its focus (a phone used beside a
    // PC left in front): no focus event comes back here, so a click or key in this terminal
    // takes the pane back to this window's grid.
    // Only input meant for the terminal itself: a press or key in the find bar or the key bar,
    // a right-click for the pane menu, a held key's repeats or an IME composition
    // must not resize the pty under the other device.
    // A phone's own input paths sit outside the grid (the input line, its Send and Enter, a key the
    // key bar sends, not a press on it), so they call this before they send: the reply is then
    // drawn for the grid that shows it.
    const reassertIfStale = (): void => {
      const shared = sharedGridRef.current;
      if (!shared || releasedRef.current || !inUse()) return;
      if (shared.cols !== term.cols || shared.rows !== term.rows) refit();
    };
    reassertIfStaleRef.current = reassertIfStale;
    const reclaim = (event: Event): void => {
      if (!(event.target instanceof Node) || !term.element?.contains(event.target)) return;
      // an IME's first key comes before compositionstart, with isComposing still false (keyCode 229)
      if (event instanceof KeyboardEvent && (event.repeat || event.isComposing || event.keyCode === 229 || composingRef.current || compositionCommitPendingRef.current)) return;
      if (event instanceof PointerEvent && event.button !== 0) return;
      if (releasedRef.current) back();
      else reassertIfStale();
    };
    // a click or a tap is the user here, whatever the window says about its focus
    const onPointer = (event: PointerEvent): void => {
      if (releasedRef.current && stackRef.current?.contains(event.target as Node)) back();
      else reclaim(event);
    };
    window.addEventListener("focus", back);
    window.addEventListener("blur", leave);
    window.addEventListener("pointerdown", onPointer, { capture: true });
    window.addEventListener("keydown", reclaim, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      term.options.disableStdin = true;
      pendingScopeRef.current = null;
      window.clearInterval(poll);
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      host.removeEventListener("touchstart", onTouchStart, { capture: true });
      host.removeEventListener("touchmove", onTouchMove, { capture: true });
      host.removeEventListener("touchend", onTouchEnd, { capture: true });
      host.removeEventListener("touchcancel", onTouchEnd, { capture: true });
      host.removeEventListener("gesturestart", onGesture);
      host.removeEventListener("gesturechange", onGesture);
      finishPinch(false);
      if (pinchStatusFrame !== null) cancelAnimationFrame(pinchStatusFrame);
      host.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("copy", onCopy);
      stopEdge();
      selectionChange.dispose();
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      releaseRef.current = () => {};
      presentationRef.current = () => {};
      leaveRef.current = () => {};
      cancelLeaveRef.current = () => {};
      reattachRef.current = () => {};
      keyboardHoldsRef.current = () => false;
      fittedRef.current = () => {};
      deferAttachRef.current = () => false;
      offBeforeReplay();
      onWatchedResize.dispose();
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", leave);
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      window.removeEventListener("keydown", reclaim, { capture: true });
      reassertIfStaleRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      onModifiedEnter.dispose();
      onCommandBackspace.dispose();
      for (const type of keepTextOn) textarea?.removeEventListener(type, keepText, true);
      host.removeEventListener("keydown", onCommandArrow);
      onData.dispose();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("paste", onFilePaste, { capture: true });
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      offDisconnect();
      osc52.dispose();
      osc8.dispose();
      modifyOtherKeysSet.dispose();
      modifyOtherKeysOff.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      if (!machineSessions) session.close();
      stopGlyphs();
      host.removeEventListener("compositionstart", compositionStart);
      host.removeEventListener("compositionend", compositionEnd);
      if (compositionEndTimer !== null) window.clearTimeout(compositionEndTimer);
      compositionCommitPendingRef.current = false;
      // A replacement mount must not share its host with the retiring terminal.
      term.element?.remove();
      disposeAfterPendingFrame(term);
      termRef.current = null;
      setTerminal((current) => current === term ? null : current);
      socketRef.current = null;
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // the theme follows the settings without a remount
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme, palette);
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
      baseFontRef.current = terminalFontSize;
      if (term.options.fontSize === terminalFontSize && term.options.fontFamily === fontFamily) return;
      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = fontFamily;
      if (observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(true)) return;
      try {
        fitRef.current?.fit();
        fittedRef.current();
      } catch {
        return;
      }
      // a chosen font loads after every attach: out of use (a reload behind another app), only
      // this grid fits, and the refit takes the pane once the user is here
      const pane = paneRef.current;
      if (pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    if (fontFamily === TERMINAL_FONT_STACK) apply();
    else void loadFontStack(fontFamily, terminalFontSize).then(apply);
    return () => { superseded = true; };
  }, [terminalFontSize, fontFamily]);

  // the setting, a zoom or the last sibling closing need not resize the host: the observer may stay silent
  useEffect(() => {
    if (narrowFontFitted.current === narrowFont) return;
    narrowFontFitted.current = narrowFont;
    const term = termRef.current;
    if (!term || observeRef.current || fixedGridRef.current || chatViewRef.current || keyboardHoldsRef.current(false)) return;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows);
  }, [narrowFont]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView) {
      const pane = paneRef.current;
      // a grid this tab drove goes back to a terminal still showing on another device (#472)
      if (pane) socketRef.current?.releaseSize(pane);
      // the grid another device left the pty at while this one showed the terminal
      const shared = sharedGridRef.current;
      const hidden = termRef.current;
      if (shared && hidden && !observeRef.current && (hidden.cols !== shared.cols || hidden.rows !== shared.rows)) hidden.resize(shared.cols, shared.rows);
      return;
    }
    if (observeRef.current || fixedGridRef.current) return;
    // the composer's keyboard may still be up as the terminal lens appears: its grid waits for it to go
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    // this runs on every load too, right after the attach: out of use (a reload behind another
    // app), only this grid fits, and the refit takes the pane once the user is here
    const pane = paneRef.current;
    if (pane && term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (activeRef.current && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) term?.focus();
  }, [chatView]);

  // hidden behind another pane of its split, the pane keeps the size the pty has; shown again, it
  // fits this screen and takes the pty, as a lens switch back to the terminal does
  const wasShown = useRef(shown);
  useEffect(() => {
    if (wasShown.current === shown) return;
    wasShown.current = shown;
    const pane = paneRef.current;
    if (!pane || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
    if (!shown) { socketRef.current?.keepSize(pane); return; }
    if (keyboardHoldsRef.current(true)) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (term && sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [shown]);

  // the split's other half took this tab's grid: this half lets the pty go and draws it at that grid;
  // made the active half, it fits its own screen and takes the pty, as a pane shown again does
  const wasFollowing = useRef(follow);
  useEffect(() => {
    if (wasFollowing.current === follow) return;
    wasFollowing.current = follow;
    const pane = paneRef.current;
    const term = termRef.current;
    if (!pane || !term || observeRef.current || fixedGridRef.current) return;
    if (follow) {
      socketRef.current?.keepSize(pane);
      const shared = sharedGridRef.current;
      if (shared && (term.cols !== shared.cols || term.rows !== shared.rows)) term.resize(shared.cols, shared.rows);
      followCursorRef.current();
      return;
    }
    followCursorRef.current();
    if (chatViewRef.current || keyboardHoldsRef.current(true)) return;
    try {
      fitRef.current?.fit();
      fittedRef.current();
    } catch {
      return;
    }
    if (sizesPty() && inUse()) socketRef.current?.resize(pane, term.cols, term.rows, true);
  }, [follow]);

  // Reset on a pane or terminal replacement: a herdr restart can keep the pane ID.
  // Old composition timers must never see the new terminal.
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
    stalledRef.current = false;
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
    hyperlinksRef.current.reset();
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
      // Keep connection proof until the server confirms the detach as held.
    };
    // A fresh background pane must not acquire size ownership even with the release setting off.
    // This also covers a replacement pane: no prior release or input ownership is inherited.
    setReleased(false);
    // A restored terminal in a cached tab waits until that tab is presented again.
    if (cachedRef.current) {
      setReleased(true);
      return leavePane;
    }
    if (deferAttachRef.current(paneId)) return leavePane;
    // under the keyboard (a pane picked while typing) the fit waits for it to go, and the attach adopts
    // the pane's size meanwhile
    const held = keyboardHoldsRef.current(true);
    if (!held) {
      try {
        fit?.fit();
        fittedRef.current();
      } catch {
        /* not laid out yet; the ResizeObserver will follow up */
      }
    }
    // A pane exempt from watching still asks to keep an existing attachment's size while away.
    const away = !inUse();
    socket.attach(paneId, term.cols, term.rows, chatViewRef.current || away || !shownRef.current || followRef.current || held);
    // no blur or hidden comes for a tab already out of use: it lets go of this pane after a moment too
    if (away) leaveRef.current();
    // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
    // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
    if (activeRef.current && !chatViewRef.current && !autoSelected && !coarseRef.current && !modalOpen() && !findOpenRef.current) term.focus();
    return leavePane;
  }, [paneId, terminalId]);

  // the message the tab kept its pane for has gone (or was held): out of use, it lets go now
  useEffect(() => { releaseRef.current(); }, [pending]);
  useEffect(() => { presentationRef.current(); }, [cached, presented, mirrored]);


  // A sibling already mounted in the split canvas becomes the keyboard target only on an
  // explicit navigation. Clicking inside it leaves focus on the actual clicked control.
  useEffect(() => {
    if (active && !autoSelected && !chatViewRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
  }, [active, autoSelected]);

  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (activeRef.current && wasAuto && !autoSelected && !chatViewRef.current && !coarseRef.current && !modalOpen() && !findOpenRef.current) termRef.current?.focus();
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
    reassertIfStaleRef.current();
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
  const submitComposerMessage = useCallback((text: string, delivery: SubmitDelivery = "immediate", clearDraft?: string, sendAnyway = false, resendId?: string, generation?: number): Promise<SubmitResult> | null => {
    const term = termRef.current;
    const socket = socketRef.current;
    const session = sessionRef.current;
    const pane = paneRef.current;
    if (!term || !socket || !session || pane === null || secretRef.current !== null || heldRef.current) return null;
    // its Enter would run the pty's line without the start a held draft keeps
    if (draftHeldForRef.current === pane) return Promise.resolve({ ok: false, code: "held_input", message: "send or discard the held input first" });
    // not the scope itself: a message sent right after a reconnect leaves before the snapshot that names it
    const epoch = session.epoch;
    const sent = socket.submit(pane, composerMessage(text), composerPayload(text, term.modes.bracketedPasteMode), false, delivery, clearDraft, sendAnyway, resendId, generation);
    if (sent === null) return null;
    const releaseSubmit = submitRetention?.retain(pane);
    const submission = delivery !== "immediate" ? { pane, socket, epoch } : null;
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
        session.acceptPending(pane, result.pending, epoch);
      } else {
        if (paneRef.current === pane) {
          if (delivery !== "immediate") setChatSent((current) => current + 1);
          setChatRefresh((current) => current + 1);
        }
      }
      return result;
    }, (error: unknown) => {
      // the send broke with no answer: it may have been typed, and it is no longer on its way
      rememberGreeting(owner, afterSettled(delivery === "immediate" ? greetingMemory(owner) : afterSend(greetingMemory(owner)), true, history)); redrawGreeting();
      throw error;
    }).finally(() => {
      if (submission) pendingSubmissionsRef.current.delete(submission);
      releaseSubmit?.();
      if (paneRef.current === pane && socketRef.current === socket && pendingEpochRef.current === epoch) releaseRef.current();
    });
  }, [onChatSuggestion, machineId, submitRetention]);

  const sendComposerText = useCallback((text: string, delivery: "queue" | "immediate" = "immediate"): false | Promise<true | string> => {
    const result = submitComposerMessage(text, delivery);
    return result === null ? false : result.then((answer) => answer.ok ? true : submitNote(answer.code, answer.message, agent));
  }, [submitComposerMessage, agent]);

  // the terminal's input line: the text typed like the keyboard would, into an agent's open
  // menu too, then Enter after the server's gap; several lines go as one paste
  const sendTerminalLine = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    // its text and Enter would land beside the held draft: Send or Discard that first
    if (draftHeldForRef.current === pane) return Promise.resolve(tRef.current("Not sent: send or discard the held input first."));
    const message = composerMessage(text);
    const payload = message.includes("\n") ? composerPayload(text, term.modes.bracketedPasteMode) : message;
    reassertIfStaleRef.current();
    const sent = socket.submit(pane, message, payload, true);
    if (sent === null) return false;
    const releaseSubmit = submitRetention?.retain(pane);
    term.scrollToBottom();
    return sent.then((result) => (result.ok ? true : submitNote(result.code, result.message))).finally(() => {
      releaseSubmit?.();
      if (paneRef.current === pane && socketRef.current === socket) releaseRef.current();
    });
  }, [submitRetention]);

  // a tap into the input line is the user here: the grid is theirs again before they type
  const reassertGrid = useCallback(() => { reassertIfStaleRef.current(); }, []);

  const pressEnter = useCallback((): boolean | string => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || pane === null || !socket.connected) return false;
    // Enter beside a held draft would run the pty's line without the held start
    if (draftHeldForRef.current === pane) return tRef.current("Not sent: send or discard the held input first.");
    reassertIfStaleRef.current();
    const sent = hasModifiers(modifiersRef.current)
      ? socket.sendKeys(pane, [terminalChord("Enter", modifiersRef.current)!]) : socket.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current || lineComposingRef.current) return;
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
      // only the selected pane: a focused sibling would take the selection (PaneCanvas onFocusCapture)
      if (activeRef.current && coarse && !chatView && turnedOn) termRef.current?.focus();
    }
  }, [inputLine, coarse, chatView, directTyping, paneId]);

  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  // Hermes' Stop is one Ctrl+C per turn (hermesStop.ts): a second one would quit it
  const hermesStopSentRef = useRef(false);
  // when this pane last sent Hermes a Ctrl+C: status flicker or a quick new turn resets the
  // guard above, so a second Ctrl+C inside Hermes' 2 s force-quit window is refused by time
  const hermesCtrlCAtRef = useRef<number | null>(null);
  // a turn waiting on an approval (blocked) is still the same turn
  useEffect(() => { if (agentStatus !== "working" && agentStatus !== "blocked") hermesStopSentRef.current = false; }, [agentStatus]);
  useEffect(() => { hermesStopSentRef.current = false; hermesCtrlCAtRef.current = null; }, [paneId, agent]);
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    const now = Date.now();
    const key = stopKey(agent, () => {
      const buffer = term.buffer.active;
      return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }, hermesStopSentRef.current, hermesCtrlCAtRef.current, now);
    if (key === null) {
      const t = tRef.current;
      if (hermesStopSentRef.current) return;
      setInputError(hermesCtrlCTooSoon(hermesCtrlCAtRef.current, now)
        ? t("Not stopped: Hermes got Ctrl+C under 2 seconds ago, and a second one would quit it. Try again in a moment.")
        : t("Not stopped: Hermes does not show a turn to interrupt. Check the terminal."));
      return;
    }
    if (key === "\u0003") {
      hermesStopSentRef.current = true;
      hermesCtrlCAtRef.current = now;
    }
    stopKeyRef.current = true;
    try { term.input(key); } finally { stopKeyRef.current = false; }
  }, [agent]);

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

  // Under the chat lens, while the input card shows, the pills the terminal lens floats top-right
  // (another app holds the pane, the output stream failed, input held for the terminal, a copy
  // note) stand over the card instead, as rows of the composer's with a dismiss each. Without the
  // card (view only, ended, a secret prompt) they stay pills. The ids carry the pane, so another
  // pane's dismissals never carry over; a dismissal goes with its notice, or when the notice says
  // something else (lib/composerNotices.ts)
  const noticesDocked = presented && paneId !== null && chatView && !secretActive && !observing && !ended;
  const noticeItems: ComposerNoticeRow[] = [];
  if (paneId !== null) {
    const owner = paneStorageId(machineId, paneId);
    const takeOver = !observing && socketRef.current?.canTakeOver() === true;
    if (held) noticeItems.push({
      id: `${owner}:held`, priority: "urgent", revision: takeOver ? "open-here" : "", warning: true, mark: <Unplug />,
      text: t("Another app has this pane open. It connects here as soon as that app lets go."),
      actions: takeOver && <button type="button" className="composer-notice-action" title={t("Take this pane from another web app or terminal attach. That connection will close.")} onClick={() => { socketRef.current?.takeOver(paneId); }}>{t("Open here")}</button>,
    });
    if (outputError) noticeItems.push({
      id: `${owner}:output`, priority: "urgent", revision: outputError, warning: true, mark: <TriangleAlert />, text: outputError,
      actions: <a className="composer-notice-action" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>{t("Reconnect")}</a>,
    });
    if (!ended && connected && !draftIsEmpty(draft)) noticeItems.push({
      id: `${owner}:draft`, priority: "activity", revision: `${draft.truncated ? "…" : ""}${draft.text}`, warning: false, mark: <Clock />,
      // on screen the row is its parts, the held text and its two controls, as the terminal lens's
      // held-input row; the words are for the live region
      text: <>
        <span className="visually-hidden">{t("Input held:")}</span>
        {draft.text.length > 0 && <code title={draft.text}>{draft.text}</code>}
        {draft.truncated && <> {t("Some input was too long to hold and was left out.")}</>}
      </>,
      actions: <>
        {/* the composer's send glyph (an up arrow) on the row's plain icon button, beside its Discard */}
        <button type="button" className="icon-button" aria-label={t("Send held input")} title={t("Send held input")} disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}><ArrowUp aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("Discard held input")} title={t("Discard held input")} onClick={discardDraft}><Trash2 aria-hidden="true" /></button>
      </>,
    });
    if (clipboardNote) noticeItems.push({ id: `${owner}:clipboard`, priority: "notice", revision: clipboardNote, warning: false, mark: <ClipboardCheck />, text: clipboardNote });
  }
  const settledNotices = settleDismissed(dismissedNotices, noticeItems);
  if (settledNotices !== dismissedNotices) setDismissedNotices(settledNotices);
  const shownNotices = noticesDocked ? arrangeNotices(noticeItems, settledNotices) : [];
  const composerNotices = shownNotices.length > 0
    ? <ComposerNotices notices={shownNotices} onDismiss={(notice) => { setDismissedNotices((dismissed) => dismissNotice(dismissed, notice)); }} />
    : null;

  const composerSend = useCallback(
    (text: string, clearDraft?: string, sendAnyway = false): boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal> => {
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
            if (cause instanceof ApiError && cause.code === "reply_unconfirmed") return t("OpenCode did not confirm the answer. Check the question before sending again.");
            return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : plainError(cause);
          },
        );
      }
      if (!socketRef.current?.connected || heldRef.current || secretRef.current !== null) return false;
      // an older bridge is told apart by the socket, once this connection's snapshot has said what it supports.
      // A draft is cleared only by a send at once: one that waits its turn is checked when it goes
      // with automatic sending off, a follow-up waits for Send now; the socket queues it on a PC too old to hold one
      const queued = composerDelivery(agent, agentStatus);
      const delivery: SubmitDelivery = queued === "queue" && !settings.autoSendQueued ? "hold" : queued;
      // Send anyway answered a box seen at once: an agent that started working since would queue it unchecked
      if (sendAnyway && delivery !== "immediate") return t("Not sent: the agent started working since. Check the terminal, then send again.");
      const result = submitComposerMessage(text, delivery, delivery === "immediate" ? clearDraft : undefined, sendAnyway);
      return result === null ? false : result.then((answer) => answer.ok ? true : submitRefusal(answer.code, answer.message, answer.draft, answer.box, agent));
    },
    [agent, agentStatus, answerPanePrompt, answering, heldByOpenQueue, submitComposerMessage, queueStore, machineId, settings.autoSendQueued],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard"): Promise<void> => {
    const perform = async (): Promise<void> => {
      const owner = queueOwner, pane = paneId;
      const socket = socketRef.current, scope = pendingScopeRef.current;
      if (owner === null || pane === null || paneRef.current !== pane) return;
      // what another tab saved since: a copy it is sending again is not confirmed here either
      pendingMessages.refresh(owner);
      const message = pendingMessages.read(owner).find((item) => item.id === id);
      if (!message || message.state === "sending") return;
      if (action === "steer" && (message.state === "uncertain" || !socket?.connected || heldRef.current || secretRef.current !== null || observeRef.current || ended || heldByOpenQueue || answering !== null)) return;
      if (message.serverOwned && !pendingMessages.isOwned(owner, id, scope)) return;
      // keys held back in the terminal draft would run in front of the message: the server pastes a
      // server-owned row's text and sends Enter without looking for a partial line (only Claude's box
      // is checked there). The row stays as it is, so Send now after the draft is settled, or Discard, still works.
      if (action === "steer" && draftHeldForRef.current === pane) {
        pendingMessages.fail(owner, id, { code: "held_input", message: "send or discard the held input first" }, false);
        return;
      }
      if (!pendingMessages.begin(owner, id)) return;
      try {
        if (message.serverOwned) {
          const result = socket?.pendingAction(pane, id, action, message.resendGeneration ?? 0);
          // offline: no frame left (the row shows submitNote's wording, not this message)
          if (!result) {
            pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, pendingActionUncertain("not_transmitted", message.state));
            return;
          }
          // as a composer send: the pane keeps its connection and lease until the receipt settles
          const releaseSubmit = submitRetention?.retain(pane);
          const answer = await result.finally(() => releaseSubmit?.());
          if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, pendingActionUncertain(answer.code, message.state),
            action === "steer" ? message.resendGeneration ?? 0 : undefined);
          // Only the matching server removal receipt removes an authoritative item.
        } else if (action === "discard") {
          pendingMessages.removeCopy(owner, id);
        } else if (message.state === "held") {
          if (!pendingMessages.unconfirm(owner, id)) {
            return;
          }
          const result = submitComposerMessage(message.text, "immediate", undefined, false, id, message.resendGeneration ?? 0);
          if (!result) {
            pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, false);
            return;
          }
          const answer = await result;
          if (answer.ok) pendingMessages.removeCopy(owner, id);
          else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code), message.resendGeneration ?? 0);
        }
      } catch {
        pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
      } finally { pendingMessages.end(owner, id); }
    };
    // Web Locks reduce contention where supported; the bridge's stable resend ID is the
    // authority on LAN HTTP and when two tabs have already read the same held copy.
    if (navigator.locks) await navigator.locks.request(`pending:${queueOwner}:${id}`, perform);
    else await perform();
  }, [answering, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage, submitRetention]);


  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: File) => uploadPaneImage(paneId ?? "", file), [paneId]);

  useEffect(() => {
    if (!active || !paneId) return;
    const onPage = (event: KeyboardEvent) => {
      const direction = plainPageDirection(event);
      if (direction === null || event.defaultPrevented || !activeRef.current || !presentedRef.current || !chatViewRef.current || modalOpen()
          || isAppShortcut(event, shortcutSettings.current) || pageScroll.current === null) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable=true]") && !target.matches(".composer-text")) return;
      event.preventDefault();
      event.stopPropagation();
      pageScroll.current(direction);
    };
    window.addEventListener("keydown", onPage, true);
    return () => window.removeEventListener("keydown", onPage, true);
  }, [active, paneId]);

  const sendApplicationPage = useCallback((direction: -1 | 1) => {
    const pane = paneRef.current, socket = socketRef.current;
    if (!pane || !socket?.connected || !activeRef.current || !presentedRef.current || chatViewRef.current || modalOpen()
        || observeRef.current || heldRef.current || endedRef.current || releasedRef.current || secretRef.current !== null
        || composingRef.current || compositionCommitPendingRef.current) return;
    // An explicit page action follows the program's own history when herdr has none.
    // The live input lease refuses an unready pane and never queues this key for later.
    socket.sendInput(pane, direction < 0 ? "\x1b[5~" : "\x1b[6~");
  }, []);

  useLayoutEffect(() => {
    if (!controls || !active || !paneId) return;
    const current: PaneControls = {
      focusInput: () => {
        if (!activeRef.current || !presentedRef.current || modalOpen() || observeRef.current) return;
        const stack = stackRef.current;
        const secret = stack?.querySelector<HTMLInputElement>(".secret-input input");
        if (secret) { secret.focus({ preventScroll: true }); return; }
        const input = stack?.querySelector<HTMLTextAreaElement>(chatViewRef.current ? ".composer-text" : ".terminal-input-text");
        if (input) input.focus({ preventScroll: true });
        else if (!chatViewRef.current && !heldRef.current && !endedRef.current) termRef.current?.focus();
      },
      scrollPage: (direction) => {
        if (activeRef.current && presentedRef.current && !modalOpen()) pageScroll.current?.(direction);
      },
    };
    controls.current = current;
    return () => { if (controls.current === current) controls.current = null; };
  }, [controls, active, paneId]);

  const secretInput = presented && paneId !== null && secretActive && !observing && !ended && connected && outputReady ? <SecretInput
    key={`${paneId}:${secret.prompt}`} prompt={secret.prompt} active={active}
    onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value) ?? null}
    onCancel={() => { if (socketRef.current?.connected) socketRef.current.sendInput(paneId, "\u0003"); }}
  /> : null;
  // the input line's row, kept while the masked input stands in for it
  const lineSlot = presented && paneId !== null && !observing && !ended && inputLine;
  // What floats from the slot may reach up to the grid's top and no further (TerminalInput.css):
  // in a short pane (a split, a phone in landscape with its keyboard up) a grown line or the masked
  // input would otherwise cover the find bar, or be clipped under the pane's frame
  const [inputSlot, setInputSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const surface = stackRef.current?.querySelector(".terminal-surface");
    if (!stackRef.current || !surface || !inputSlot) return;
    const measure = () => {
      const slot = inputSlot.getBoundingClientRect();
      // the chat lens's box-less slot has no rect, and nothing floats there to cap
      if (slot.width === 0) return;
      const room = slot.bottom - surface.getBoundingClientRect().top;
      inputSlot.style.setProperty("--terminal-input-room", `${Math.max(0, Math.floor(room))}px`);
    };
    measure();
    // the surface moves with the find bar and resizes with the stack and the key bar under it
    const observer = new ResizeObserver(measure);
    observer.observe(stackRef.current);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [inputSlot]);

  // the wait for input is a live region in the banner column from the stack's first render, clipped while
  // empty (never display: none); its words land a frame after it (lib/useAnnouncedText.ts). Only a
  // selected pane waits: with none there is no terminal whose input could become ready
  const waitingWords = useAnnouncedText(paneId !== null && !chatView && !observing && connected && !inputReady && !held && !ended && !released ? t("Waiting for terminal input…") : null);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    <div ref={stackRef} className={`terminal-stack${chatView ? " is-chat" : ""}${greeted ? " is-greeted" : ""}`} data-pane-owner={paneId === null ? undefined : paneStorageId(machineId, paneId)} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}
      data-pane-content={!chatView && paneId !== null && active && presented && shown && connected && outputReady && parsedTarget === outputTarget && !held && !ended && !released && !unsupported && !outputError ? presentationKey : undefined}>
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
        {paneId !== null && held && !noticesDocked && (
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
        {paneId !== null && outputError && !noticesDocked && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <button type="button" className="btn" onClick={() => reattachRef.current()}>{t("Reconnect")}</button>
          </div>
        )}
        {!chatView && inputError && <div className="terminal-banner" role="status">{inputError}<button type="button" className="btn terminal-banner-action" onClick={() => setInputError(null)}>{t("Dismiss")}</button></div>}
        <div className={waitingWords === null ? "visually-hidden" : "terminal-banner"} role="status">{waitingWords}</div>
        {paneId !== null && !chatView && released && <div className="terminal-banner" role="status">{t(watching ? "View only while you use another window · click to type" : "Paused while you use another window")}</div>}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            {t("Terminal ended")}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            {t(connectedBefore ? "Reconnecting to herdr web ui…" : "Connecting to herdr web ui…")}
            {/* one line, cut with an ellipsis: a command is never broken inside a word; the title holds it whole */}
            {draft.text.length > 0 && <span className="draft-held" title={draft.text}> {t("Input held:")} <code>“{draft.text}”</code></span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && !noticesDocked && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            {/* on screen the row is its parts, the command and its two controls; the words are for the live region */}
            <span className="visually-hidden">{t("Input held:")}</span>
            {draft.text.length > 0 && <code className="draft-text" title={draft.text}>{draft.text}</code>}
            <span className="draft-actions">
              <button type="button" className="icon-button draft-send" aria-label={t("Send held input")} title={t("Send held input")} disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                <SendHorizontal aria-hidden="true" />
              </button>
              <button type="button" className="icon-button draft-discard" aria-label={t("Discard held input")} title={t("Discard held input")} onClick={discardDraft}>
                <Trash2 aria-hidden="true" />
              </button>
            </span>
            {/* said only when it applies, on a line under the row. The preview shows the start of the
                text: without this, a draft that lost its end looks whole */}
            {draft.truncated && <span className="draft-truncated">{t("Some input could not be held and was left out.")}</span>}
            {/* Enter is never held: without this, two commands look like one line and a paste looks whole */}
            {draft.leftOut && <span className="draft-truncated">{t("An Enter or line break was left out: Send never presses Enter.")}</span>}
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            <Eye aria-hidden="true" />
            {t("View only")}
          </div>
        )}
        {paneId !== null && !chatView && selectionQuote?.pane === paneId && (
          <button type="button" className="terminal-banner terminal-banner-action terminal-quote"
            onMouseDown={(event) => { event.preventDefault(); }}
            onClick={() => {
              const block = formatTerminalQuote({ label: title?.trim() || paneId, range: selectionQuote.range, text: selectionQuote.text });
              if (block === null) return;
              const key = `herdr-web-ui:composer-draft:${paneStorageId(machineId, paneId)}`;
              const next = appendQuote(composerDrafts.read(key).text, block, MAX_COMPOSER_CHARS);
              if (next === null) { noteClipboard(t("Too long for the message draft")); return; }
              composerDrafts.set(key, next);
              termRef.current?.clearSelection();
              noteClipboard(t("Added to the message draft"));
            }}>
            <Quote aria-hidden="true" />{t("Quote in message")}
          </button>
        )}
        {clipboardNote && !noticesDocked && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      {presented && findOpen && !chatView && paneId !== null && (
        <FindBar key={paneId} paneId={paneId} viewportIntent={viewportIntent} onResult={setSearchState} activePane={active} focusRequest={findRequest} disabled={!connected || held || ended || released || !outputReady}
          onClose={() => { setFindOpen(false); if (activeRef.current && !coarse) termRef.current?.focus(); }} />
      )}
      <div className="terminal-surface">
        {/* xterm hides its rendered rows from assistive technology, so the region around the
            visible grid carries the pane's name: a screen reader announces which pane
            this is. No tabIndex: xterm's helper textarea takes the keyboard here on attach, so a
            stop on the wrapper would only be an empty one ahead of it. */}
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} role={chatView ? undefined : "region"} aria-roledescription={chatView ? undefined : t("Terminal")} aria-label={chatView ? undefined : terminalName} />
        <span className="terminal-font-size" ref={pinchBadgeRef} hidden aria-hidden="true" />
        <span className="visually-hidden" ref={pinchStatusRef} aria-live="polite" />
        {paneId !== null && <TerminalViewportTools key={paneId} viewportIntent={viewportIntent} terminal={terminal} paneId={paneId}
          pageScroll={chatView ? undefined : pageScroll}
          lineScroll={chatView ? undefined : lineScroll}
          onApplicationPage={sendApplicationPage}
          enabled={presented && connected && outputReady && !chatView && !held && !ended && !released && !unsupported}
          interactive={!observing && !secretActive && !viewportSearching} search={searchState} onError={setInputError} />}
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
            presentationKey={presentationKey}
            finishEpoch={finishEpoch}
            finishId={finishId}
            key={paneId}
            paneId={paneId}
            active={active}
            visible={presented && shown}
            pageScroll={pageScroll}
            refreshKey={chatRefresh}
            invalidationKey={chatInvalidation}
            onConversationWatch={onConversationWatch}
            conversationPushes={conversationPushes && !released}
            onTerminalOutput={onTerminalOutput}
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
            onRestored={onChatRestored}
            promptRefreshKey={promptRefresh}
            pendingAnswer={pendingAnswer !== null && pendingAnswer.pane === paneId ? pendingAnswer : null}
            onPendingAnswerDone={clearPendingAnswer}
            promptDock={promptDock}
            onPromptAnswered={onPromptAnswered}
            title={title}
          />
          </RenderBoundary>
        )}
      </div>
      {/* the queue is the composer's, so it shows under the chat lens only: there alone is an open
          Codex question known (heldByOpenQueue), and Send now must not type into one */}
      {presented && paneId !== null && chatView && !observing && !ended && queueOwner !== null && queued.length > 0 && (
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
              spellCheck autoCapitalize="sentences" autoCorrect="on"
              onChange={(event) => { queueStore.edit(queueOwner, message.id, event.target.value); }}
            />
            <div className="composer-queue-actions">
              <button type="button" className="composer-queue-send"
                disabled={!connected || held || secretActive || queueSending !== null || queued.some((item) => queueStore.isSending(item.id)) || heldByOpenQueue || message.text.trim().length === 0}
                title={heldByOpenQueue ? t("Codex has a question open in the terminal: answer it above first") : undefined}
                onClick={() => {
                  if (sendingRef.current || !queueStore.beginSend(queueOwner, message.id)) return;
                  sendingRef.current = true;
                  const owner = queueOwner;
                  setQueueSending(message.id); setQueueError(null); heldRowNotes.delete(owner);
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
      {presented && paneId !== null && chatView && !observing && queueOwner !== null && pending.length > 0 && <PendingMessages
        key={`pending-${queueOwner}`}
        active={active}
        messages={pending.map((message) => !message.serverOwned || pendingMessages.isOwned(queueOwner, message.id, pendingScopeRef.current)
          ? message : { ...message, serverOwned: false, state: "uncertain" as const })}
        connected={connected}
        agent={agent}
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
      {presented && paneId !== null && chatView && <div className="prompt-dock" ref={setPromptDock} aria-live="polite" />}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
      {presented && paneId !== null && chatView && !secretActive && !observing && !ended && (
        <Composer
          key={paneId}
          paneId={paneId}
          cwd={cwd}
          branch={branchWord === DETACHED ? t("Detached HEAD") : branchWord}
          worktreeRepo={worktreeRepo}
          autoFocus={active && !autoSelected && !coarse}
          active={active}
          agent={agent}
          agentStatus={agentStatus}
          backgroundTasks={backgroundTasks}
          plan={plan}
          backgroundWait={backgroundWait}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected && !held}
          connectedBefore={connectedBefore}
          answerHint={answering === null ? null
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          // no suggestion under any card, a fallback or queued one included
          suggestion={chatPrompt?.pane !== paneId && chatSuggestion?.pane === paneId ? chatSuggestion.value : null}
          restored={chatPrompt?.pane !== paneId && chatRestored?.pane === paneId ? chatRestored.value : null}
          notices={composerNotices}
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
      {/* In the terminal lens the input line and the masked input float over the grid's last rows
          from a slot that keeps one row's height in flow: a line that grows while it is typed, a
          note under it or the masked input taking its place would otherwise take rows from the
          grid, and each change of its height resizes the shared pty. The masked input sits in this
          slot in the chat lens too (a box-less slot there, TerminalInput.css), so switching lenses
          keeps it mounted: a remount would drop what was typed and a send still on its way */}
      {((!chatView && lineSlot) || secretInput) && <div ref={setInputSlot} className={`terminal-input-slot${!chatView && lineSlot ? "" : " is-empty"}`}>
        {secretInput ?? (!chatView && lineSlot && !secretActive && <TerminalInput key={paneId} active={active} owner={paneStorageId(machineId, paneId)} onComposing={setLineComposing} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} onFocus={reassertGrid} />)}
      </div>}
      {presented && paneId !== null && !secretActive && !observing && !chatView && <KeyBar disabled={composing || !connected || !inputReady || held || ended} onKey={pressKey}
        holdScope={`${paneStorageId(machineId, paneId)}:${view}`}
        modifiers={modifiers} onToggleModifier={toggleModifier} items={settings.keyBarItems}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect, directDisabled: lineComposing } : {})} />}
    </div>
  );
}
