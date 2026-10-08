import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import type { ServerWebSocket } from "bun";

import type { AgentKind, AgentStatus, ClientMessage, ClientRole, HealthAuth, HerdrPane, PendingMessage, ReadFormat, ReadSource, ServerFeature, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { paneTitle } from "../shared/notify-policy.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { DEVICE_COOKIE, authClient, handleAuthRequest, isAuthenticated, parseCookies, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { cameThroughProxy, decideAccess, isLoopbackAddress, isServeOwnerRequest } from "./access.ts";
import { DeviceStore, handleDeviceRequest } from "./devices.ts";
import { remoteAccess, TailnetIdentitySource } from "./tailscale.ts";
import { paneCommands } from "./commands.ts";
import { paneFiles } from "./files.ts";
import { badRequest, errorResponse, isCount, isJsonObject, jsonResponse } from "./http.ts";
import { serveStatic } from "./static.ts";
import { startStatusCollector } from "./collector.ts";
import { conversationImage, ConversationUnavailable, forgetPaneTranscriptState, HistoryChanged, paneConversation, paneRunsOmo, toolOutput } from "./conversation.ts";
import { omoPanes } from "./omo.ts";
import { OMO_ALIASES, OmoStatus, processAlive } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import { CompletionTracker } from "./completion.ts";
import { freeAgentName } from "./agent-name.ts";
import { SHELL_AGENTS, isShellAgentKind, shellAgentExecutable, startShellAgent } from "./shell-agent.ts";
import { listDirectories } from "./directories.ts";
import { fileResponse, locateFile } from "./file-view.ts";
import {
  agentManifests,
  agentPrompt,
  agentStart,
  HerdrError,
  herdrSocketPath,
  paneClose,
  paneRead,
  paneScroll,
  paneScrollInfo,
  paneSelectionRead,
  paneRename,
  paneSendKeys,
  paneSendText,
  ping,
  sessionSnapshot,
  tabClose,
  tabCreate,
  tabRename,
  workspaceClose,
  workspaceCreate,
  workspaceMove,
  workspaceRename,
  worktreeCreate,
  worktreeList,
  worktreeOpen,
  worktreeRemove,
} from "./herdr/client.ts";
import { type AlertTiming, createPushService, defaultStateDir, handlePushRequest } from "./push.ts";
import { codexQuestionsCollapsed, handlePromptRequest, heldCandidate, modelListWaits, noteSubmitted, parseInteractivePrompt, promptWaitEnded } from "./prompt.ts";
import { secretPrompt, validSecret } from "../shared/secret-prompt.ts";
import { PasteImageError, savePaneImage } from "./paste.ts";
import { PtySession } from "./pty/session.ts";
import { AttachOutputTail, isTakeoverExit } from "./attach-output.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";
import { MirrorSession } from "./mirror.ts";
import { mirrorInput } from "./mirror-input.ts";
import { PendingInputs, PendingInputError, type PendingIdentity, type PendingRecord } from "./pending-input.ts";
import { PendingRequestBook } from "./pending-requests.ts";
import { OutputWindow, OUTPUT_HIGH_BYTES, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS, ReplayBuffer } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import { connectUpdater, handleUpdateRequest, type UpdateService } from "./update-api.ts";
import { handleHerdrUpdateRequest, HerdrUpdater } from "./herdr-update.ts";
import { handleTelemetryRequest, Telemetry } from "./telemetry.ts";
import { handleUsageRequest, UsageService } from "./usage.ts";
import { handleVoiceRequest, VoiceService } from "./voice.ts";

import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity, registerBridge } from "./bridge.ts";
import { MachineManager } from "./machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineRelay } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";

const MAX_REPLAY_BYTES = 256 * 1024;
/**
 * herdr's refusal of an attach while a read of the same terminal is in progress; it asks
 * for a retry. A read of more lines than an idle alt-screen agent (Codex) shows, like the
 * transcript match's 400, makes herdr scroll the agent's history back with wheel events:
 * up to 15 s, and 5 more to restore it (herdr 0.9, src/server/alt_screen_read.rs). A
 * 400-line read of an idle Codex pane took about a second, refusing every attach meanwhile.
 */
const ATTACH_READ_RACE_RE = /has a read in progress; retry/;
/**
 * herdr's refusal when another client holds the terminal's one attach slot. It is the attach's
 * last line, after its teardown: the same words earlier in the pane's own output are not it.
 */
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/;
/** how long refused attaches are retried: herdr's longest read of that kind */
const ATTACH_RETRY_FOR_MS = 20_000;
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRY_MAX_MS = 500;
/** a refused attach says so within milliseconds of its first bytes: those are held this long */
const ATTACH_HOLD_MS = 100;
/**
 * What `herdr terminal attach` writes itself before herdr has answered: terminal modes set and
 * reset only (mouse reporting off, the alternate screen on; the last one maybe cut short). The
 * answer can come any time after them, later than the hold on a busy PC, so they say nothing
 * about whether the attach took and do not start the hold. A refusal and a screen both begin
 * with something else.
 */
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[\?[\d;]+[hl])*(?:\x1b(?:\[(?:\?[\d;]*)?)?)?$/;
/** how often a terminal another web bridge holds is tried again, while clients here still want it */
const ATTACH_HELD_RETRY_MS = 3_000;
/**
 * herdr refusing an attach, its line (maybe not all of it yet) the last output, before the
 * exit has come. The same words earlier in the pane's own output, with more after them, are not it.
 */
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/;
/** how long a refusal's exit is waited for before its output is taken for the pane's own */
const ATTACH_REFUSAL_EXIT_MS = 2_000;
const ATTACH_HELD_MESSAGE = "Another web bridge has this pane open. It connects here as soon as that bridge lets go.";
/**
 * How long a pane whose attach herdr ended is looked up again before its terminal is taken for
 * ended. A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane
 * to a new server under a new terminal id and cuts each attach with "server shut down", the
 * words a pane that exited gets too. Measured on herdr 0.9.3: the socket answers
 * server_unavailable for ~200 ms, then the pane is back under its new terminal; an exited
 * pane is gone from the snapshot within ~30 ms.
 */
const ATTACH_RELOOKUP_FOR_MS = 5_000;
const ATTACH_RELOOKUP_MS = 100;
/** what a pane lookup answers for a pane that has no terminal to attach any more */
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);
/** The gap between a composer message's text and its Enter (see submitText). */
export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
const TYPED_SETTLE_MS = 300;
/**
 * Nothing of a composer message is typed once this long has passed since it reached the
 * server (it can wait behind a stalled one in the pane's queue): it answers submit_timeout
 * instead. A send that starts in time ends within two more 10s RPCs, before the client
 * stops waiting (SUBMIT_TIMEOUT_MS in src/lib/ws.ts), so a message it gave up on never
 * reaches the pane later.
 */
export const SUBMIT_DEADLINE_MS = 45_000;
const SERVER_FEATURES: ServerFeature[] = ["submit", "pending-input", "secret-input", "input-ready", "take-over"];

/** Bind addresses only this machine can reach, so an unset token is nobody else's business. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
/** pane.read's own enums; a read outside them is refused here rather than sent to herdr as a guess (the generated types are open-ended) */
const READ_SOURCES = new Set<ReadSource>(["detection", "recent", "recent_unwrapped", "visible"]);
const READ_FORMATS = new Set<ReadFormat>(["ansi", "text"]);

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "Oh My Pi",
  omo: "OmO",
  gjc: "Gajae Code",
  pi: "pi",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  kimi: "Kimi",
  amp: "Amp",
};

function expandedDirectory(value: string): string | null {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  try {
    return statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

async function paneContext(paneId: string): Promise<{ agent: string | null; cwd: string }> {
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };
}

type AgentPayload = { kind?: unknown; name?: unknown; args?: unknown };

/** What is wrong with a request's `agent`, in the API's words; null when it can be started. */
function agentFault(agent: AgentPayload | undefined): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0) return "agent.kind is required";
  if ((agent.name !== undefined && typeof agent.name !== "string")
    || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")))) {
    return "agent.name must be a string and agent.args must be an array of strings";
  }
  return null;
}

/**
 * Starts a checked `agent` in a pane herdr just made. A failure is answered, not thrown: the
 * workspace, tab or worktree around the pane is there either way.
 */
async function agentLaunch(paneId: string, agent: AgentPayload): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  try {
    const kind = agent.kind as string;
    const args = agent.args as string[] | undefined;
    if (isShellAgentKind(kind)) await startShellAgent(kind, paneId, args);
    else {
      const given = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
      // herdr refuses a name another agent holds. Two creations at once can pick the same
      // free one: the refused one picks again. It also refuses a pane whose shell is not up
      // yet (`agent_pane_busy`, herdr 0.9.3), which a pane made a moment ago can be.
      const shellDeadline = Date.now() + 10_000;
      for (let attempt = 1; ; ) {
        try {
          await agentStart({
            name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((running) => running.name)),
            kind,
            paneId,
            ...(args === undefined ? {} : { args }),
            timeoutMs: 60_000,
          });
          break;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
            await Bun.sleep(100);
            continue;
          }
          if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
          attempt += 1;
        }
      }
    }
    return { agent_started: true };
  } catch (error) {
    return {
      agent_started: false,
      error: {
        code: error instanceof HerdrError ? error.code : "agent_start_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

interface SocketData {
  deviceId?: string;
  readOnly?: boolean;
  revoked?: boolean;
  unwatchDevice?: () => void;
  relay?: MachineRelay;
  /** A fresh claim per attach lifetime; deleting it invalidates queued terminal keys. */
  attached: Map<string, object>;
  output: Map<string, OutputWindow>;
  closing: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
}

type Client = ServerWebSocket<SocketData>;

/**
 * One live PTY per pane, shared by every client watching that pane.
 *
 * The terminal is a real `herdr terminal attach` on a PTY rather than repeated
 * `pane.read` snapshots, so the browser receives an actual byte stream: xterm.js
 * keeps screen state and selection, while herdr owns scrollback.
 */
interface PaneAttachment {
  ready: boolean;
  pty: PtySession | MirrorSession;
  /** set when herdr cannot attach here: `pty` repaints the pane's screen (server/mirror.ts), on the pane's own grid */
  mirror?: MirrorSession;
  clients: Set<Client>;
  /** the pty's current grid: interact clients set it, observe clients adopt it */
  cols: number;
  rows: number;
  /** bounded tail so a client joining late still sees the current screen */
  replay: ReplayBuffer;
  stalled: Map<Client, number>;
  /** another web bridge holds herdr's one attach slot for this terminal: waiting for it to let go */
  held?: boolean;
  /** the next held or read-race retry; takeover and close both cancel it */
  retry?: ReturnType<typeof setTimeout>;
  /** a held terminal's next try takes the slot from the other bridge for this client (`take-over`); a pty attachment only */
  takeOver?: (client: Client) => void;
  /** the next look for the terminal a pane lives on after herdr ended its attach; a closed attachment cancels it */
  relookup?: ReturnType<typeof setTimeout>;
}

function send(client: Client, message: ServerMessage): number {
  if (client.data.closing) return 0;
  try {
    const encoded = JSON.stringify(message);
    // Include JSON escaping in the transport budget, before Bun could drop a
    // frame at its own cap. An overload close is explicit and never auto-replayed.
    if (client.getBufferedAmount() + Buffer.byteLength(encoded) > OUTPUT_HARD_BYTES) {
      client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    // -1 means ALREADY queued. Never retry that frame, or terminal bytes repeat.
    const result = client.send(encoded);
    if (result === 0) client.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    return result;
  } catch {
    /* client vanished mid-send */
    return 0;
  }
}

export function createServer(
  options: {
    port?: number;
    hostname?: string;
    token?: string;
    /** where VAPID keys and push subscriptions persist; tests pass a temp dir */
    stateDir?: string;
    /** the PC's own Tailscale login, for the identity check; tests set it, otherwise `tailscale status` says */
    tailscaleOwner?: string | null;
    /** the operator declares `tailscale serve` as this install's only ingress; HERDR_WEB_TAILSCALE_SERVE_ONLY=1 says the same */
    tailscaleServeOnly?: boolean;
    /** the tailnet identity behind the access check; unset, the tailscale CLI says. Tests pass one with their own status reader. */
    tailnet?: TailnetIdentitySource;
    /** Native Codex store; defaults to CODEX_HOME. Tests use an isolated store. */
    codexHome?: string;
    updates?: UpdateService;
    /** updates herdr itself (server/herdr-update.ts); unset, the app offers no herdr update. Tests pass one that runs a stand-in herdr. */
    herdrUpdate?: HerdrUpdater;
    /** anonymous install and update counts (server/telemetry.ts); unset, the server sends none and answers 404. Only the real entrypoint passes one. */
    telemetry?: Telemetry;
    /** plan limits of the AI subscriptions signed in here; tests pass one without real sign-ins */
    usage?: UsageService;
    /** voice input's key, provider and models; tests pass one with their own env and fetch */
    voice?: VoiceService;
    machines?: boolean;
    registerBridge?: boolean;
    /** SUBMIT_DEADLINE_MS; tests shorten it */
    submitDeadlineMs?: number;
    /** SUBMIT_DELAY_MS; a test lengthens it to hold a second message behind the first */
    submitDelayMs?: number;
    /** How long a queued send waits for a confirmed new turn to start; tests shorten it. */
    pendingStartTimeoutMs?: number;
    /** how long a push alert waits for the pane to change first (server/push.ts); tests send at once */
    alertTiming?: Partial<AlertTiming>;
    /** accept plain-http loopback push endpoints (server/push.ts); only tests delivering to push.fake.ts set it */
    pushLoopbackHttp?: boolean;
    /** ATTACH_RETRY_FOR_MS; tests shorten it */
    attachRetryForMs?: number;
    /** ATTACH_HELD_RETRY_MS; tests shorten it */
    attachHeldRetryMs?: number;
    /** ATTACH_RELOOKUP_FOR_MS; tests shorten it */
    attachRelookupForMs?: number;
    /** ATTACH_HOLD_MS; a test lengthens it so an attach's exit always comes before its hold ends */
    attachHoldMs?: number;
    /** whether herdr can `terminal attach`; unset, its ping says, and this runtime's PTY sidecar has to be runnable. Tests give a Windows herdr's answer, at once or as late as a ping's. */
    terminalAttach?: boolean | (() => Promise<boolean>);
    /** whether this runtime can run the PTY sidecar; unset, server/pty/sidecar.ts says. Tests give a runtime without Node or node-pty, while herdr keeps its own answer. */
    sidecar?: boolean;
  } = {},
): { port: number; hostname: string; stop: () => void } {
  const attachments = new Map<string, PaneAttachment>();
  /** whether this bridge can `terminal attach`: herdr is asked once, and the PTY sidecar has to be runnable here (server/pty/sidecar.ts) */
  /** whether the sidecar can run, settled as the server starts so that attach, /api/health and /api/bridge tell one answer; a forced answer (tests) stands in for it */
  const sidecar = options.sidecar ?? (options.terminalAttach === undefined ? sidecarAvailable() : options.terminalAttach !== false);
  let terminalAttachKnown: boolean | null = typeof options.terminalAttach === "boolean" ? options.terminalAttach : null;
  const terminalAttach = async (): Promise<boolean> => {
    if (terminalAttachKnown === null) {
      terminalAttachKnown = typeof options.terminalAttach === "function" ? await options.terminalAttach() : attachableIdentity(await ping(), sidecar).terminal_attach !== false;
    }
    return terminalAttachKnown;
  };
  const retryFor = options.attachRetryForMs ?? ATTACH_RETRY_FOR_MS;
  const heldRetry = options.attachHeldRetryMs ?? ATTACH_HELD_RETRY_MS;
  const relookupFor = options.attachRelookupForMs ?? ATTACH_RELOOKUP_FOR_MS;
  const holdFor = options.attachHoldMs ?? ATTACH_HOLD_MS;
  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();
  const clients = new Set<Client>();
  type PendingLease = { attachment: PaneAttachment; pty: PtySession | MirrorSession; authority: object };
  const pendingAuthorities = new WeakMap<Client, Map<string, object>>();
  type PendingItem = PendingRecord<Client, PendingLease>;
  const pending = new PendingInputs<Client, PendingLease>((owner, paneId, messages, removed) => {
    send(owner, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
  }, Date.now, options.pendingStartTimeoutMs);
  const pendingDrains = new Set<string>();
  type SubmitReply = { ok: boolean; pending?: PendingMessage; code?: string; message?: string };
  const pendingRequests = new WeakMap<Client, PendingRequestBook<SubmitReply>>();
  /** each pane's input while a composer message is in flight, one step after another */
  const paneQueues = new Map<string, Promise<unknown>>();
  /** when each pane last got keystrokes through its attach pty */
  const lastTyped = new Map<string, number>();
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["HERDR_WEB_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  const devices = new DeviceStore(options.stateDir ?? defaultStateDir());
  const usage = options.usage ?? new UsageService();
  const voice = options.voice ?? new VoiceService({ stateDir: options.stateDir ?? defaultStateDir(), env: process.env, fetch });
  /** a login named here is taken as it is: a tagged node has none of its own to read (HERDR_WEB_TAILSCALE_OWNER) */
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["HERDR_WEB_TAILSCALE_OWNER"]?.trim() || undefined;
  const tailnet = options.tailnet ?? new TailnetIdentitySource();
  const identityOf = async (grantPath: boolean, host: string | null) => {
    if (namedOwner !== undefined) return { ...(grantPath ? await tailnet.freshIdentity(host) : { soleLogin: null, dnsName: null, tailnetIp: null }), owner: namedOwner, tagged: false };
    return grantPath ? tailnet.freshIdentity(host) : tailnet.identity();
  };
  identityOf(false, null);
  const serveOnly = options.tailscaleServeOnly ?? process.env["HERDR_WEB_TAILSCALE_SERVE_ONLY"] === "1";

  /**
   * Runs `task` after everything queued for the pane. While a composer message is in
   * flight, the pane's other input (keystrokes, keys, prompt answers) waits behind it:
   * a Stop tapped right after Send must not land between the text and its Enter.
   */
  function serialize<T>(paneId: string, task: () => T | Promise<T>): Promise<T> {
    const run = (paneQueues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(task);
    paneQueues.set(paneId, run);
    run.catch(() => {}).finally(() => { if (paneQueues.get(paneId) === run) paneQueues.delete(paneId); });
    return run;
  }

  /**
   * Types a composer message and submits it, with its own Enter after the text: arriving
   * in the same chunk as the paste, a TUI still busy with it (turning an image path into
   * an attachment, redrawing after the phone keyboard closed) could take it for a newline
   * and leave the message unsent in its input box. Done here rather than in the browser,
   * the gap survives a jittery connection and the Enter still goes when the phone locks.
   *
   * An agent gets it through herdr's agent.prompt (the paste, then Enter 300ms later),
   * which refuses while the agent waits for an answer: the message is not typed into its
   * menu. A pane without an agent in front gets `payload`, shaped for its own paste mode,
   * through send_text, then Enter SUBMIT_DELAY_MS later; both return once the pane has
   * the bytes, so the pane sees the whole gap. So does a Codex "blocked" only by questions
   * waiting collapsed in its queue: its main prompt still takes the message.
   */
  async function submitText(paneId: string, text: string, payload: string, arrivedAt: number, fromTerminal = false, authorize: () => void = () => {}): Promise<void> {
    const inTime = (): void => {
      authorize();
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) {
        throw new HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
      }
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // the terminal's input line stands in for the keyboard: it types what the user wrote, an
    // answer into an open menu included, where agent.prompt would refuse
    if (!fromTerminal) try {
      await agentPrompt(paneId, text);
      noteSubmitted(paneId, text);
      return;
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      const queuedOnly = error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
      if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
    }
    inTime();
    // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
    // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
    // asked only for such a block, so a one-line message never waits on it.
    const shaped = await mirrorInput(payload, async () => await terminalAttach() ? null : (await paneContext(paneId)).agent);
    inTime();
    await paneSendText(paneId, shaped);
    await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
    authorize();
    await paneSendKeys(paneId, ["Enter"]);
    noteSubmitted(paneId, text);
  }

  function authorizeSocket(client: Client): void {
    if (client.data.revoked) throw new HerdrError("device_revoked", "this device's access was revoked");
    if (client.data.readOnly || client.data.mode === "observe") throw new HerdrError("read_only", "this connection can only watch");
  }

  /** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
  async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if ((pane?.agent ?? pane?.agent_session?.agent) !== "codex") return false;
    // A collapsed queue in scrollback must not bypass an approval on the live screen.
    return codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text);
  }

  const pendingIdentity = (pane: HerdrPane): PendingIdentity => ({
    agent: pane.agent ?? pane.agent_session?.agent ?? null, terminalId: pane.terminal_id,
    session: pane.agent_session ? `${pane.agent_session.kind}:${pane.agent_session.source}:${pane.agent_session.value}` : null,
  });
  const pendingText = (text: string): string => {
    const normalized = text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
    if (!normalized.trim() || normalized.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
      throw new HerdrError("invalid_submit_text", "A pending chat message must be nonempty text, at most 20000 characters, without terminal control characters");
    }
    return normalized;
  };
  function pendingLease(owner: Client, paneId: string): PendingLease {
    const attachment = attachments.get(paneId);
    if (!attachment) throw new HerdrError("input_not_ready", "The pane is not attached and ready");
    let authorities = pendingAuthorities.get(owner);
    if (!authorities) { authorities = new Map(); pendingAuthorities.set(owner, authorities); }
    let authority = authorities.get(paneId);
    if (!authority) { authority = {}; authorities.set(paneId, authority); }
    const lease = { attachment, pty: attachment.pty, authority };
    authorizePending(owner, paneId, lease);
    return lease;
  }
  // Losing authority cancels already-running checks too. Rejoining the same shared
  // attachment or returning to interact must never revive a captured lease.
  function holdPending(owner: Client, paneId?: string): void {
    if (paneId === undefined) pendingAuthorities.delete(owner);
    else pendingAuthorities.get(owner)?.delete(paneId);
    pending.hold(owner, paneId);
  }
  function holdPendingPane(paneId: string, fault: { code: string; message: string }): void {
    for (const owner of clients) pendingAuthorities.get(owner)?.delete(paneId);
    pending.holdPane(paneId, fault);
  }
  function authorizePending(owner: Client, paneId: string, lease: PendingLease): void {
    authorizeSocket(owner);
    if (!clients.has(owner) || owner.data.closing) throw new HerdrError("disconnected", "The pending message's connection closed");
    if (pendingAuthorities.get(owner)?.get(paneId) !== lease.authority) throw new HerdrError("pending_lease_lost", "The pending message's authority changed; review it before sending again");
    const attachment = attachments.get(paneId);
    if (attachment?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
    if (attachment !== lease.attachment || attachment.pty !== lease.pty || !owner.data.attached.has(paneId)
      || !attachment.clients.has(owner) || !attachment.ready) throw new HerdrError("input_not_ready", "The pending message's pane connection changed");
  }
  async function pendingContext(owner: Client, paneId: string, lease: PendingLease, identity?: PendingIdentity): Promise<{ pane: HerdrPane; identity: PendingIdentity; working: boolean }> {
    authorizePending(owner, paneId, lease);
    // The same normalized snapshot the client sees includes a known Codex finish that
    // herdr reports as unknown. Nothing is inferred from a bare unknown state.
    const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const current = pendingIdentity(pane);
    if (identity && (identity.agent !== current.agent || identity.terminalId !== current.terminalId || identity.session !== current.session)) {
      throw new HerdrError("pending_target_changed", "The pane's terminal or agent session changed; review the message before sending it again");
    }
    // the live screen, not the viewport: a pane scrolled into its history still draws its next
    // menu or password prompt at the bottom (server/prompt.ts liveScreen)
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, lease.attachment.cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    const collapsed = current.agent === "codex" && codexQuestionsCollapsed(screen);
    // a message Claude Code holds for its invisible characters is a card to answer first, also once its hint has gone
    const held = current.agent === "claude" ? heldCandidate(paneId) : null;
    if (current.agent && (parseInteractivePrompt(current.agent, screen, null, true, [], held) !== null || modelListWaits(current.agent, screen) || (pane.agent_status === "blocked" && !collapsed))) {
      throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
    }
    if (current.agent && !["working", "idle", "done"].includes(pane.agent_status) && !collapsed) {
      throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
    }
    authorizePending(owner, paneId, lease);
    return { pane, identity: current, working: current.agent !== null && (pane.agent_status === "working" || collapsed) };
  }
  const pendingFault = (error: unknown) => ({
    code: error instanceof HerdrError || error instanceof PendingInputError ? error.code : "submit_failed",
    message: error instanceof Error ? error.message : String(error),
  });
  async function dispatchPendingText(owner: Client, paneId: string, text: string, lease: PendingLease, identity: PendingIdentity,
    automatic: boolean, arrivedAt: number, committing: (working: boolean) => void = () => {}): Promise<SubmitReply> {
    let wrote = false;
    // what the checks below read is older than a status event that arrives while they run
    let mark = pending.mark(paneId);
    try {
      const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
      if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
      mark = pending.mark(paneId);
      const context = await pendingContext(owner, paneId, lease, identity);
      if (automatic && context.working) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      authorizePending(owner, paneId, lease);
      // Pending input is a guarded literal paste + Enter, never Codex's native Tab queue.
      // Keep the final key here so a disconnect, pane switch or new menu can cancel it.
      wrote = true;
      await paneSendText(paneId, `\u001b[200~${text}\u001b[201~`);
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      const beforeEnter = await pendingContext(owner, paneId, lease, identity);
      if (automatic && beforeEnter.working) throw new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed");
      authorizePending(owner, paneId, lease);
      committing(!automatic && beforeEnter.working);
      await paneSendKeys(paneId, ["Enter"]);
      // after the checks above: they would take this very message, pasted, for a held one
      noteSubmitted(paneId, text);
      return { ok: true };
    } catch (error) {
      const fault = wrote ? { code: "submit_changed", message: "Pending-message delivery could not be confirmed. Check the terminal before sending again." } : pendingFault(error);
      if (automatic && !wrote && fault.code === "agent_blocked") pending.observe(paneId, "blocked", mark);
      return { ok: false, ...fault };
    }
  }
  async function dispatchPending(item: PendingItem, automatic: boolean, arrivedAt: number): Promise<SubmitReply> {
    const reply = await dispatchPendingText(item.owner, item.paneId, item.message.text, item.lease, item.identity,
      automatic, arrivedAt, (working) => pending.committing(item, working));
    pending.settle(item, reply.ok ? undefined : { code: reply.code!, message: reply.message! }, reply.code === "submit_changed",
      automatic && ["pending_wait", "agent_blocked"].includes(reply.code ?? ""));
    return reply;
  }
  function drainPending(paneId: string): void {
    if (pendingDrains.has(paneId) || pending.next(paneId) === null) return;
    pendingDrains.add(paneId);
    const arrivedAt = Date.now();
    void serialize(paneId, async () => {
      const item = pending.next(paneId);
      if (item && pending.claim(item, true)) await dispatchPending(item, true, arrivedAt);
    }).catch((error) => console.warn("pending message:", pendingFault(error).code)).finally(() => {
      pendingDrains.delete(paneId);
      drainPending(paneId);
    });
  }
  function replayPendingOutcome(owner: Client, paneId: string, id: string): boolean {
    const outcome = pending.outcome(owner, paneId, id);
    if (!outcome) return false;
    send(owner, { type: "pending-messages", pane_id: paneId, messages: pending.list(owner, paneId), removed: [{ id, outcome }] });
    return true;
  }

  function stopSlowClient(client: Client): void {
    if (client.data.closing) return;
    client.data.closing = true;
    pending.close(client);
    clients.delete(client);
    for (const paneId of client.data.attached.keys()) detach(paneId, client);
    client.data.attached.clear();
    client.data.output.clear();
    client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output consumer stalled");
  }

  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment?.pty) return;
    let paused = false;
    for (const client of attachment.clients) {
      const window = client.data.output.get(paneId);
      const buffered = client.getBufferedAmount();
      const blocked = window?.blocked || buffered >= OUTPUT_HIGH_BYTES;
      if (!blocked) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) {
        stopSlowClient(client);
      } else {
        paused = true;
      }
    }
    if (attachments.get(paneId) !== attachment) return;
    if (paused) attachment.pty.pause();
    else attachment.pty.resume();
  }

  function sendOutput(client: Client, paneId: string, data: string): void {
    const window = client.data.output.get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || client.getBufferedAmount() >= OUTPUT_HARD_BYTES) {
      stopSlowClient(client);
      return;
    }
    send(client, {
      type: "pty-data", pane_id: paneId, data,
      ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes) } } : {}),
    });
  }
  const push = createPushService({
    stateDir: options.stateDir ?? defaultStateDir(),
    timing: options.alertTiming,
    loopbackHttp: options.pushLoopbackHttp === true,
    canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)),
    lookupTitle: async (paneId) => {
      const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      return pane ? paneTitle(pane) : undefined;
    },
  });

  /** `done` for agents herdr loses track of (server/completion.ts), kept across restarts */
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"));
  /** OmO panes get their status from OmO's session files: herdr reports none for them (server/omo-status.ts) */
  const omo = new OmoStatus({
    discover: (panes) => omoPanes(panes),
    snapshot: sessionSnapshot,
    onChange: (paneId, derived, background, turn) => omoChanged(paneId, derived, background, turn),
    // herdr called it `claude` or `pi` until now: what it finished under that name is its own
    onFound: (paneId) => completions.adopt(paneId, "omo", OMO_ALIASES),
  });
  /** herdr's snapshot with OmO's own status in it: what the completion tracker and web push are given */
  const rawSnapshot = async (): Promise<SessionSnapshot> => {
    const snapshot = await sessionSnapshot();
    await omo.refresh(snapshot.panes);
    return omo.apply(snapshot);
  };
  /** the snapshot clients get: finishes settled, OmO panes named, their running background tasks counted */
  const clientSnapshot = async (): Promise<SessionSnapshot> => {
    const snapshot = await completions.readSnapshot(rawSnapshot);
    if (!snapshot.panes.some((pane) => omo.backgroundOf(pane.pane_id) > 0)) return snapshot;
    return { ...snapshot, panes: snapshot.panes.map((pane) => omo.backgroundOf(pane.pane_id) > 0 ? { ...pane, background_tasks: omo.backgroundOf(pane.pane_id) } : pane) };
  };
  const machines = options.machines === false ? null : new MachineManager(options.stateDir ?? defaultStateDir(), push, completions, clientSnapshot);
  const bridgeToken = randomBytes(32).toString("hex");

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  function broadcastAll(message: ServerMessage): void {
    machines?.localMessage(message);
    for (const client of clients) send(client, message);
  }

  async function terminalInfoFor(paneId: string, timeoutMs?: number): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    // herdr (0.9.3+) could not restore it after a restart: its terminal has no process
    // and an attach would only die with "not found". The client shows the reason instead.
    if (pane.restore_error) throw new HerdrError("pane_not_restored", pane.restore_error);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    return { terminalId, rect: rect ? { width: rect.width, height: rect.height } : null };
  }

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const member of attachment.clients) holdPending(member, paneId);
    attachments.delete(paneId);
    clearTimeout(attachment.retry);
    clearTimeout(attachment.relookup);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) member.data.output.delete(paneId);
    const retired = attachment.pty.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.pty.kill();
  }

  /** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
  function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
      return null;
    }
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
    return { cols, rows };
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    // a mirrored pane's grid is herdr's own: no browser resizes it
    if (!attachment || attachment.mirror || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.pty.resize(cols, rows);
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  async function spawnAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    await retiringAttachments.get(paneId);
    const mirrored = !(await terminalAttach());
    const { terminalId, rect } = await terminalInfoFor(paneId);
    // an observer-first attachment spawns at the pane's own grid (fallback 80x24 when
    // the layout has no rect for it): the attach must not seed the shared pty with a
    // watching phone's viewport
    const spawnCols = forObserver || mirrored ? (rect?.width ?? 80) : cols;
    const spawnRows = forObserver || mirrored ? (rect?.height ?? 24) : rows;
    const attachment: PaneAttachment = {
      ready: mirrored,
      pty: undefined as unknown as PtySession,
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
      stalled: new Map(),
    };
    attachments.set(paneId, attachment);

    if (mirrored) {
      const mirror = new MirrorSession({
        cols: spawnCols,
        rows: spawnRows,
        size: async () => {
          const now = (await terminalInfoFor(paneId)).rect;
          return now ? { cols: now.width, rows: now.height } : null;
        },
        // the grid follows herdr's layout: the clients adopt the new size before the screen
        onResize: (cols, rows) => {
          if (attachments.get(paneId) !== attachment) return;
          attachment.cols = cols;
          attachment.rows = rows;
          broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows, fixed: true });
        },
        read: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
        write: (data) => paneSendText(paneId, data),
        onData: (frame) => {
          if (attachments.get(paneId) !== attachment) return;
          for (const client of attachment.clients) sendOutput(client, paneId, frame);
          reconcileOutput(paneId);
        },
        onExit: (code) => {
          if (attachments.get(paneId) !== attachment) return;
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        },
      });
      attachment.pty = mirror;
      attachment.mirror = mirror;
      return attachment;
    }

    // No --takeover unless asked: another web bridge may own the exclusive attach slot.
    // Report that conflict without displacing it or the user's own TUI; a client here may
    // still take it on purpose (`take-over`), and the other bridge then waits in turn.
    // herdr also refuses an attach while a read of the same terminal is in progress ("has a
    // read in progress; retry"), and this server reads panes all the time (prompt polls,
    // transcript matches): an attach that races one, typically a phone reconnecting just as
    // Codex finished an answer, is started again for the same clients, for as long as such
    // a read can last, instead of ending their terminal.
    const forward = (data: string): void => {
      if (attachments.get(paneId) !== attachment) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) sendOutput(client, paneId, data);
      reconcileOutput(paneId);
    };
    let retries = 0;
    let refusedSince: number | null = null;
    /** who asked the next start to take the slot; asked for while a try was still running, the one after it */
    let takeover: Client | null = null;
    let takeoverWanted: Client | null = null;
    /** A click counts only while its client is still here and may type: no later start acts for one that left or observes. */
    const mayTakeOver = (client: Client | null): client is Client =>
      client !== null && attachment.clients.has(client) && client.data.mode === "interact" && !client.data.closing;
    /** an attempt, live attach or terminal lookup is running: another start must wait */
    let trying = false;
    /** Starts at most one attempt, cancelling any scheduled retry before it can overlap. */
    const again = (): void => {
      if (attachments.get(paneId) !== attachment || trying) return;
      clearTimeout(attachment.retry);
      attachment.retry = undefined;
      if (attachment.clients.size === 0) {
        closeAttachment(paneId);
        return;
      }
      try {
        attachment.pty = start();
      } catch (error) {
        const message = spawnFailure(paneId, error);
        broadcast(paneId, { type: "error", code: "command_failed", message });
        broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
        closeAttachment(paneId);
      }
    };
    /** the terminal attached to: a pane keeps its id across a server handoff, its terminal does not */
    let attachedTerminal = terminalId;
    const start = (): PtySession => {
      let takingOver = mayTakeOver(takeover) ? takeover : null;
      takeover = null;
      trying = true;
      let output = ""; // this attach's own last words: herdr's refusal is in them
      // its first bytes wait ATTACH_HOLD_MS: a refusal (herdr's setup, teardown and message)
      // is dropped then, never painted into the clients' terminal
      let held: string | null = "";
      let heldSince = 0;
      let holding = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      const outputTail = new AttachOutputTail();
      let tailTimer: ReturnType<typeof setTimeout> | undefined;
      const flushTail = (taken = false): void => {
        clearTimeout(tailTimer);
        const data = outputTail.flush(taken);
        if (data) forward(data);
      };
      const publish = (data: string): void => {
        clearTimeout(tailTimer);
        const visible = outputTail.push(data);
        if (visible) forward(visible);
        // A pane may print the same bytes without exiting: never keep its text indefinitely.
        if (outputTail.pending) tailTimer = setTimeout(flushTail, holdFor);
      };
      /** ended before its exit came: what it still prints is no attach's */
      let retired = false;
      const release = (): void => {
        clearTimeout(holdTimer);
        if (held === null) return;
        const data = held;
        held = null;
        if (data) publish(data);
      };
      const took = (): void => {
        // a closed attachment's kill skips onExit, which would clear this timer: a newer
        // attachment on the pane must not hear this one's resume
        if (attachments.get(paneId) !== attachment) return;
        // a refusal whose exit comes late (a busy PC) is not an attach: resuming would free
        // the input to a pane another bridge may hold. Only output after it is an attach's.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < ATTACH_REFUSAL_EXIT_MS) {
            holdTimer = setTimeout(took, holdFor);
            return;
          }
          // its exit is overdue: this try ends here, as that exit would have ended it (a pane
          // whose own output ends the same way waits for more output on a later try)
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        // A click is consumed by success, including an ordinary retry that won the slot.
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        // the attach took: a pane that waited for another bridge is this bridge's again
        if (attachment.held) {
          attachment.held = false;
          broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        broadcast(paneId, { type: "input-ready", pane_id: paneId });
        release();
      };
      const ended = (code: number | null): void => {
        trying = false;
        clearTimeout(holdTimer);
        clearTimeout(tailTimer);
        if (attachments.get(paneId) !== attachment) return;
        if (attachment.ready) {
          broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
          holdPendingPane(paneId, { code: "input_not_ready", message: "The pane's attachment is restarting; review pending messages before sending them" });
        }
        attachment.ready = false;
        const now = Date.now();
        // displaced after attaching (herdr's last words): the read-race words may still be on its screen
        const displaced = code !== 0 && isTakeoverExit(output);
        if (!displaced && code !== 0 && ATTACH_READ_RACE_RE.test(output) && now - (refusedSince ??= now) < retryFor) {
          held = null;
          retries += 1;
          // An explicit request survives a read race only until an attach succeeds.
          takeover = mayTakeOver(takingOver) ? takingOver : takeoverWanted;
          takeoverWanted = null;
          attachment.retry = setTimeout(again, Math.min(ATTACH_RETRY_MS * 2 ** (retries - 1), ATTACH_RETRY_MAX_MS));
          return;
        }
        if (displaced || (code !== 0 && ATTACH_HELD_RE.test(output))) {
          flushTail(displaced);
          held = null; // herdr's refusal is not the pane's output: never painted, and it repeats
          // waiting for the other bridge is not a read race: the next one gets its full budget
          refusedSince = null;
          retries = 0;
          // Another web bridge holds herdr's one attach slot (two bridges on one herdr, e.g. a
          // second install beside the first). Its attach is left alone; this pane waits for it
          // to let go, trying again while anyone here still has it open, instead of ending.
          if (!attachment.held) broadcast(paneId, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: paneId });
          attachment.held = true;
          // Displaced after attaching: a click this attach waited on is spent, only a new one takes it back.
          if (!displaced && mayTakeOver(takeoverWanted)) {
            takeover = takeoverWanted;
            takeoverWanted = null;
            again();
          } else {
            takeoverWanted = null;
            attachment.retry = setTimeout(again, heldRetry);
          }
          return;
        }
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        trying = true; // a live-handoff lookup owns the next start until it finishes
        release();
        flushTail();
        const finish = (): void => {
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        };
        // a refusal whose exit never came ended this try itself, on a terminal that is still there
        if (retired) return finish();
        // herdr ended the attach, maybe not the pane: after a live handoff the pane lives on under
        // a new terminal, and the same clients attach to that one. A pane that is gone, or still
        // on this terminal once the lookups run out, ended.
        const deadline = Date.now() + relookupFor;
        const retryLookup = (): void => {
          if (Date.now() >= deadline) return finish();
          attachment.relookup = setTimeout(relookup, ATTACH_RELOOKUP_MS);
        };
        const relookup = (): void => {
          // a herdr that takes the request and never answers must not hold the terminal past the
          // deadline: the lookup gets what is left of it, not the RPC's own 10 s
          terminalInfoFor(paneId, Math.max(1, deadline - Date.now())).then(({ terminalId: now }) => {
            if (attachments.get(paneId) !== attachment) return;
            if (now === attachedTerminal) return retryLookup();
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            attachedTerminal = now;
            // a new terminal gets the whole read-race budget
            refusedSince = null;
            retries = 0;
            try {
              attachment.pty = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              finish();
            }
          }, (error: unknown) => {
            if (attachments.get(paneId) !== attachment) return;
            if (error instanceof HerdrError && PANE_GONE_CODES.has(error.code)) return finish();
            // herdr is between servers (server_unavailable, connect_failed) or not answering (timeout): ask again
            retryLookup();
          });
        };
        relookup();
      };
      const session = new PtySession({
        command: process.env["HERDR_WEB_HERDR_BIN"] || "herdr",
        // --takeover goes after the id: before it, herdr reads the id as an unknown option
        args: ["terminal", "attach", attachedTerminal, ...(takingOver ? ["--takeover"] : [])],
        // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
        // the same session the RPCs talk to, or a named session's terminals are
        // looked up on the default socket and the attach dies.
        env: { HERDR_SOCKET_PATH: herdrSocketPath() },
        cols: attachment.cols,
        rows: attachment.rows,
        onData: (data) => {
          if (retired || attachments.get(paneId) !== attachment) return;
          output = (output + data).slice(-1024);
          if (held === null) return publish(data);
          held += data;
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(took, holdFor);
          }
        },
        onExit: ended,
      });
      return session;
    };
    attachment.takeOver = (client) => {
      if (attachments.get(paneId) !== attachment || !attachment.held) return;
      if (trying) {
        takeoverWanted = client;
        return;
      }
      clearTimeout(attachment.retry);
      takeover = client;
      again();
    };
    try {
      attachment.pty = start();
    } catch (error) {
      // Bun.spawn throws synchronously (node missing from PATH, fd or process limits): the
      // placeholder must go with it, or the next attach joins a record with no pty and
      // its close dereferences one (#154). The waiting attaches get the error in-band.
      attachments.delete(paneId);
      spawnFailure(paneId, error);
      throw error;
    }

    return attachment;
  }

  /** The attaching client sees the error in-band; the log is the only record the operator gets. */
  function spawnFailure(paneId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`terminal attach for pane ${paneId} failed to start: ${message}`);
    return message;
  }

  function detach(paneId: string, client: Client): void {
    holdPending(client, paneId);
    client.data.output.delete(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** A broken state file must cost the alert, never the server (an unhandled rejection would). */
  const logPushError = (error: unknown): void => {
    console.error(`web push: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients and web push. */
  function omoChanged(paneId: string, derived: AgentStatus, background: number, turn: boolean): void {
    // OmO's own turn, which herdr's status never shows: back at work, its form has had its answer
    if (turn && derived === "working") promptWaitEnded(paneId);
    // a background task starting or ending is no turn: the status stands, and nothing is alerted
    const status = turn ? completions.observe(paneId, derived, "omo") : completions.current(paneId) ?? completions.observe(paneId, derived, "omo");
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status, background_tasks: background });
    if (turn) push.onStatus(paneId, status).catch(logPushError);
  }

  const collector = startStatusCollector({
    onStatus: (paneId, raw, agent, replay) => {
      // read back from a snapshot around a gap between subscriptions. An OmO pane's status there
      // is OmO's own or herdr's by turns (server/omo-status.ts), and a difference is no change
      if (replay && (omo.runs(paneId) || !completions.replayed(paneId, raw, replay))) return;
      // another agent took an OmO pane: what OmO worked on there is not that agent's to finish
      if (omo.named(paneId, agent)) completions.forget(paneId);
      // the frame below names no agent: one herdr names anew is read into the roster now. An OmO
      // pane is `omo` in every snapshot, whatever herdr calls it in an event
      machines?.localAgents([{ pane_id: paneId, agent: omo.runs(paneId) ? "omo" : agent }]);
      // herdr says `claude/idle` for an OmO pane whatever it does: its own status stands
      if (omo.tracks(paneId)) return;
      // back at work, the agent has had its answer, maybe from a terminal: the same prompt on
      // its screen after this is another asking, which an answer to the old card must not take.
      // Only for a status that counts: a replay that changed nothing and herdr's word on an OmO
      // pane (omoChanged has OmO's own) end no asking
      if (raw === "working") promptWaitEnded(paneId);
      // an agent herdr lost on the way still works and finishes as such (server/completion.ts);
      // an OmO pane whose session is not known keeps herdr's status, under its own name
      const status = completions.observe(paneId, raw, omo.runs(paneId) ? "omo" : agent);
      pending.status(paneId, status); drainPending(paneId);
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status });
      push.onStatus(paneId, status).catch(logPushError);
    },
    // a finish reported as done, now in front at herdr's terminal: seen, idle again
    onFocus: (paneId) => {
      if (!completions.seen(paneId)) return;
      pending.status(paneId, "idle"); drainPending(paneId);
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: "idle" });
      push.onStatus(paneId, "idle").catch(logPushError);
    },
    onBaseline: (panes) => {
      push.seed(panes);
      for (const pane of panes) {
        // A fast mirrored client may queue before the collector's first baseline. A
        // known ready baseline can schedule a fresh guarded check even when the tracker
        // still remembers working; an unknown baseline never supplies that permission.
        const status = pane.agent_status === "idle" || pane.agent_status === "done" ? pane.agent_status : completions.current(pane.pane_id) ?? pane.agent_status;
        pending.status(pane.pane_id, status); drainPending(pane.pane_id);
      }
    },
    // a pane created a moment ago got its agent after the roster's own read of it. After the
    // snapshot's replays: a roster read before them could show a finish ahead of its status frame
    onReconciled: (panes) => machines?.localAgents(panes),
    // the tracker first: what it makes of each pane (a finish after work is done, not idle) is
    // what the alerts are measured against from here, or the next event would alert of it
    onResync: (panes, newer) => {
      completions.resync(panes, newer);
      for (const pane of panes) { pending.status(pane.pane_id, completions.current(pane.pane_id) ?? pane.agent_status); drainPending(pane.pane_id); }
      push.resync(panes.map((pane) => ({ ...pane, agent_status: completions.current(pane.pane_id) ?? pane.agent_status })), newer);
    },
    onPaneEnded: (paneId) => {
      holdPendingPane(paneId, { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" });
      pending.forget(paneId);
      completions.forget(paneId);
      // the terminal is gone, so is whatever its chat parsed (server/conversation.ts)
      forgetPaneTranscriptState(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
  }, { snapshot: rawSnapshot });
  omo.start();

  const envPort = process.env["PORT"];
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,

    async fetch(request, bunServer) {
      const url = new URL(request.url);
      let { pathname } = url;
      const bridgeAuthorized = isAuthenticated(request, bridgeToken);
      const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === "/api/agents" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/worktree/") || pathname.startsWith("/api/tab/") || pathname.startsWith("/api/fs/") || pathname === "/ws";
      const ip = bunServer.requestIP(request);
      const loopback = ip !== null && isLoopbackAddress(ip.address);
      const forwarded = cameThroughProxy(request.headers);
      const funnel = request.headers.has("tailscale-funnel-request");
      const tailscaleLogin = request.headers.get("tailscale-user-login");
      const requestHost = request.headers.get("host");
      // the guessing budget of the address that asks (auth.ts): a token presented while it waits is not compared
      const client = authClient(ip?.address ?? null, request.headers);
      const presented = presentedToken(request, token, client);
      // counted at once, before any await below lets a concurrent guess pass the same check. Every
      // wrong token counts, a paired watch device's too (a right one would upgrade it to drive);
      // the connection server's own bridge token does not
      if (presented === "wrong" && !bridgeAuthorized) recordPresentedTokenFailure(client);
      const tokenMatched = presented === "match";
      const pairedDevice = devices.match(parseCookies(request.headers.get("cookie")).get(DEVICE_COOKIE));
      const requestShape = { loopback, forwarded, funnel, tailscaleLogin, serveOnly };
      const identity = await identityOf(token === "" && pairedDevice === null && isServeOwnerRequest(requestShape) && (pathname === "/ws" || pathname.startsWith("/api/")), requestHost);
      const access = decideAccess({
        ...requestShape,
        host: requestHost,
        tokenMatched,
        device: pairedDevice,
        ...identity,
        tokenConfigured: token !== "",
        gated: devices.gated,
      });
      const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);

      if (requiresAuth(pathname) && !authenticated) {
        // a script's Bearer guess is told to wait; a browser's cookie gets the usual 401 and its sign-in form
        if (presented === "held" && pathname !== "/ws" && request.headers.has("authorization")) return presentedTokenHeld(client);
        // The WS client never parses a body, so the upgrade refusal stays plain text.
        return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson(access.level === "none" ? access.reason : "token_required");
      }

      const readOnly = access.level === "full" && access.role === "watch";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
        return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
      }
      // An empty segment ("//") reads as another route to the checks below, while the PC proxy
      // drops it before forwarding: `/api/machines/<id>//fs/file` would pass as not a file read.
      if (pathname.startsWith("/api/") && pathname.includes("//")) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
      // What a watching device must not reach, spelled out rather than inferred from the
      // method: file contents (those files include credentials) and a directory listing
      // (names and sizes are the shape of a repository the terminals never print), plus
      // every mutation except the two below.
      const fileRead = /^\/api\/(?:machines\/[^/]+\/)?fs\//.test(pathname);
      const directoryListing = /^\/api\/(?:machines\/[^/]+\/)?workspace\/directories$/.test(pathname);
      // Signing a device's own alerts in is a preference of that device, so `watch` keeps
      // it. The endpoint it registers is https-only (server/push.ts), and that is the
      // protection: a watch device's subscription is delivered every status change anyway.
      // /api/push/test stays with a session that can drive only because it is a mutation.
      const ownPreferences = pathname === "/api/auth" || pathname === "/api/push/subscribe";
      if (readOnly && (fileRead || directoryListing || mutating && !ownPreferences)) {
        return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
      }

      if (pathname === "/api/bridge") {
        if (token === "" && !bridgeAuthorized) return unauthorizedJson();
        try { return jsonResponse(await bridgeIdentity(sidecar)); } catch (error) { return errorResponse(error); }
      }
      if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
        if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
        // /local aliases preserve every existing endpoint without a self-proxy.
        if (pathname.startsWith("/api/machines/local/")) {
          if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
          pathname = pathname.replace("/api/machines/local/", "/api/");
          if (!/^\/api\/(session|agents|pane\/|workspace\/|worktree\/|tab\/)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
          url.pathname = pathname;
        } else {
          // a worktree made with an agent waits on git and then agent.start, up to 150 s on the PC
          bunServer.timeout(request, pathname === "/api/machines/events" ? 0 : pathname.endsWith("/worktree/create") ? 180 : 80);
          const deviceId = access.level === "full" ? access.device?.id : undefined;
          const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : undefined);
          response.headers.set("cache-control", "no-store");
          return response;
        }
      }
      if (pathname === "/ws") {
        if (!sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        const deviceId = access.level === "full" ? access.device?.id : undefined;
        const machineId = url.searchParams.get("machine_id");
        if (machineId && machineId !== "local") {
          if (access.level === "none") return unauthorizedJson(access.reason);
          if (!machines?.endpoint(machineId)) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
          let relay: MachineRelay | undefined;
          try {
            relay = new MachineRelay(machines, machineId, readOnly);
            await relay.ready;
            const upgraded = bunServer.upgrade(request, { data: { attached: new Map<string, object>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, relay, deviceId, readOnly } });
            if (upgraded) return undefined as unknown as Response;
            relay.close();
          } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
          return new Response("websocket upgrade required", { status: 426 });
        }
        const upgraded = bunServer.upgrade(request, { data: { attached: new Map<string, object>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, deviceId, readOnly } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/auth") return handleAuthRequest(request, token, client);
      if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
        try {
          const response = await handleDeviceRequest(request, pathname, devices, access);
          if (request.method === "DELETE" && response.status === 204) {
            // The device registry is the delivery authority even if cleaning the push file fails.
            try { push.revokeDevice(pathname.slice("/api/devices/".length)); } catch (error) { logPushError(error); }
          }
          return response;
        } catch (error) { return errorResponse(error); }
      }

      if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
        return handleUpdateRequest(request, pathname, options.updates);
      }
      if (pathname === "/api/herdr/update") return handleHerdrUpdateRequest(request, options.herdrUpdate);
      if (pathname === "/api/telemetry") return handleTelemetryRequest(request, options.telemetry);

      if (pathname === "/api/usage") return handleUsageRequest(request, url, usage);
      // a long clip can keep the provider silent past Bun's 10 s idle limit before the first line
      if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { bunServer.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }

      if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
        try {
          // a paired device owns its alerts; the open LAN (before any pairing) owns them only while
          // it stays open, like a subscription from before owners (undefined); a local/token/
          // Tailscale sign-in is the owner (null)
          const owner = access.level !== "full" ? null : access.device?.id ?? (access.via === "open" ? undefined : null);
          const answered = await handlePushRequest(request, pathname, push, owner);
          if (answered) return answered;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/health") {
        const auth: HealthAuth = access.level === "full"
          ? { required: false, authenticated: true, via: access.via, role: access.role }
          : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
        if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL });
        try {
          const info = await ping();
          // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
          const herdr = attachableIdentity(info, sidecar);
          return jsonResponse({ ok: true, herdr, auth,
            web_ui: { boot_id: process.env["HERDR_WEB_BOOT_ID"] ?? null, revision: process.env["HERDR_WEB_REVISION"] ?? null } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/access") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        return jsonResponse(await remoteAccess(bunServer.port ?? DEFAULT_PORT), 200, { "cache-control": "no-store" });
      }

      if (pathname === "/api/session") {
        try {
          return jsonResponse({ snapshot: await clientSnapshot() });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/agents") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          const kinds = new Set((await agentManifests()).manifests.map((manifest) => manifest.agent));
          kinds.add("omp");
          kinds.add("claude");
          // not herdr kinds: offered where this server can run them (see shell-agent.ts)
          for (const kind of Object.keys(SHELL_AGENTS)) if (shellAgentExecutable(kind)) kinds.add(kind);
          const agents: AgentKind[] = [...kinds]
            .map((kind) => ({ kind, label: AGENT_LABELS[kind] ?? kind }))
            .sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind));
          return jsonResponse({ agents });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/fs/stat" || pathname === "/api/fs/file") {
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        let cwd: string | null = null;
        if (paneId) {
          try { cwd = (await paneContext(paneId)).cwd; } catch { /* an absolute path still opens */ }
        }
        const found = locateFile(url.searchParams.get("path") ?? "", cwd);
        if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
        // several files end in that name: the viewer lists them to choose from
        if ("candidates" in found) return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates: found.candidates } }, 409);
        return pathname === "/api/fs/stat" ? jsonResponse(found.info) : fileResponse(found.info, url.searchParams.get("download") === "1");
      }

      if (pathname === "/api/workspace/directories") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        // a folder a pane's chat names is read from that pane's folder, as a file it names is
        const paneId = url.searchParams.get("pane_id");
        let base: string | undefined;
        if (paneId) {
          try { base = (await paneContext(paneId)).cwd; } catch { /* an absolute path still lists */ }
          // a relative path whose pane is gone has no folder to be read from: not the server's own
          const path = (url.searchParams.get("path") ?? "").trim();
          if (base === undefined && path !== "" && path !== "~" && !path.startsWith("~/") && !isAbsolute(path)) return badRequest("invalid_cwd", "the pane a relative path belongs to is gone");
        }
        const listing = listDirectories(url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1", base);
        return listing === null ? badRequest("invalid_cwd", "path must be a directory this user can read") : jsonResponse(listing);
      }

      // A tab is made the way a workspace is: herdr opens it with a shell in its root pane, and
      // the agent (if any) starts there through the one launch path, so names, retries and a
      // partial failure read the same for both.
      if (pathname === "/api/workspace/create" || pathname === "/api/tab/create") {
        const inWorkspace = pathname === "/api/tab/create";
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; cwd?: unknown; label?: unknown; agent?: { kind?: unknown; name?: unknown; args?: unknown } | null };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (inWorkspace && (typeof payload.workspace_id !== "string" || payload.workspace_id.trim() === "")) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        // the client sends null for "not given": treat it exactly like an absent field
        if (payload.cwd === null) delete payload.cwd;
        if (payload.label === null) delete payload.label;
        if (payload.agent === null) delete payload.agent;
        if (payload.cwd !== undefined && typeof payload.cwd !== "string") return badRequest("invalid_cwd", "cwd must be an existing directory");
        const cwd = payload.cwd === undefined ? undefined : expandedDirectory(payload.cwd);
        if (payload.cwd !== undefined && cwd === null) return badRequest("invalid_cwd", "cwd must be an existing directory");
        if (payload.label !== undefined && typeof payload.label !== "string") return badRequest("missing_label", "label must be a string");
        const fault = agentFault(payload.agent);
        if (fault !== null) return badRequest("invalid_agent", fault);
        // agent.start can legitimately take a minute; Bun's default idle timeout is shorter.
        if (payload.agent) bunServer.timeout(request, 75);
        try {
          const options = {
            ...(cwd === undefined || cwd === null ? {} : { cwd }),
            ...(typeof payload.label === "string" ? { label: payload.label } : {}),
          };
          const created = inWorkspace
            ? await tabCreate({ ...options, workspaceId: payload.workspace_id as string })
            : await workspaceCreate(options);
          const workspaceId = created.tab.workspace_id;
          if (!payload.agent) {
            return jsonResponse({ workspace_id: workspaceId, pane_id: created.root_pane.pane_id, agent_started: false });
          }
          return jsonResponse({ workspace_id: workspaceId, pane_id: created.root_pane.pane_id, ...(await agentLaunch(created.root_pane.pane_id, payload.agent)) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      // A worktree is a git checkout herdr opens as a workspace grouped with its repository's.
      // The workspace names the repository; herdr finds the checkout root from its folder.
      if (pathname === "/api/worktree/list") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const workspaceId = url.searchParams.get("workspace_id") ?? "";
        if (workspaceId === "") return badRequest("missing_workspace_id", "workspace_id is required");
        try {
          const listing = await worktreeList(workspaceId);
          return jsonResponse({ source: listing.source, worktrees: listing.worktrees });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/worktree/remove") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; force?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        if (payload.force !== undefined && typeof payload.force !== "boolean") return badRequest("invalid_force", "force must be a boolean");
        // git can take a while to delete a large checkout; Bun's default idle timeout is shorter.
        bunServer.timeout(request, 75);
        try {
          const removed = await worktreeRemove(payload.workspace_id, payload.force === true);
          return jsonResponse({ ok: true, path: removed.path, forced: removed.forced });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/worktree/create" || pathname === "/api/worktree/open") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; branch?: unknown; base?: unknown; label?: unknown; path?: unknown; agent?: AgentPayload | null };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        // the client sends null for "not given": an empty string is not given either
        const text = (value: unknown, name: string): string | undefined => {
          if (value === undefined || value === null) return undefined;
          if (typeof value !== "string") throw badRequest(`invalid_${name}`, `${name} must be a string`);
          const trimmed = value.trim();
          return trimmed === "" ? undefined : trimmed;
        };
        let branch: string | undefined, base: string | undefined, label: string | undefined;
        try {
          branch = text(payload.branch, "branch"); base = text(payload.base, "base"); label = text(payload.label, "label");
        } catch (response) {
          return response as Response;
        }
        // a checkout path is taken as git names it, spaces and all
        let path: string | undefined;
        if (payload.path !== undefined && payload.path !== null) {
          if (typeof payload.path !== "string") return badRequest("invalid_path", "path must be a string");
          if (payload.path !== "") path = payload.path;
        }
        if (path !== undefined && !isAbsolute(path)) return badRequest("invalid_path", "path must be absolute");
        const creating = pathname === "/api/worktree/create";
        // a new checkout can start an agent in its pane, as a new workspace can; null is "not given"
        const agent = creating ? payload.agent ?? undefined : undefined;
        const fault = agentFault(agent);
        if (fault !== null) return badRequest("invalid_agent", fault);
        if (creating && branch === undefined) return badRequest("missing_branch", "branch is required");
        if (!creating && branch === undefined && path === undefined) return badRequest("missing_target", "path or branch is required");
        // a checkout of a large repository can take a while; Bun's default idle timeout is shorter.
        // and agent.start after it can take a minute more.
        if (creating) bunServer.timeout(request, agent ? 150 : 75);
        try {
          const opened = creating
            ? await worktreeCreate({ workspaceId: payload.workspace_id, branch: branch as string, base, label, path })
            : await worktreeOpen({ workspaceId: payload.workspace_id, path, branch, label });
          return jsonResponse({
            workspace_id: opened.workspace.workspace_id,
            pane_id: opened.root_pane.pane_id,
            already_open: opened.already_open === true,
            path: opened.worktree.path,
            branch: opened.worktree.branch,
            ...(agent ? await agentLaunch(opened.root_pane.pane_id, agent) : {}),
          });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/workspace/rename" || pathname === "/api/workspace/move" || pathname === "/api/workspace/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; label?: unknown; insert_index?: unknown; close_group?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        if (pathname === "/api/workspace/close" && payload.close_group !== undefined && typeof payload.close_group !== "boolean") {
          return badRequest("invalid_close_group", "close_group must be a boolean");
        }
        if (pathname === "/api/workspace/rename" && typeof payload.label !== "string") {
          return badRequest("missing_label", "label is required");
        }
        if (pathname === "/api/workspace/move" && (typeof payload.insert_index !== "number" || !Number.isInteger(payload.insert_index) || payload.insert_index < 0)) {
          return badRequest("invalid_index", "insert_index must be a non-negative integer");
        }
        try {
          if (pathname === "/api/workspace/rename") await workspaceRename(payload.workspace_id, payload.label as string);
          else if (pathname === "/api/workspace/move") await workspaceMove(payload.workspace_id, payload.insert_index as number);
          else await workspaceClose(payload.workspace_id, undefined, payload.close_group === true);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      // herdr's prefix+shift+t and prefix+shift+x: a tab's name, and a tab closed with every pane in it
      if (pathname === "/api/tab/rename" || pathname === "/api/tab/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { tab_id?: unknown; label?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.tab_id !== "string" || payload.tab_id.length === 0) return badRequest("missing_tab_id", "tab_id is required");
        try {
          if (pathname === "/api/tab/rename") {
            // herdr would keep an empty label as the tab's name, and its own tab row would show nothing
            const label = typeof payload.label === "string" ? payload.label.trim() : "";
            if (label === "") return badRequest("missing_label", "label is required");
            await tabRename(payload.tab_id, label);
            // no pane event follows a rename, so the clients are told here
            broadcastAll({ type: "session-changed" });
          } else {
            // herdr emits pane.closed for the tab's panes, and the collector tells the clients
            await tabClose(payload.tab_id);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/rename") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: unknown; label?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (typeof payload.label !== "string") return badRequest("missing_label", "label is required");
        try {
          await paneRename(payload.pane_id, payload.label.length === 0 ? null : payload.label);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/commands" || pathname === "/api/pane/files") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        try {
          const context = await paneContext(paneId);
          if (pathname === "/api/pane/commands") {
            // herdr names an omo pane `pi` while omo waits: pi's commands and templates are not omo's
            const agent = context.agent === "pi" && await paneRunsOmo(paneId) ? "omo" : context.agent;
            return jsonResponse({ commands: paneCommands(agent, context.cwd) });
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? 20 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1) return badRequest("invalid_limit", "limit must be a positive integer");
          return jsonResponse({ files: await paneFiles(context.cwd, url.searchParams.get("q") ?? "", Math.min(limit, 100)) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/omo-tasks") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const session = omo.sessionOf(paneId);
        // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
        const server_time = new Date().toISOString();
        if (session === null) return jsonResponse({ tasks: [], runs: [], server_time });
        return jsonResponse({ tasks: omoTasks(session.cwd, session.sessionId, processAlive), runs: omoRuns(session.cwd, session.sessionId), server_time });
      }

      if (pathname === "/api/pane/read") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const linesRaw = url.searchParams.get("lines");
        const lines = linesRaw === null ? undefined : Number(linesRaw);
        if (lines !== undefined && !Number.isFinite(lines)) {
          return badRequest("invalid_lines", "lines must be a number");
        }
        // herdr knows these enums and has its own answer for a wrong one, but a read this
        // route never meant to make is refused here rather than sent on as a guess
        const source = url.searchParams.get("source") ?? "visible";
        if (!READ_SOURCES.has(source)) return badRequest("invalid_source", `source must be one of ${[...READ_SOURCES].join(", ")}`);
        const format = url.searchParams.get("format") ?? "text";
        if (!READ_FORMATS.has(format)) return badRequest("invalid_format", `format must be one of ${[...READ_FORMATS].join(", ")}`);
        try {
          const read = await paneRead({ paneId, source: source as ReadSource, format: format as ReadFormat, ...(lines === undefined ? {} : { lines }) });
          return jsonResponse({ read });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/scroll") {
        if (request.method === "GET") {
          const paneId = url.searchParams.get("pane_id");
          if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
          try {
            return jsonResponse({ scroll: await paneScrollInfo(paneId) });
          } catch (error) {
            return errorResponse(error);
          }
        }
        if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
        let payload: { pane_id?: unknown; offset_from_bottom?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (!isCount(payload.offset_from_bottom)) return badRequest("invalid_offset", "offset_from_bottom must be a non-negative integer");
        try {
          return jsonResponse({ scroll: await paneScroll(payload.pane_id, payload.offset_from_bottom) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/selection") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const [anchorRow, anchorCol, cursorRow, cursorCol] = ["anchor_row", "anchor_col", "cursor_row", "cursor_col"]
          .map((name) => { const raw = url.searchParams.get(name); return raw === null || raw === "" ? NaN : Number(raw); });
        if (![anchorRow, anchorCol, cursorRow, cursorCol].every(isCount)) {
          return badRequest("invalid_range", "anchor_row, anchor_col, cursor_row and cursor_col must be non-negative integers");
        }
        try {
          const text = await paneSelectionRead(paneId, { row: anchorRow!, col: anchorCol! }, { row: cursorRow!, col: cursorCol! });
          return jsonResponse({ text });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/tool-output") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const output = await toolOutput(paneId, ref, options.codexHome);
          if (output === null) return jsonResponse({ error: { code: "output_not_found", message: "no such tool call in this pane's conversation" } }, 404);
          return new Response(output, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/image") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const image = await conversationImage(paneId, ref, options.codexHome);
          if (image === null) return jsonResponse({ error: { code: "image_not_found", message: "no such image in this pane's conversation" } }, 404);
          // Claude embeds immutable bytes; a Codex attachment may name a local file that changes.
          return new Response(image.bytes, { headers: { "content-type": image.mediaType, "cache-control": ref.startsWith("codex-") ? "private, no-store" : "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const page = {
          before: url.searchParams.get("before") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
        };
        try {
          const { version, ...conversation } = await paneConversation(paneId, options.codexHome, page);
          // The chat polls every 2s: an unchanged conversation answers 304 with no body.
          // no-store keeps the browser's own cache out of it, so the chat sees the 304.
          const etag = `"${version}"`;
          const headers = { etag, "cache-control": "no-store" };
          if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
          return jsonResponse(conversation, 200, headers);
        } catch (error) {
          if (error instanceof HistoryChanged) return jsonResponse({ error: { code: "history_changed", message: error.message } }, 409);
          // an unrecognized pane is not an error: the client falls back to the
          // scrollback transcript, exactly like chatmux's terminal fallback
          if (error instanceof ConversationUnavailable) return jsonResponse({ source: "scrollback", turns: [] });
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/input" || pathname === "/api/pane/keys") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; text?: string; keys?: string[] };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          if (pathname === "/api/pane/input") {
            if (typeof payload.text !== "string") return badRequest("missing_text", "text is required");
            await paneSendText(payload.pane_id, payload.text);
          } else {
            if (!Array.isArray(payload.keys) || !payload.keys.every((key) => typeof key === "string")) return badRequest("missing_keys", "keys must be an array");
            await paneSendKeys(payload.pane_id, payload.keys);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          // herdr emits pane.closed -> the collector broadcasts session-changed, so
          // every client refetches and the pane leaves sidebars on its own
          await paneClose(payload.pane_id);
          // the pane is gone: whatever its chat parsed is released with it (server/conversation.ts)
          forgetPaneTranscriptState(payload.pane_id);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/image") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; content_type?: string; data_base64?: string; name?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        if ((payload.content_type !== undefined && typeof payload.content_type !== "string")
          || (payload.data_base64 !== undefined && typeof payload.data_base64 !== "string")
          || (payload.name !== undefined && typeof payload.name !== "string")) {
          return badRequest("invalid_image", "content_type, data_base64 and name must be strings");
        }
        try {
          const path = await savePaneImage({
            paneId: payload.pane_id,
            contentType: payload.content_type ?? "",
            dataBase64: payload.data_base64 ?? "",
            name: payload.name,
          });
          return jsonResponse({ ok: true, path });
        } catch (error) {
          if (error instanceof PasteImageError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
          }
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/pane/prompt")) {
        try {
          const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome });
          if (response) return response;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
      }

      // static client - public even when the API is gated, so the login UI can load
      return serveStatic(pathname);
    },

    websocket: {
      // This transport cap also covers clients that predate application ACKs.
      backpressureLimit: OUTPUT_HARD_BYTES,
      closeOnBackpressureLimit: true,
      drain(client) {
        for (const paneId of client.data.attached.keys()) reconcileOutput(paneId);
      },
      async open(client) {
        if (client.data.deviceId) {
          client.data.unwatchDevice = devices.onRevoke(client.data.deviceId, () => {
            client.data.revoked = true;
            client.data.closing = true;
            clients.delete(client);
            for (const paneId of client.data.attached.keys()) detach(paneId, client);
            client.data.attached.clear();
            client.data.output.clear();
            client.data.relay?.close(1008, "Device access revoked");
            client.close(1008, "Device access revoked");
          });
          if (client.data.revoked) return;
        }
        if (client.data.relay) { client.data.relay.bind(client as ServerWebSocket<unknown>); return; }
        clients.add(client);
        try {
          send(client, { type: "snapshot", snapshot: await clientSnapshot(), features: SERVER_FEATURES });
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "snapshot_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      async message(client, raw) {
        if (client.data.closing) return;
        if (client.data.relay) { client.data.relay.message(raw); return; }
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          send(client, { type: "error", code: "invalid_json", message: "message must be JSON" });
          return;
        }
        try {
          switch (message.type) {
            case "attach": {
              if (message.flow_control !== undefined && message.flow_control !== "ack") {
                send(client, { type: "error", code: "invalid_flow_control", message: "flow_control must be ack" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // record the pane before the await: a detach (switching panes) or a close
              // that lands while the terminal is looked up must cancel this attach, and
              // neither can see a client that only joins the attachment afterwards
              const claim = client.data.attached.get(message.pane_id) ?? {};
              if (!client.data.attached.has(message.pane_id)) client.data.attached.set(message.pane_id, claim);
              let attachment: PaneAttachment;
              try {
                // a covered grid (keep_size) creates the pty at the pane's own size, as an observer does
                attachment = await ensureAttachment(message.pane_id, geometry.cols, geometry.rows, client.data.mode === "observe" || message.keep_size === true);
              } catch (error) {
                if (client.data.attached.get(message.pane_id) === claim) client.data.attached.delete(message.pane_id);
                throw error;
              }
              if (client.data.attached.get(message.pane_id) !== claim) {
                releaseUnclaimed(message.pane_id, attachment);
                break;
              }
              // a mirror whose pane went away during its first read has already ended: joining
              // it would leave this client on a terminal that never says anything again
              if (attachment.mirror && attachments.get(message.pane_id) !== attachment) {
                client.data.attached.delete(message.pane_id);
                send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
                break;
              }
              // An idempotent attach must not replay terminal bytes a second time.
              const alreadyAttached = attachment.clients.has(client);
              attachment.clients.add(client);
              if (!alreadyAttached && message.flow_control === "ack") client.data.output.set(message.pane_id, new OutputWindow());
              // a mirrored screen is drawn for the pane's own grid: the client takes that size
              // before the screen, or the rows would wrap in a grid of another width
              if (attachment.mirror) send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows, fixed: true });
              // hand the newcomer the current screen it would otherwise have missed
              // (a mirror keeps its latest screen whole; a pty keeps a bounded tail of its stream)
              const replay = attachment.mirror ? attachment.mirror.current ?? "" : attachment.replay.text();
              if (!alreadyAttached && replay) sendOutput(client, message.pane_id, replay);
              // a pane waiting for another web bridge to let go says so to each newcomer, too
              if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
              reconcileOutput(message.pane_id);
              if (client.data.closing) break;
              if (attachment.ready && !attachment.held) send(client, { type: "input-ready", pane_id: message.pane_id });
              if (attachment.mirror) break;
              if (client.data.mode === "interact" && message.keep_size !== true) {
                // an operator's viewport owns the shared grid
                resizePty(message.pane_id, geometry.cols, geometry.rows);
              } else {
                // an observer, or a grid the chat lens covers, adopts the grid the operators left behind
                send(client, {
                  type: "pane-geometry",
                  pane_id: message.pane_id,
                  cols: attachment.cols,
                  rows: attachment.rows,
                });
              }
              break;
            }
            case "take-over": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const attachment = attachments.get(message.pane_id);
              if (attachment?.clients.has(client)) attachment.takeOver?.(client);
              break;
            }
            case "detach": {
              client.data.attached.delete(message.pane_id);
              detach(message.pane_id, client);
              break;
            }
            case "pty-ack": {
              // Observers may acknowledge output, but never input or resize it.
              const window = client.data.output.get(message.pane_id);
              if (window && window.id === message.stream_id && !window.acknowledge(message.stream_id, message.offset)) {
                send(client, { type: "error", code: "invalid_ack", message: "offset must acknowledge bytes already sent" });
                break;
              }
              reconcileOutput(message.pane_id);
              break;
            }
            case "input": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              // typing goes straight through the pty, unless a composer message is still in
              // flight: then it waits its turn and goes the message's own way (send_text), since
              // the pty holds a lone ESC ~150ms and a Stop would overtake nothing
              // typing reaches an attached pane only, queued or not
              const attachment = attachments.get(message.pane_id);
              const inputFailed = () => {
                if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
              };
              // without a pty (Windows: no terminal, or a mirrored one) typing, the key bar's Enter,
              // Stop and arrows go through herdr itself, each in its turn behind a message in flight.
              // The turn is taken before herdr is asked what it can do: a message sent while
              // that answer is on its way must not overtake the typing.
              if (terminalAttachKnown === false || (!attachment && terminalAttachKnown === null)) {
                const text = message.text;
                // typed into this attach, or into none: one left meanwhile (even attached again) takes none of it
                const origin = attachment?.clients.has(client) ? attachment : undefined;
                const claim = client.data.attached.get(message.pane_id);
                void serialize(message.pane_id, async () => {
                  // a herdr that attaches: typing reaches an attached pane only
                  if (await terminalAttach()) { inputFailed(); return; }
                  // a pasted block asks herdr what the pane runs, so it is shaped before the checks below
                  const shaped = await mirrorInput(text, async () => (await paneContext(message.pane_id)).agent);
                  if (client.data.attached.get(message.pane_id) !== claim
                    || (origin && (attachments.get(message.pane_id) !== origin || !origin.clients.has(client)))) { inputFailed(); return; }
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  await paneSendText(message.pane_id, shaped);
                  // the echo is read at once, not at the mirror's next idle read
                  attachments.get(message.pane_id)?.mirror?.poke();
                }).catch(inputFailed);
                break;
              }
              // another web bridge has this pane's terminal: nothing typed here reaches it
              if (!attachment?.clients.has(client) || !attachment.ready || attachment.held) {
                send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
                break;
              }
              if (paneQueues.has(message.pane_id)) {
                const text = message.text;
                // typed into this attach: one that ended meanwhile (and was attached again) takes none of it
                const pty = attachment.pty;
                const claim = client.data.attached.get(message.pane_id);
                void serialize(message.pane_id, () => {
                  // held while this waited its turn: it goes nowhere, as unqueued typing would
                  if (attachments.get(message.pane_id) !== attachment || attachment.pty !== pty
                    || client.data.attached.get(message.pane_id) !== claim
                    || !attachment.clients.has(client) || !attachment.ready || attachment.held) { inputFailed(); return; }
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  return paneSendText(message.pane_id, text);
                }).catch(inputFailed);
              } else {
                if (!attachment.pty.write(message.text)) { inputFailed(); break; }
                lastTyped.set(message.pane_id, Date.now());
                if (lastTyped.size > 64) {
                  for (const [pane, at] of lastTyped) if (Date.now() - at > TYPED_SETTLE_MS) lastTyped.delete(pane);
                }
              }
              break;
            }
            case "resize": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // the pty is still being created (an attach from the chat lens, then the switch to the
              // terminal lens before the terminal was looked up): the resize waits for it. Dropped,
              // it would leave the pty at the pane's own grid under a terminal fitted to another.
              const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
              if (creating && client.data.attached.has(message.pane_id)) {
                try { await creating; } catch { break; }
                if (client.data.closing || client.data.mode !== "interact" || !client.data.attached.has(message.pane_id)) break;
              }
              resizePty(message.pane_id, geometry.cols, geometry.rows);
              break;
            }
            case "keys": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const attachment = attachments.get(message.pane_id);
              // Terminal chords belong to the attachment that accepted them, just like input.
              // Unattached RPC keys retain their existing path (including native Windows).
              const origin = attachment?.clients.has(client) ? attachment : undefined;
              const pty = origin?.pty;
              const claim = client.data.attached.get(message.pane_id);
              if (attachment?.held) {
                send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                break;
              }
              // an attach still being looked up: its chord has no attachment to belong to yet, and must
              // not take the unattached RPC path around the claim it will be checked against
              if (origin === undefined && claim !== undefined) {
                send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
                break;
              }
              await serialize(message.pane_id, async () => {
                // the attach this chord was pressed in is gone (left, replaced, or left and joined again).
                // `input_failed`, as queued typing answers: `input_not_ready` makes the client drop the
                // pane's readiness, and the attach it holds by now has already been told it is ready
                if (origin && (attachments.get(message.pane_id) !== origin || origin.pty !== pty
                  || client.data.attached.get(message.pane_id) !== claim || !origin.clients.has(client))) {
                  if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
                  return;
                }
                if (origin && !origin.ready) {
                  if (clients.has(client)) send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
                  return;
                }
                // held while this waited its turn (the attach was refused after the check above)
                if (attachments.get(message.pane_id)?.held) {
                  send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                  return;
                }
                // a key pressed by a connection that has gone since is not pressed
                if (!clients.has(client)) return;
                authorizeSocket(client);
                await paneSendKeys(message.pane_id, message.keys);
                attachments.get(message.pane_id)?.mirror?.poke();
              });
              break;
            }
            case "secret": {
              // Refuse busy panes instead of retaining the secret behind another send.
              const result = (ok: boolean, code?: string) => send(client, {
                type: "secret-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code } : {}),
              });
              try {
                if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string"
                  || typeof message.prompt !== "string" || secretPrompt(message.prompt) !== message.prompt || !validSecret(message.secret)) {
                  result(false, "invalid_secret"); break;
                }
                if (client.data.mode === "observe") { result(false, "read_only"); break; }
                const attachment = attachments.get(message.pane_id);
                if (!attachment?.clients.has(client)) { result(false, "not_attached"); break; }
                if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); break; }
                if (paneQueues.has(message.pane_id)) { result(false, "pane_busy"); break; }
                // the attach this secret was sent from: leaving it (even joining again) takes the secret back
                const claim = client.data.attached.get(message.pane_id);
                await serialize(message.pane_id, async () => {
                  // A viewport scrolled into history can still show an old password prompt.
                  // Validate the live screen before typing a secret into the current program.
                  const screen = await paneRead({ paneId: message.pane_id, source: "detection", format: "text" });
                  if (client.data.closing || client.data.mode === "observe") { result(false, "read_only"); return; }
                  authorizeSocket(client);
                  if (!attachment.clients.has(client) || attachments.get(message.pane_id) !== attachment
                    || client.data.attached.get(message.pane_id) !== claim) { result(false, "not_attached"); return; }
                  if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); return; }
                  if (secretPrompt(screen.text, attachment.cols) !== message.prompt) { result(false, "prompt_changed"); return; }
                  if (attachment.mirror) {
                    // A mirrored pane has no pty to type into: the secret is herdr's text, then the
                    // Enter key (a `\r` inside the text is not Enter to every shell). Both are awaited,
                    // so a send herdr refused is answered as failed, not as entered.
                    await paneSendText(message.pane_id, message.secret);
                    await paneSendKeys(message.pane_id, ["Enter"]);
                  } else {
                    // Direct attach keystrokes: no agent transcript, RPC payload or delayed Enter.
                    if (!attachment.pty.write(`${message.secret}\r`)) { result(false, "input_not_ready"); return; }
                  }
                  result(true);
                });
              } catch {
                // Never forward an exception that might include submitted bytes.
                result(false, "secret_failed");
              } finally { message.secret = ""; }
              break;
            }
            case "submit": {
              // every submit is answered: the composer keeps its text until it hears back
              const result = (ok: boolean, code?: string, text?: string, accepted?: PendingMessage) => send(client, {
                type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(accepted ? { pending: accepted } : {}), ...(code ? { code, message: text } : {}),
              });
              if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
                || typeof message.text !== "string" || typeof message.payload !== "string") {
                send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
                break;
              }
              if ((message.delivery !== undefined && message.delivery !== "immediate" && message.delivery !== "queue")
                || (message.delivery === "queue" && message.typed !== undefined && message.typed !== false)) {
                result(false, "invalid_delivery", "Use immediate delivery, or queue a chat message");
                break;
              }
              if (client.data.mode === "observe") {
                result(false, "read_only", "this connection is in observe mode");
                break;
              }
              // another web bridge has this pane's terminal: its user types there, not this one
              if (attachments.get(message.pane_id)?.held) {
                result(false, "attach_held", ATTACH_HELD_MESSAGE);
                break;
              }
              const arrivedAt = Date.now();
              try {
                if (message.delivery === "queue") {
                  let book = pendingRequests.get(client);
                  if (!book) { book = new PendingRequestBook((reply: SubmitReply) => reply.pending !== undefined && pending.retains(client, reply.pending.id)); pendingRequests.set(client, book); }
                  // a digest, so a receipt kept for replay never holds a large request's bytes
                  const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([message.pane_id, message.text, message.payload])).digest("hex");
                  const previous = book.get(message.id, fingerprint);
                  const lease = previous ? null : pendingLease(client, message.pane_id);
                  const reply = previous ?? book.run(message.id, fingerprint, () => serialize(message.pane_id, async (): Promise<SubmitReply> => {
                    const text = pendingText(message.text);
                    const mark = pending.mark(message.pane_id);
                    const context = await pendingContext(client, message.pane_id, lease!);
                    if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "This pending message waited too long; nothing was typed");
                    if (!context.working) {
                      // the agent left while the message was on its way: a chat follow-up is not typed into what is there now
                      if (context.identity.agent === null) throw new HerdrError("agent_not_ready", "No agent is in front of this pane now; nothing was typed");
                      // A request that raced the turn's finish still needs cancellable
                      // paste + Enter; agent.prompt commits its key inside herdr. With a message
                      // already waiting its turn here, this one takes its place behind it instead.
                      if (!pending.waiting(message.pane_id)) return dispatchPendingText(client, message.pane_id, text, lease!, context.identity, false, arrivedAt);
                    }
                    pending.observe(message.pane_id, context.pane.agent_status, mark);
                    const item = pending.enqueue(client, message.pane_id, message.id, text, lease!, context.identity);
                    return { ok: true, pending: item.message };
                  }).catch((error): SubmitReply => ({ ok: false, ...pendingFault(error) })));
                  const answer = await reply;
                  const accepted = answer.pending ? pending.get(client, message.pane_id, answer.pending.id)?.message : undefined;
                  if (answer.pending && !accepted) replayPendingOutcome(client, message.pane_id, answer.pending.id);
                  result(answer.ok, answer.code, answer.message, accepted);
                  drainPending(message.pane_id);
                  break;
                }
                await serialize(message.pane_id, () => {
                  // held while this waited its turn (the attach was refused after the check above)
                  if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
                  return submitText(message.pane_id, message.text, message.payload, arrivedAt, message.typed === true, () => authorizeSocket(client));
                });
                result(true);
              } catch (error) {
                const fault = pendingFault(error); result(false, fault.code, fault.message);
              }
              break;
            }
            case "pending-action": {
              const result = (reply: SubmitReply) => send(client, { type: "pending-result", id: message.id, pane_id: message.pane_id, pending_id: message.pending_id, ...reply });
              if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
                || typeof message.pending_id !== "string" || !message.pending_id || !["steer", "discard"].includes(message.action)) {
                result({ ok: false, code: "invalid_pending_action", message: "Use steer or discard with a pending-message id" }); break;
              }
              const arrivedAt = Date.now();
              try {
                authorizeSocket(client);
                const lease = message.action === "steer" ? pendingLease(client, message.pane_id) : null;
                const answer = await serialize(message.pane_id, async (): Promise<SubmitReply> => {
                  authorizeSocket(client);
                  if (!clients.has(client) || client.data.closing) throw new HerdrError("disconnected", "This connection closed");
                  const item = pending.get(client, message.pane_id, message.pending_id);
                  if (!item) return replayPendingOutcome(client, message.pane_id, message.pending_id)
                    ? { ok: true } : { ok: false, code: "pending_not_found", message: "This pending message does not belong to this connection" };
                  if (message.action === "discard") return pending.discard(item) ? { ok: true } : { ok: false, code: "pending_busy", message: "This message is already being sent" };
                  if (item.message.state === "uncertain") return { ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" };
                  await pendingContext(client, item.paneId, lease!, item.identity);
                  if (!pending.claim(item, false)) return { ok: false, code: "pending_busy", message: "This message is already being sent" };
                  item.lease = lease!;
                  return dispatchPending(item, false, arrivedAt);
                });
                result(answer);
                drainPending(message.pane_id);
              } catch (error) { result({ ok: false, ...pendingFault(error) }); }
              break;
            }
            case "role": {
              if (message.mode !== "interact" && message.mode !== "observe") {
                send(client, { type: "error", code: "invalid_role", message: "mode must be interact or observe" });
                break;
              }
              if (client.data.readOnly) message.mode = "observe";
              if (message.mode === "observe") holdPending(client);
              client.data.mode = message.mode;
              send(client, { type: "role-ack", mode: message.mode });
              if (message.mode === "observe") {
                // the fresh observer needs the grid it must adopt
                for (const paneId of client.data.attached.keys()) {
                  const attachment = attachments.get(paneId);
                  if (attachment) {
                    send(client, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
                  }
                }
              }
              break;
            }
          }
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "command_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      close(client) {
        client.data.unwatchDevice?.();
        if (client.data.relay) { client.data.relay.close(); return; }
        pending.close(client);
        clients.delete(client);
        for (const paneId of client.data.attached.keys()) detach(paneId, client);
        client.data.attached.clear();
        client.data.output.clear();
      },
    },
  });

  const registration = options.registerBridge ? registerBridge(server.port ?? 0, bridgeToken) : null;

  // ACKs can stop arriving entirely (a suspended tab). Bound the pause even then.
  const outputTimer = setInterval(() => {
    pending.expire();
    for (const paneId of attachments.keys()) reconcileOutput(paneId);
  }, 100);
  outputTimer.unref();

  return {
    port: server.port ?? 0,
    hostname,
    stop: () => {
      clearInterval(outputTimer);
      collector.stop();
      omo.stop();
      machines?.stop();
      registration?.close();
      for (const paneId of [...attachments.keys()]) closeAttachment(paneId);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const updates = connectUpdater();
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
  const telemetry = new Telemetry({ stateDir: defaultStateDir(), version, env: process.env, fetch, previousVersion: () => updates.installed().previous_version });
  const instance = createServer({ updates, herdrUpdate: new HerdrUpdater(), telemetry, registerBridge: true });
  telemetry.start();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    telemetry.stop();
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot.
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.env["HERDR_WEB_MANAGED"] === "1") process.on("disconnect", shutdown);
  console.log(`herdr-web-ui listening on http://${instance.hostname}:${instance.port}`);
  if (!LOOPBACK_HOSTNAMES.has(instance.hostname)) {
    if ((process.env["HERDR_WEB_TOKEN"] ?? "") === "") {
      console.error(
        `WARNING: listening on ${instance.hostname} without HERDR_WEB_TOKEN - until a device is paired (Settings → Devices, on this PC) anyone who can reach this address can type into your terminals; pair your devices, set HERDR_WEB_TOKEN=<token>, or keep HOST=127.0.0.1 and reach it through Tailscale or an SSH tunnel.`,
      );
    }
    // The bind address says nothing about the transport: a token cookie and every keystroke
    // travel in the clear on plain http, so a listener on the same network gets them.
    if ((process.env["HERDR_WEB_TOKEN"] ?? "") !== "") {
      console.error(
        `WARNING: listening on http://${instance.hostname}:${instance.port} - HERDR_WEB_TOKEN is not confidential over cleartext http; on an untrusted network anyone who can read the traffic has the token and everything you type. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep HOST=127.0.0.1.`,
      );
    }
  }
}
