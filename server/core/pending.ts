import { AGENT_PICKER_MESSAGE, closeBackslash, closeMention, type createSubmitText, freeAgentInput, freeClaudeBox, freeHermesInput, InputDraftError, modelSwitchText, OMP_REPORT_POLL_MS, OMP_STARTUP_MS, ompStartingUntil, pendingFault, pendingIdentity, pendingText, submitFraming, untilOmpReported } from "./composer.ts";
import { grokEcho, grokQueue, sendGrokQueuedNow } from "./grok-queue.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import type { AttachmentView, TerminalSighting } from "./terminals.ts";
import type { ClientMessage, HerdrPane, PendingMessage, PendingRemoval, SessionSnapshot } from "../../shared/protocol.ts";
import { typingGuards } from "../input-guard.ts";
import { claudeForegroundSession, isClaudeProcess } from "../claude-store.ts";
import { HerdrError, type HerdrFailureView, paneGet, paneProcessInfo, paneRead, paneSendKeys, paneSendText, type ProcessInfo } from "../herdr/client.ts";
import { bindCommandProcess, claudeHeldIsGrey, codexQuestionsCollapsed, isClaudeHeld, heldCandidate, noteSubmitted, parseInteractivePrompt, piRunsCommand, piListsTemplate, prepareCommandSend, shownInputBox } from "../prompt.ts";
import { agentPickerWaits, registry } from "../dialogs/registry.ts";
import { codexOwnScreenOpen, CODEX_OWN_SCREEN_MESSAGE } from "../dialogs/codex.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { PendingInputs, samePendingIdentity, type PendingIdentity, type PendingRecord } from "../pending-input.ts";
import { NO_AGENT_MESSAGE, PASTED_NOT_SENT_MESSAGE, submitNotTyped } from "../../shared/submit-outcome.ts";
import { processStartedAtAsync } from "../process-start.ts";
import { agentProcessInFront } from "../agent-process.ts";
import { agentProcesses } from "../conversation.ts";
import { isShellAgentKind, SHELL_AGENTS } from "../shell-agent.ts";
import { capturePiDeliveryAnchorRetrying, matchPiDeliveries, PiReceiptCapacity, piRecordText, type PiDeliveryAnchor, type PiReceiptReservation } from "../pi-delivery.ts";
import { isPiProcess, piTranscriptPath, piUnwrittenHeaderId } from "../pi.ts";
import { PendingRequestBook } from "../pending-requests.ts";
import { interruptCodexSteering } from "../codex-steering.ts";
import type { OmoStatus } from "../omo-status.ts";
import { heldOmoProcess } from "../omo.ts";
import { startOpenCodeWatch, openCodeSkillsToType, type OpenCodeWatch, skillsNotAttached } from "../opencode-native.ts";
import { herdrSkillAttachIo, type PromptPiece, typeWithSkills } from "../opencode-skill-attach.ts";

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

type PendingLease = { sighting: TerminalSighting; authority: object };
export type FirstMessageOwner = { readonly firstMessages: true };
export const FIRST_MESSAGE_OWNER: FirstMessageOwner = { firstMessages: true };
export type PendingOwner = Client | FirstMessageOwner;
const isClient = (owner: PendingOwner): owner is Client => owner !== FIRST_MESSAGE_OWNER;
const withoutEscapes = (screen: string): string => screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
type PendingItem = PendingRecord<PendingOwner, PendingLease | null>;
type SubmitReply = { ok: boolean; pending?: PendingMessage; sending_at?: string; code?: string; message?: string; refusal?: { draft: string | null; box: string | null; identity: PendingIdentity };
  unannounced?: true };
class CodexOwnScreenRefusal extends HerdrError {
  constructor(message = CODEX_OWN_SCREEN_MESSAGE) { super("agent_blocked", message); }
}
const agentPickerRefusal = (): HerdrError => new CodexOwnScreenRefusal(AGENT_PICKER_MESSAGE);
/** Codex's question whether to trust the folder it was started in, by its card's title (0.167, and as older versions asked it). */
const CODEX_FOLDER_QUESTION_RE = /^(?:Trust this folder\?|Do you trust the contents)/i;
const CODEX_UPDATE_MENU_TITLE = "Codex";
/**
 * What a screen of Codex's own that has the input (codexOwnScreenOpen) is refused as, given the card the chat reads
 * of it, if any; null when the composer has the input.
 * - A screen the user opened is not reported by herdr, and neither is its end (CodexOwnScreenRefusal): one with no
 *   card, and /model's levels, which the chat reads as a card (registry.waits).
 * - A prompt Codex asks (an approval, a question: a card) is one herdr reports, maybe a moment after the screen: the
 *   refusal of a waiting menu, after whose end a status event drains the queue again. So is anything herdr already
 *   calls blocked.
 * - The folder question is a card herdr reports on a wide pane only (blocked at 80 columns and up, at rest at 60
 *   and under, Codex 0.167 under herdr 0.9.5). Where herdr is known not to report it (`herdr` is "rest"), nothing
 *   tells its end either, and it is refused as a screen the user opened; a caller that has not read the pane's
 *   status ("unknown") leaves it to the waiting-menu refusal.
 * - The update menu is held as a screen the user opened, whatever herdr reports (rest, blocked, or not read): "Update
 *   now" leaves Codex's screen for npm run under Codex's own process, so a status event during the install would
 *   otherwise drain a message queued again into the terminal, where the shell reads it once Codex exits.
 */
function codexScreenRefusal(screen: string, card: { title: string | null } | null, herdr: "blocked" | "rest" | "unknown"): HerdrError | null {
  if (card?.title === CODEX_UPDATE_MENU_TITLE) return new CodexOwnScreenRefusal();
  if (!codexOwnScreenOpen(screen)) return null;
  const waiting = (): HerdrError => new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
  if (herdr === "blocked") return waiting();
  if (card === null || registry.waits("codex", screen)) return new CodexOwnScreenRefusal();
  return herdr === "rest" && (CODEX_FOLDER_QUESTION_RE.test(card.title ?? "")) ? new CodexOwnScreenRefusal() : waiting();
}
type PiTypedReceipt = { owner: Client; resumeKey?: string; message: PendingMessage; match: string; template: boolean; identity: PendingIdentity; anchor: PiDeliveryAnchor | null };
const FIRST_MESSAGE_RETRY_CODES = new Set(["input_not_ready", "pending_lease_lost", "disconnected", "read_only"]);
const FIRST_MESSAGE_UNATTENDED = { code: "first_message_unattended", message: "The page that sent this first message is gone; send it now or discard it" };
const AGENT_NOT_READY = { code: "agent_not_ready", message: NO_AGENT_MESSAGE };
function runsAgentProgram(entry: { name?: string | null; argv0?: string | null; argv?: readonly string[] | null }, agent: string | null): boolean {
  if (agent === null) return false;
  if (agentProcesses([entry], agent).length > 0) return true;
  if (isShellAgentKind(agent) && SHELL_AGENTS[agent]!(entry.argv ?? [])) return true;
  // Claude's native build titles itself `Claude`, or by its version on macOS (claude-store.ts)
  if (agent === "claude") return isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined });
  return agent === "pi" && isPiProcess(entry.argv ?? []);
}
function runsOtherProgram(entry: { name?: string | null; argv0?: string | null; argv?: readonly string[] | null }, agent: string | null): boolean {
  if (runsAgentProgram(entry, agent)) return false;
  if ((entry.argv?.length ?? 0) > 0 || entry.argv0) return true;
  const name = entry.name?.trim() ?? "";
  return name !== "" && !["node", "bun", "python", "python3"].includes(name);
}
const agentRuns = (identity: PendingIdentity, recognized: boolean): boolean => identity.agent !== null && identity.processPid !== null && recognized;
const TARGET_CHANGED = { code: "pending_target_changed", message: "The pane's terminal or agent session changed; review the message before sending it again" };
const LAUNCH_GONE = { code: "first_message_launch_ended", message: "The agent started for this message has ended; review the message before sending it" };
const TYPED_WHILE_WAITING = { code: "typed_while_waiting", message: "Something was typed in this terminal while omp was starting. Check its input line there, then send this message" };
const FIRST_MESSAGE_RECEIPTS = 8;

export function createPendingDelivery({ options, clients, attachments, sight, serialize, lastTyped, typedInto = () => 0, submitText, authorizeSocket, clientSnapshot, omo, queueHeld = () => false, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS }: {
  options: { pendingStartTimeoutMs?: number; piReceiptLimit?: number; submitDeadlineMs?: number; submitDelayMs?: number; ompReportPollMs?: number; ompStartupMs?: number; openCodeStateDir?: string;
    herdrFailure?: HerdrFailureView };
  clients: Set<Client>;
  attachments: ReadonlyMap<string, AttachmentView>;
  sight: (client: Client, paneId: string) => TerminalSighting;
  serialize: <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;
  lastTyped: ReadonlyMap<string, number>;
  typedInto?: (paneId: string) => number;
  submitText: ReturnType<typeof createSubmitText>;
  authorizeSocket: (client: Client) => void;
  clientSnapshot: () => Promise<SessionSnapshot>;
  omo: Pick<OmoStatus, "sessionOf">;
  queueHeld?: (paneId: string, fresh: boolean) => boolean;
  SUBMIT_DEADLINE_MS: number;
  SUBMIT_DELAY_MS: number;
  TYPED_SETTLE_MS: number;
}) {
  const pendingAuthorities = new WeakMap<Client, Map<string, object>>();
  const firstReceipts = new Map<string, Array<{ id: string; outcome: "sent" | "discarded" | "dismissed" }>>();
  const typists = (paneId: string): Client[] => [...clients].filter((client) => {
    if (!client.data.attached.has(paneId)) return false;
    try { authorizeSocket(client); } catch { return false; }
    return typingGuards.pendingLease(sight(client, paneId).facts());
  });
  const pending = new PendingInputs<PendingOwner, PendingLease | null>((owner, paneId, messages, removed) => {
    if (isClient(owner)) {
      send(owner, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
      keepReceipts(owner, paneId, messages, removed);
      return;
    }
    if (removed) firstReceipts.set(paneId, [...(firstReceipts.get(paneId) ?? []), ...removed].slice(-FIRST_MESSAGE_RECEIPTS));
    for (const client of clients) {
      if (client.data.attached.has(paneId) && connectionOf(client).mode !== "observe") send(client, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
    }
  }, Date.now, options.pendingStartTimeoutMs, undefined, (owner) => !isClient(owner));
  let nextFirstRequestId = -1;
  const launchBound = new WeakSet<PendingItem>();
  const launchedNames = new WeakMap<PendingItem, string>();
  const processName = (processes: ProcessInfo | undefined, pid: number | null | undefined): string | undefined =>
    pid == null ? undefined : processes?.foreground_processes?.find((entry) => entry.pid === pid)?.name;
  const launchBoundIn = (paneId: string): PendingItem[] => pending.list(FIRST_MESSAGE_OWNER, paneId)
    .map((message) => pending.get(FIRST_MESSAGE_OWNER, paneId, message.id))
    .filter((item): item is PendingItem => item !== undefined && launchBound.has(item)
      && (item.message.state === "queued" || (item.message.state === "held" && item.message.error?.code !== TARGET_CHANGED.code && item.message.error?.code !== LAUNCH_GONE.code)));
  const holdFor = (item: PendingItem, fault: { code: string; message: string }): void => {
    if (item.message.state === "held") pending.rehold(item, fault);
    else pending.holdItem(item, fault);
  };
  const requesters = new WeakMap<PendingItem, Client>();
  const requested = new WeakMap<Client, Set<PendingItem>>();
  const present = (client: Client): boolean => clients.has(client) && !connectionOf(client).closing;
  const pendingDrains = new Set<string>();
  const pendingRequests = new WeakMap<Client, PendingRequestBook<SubmitReply>>();
  const draftConfirmations = new WeakMap<Client, Map<string, { draft: string | null; identity: PendingIdentity; box?: string | null }>>();

  const piTyped = new Map<string, PiTypedReceipt[]>();
  // Presentation only, bound to both the authenticated device and an opaque browser
  // correlator. Retaining a receipt never retains permission to send input.
  const PI_RESUME_MS = 10 * 60 * 1000, PI_RESUME_LIMIT = 1024;
  const livePiOwner = (owner: Client): boolean => clients.has(owner) && !connectionOf(owner).closing;
  const piCompleted: Array<{ paneId: string; key: string; id: string; at: number }> = [];
  const completed: Array<{ paneId: string; key: string; id: string; outcome: "sent" | "discarded" | "held" | "uncertain" | "sending"; at: number; hash?: string;
    gone?: true }> = [];
  const elapsed = (): number => performance.now();
  const endedPanes = new Map<string, number>();
  const receiptKeys = new WeakMap<Client, Map<string, string>>();
  const resumeKey = (client: Client, paneId: string): string | undefined => {
    const id = client.data.attached.get(paneId)?.receiptResumeId;
    return id ? JSON.stringify([client.data.deviceId ?? null, id]) : undefined;
  };
  const prunePi = (): void => {
    const cutoff = Date.now() - PI_RESUME_MS;
    while (piCompleted.length && (piCompleted[0]!.at < cutoff || piCompleted.length > PI_RESUME_LIMIT)) piCompleted.shift();
    const ended = elapsed() - PI_RESUME_MS;
    for (let at = 0; at < completed.length && completed[at]!.at < ended;) {
      if (completed[at]!.outcome === "sending") at++; else completed.splice(at, 1);
    }
    const counted = (entry: (typeof completed)[number]): boolean => entry.outcome === "held" || entry.outcome === "discarded";
    for (let over = completed.filter(counted).length - PI_RESUME_LIMIT; over > 0; over--) completed.splice(completed.findIndex(counted), 1);
    let count = 0;
    for (const [paneId, items] of piTyped) {
      const kept = items.filter((item) => {
        if (!livePiOwner(item.owner) && (Date.parse(item.message.created_at) < cutoff || ++count > PI_RESUME_LIMIT)) {
          releasePiSlot(item); return false;
        }
        return true;
      });
      if (kept.length) piTyped.set(paneId, kept); else piTyped.delete(paneId);
      if (!kept.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
    }
  };
  const piConsumed = new Map<string, Set<string>>();
  const piCapacity = new PiReceiptCapacity<Client>(options.piReceiptLimit ?? 256);
  const piSlots = new WeakSet<PiTypedReceipt>();
  const releasePiSlot = (item: PiTypedReceipt): void => {
    if (piSlots.delete(item)) piCapacity.remove(item.owner);
  };
  const activePiReceipt = (paneId: string, item: PiTypedReceipt): boolean =>
    item.message.error?.code === "pi_transcript_pending" && piSlots.has(item) && piTyped.get(paneId)?.includes(item) === true;
  const reservePiReceipt = (owner: Client, identity: PendingIdentity): PiReceiptReservation<Client> | null => {
    if (identity.agent !== "pi") return null;
    const reservation = piCapacity.reserve(owner);
    if (reservation === null) throw new HerdrError("pending_limit", "Too many Pi transcript receipts are still waiting; dismiss one before sending more");
    return reservation;
  };
  const piReceiptText = (identity: PendingIdentity, text: string): string | undefined => {
    if (identity.agent !== "pi") return undefined;
    try { return closeMention(pendingText(modelSwitchText(identity.agent, text))); }
    catch { return undefined; }
  };
  const piMessages = (paneId: string, owner: Client): PendingMessage[] => (piTyped.get(paneId) ?? [])
    .filter((item) => item.owner === owner)
    .map((item) => ({ ...item.message, ...(item.message.error ? { error: { ...item.message.error } } : {}) }));
  const publishPi = (paneId: string, removed?: Array<{ owner: Client; id: string; outcome: "consumed" | "discarded" }>): void => {
    const owners = new Set((piTyped.get(paneId) ?? []).map((item) => item.owner));
    for (const item of removed ?? []) owners.add(item.owner);
    for (const owner of owners) {
      if (!clients.has(owner) || !owner.data.attached.has(paneId) || connectionOf(owner).mode === "observe") continue;
      const ownRemoved = removed?.filter((item) => item.owner === owner).map(({ id, outcome }) => ({ id, outcome }));
      send(owner, { type: "pending-messages", pane_id: paneId, messages: piMessages(paneId, owner), ...(ownRemoved?.length ? { removed: ownRemoved } : {}) });
    }
  };
  const preparePiReceipt = async (paneId: string, identity: PendingIdentity): Promise<PiDeliveryAnchor | null | undefined> => {
    if (identity.agent !== "pi") return undefined;
    const found = await piTranscriptPath(paneId).catch(() => null);
    if (found === null) return null;
    const path = "unwritten" in found ? found.unwritten.path : found.path;
    if (!("unwritten" in found)) return capturePiDeliveryAnchorRetrying(path);
    const expected = piUnwrittenHeaderId(path);
    return expected === null ? null : capturePiDeliveryAnchorRetrying(path, true, expected);
  };
  const recordPiTyped = (owner: Client, paneId: string, requestId: number, text: string, identity: PendingIdentity, anchor: PiDeliveryAnchor | null | undefined,
    reservation?: PiReceiptReservation<Client> | null, template = false): void => {
    if (anchor === undefined || !clients.has(owner) || connectionOf(owner).closing) return;
    if (anchor === null) piCapacity.release(reservation);
    else if (!piCapacity.retain(owner, reservation)) return;
    prunePi();
    const receipt: PiTypedReceipt = {
      owner, resumeKey: resumeKey(owner, paneId), identity: { ...identity }, anchor,
      // Pi expands pasted tabs and trims its record, including closeMention's space (#2454).
      match: piRecordText(text), template,
      message: { id: `pi:${crypto.randomUUID()}`, request_id: requestId, text, state: "uncertain", created_at: new Date().toISOString(),
        error: anchor === null
          ? { code: "transcript_unconfirmed", message: "Pi's exact transcript could not be resolved before Enter" }
          : { code: "pi_transcript_pending", message: "Waiting for Pi's durable transcript append" } },
    };
    if (anchor !== null) piSlots.add(receipt);
    const items = piTyped.get(paneId) ?? [];
    items.push(receipt); piTyped.set(paneId, items);
    publishPi(paneId);
    void reconcilePiDeliveries(paneId);
  };
  const failPi = (paneId: string, items: readonly PiTypedReceipt[], reason: "changed" | "budget" | "ambiguous" = "changed"): void => {
    let changed = false;
    for (const item of items) {
      if (!activePiReceipt(paneId, item)) continue;
      releasePiSlot(item);
      item.message.error = reason === "budget"
        ? { code: "transcript_unconfirmed", message: "Pi's transcript exceeded the confirmation budget" }
        : reason === "ambiguous"
          ? { code: "transcript_unconfirmed", message: "Pi's transcript shows the same text submitted before this send" }
          : { code: "pi_transcript_target_changed", message: "The Pi terminal or session changed before its transcript append was confirmed" };
      changed = true;
    }
    if (changed) {
      if (!(piTyped.get(paneId) ?? []).some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      publishPi(paneId);
    }
  };
  async function reconcilePiDeliveries(paneId: string): Promise<void> {
    prunePi();
    const items = piTyped.get(paneId);
    if (!items?.some((item) => item.message.error?.code === "pi_transcript_pending")) return;
    await serialize(paneId, async () => {
      const currentItems = piTyped.get(paneId)?.filter((item): item is PiTypedReceipt & { anchor: PiDeliveryAnchor } => activePiReceipt(paneId, item) && item.anchor !== null) ?? [];
      if (currentItems.length === 0) return;
      let identity: PendingIdentity;
      try { identity = (await currentIdentity(paneId, currentItems[0]!.identity.processPid ?? null)).identity; }
      catch { return; }
      if (identity.processBirth == null && currentItems.some((item) => item.identity.processPid === identity.processPid && item.identity.processBirth != null)) return;
      const same = currentItems.filter((item) => activePiReceipt(paneId, item) && samePendingIdentity(item.identity, identity));
      failPi(paneId, currentItems.filter((item) => !same.includes(item)));
      if (same.length === 0) return;
      let found: Awaited<ReturnType<typeof piTranscriptPath>>;
      try { found = await piTranscriptPath(paneId); } catch { return; }
      if (found === null) return;
      const path = "unwritten" in found ? found.unwritten.path : found.path;
      let matching = same.filter((item) => activePiReceipt(paneId, item) && path === item.anchor.path);
      failPi(paneId, same.filter((item) => !matching.includes(item)));
      if (matching.length === 0 || "unwritten" in found) return;
      const candidates = matching.map((item) => ({ id: item.message.id, text: item.match, template: item.template, anchor: item.anchor }));
      const entries = piConsumed.get(paneId) ?? new Set<string>();
      piConsumed.set(paneId, entries);
      let result = matchPiDeliveries(path, candidates, entries);
      for (let attempt = 0; result.retry && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        matching = matching.filter((item) => activePiReceipt(paneId, item));
        if (matching.length === 0) return;
        result = matchPiDeliveries(path, candidates.filter((candidate) => matching.some((item) => item.message.id === candidate.id)), entries);
      }
      if (result.retry) return;
      failPi(paneId, matching.filter((item) => result.changed.includes(item.message.id)));
      failPi(paneId, matching.filter((item) => result.unavailable?.includes(item.message.id)), "budget");
      failPi(paneId, matching.filter((item) => result.ambiguous?.includes(item.message.id)), "ambiguous");
      if (result.consumed.length === 0) return;
      const consumed = new Set(matching.filter((item) => activePiReceipt(paneId, item) && result.consumed.includes(item.message.id)).map((item) => item.message.id));
      for (const item of matching) if (consumed.has(item.message.id)) {
        releasePiSlot(item);
        if (item.resumeKey) piCompleted.push({ paneId, key: item.resumeKey, id: item.message.id, at: Date.now() });
      }
      prunePi();
      const retained = (piTyped.get(paneId) ?? []).filter((item) => !consumed.has(item.message.id));
      if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
      if (!retained.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      publishPi(paneId, matching.filter((item) => consumed.has(item.message.id)).map((item) => ({ owner: item.owner, id: item.message.id, outcome: "consumed" as const })));
    }).catch(() => {});
  }
  const discardPiReceipt = (owner: Client, paneId: string, id: string): boolean => {
    const items = piTyped.get(paneId);
    const item = items?.find((candidate) => candidate.owner === owner && candidate.message.id === id);
    if (!item || item.message.error?.code === "pi_transcript_pending") return false;
    const retained = items!.filter((candidate) => candidate !== item);
    if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
    publishPi(paneId, [{ owner, id, outcome: "discarded" }]);
    return true;
  };

  function pendingLease(owner: Client, paneId: string): PendingLease {
    const sighting = sight(owner, paneId);
    if (!sighting.facts().attached) throw new HerdrError("input_not_ready", "The pane is not attached and ready");
    let authorities = pendingAuthorities.get(owner);
    if (!authorities) { authorities = new Map(); pendingAuthorities.set(owner, authorities); }
    let authority = authorities.get(paneId);
    if (!authority) { authority = {}; authorities.set(paneId, authority); }
    const lease = { sighting, authority };
    authorizePending(owner, paneId, lease);
    return lease;
  }
  // Losing authority cancels already-running checks too. Rejoining the same shared
  // attachment or returning to interact must never revive a captured lease.
  function holdPending(owner: Client, paneId?: string): void {
    if (paneId === undefined) pendingAuthorities.delete(owner);
    else pendingAuthorities.get(owner)?.delete(paneId);
    pending.hold(owner, paneId);
    holdRequested(owner, paneId);
  }
  function holdRequested(client: Client, paneId?: string): void {
    const items = requested.get(client);
    if (!items) return;
    for (const item of [...items]) {
      if (paneId !== undefined && item.paneId !== paneId) continue;
      items.delete(item);
      requesters.delete(item);
      pending.holdItem(item, FIRST_MESSAGE_UNATTENDED);
      drainPending(item.paneId);
    }
  }
  function holdPendingPane(paneId: string, fault: { code: string; message: string }): void {
    for (const owner of clients) pendingAuthorities.get(owner)?.delete(paneId);
    pending.holdPane(paneId, fault);
    failPi(paneId, piTyped.get(paneId) ?? []);
    if (fault.code === "pane_not_found") {
      for (const message of pending.list(FIRST_MESSAGE_OWNER, paneId)) {
        const item = pending.get(FIRST_MESSAGE_OWNER, paneId, message.id);
        if (item) pending.discard(item);
      }
      firstReceipts.delete(paneId);
      ompUnknown.delete(paneId);
      forgetOmpStart(paneId);
      endedPanes.delete(paneId);
      endedPanes.set(paneId, Date.now());
      if (endedPanes.size > PI_RESUME_LIMIT) endedPanes.delete(endedPanes.keys().next().value!);
      for (let at = completed.length - 1; at >= 0; at--) {
        const entry = completed[at]!;
        if (entry.paneId !== paneId) continue;
        if (entry.outcome === "held") completed.splice(at, 1);
        else if (entry.outcome === "sending") entry.gone = true;
      }
    }
  }
  function movePendingPane(from: string, to: string): void {
    if (from === to) return;
    const fault = { code: "pane_moved", message: "The pane moved to another workspace; review this message and send it again" };
    holdPendingPane(from, fault);
    pending.move(from, to, fault);
    forgetOmpStart(from);
    ompUnknown.delete(from);
    const receipts = firstReceipts.get(from);
    firstReceipts.delete(from);
    if (receipts) firstReceipts.set(to, [...firstReceipts.get(to) ?? [], ...receipts].slice(-FIRST_MESSAGE_RECEIPTS));
    for (const entry of completed) if (entry.paneId === from) entry.paneId = to;
    const typed = piTyped.get(from);
    piTyped.delete(from);
    piConsumed.delete(from);
    if (typed) {
      piTyped.set(to, [...piTyped.get(to) ?? [], ...typed]);
      publishPi(to);
    }
  }
  function authorizePending(owner: Client, paneId: string, lease: PendingLease): void {
    authorizeSocket(owner);
    if (!clients.has(owner) || connectionOf(owner).closing) throw new HerdrError("disconnected", "The pending message's connection closed");
    if (pendingAuthorities.get(owner)?.get(paneId) !== lease.authority) throw new HerdrError("pending_lease_lost", "The pending message's authority changed; review it before sending again");
    const facts = lease.sighting.facts();
    if (facts.currentHeld) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
    if (!typingGuards.pendingLease(facts)) throw new HerdrError("input_not_ready", "The pending message's pane connection changed");
  }
  async function currentIdentity(paneId: string, bound: number | null = null, kind: string | null = null): Promise<{ pane: HerdrPane; identity: PendingIdentity; shellPid: number | null; processes: ProcessInfo | undefined;
    recognized: boolean;
    held: { pid: number; started: number | null } | null }> {
    const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const base = pendingIdentity(pane);
    const pick = async (info: ProcessInfo | undefined): Promise<{ pid: number | null; held: { pid: number; started: number | null } | null }> => {
      const held = base.agent === "omo" ? await heldOmoProcess(pane, info?.foreground_processes ?? [], undefined, bound) : null;
      const agent = base.agent ?? kind;
      const foreground = info?.foreground_processes ?? [];
      return { pid: agentProcessInFront(info, agent, bound, held?.pid)?.pid
        ?? foreground.find((entry) => entry.pid !== info?.shell_pid && runsAgentProgram(entry, agent))?.pid
        ?? foreground[0]?.pid ?? null, held };
    };
    const inFront = (info: ProcessInfo | undefined, pid: number | null): boolean =>
      pid === null ? (info?.foreground_processes ?? []).length === 0 : (info?.foreground_processes ?? []).some((entry) => entry.pid === pid);
    let info = await paneProcessInfo(paneId);
    for (let attempt = 1; ; attempt++) {
      const { pid, held } = await pick(info);
      const processBirth = pid === null ? null : await processStartedAtAsync(pid);
      const claudeSession = base.agent === "claude" ? await claudeForegroundSession(info?.foreground_processes ?? []) : null;
      const after = await paneProcessInfo(paneId);
      const settled = inFront(after, pid);
      if (settled || attempt === 3) {
        const processPid = settled ? pid : (await pick(after)).pid;
        const processHeld = settled && held?.pid === pid && held.started !== null && held.started === processBirth ? held : null;
        const entry = after?.foreground_processes?.find((candidate) => candidate.pid === processPid);
        // Windows names only the pane's shell in front, whatever runs in it, and has no foreground process group
        // (windows-processes.ts): which program takes the pane's input cannot be told there, so no agent is recognized
        // and a message for an agent alone is refused (#511, a known limit)
        const recognized = process.platform !== "win32" && entry !== undefined && runsAgentProgram(entry, base.agent);
        return { pane, shellPid: after?.shell_pid ?? null, processes: after, held: processHeld, recognized, identity: {
          ...base, processPid, processBirth: settled ? processBirth : null,
          omoSession: omo.sessionOf(paneId)?.sessionId ?? null,
          claudeSession: settled ? claudeSession : null,
        } };
      }
      info = after;
    }
  }
  /**
   * The process a check passed for is still in front, read once more after the awaits that followed it and just
   * before a write: herdr cannot compare and send in one step, so this keeps the window to the write's own call.
   */
  async function stillInFront(paneId: string, current: number | null | undefined, pinned: PendingIdentity | null = null, agentOnly = false): Promise<void> {
    const pid = pinned?.processPid ?? current;
    const inFront = async (): Promise<NonNullable<ProcessInfo["foreground_processes"]>> => {
      if (agentOnly) {
        const now = await currentIdentity(paneId, pid ?? null);
        if (pid == null || now.identity.processPid !== pid || !agentRuns(now.identity, now.recognized)) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
        return now.processes?.foreground_processes ?? [];
      }
      const foreground = (await paneProcessInfo(paneId))?.foreground_processes ?? [];
      if (pid != null && !foreground.some((entry) => entry.pid === pid)) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
      return foreground;
    };
    // /clear and /resume switch Claude's session in the same process, so its PID in front says nothing of the
    // session the message is pinned to: that is read from Claude's own records (once more for a record caught being
    // rewritten), and the process is then asked for again, as one that left the front still alive keeps its record
    // (#2279). Neither can be compared in the write's own call: a switch during that last herdr read is not seen
    const session = pinned?.agent === "claude" ? pinned.claudeSession ?? null : null;
    if (pid == null && session === null && !agentOnly) return;
    const foreground = await inFront();
    if (session !== null) {
      if ((await claudeForegroundSession(foreground) ?? await claudeForegroundSession(foreground)) !== session) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
      await inFront();
    }
    await sameStart(pinned);
  }
  async function sameStart(pinned: PendingIdentity | null): Promise<void> {
    if (pinned?.processPid == null || pinned.processBirth == null) return;
    const birth = await processStartedAtAsync(pinned.processPid);
    if (!samePendingIdentity(pinned, { ...pinned, processBirth: birth })) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
  }
  async function noMaskedPrompt(paneId: string, cols: number | undefined, pinned: PendingIdentity | null): Promise<void> {
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    const own = pinned?.agent === "codex" ? codexScreenRefusal(screen, parseInteractivePrompt("codex", screen, null, true, [], null), "unknown") : null;
    if (own !== null) throw own;
    if (pinned?.agent && agentPickerWaits(pinned.agent, screen)) throw agentPickerRefusal();
    await sameStart(pinned);
  }
  async function pendingContext(owner: Client, paneId: string, lease: PendingLease, identity?: PendingIdentity, pasted = false, agentOnly = false): Promise<{ pane: HerdrPane; identity: PendingIdentity; working: boolean; screen: string; processes: ProcessInfo | undefined; held: { pid: number; started: number | null } | null; collapsed: boolean; agentInFront: boolean }> {
    authorizePending(owner, paneId, lease);
    let { pane, identity: current, processes, held: holder, recognized } = await currentIdentity(paneId, identity?.processPid ?? null);
    const unknown = (): boolean => identity?.claudeSession != null && current.claudeSession == null;
    if (unknown()) ({ pane, identity: current, processes, held: holder, recognized } = await currentIdentity(paneId, identity?.processPid ?? null));
    const lost = unknown();
    if (identity && (!samePendingIdentity(identity, current) || lost)) {
      throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
    }
    if (identity) {
      identity.session ??= current.session;
      identity.processPid ??= current.processPid;
      identity.processBirth ??= current.processBirth;
      identity.omoSession ??= current.omoSession;
      identity.claudeSession ??= current.claudeSession;
    }
    // the live screen, not the viewport: a pane scrolled into its history still draws its next
    // menu or password prompt at the bottom (server/prompt.ts liveScreen)
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, lease.sighting.facts().cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    const collapsed = current.agent === "codex" && codexQuestionsCollapsed(screen);
    const held = !pasted && current.agent === "claude" ? heldCandidate(paneId) : null;
    const prompt = current.agent ? parseInteractivePrompt(current.agent, screen, null, true, [], held) : null;
    const waits = prompt !== null && !(pasted && isClaudeHeld(prompt)) && !(await claudeHeldIsGrey(paneId, prompt));
    const own = current.agent === "codex" ? codexScreenRefusal(screen, waits ? prompt : null, pane.agent_status === "blocked" ? "blocked" : "rest") : null;
    if (own !== null) throw own;
    if (current.agent && pane.agent_status !== "blocked" && agentPickerWaits(current.agent, screen)) throw agentPickerRefusal();
    if (current.agent && (waits || registry.waits(current.agent, screen) || (pane.agent_status === "blocked" && !collapsed))) {
      throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
    }
    if (current.agent && !["working", "idle", "done"].includes(pane.agent_status) && !collapsed) {
      throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
    }
    await stillInFront(paneId, current.processPid, identity ?? null, agentOnly);
    authorizePending(owner, paneId, lease);
    const agentInFront = agentRuns(current, recognized);
    return { pane, identity: current, working: current.agent !== null && (pane.agent_status === "working" || collapsed), screen, processes, held: holder, collapsed, agentInFront };
  }

  async function dispatchPendingText(owner: Client, paneId: string, text: string, lease: PendingLease, identity: PendingIdentity,
    automatic: boolean, arrivedAt: number, committing: (working: boolean, restarting?: boolean) => void = () => {}, interruptWorkingCodex = false,
    requestId = 0, agentOnly = false, queued = false,
    row: { withdrawn?: () => boolean; waiting?: (waits: boolean) => void } = {}): Promise<SubmitReply> {
    let wrote = false;
    let stranded = false;
    let watch: OpenCodeWatch | null = null;
    let piReservation: PiReceiptReservation<Client> | null = null;
    let mark = pending.mark(paneId);
    try {
      const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
      // fixed wait: herdr holds a lone ESC typed into the pty ~150ms, so a Stop tapped just before reaches the pane first
      if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
      mark = pending.mark(paneId);
      let context = await pendingContext(owner, paneId, lease, identity);
      let waitedForOmp = false, endsOmpStart = false;
      if (context.identity.agent === "omp" && automatic) {
        const until = await ompStartingUntil(paneId, context.pane, options);
        if (until !== null) {
          waitForOmp(paneId, until);
          throw new HerdrError("pending_wait", "omp is still starting; this message waits until it takes input");
        }
      } else if (context.identity.agent === "omp") {
        try {
          const waited = await untilOmpReported(paneId, context.pane, () => {
            authorizePending(owner, paneId, lease);
            if (row.withdrawn?.()) throw new HerdrError("pending_discarded", "This message was discarded while it waited for omp; nothing was typed");
            if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
          }, options, { strict: true, waiting: () => { waitedForOmp = true; row.waiting?.(true); } });
          endsOmpStart = waited.agent_session?.source === "herdr:omp" || !typedSinceStart(paneId);
          if (waited !== context.pane) {
            mark = pending.mark(paneId);
            context = await pendingContext(owner, paneId, lease, identity);
          }
        } finally { if (waitedForOmp) row.waiting?.(false); }
      }
      if (agentOnly && !context.agentInFront) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
      if (agentOnly && context.collapsed) throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
      const sent = closeBackslash(context.identity.agent, modelSwitchText(context.identity.agent, text));
      const piTracked = context.identity.agent !== "pi" || !piRunsCommand(context.pane, text);
      piReservation = piTracked ? reservePiReceipt(owner, context.identity) : null;
      const receiptText = piTracked ? piReceiptText(context.identity, text) : undefined;
      const piTemplate = piTracked && piListsTemplate(context.pane, text);
      if ((automatic || (queued && waitedForOmp)) && (context.working || queueHeld(paneId, false))) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      if (context.identity.agent === "claude") await freeClaudeBox(paneId, context.working, () => authorizePending(owner, paneId, lease), arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS), automatic || queued)
        .catch((error: unknown) => { throw error instanceof InputDraftError ? new InputDraftError(error.draft, context.identity, error.box, error.message) : error; });
      else if (context.identity.agent === "hermes") context.screen = await freeHermesInput(paneId, context.identity);
      else await freeAgentInput(paneId, context.identity.agent, context.identity);
      const opencode = await openCodeSkillsToType(context.pane, prepareCommandSend(context.pane, text, context.screen), text, context.screen, options.openCodeStateDir);
      let command = opencode.sent;
      bindCommandProcess(paneId, command, context.processes, context.pane, context.identity.agent === "omo" ? context.held : undefined);
      const skills = agentOnly ? [] : opencode.skills;
      if (agentOnly && command) command = skillsNotAttached(command, opencode.skills);
      let attached: string[] = [];
      let prompt: PromptPiece[] = [{ pasted: closeMention(sent) }];
      watch = startOpenCodeWatch(context.pane, command, options.openCodeStateDir);
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      await stillInFront(paneId, context.identity.processPid, identity, agentOnly);
      await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      authorizePending(owner, paneId, lease);
      if ((automatic || queued) && queueHeld(paneId, true)) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      const allowed = (): boolean => {
        try { authorizePending(owner, paneId, lease); return true; } catch { return false; }
      };
      wrote = true;
      if (command && skills.length > 0) {
        let typed = false;
        const typing = (): boolean => { const ok = allowed(); typed ||= ok; return ok; };
        const revalidate = async (): Promise<void> => {
          const current = await pendingContext(owner, paneId, lease, identity, typed);
          if (automatic && !typed && (current.working || queueHeld(paneId, false))) throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
        };
        const beforeKey = async (screen: string): Promise<void> => {
          if (secretPrompt(withoutEscapes(screen), lease.sighting.facts().cols) !== null) {
            throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
          }
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
        };
        const result = await typeWithSkills(text, skills, typing, herdrSkillAttachIo(paneId), revalidate, beforeKey).catch((error: unknown) => {
          if (!typed) {
            wrote = false;
            if (error instanceof HerdrError && error.code === "cancelled") authorizePending(owner, paneId, lease);
          }
          throw error;
        });
        attached = result.attached;
        prompt = result.prompt;
        command = skillsNotAttached(command, result.missed);
      } else {
        await paneSendText(paneId, `\u001b[200~${closeMention(sent)}\u001b[201~`, undefined, allowed).catch((error: unknown) => {
          if (error instanceof HerdrError && error.code === "cancelled") { wrote = false; authorizePending(owner, paneId, lease); }
          throw error;
        });
      }
      // fixed wait: the TUI takes the paste before its Enter, which arriving with it could read as a newline
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      const enterRefused = (error: unknown): never => {
        if (agentOnly && error instanceof HerdrError && [TARGET_CHANGED.code, AGENT_NOT_READY.code, "agent_blocked", "pending_wait"].includes(error.code)) {
          stranded = true;
          throw new HerdrError("pasted_not_sent", PASTED_NOT_SENT_MESSAGE);
        }
        throw error;
      };
      let beforeEnter = await pendingContext(owner, paneId, lease, identity, true, agentOnly).catch(enterRefused);
      if (automatic && (beforeEnter.working || queueHeld(paneId, false))) enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
      authorizePending(owner, paneId, lease);
      const beforeCapturePid = beforeEnter.identity.processPid;
      const piAnchor = piTracked ? await preparePiReceipt(paneId, beforeEnter.identity).catch(() => null) : undefined;
      if (piAnchor !== undefined) {
        beforeEnter = await pendingContext(owner, paneId, lease, identity, true, agentOnly).catch(enterRefused);
        if (automatic && (beforeEnter.working || queueHeld(paneId, false))) enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
        await stillInFront(paneId, beforeCapturePid, identity, agentOnly).catch(enterRefused);
      }
      if (agentOnly && !beforeEnter.agentInFront) enterRefused(new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message));
      if (agentOnly && beforeEnter.collapsed) enterRefused(new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal"));
      await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity).catch(enterRefused);
      const resumed = (): boolean => (automatic || queued) && queueHeld(paneId, true);
      const refuseResumed = (): never => enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
      if (resumed()) refuseResumed();
      authorizePending(owner, paneId, lease);
      const steering = !automatic && beforeEnter.working;
      committing(steering);
      // Claude Code queues what Enter commits during a turn; Ctrl+Enter sends it now (#737). herdr
      // encodes the key as the pane asked, and as a plain CR for a program that asked for nothing.
      const sentAt = Date.now();
      let refused = false;
      await paneSendKeys(paneId, [steering && beforeEnter.identity.agent === "claude" ? "ctrl+enter" : "Enter"], undefined, () => allowed() && !(refused = resumed()))
        .catch((error: unknown) => { if (refused) refuseResumed(); throw error; });
      // the screen after its Enter says whether Grok queued the message, also from a Grok read at rest: another client
      // can start a turn before the Enter, and in minimal mode herdr does not tell a running turn. Compared with the
      // queue as read right before that Enter, with this delivery's paste in the prompt
      if (interruptWorkingCodex && beforeEnter.identity.agent === "grok") {
        await sendGrokQueuedNow({
          message: closeMention(sent),
          before: { working: beforeEnter.working, queue: grokQueue(beforeEnter.screen), echo: grokEcho(beforeEnter.screen) },
          delayMs: options.submitDelayMs ?? SUBMIT_DELAY_MS,
          look: async () => {
            const current = await pendingContext(owner, paneId, lease, identity, true, agentOnly);
            authorizePending(owner, paneId, lease);
            return { status: current.pane.agent_status, screen: current.screen };
          },
          lastScreen: async () => (await paneRead({ paneId, source: "detection", format: "text" })).text,
          sendEnter: async () => {
            authorizePending(owner, paneId, lease);
            await paneSendKeys(paneId, ["Enter"], undefined, allowed);
          },
        });
      }
      if (endsOmpStart) forgetOmpStart(paneId);
      if (receiptText !== undefined) {
        try { recordPiTyped(owner, paneId, requestId, receiptText, beforeEnter.identity, piAnchor, piReservation, piTemplate); } catch {}
      }
      let statusAtRead = pending.current(paneId);
      await interruptCodexSteering(interruptWorkingCodex, closeMention(text), { agent: beforeEnter.identity.agent, working: beforeEnter.working, screen: beforeEnter.screen }, {
        read: async () => {
          const status = pending.current(paneId);
          const current = await pendingContext(owner, paneId, lease, identity, true);
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
          statusAtRead = status;
          return { agent: current.identity.agent, working: current.working, screen: current.screen };
        },
        restarting: () => committing(true, true),
        escape: (fresh) => paneSendKeys(paneId, ["Escape"], undefined, () => allowed() && fresh() && pending.current(paneId) === statusAtRead),
      });
      noteSubmitted(paneId, sent, command, sentAt);
      if (command) watch?.commit(command, prompt, attached);
      return { ok: true };
    } catch (error) {
      watch?.cancel();
      if (stranded) return { ok: false, code: "pasted_not_sent", message: PASTED_NOT_SENT_MESSAGE };
      const fault = error instanceof HerdrError && error.code === "submit_changed" ? pendingFault(error, options.herdrFailure)
        : wrote ? { code: "submit_changed", message: "Pending-message delivery could not be confirmed. Check the terminal before sending again." } : pendingFault(error, options.herdrFailure);
      const unannounced = !wrote && error instanceof CodexOwnScreenRefusal;
      if (automatic && !wrote && fault.code === "agent_blocked" && !unannounced) pending.observe(paneId, "blocked", mark);
      if (queued && !wrote && error instanceof InputDraftError && error.identity) return { ok: false, ...fault, refusal: { draft: error.draft, box: error.box, identity: error.identity } };
      return { ok: false, ...fault, ...(unannounced ? { unannounced } : {}) };
    } finally { piCapacity.release(piReservation); }
  }
  async function dispatchPending(item: PendingItem, automatic: boolean, arrivedAt: number, interruptWorkingCodex = false, by: Client | null = isClient(item.owner) ? item.owner : null): Promise<SubmitReply> {
    let reply: SubmitReply;
    try {
      if (by === null) throw new HerdrError("input_not_ready", "No connection has the pane attached to type the message");
      const lease = item.lease ?? pendingLease(by, item.paneId);
      reply = await dispatchPendingText(by, item.paneId, item.message.text, lease, item.identity,
        automatic, arrivedAt, (working, restarting) => pending.committing(item, working, restarting), interruptWorkingCodex, item.message.request_id, item.message.agent_only === true, false,
        { withdrawn: () => withdrawn.has(item), waiting: (waits) => pending.sendingWaitsFor(item, waits ? "omp_starting" : undefined) });
    } catch (error) {
      reply = { ok: false, ...pendingFault(error, options.herdrFailure) };
    }
    const code = reply.code ?? "";
    const requester = requesters.get(item);
    const unattended = automatic && !isClient(item.owner) && (requester === undefined || !present(requester));
    const retryable = (["pending_wait", "agent_blocked"].includes(code) && reply.unannounced !== true) || (!isClient(item.owner) && FIRST_MESSAGE_RETRY_CODES.has(code));
    const fault = reply.ok ? undefined : unattended && retryable ? FIRST_MESSAGE_UNATTENDED : { code: reply.code!, message: reply.message! };
    pending.settle(item, fault, reply.code === "submit_changed" || reply.code === "pasted_not_sent", automatic && retryable && !unattended);
    if (automatic && reply.unannounced === true && fault !== undefined) pending.holdPane(item.paneId, fault);
    return reply;
  }
  function drainPending(paneId: string): void {
    const learning = launchBoundIn(paneId).length > 0;
    if (pending.next(paneId) === null && !learning) return;
    if (pendingDrains.has(paneId)) {
      if (learning) drainAgain.add(paneId);
      return;
    }
    pendingDrains.add(paneId);
    const arrivedAt = Date.now();
    let dispatched = false;
    void serialize(paneId, async () => {
      if (learning) await learnLaunched(paneId);
      const item = pending.next(paneId);
      if (!item) return;
      const requester = requesters.get(item);
      const by = isClient(item.owner) ? item.owner : requester !== undefined && typists(paneId).includes(requester) ? requester : null;
      if (by === null) return;
      const bound = await bindLaunched(item);
      if (bound === "wait") return;
      if (bound === "ended") { holdFor(item, LAUNCH_GONE); drainAgain.add(paneId); return; }
      if (await awaitsOmp(item)) return;
      if (!pending.claim(item, true)) return;
      dispatched = true;
      await dispatchPending(item, true, arrivedAt, false, by);
      takenWithPane(item, arrivedAt);
    }).catch((error) => console.warn("pending message:", pendingFault(error, options.herdrFailure).code)).finally(() => {
      pendingDrains.delete(paneId);
      const again = drainAgain.delete(paneId);
      if (dispatched || again) drainPending(paneId);
    });
  }
  const drainAgain = new Set<string>();
  function takenWithPane(item: PendingItem, since: number): void {
    if (!isClient(item.owner) && (endedPanes.get(item.paneId) ?? -Infinity) >= since && pending.discard(item)) firstReceipts.delete(item.paneId);
  }
  const ompWaits = new Set<string>();
  const ompUnknown = new Map<string, number>();
  const ompStarts = new Map<string, { typed: number; until: number }>();
  const linesTyped = new Map<string, number>();
  const typedCount = (paneId: string): number => typedInto(paneId) + (linesTyped.get(paneId) ?? 0);
  function typedWhileOmpStarted(paneId: string): boolean {
    const start = ompStarts.get(paneId);
    if (!start) return false;
    if (Date.now() >= start.until) {
      if (ompWaits.has(paneId) && typedSinceStart(paneId)) return true;
      forgetOmpStart(paneId);
      return false;
    }
    return typedSinceStart(paneId);
  }
  function typedSinceStart(paneId: string): boolean {
    const start = ompStarts.get(paneId);
    return start !== undefined && typedCount(paneId) !== start.typed;
  }
  function forgetOmpStart(paneId: string): void {
    ompStarts.delete(paneId);
    linesTyped.delete(paneId);
  }
  const withdrawn = new WeakSet<PendingItem>();
  async function awaitsOmp(item: PendingItem): Promise<boolean> {
    const paneId = item.paneId;
    if (ompWaits.has(paneId)) return true;
    if (item.identity.agent !== "omp") return false;
    let until: number | null;
    try {
      const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      until = !pane || pendingIdentity(pane).agent !== "omp" ? null : await ompStartingUntil(paneId, pane, options);
      ompUnknown.delete(paneId);
    } catch {
      const since = ompUnknown.get(paneId) ?? Date.now();
      if (Date.now() - since >= (options.ompStartupMs ?? OMP_STARTUP_MS)) { ompUnknown.delete(paneId); return false; }
      ompUnknown.set(paneId, since);
      if (!ompStarts.has(paneId)) ompStarts.set(paneId, { typed: typedCount(paneId), until: since + (options.ompStartupMs ?? OMP_STARTUP_MS) });
      waitForOmp(paneId, null);
      return true;
    }
    if (until === null) {
      if (typedWhileOmpStarted(paneId)) { pending.holdQueued(paneId, TYPED_WHILE_WAITING); return true; }
      forgetOmpStart(paneId);
      return false;
    }
    if (typedWhileOmpStarted(paneId)) { pending.holdQueued(paneId, TYPED_WHILE_WAITING); return true; }
    waitForOmp(paneId, until);
    return true;
  }
  function waitForOmp(paneId: string, until: number | null): void {
    if (ompWaits.has(paneId)) return;
    ompWaits.add(paneId);
    if (until !== null) {
      const start = ompStarts.get(paneId);
      if (start) start.until = until; else ompStarts.set(paneId, { typed: typedCount(paneId), until });
      pending.waitingFor(paneId, "omp_starting");
    }
    const typedMeanwhile = (): boolean => {
      if (!typedSinceStart(paneId)) return false;
      pending.holdQueued(paneId, TYPED_WHILE_WAITING);
      return true;
    };
    void (async () => {
      for (;;) {
        await Bun.sleep(options.ompReportPollMs ?? OMP_REPORT_POLL_MS);
        if (pending.next(paneId) === null) {
          ompUnknown.delete(paneId);
          if (!typedSinceStart(paneId)) forgetOmpStart(paneId);
          return;
        }
        if (typedMeanwhile() || until === null) return;
        if (Date.now() >= until) {
          console.warn(`[omp] ${paneId}: herdr's omp integration reported no session while omp started; sending anyway`);
          return;
        }
        try {
          const pane = await paneGet(paneId);
          if (pendingIdentity(pane).agent !== "omp" || pane.agent_session?.source === "herdr:omp") return;
        } catch (error) {
          if (pendingFault(error, options.herdrFailure).code === "pane_not_found") return;
        }
      }
    })().finally(() => {
      ompWaits.delete(paneId);
      typedMeanwhile();
      pending.waitingFor(paneId, undefined);
      if (pendingDrains.has(paneId)) drainAgain.add(paneId); else drainPending(paneId);
    });
  }
  async function queueFirstMessage(paneId: string, raw: string, kind: string, requester: string | null = null, launchedPid: number | null = null): Promise<PendingMessage> {
    const text = pendingText(raw);
    const page = requester === null ? undefined : [...clients].find((client) => client.data.connectionId === requester && present(client));
    const message = await serialize(paneId, async () => {
      const { pane, identity, shellPid, processes, held } = await currentIdentity(paneId, launchedPid, kind);
      const launchedProcess = launchedPid !== null
        ? { processPid: launchedPid, processBirth: identity.processPid === launchedPid ? identity.processBirth : await processStartedAtAsync(launchedPid) }
        : identity.processPid !== null && identity.processPid !== undefined && identity.processPid !== shellPid
          && runsAgentProgram(processes?.foreground_processes?.find((entry) => entry.pid === identity.processPid) ?? {}, kind)
          ? { processPid: identity.processPid, processBirth: identity.processBirth } : {};
      const sessions = identity.agent === kind
        ? { session: identity.session, omoSession: identity.omoSession ?? null, claudeSession: identity.claudeSession ?? null } : { session: null };
      const item = pending.enqueue(FIRST_MESSAGE_OWNER, paneId, nextFirstRequestId--, text, null,
        { agent: kind, terminalId: pane.terminal_id, ...sessions, ...launchedProcess });
      launchBound.add(item);
      if (kind === "omp" && !ompStarts.has(paneId)) ompStarts.set(paneId, { typed: typedCount(paneId), until: Date.now() + (options.ompStartupMs ?? OMP_STARTUP_MS) });
      learn(item, identity, shellPid, processes, held);
      if (page === undefined || !present(page)) pending.holdItem(item, FIRST_MESSAGE_UNATTENDED);
      else {
        requesters.set(item, page);
        requested.set(page, (requested.get(page) ?? new Set()).add(item));
      }
      return item.message;
    });
    drainPending(paneId);
    return { ...message };
  }
  function learn(item: PendingItem, identity: PendingIdentity, shellPid: number | null, processes: ProcessInfo | undefined, held: { pid: number } | null = null): void {
    if (identity.terminalId !== item.identity.terminalId || identity.agent !== item.identity.agent || !samePendingIdentity(item.identity, identity)) return;
    item.identity.session ??= identity.session;
    if (identity.processPid !== shellPid) {
      const foreground = (processes?.foreground_processes ?? []).filter((entry) => entry.pid !== shellPid);
      const entry = foreground.find((candidate) => candidate.pid === identity.processPid);
      if (identity.processPid == null || held?.pid === identity.processPid
        || (entry !== undefined && (foreground.length === 1 || !runsOtherProgram(entry, item.identity.agent)))) {
        item.identity.processPid ??= identity.processPid;
        item.identity.processBirth ??= identity.processBirth;
      }
      const name = identity.processPid === item.identity.processPid ? processName(processes, identity.processPid) : undefined;
      if (name) launchedNames.set(item, name);
    }
    item.identity.omoSession ??= identity.omoSession;
    item.identity.claudeSession ??= identity.claudeSession;
  }
  async function learnLaunched(paneId: string): Promise<void> {
    const items = launchBoundIn(paneId);
    if (items.length === 0) return;
    for (const item of items) {
      const { identity, shellPid, processes, held } = await currentIdentity(paneId, item.identity.processPid ?? null);
      if (launchGone(item, identity, shellPid, processes)) holdFor(item, LAUNCH_GONE);
      else if (identity.processBirth == null && item.identity.processBirth != null && identity.processPid === item.identity.processPid) continue;
      else if (targetChanged(item, identity)) holdFor(item, TARGET_CHANGED);
      else learn(item, identity, shellPid, processes, held);
    }
  }
  async function bindLaunched(item: PendingItem): Promise<"bound" | "wait" | "ended"> {
    if (!launchBound.has(item)) return "bound";
    const { identity, shellPid, processes, held } = await currentIdentity(item.paneId, item.identity.processPid ?? null);
    if (launchGone(item, identity, shellPid, processes)) return "ended";
    if (identity.terminalId === item.identity.terminalId && identity.agent === null) return "wait";
    learn(item, identity, shellPid, processes, held);
    return "bound";
  }
  function targetChanged(item: PendingItem, identity: PendingIdentity): boolean {
    return identity.terminalId !== item.identity.terminalId || (identity.agent !== null && !samePendingIdentity(item.identity, identity));
  }
  function launchGone(item: PendingItem, identity: PendingIdentity, shellPid: number | null, processes: ProcessInfo | undefined): boolean {
    const launched = item.identity.processPid;
    if (launched == null || identity.terminalId !== item.identity.terminalId) return false;
    const front = processName(processes, identity.processPid);
    const launchedName = launchedNames.get(item);
    const shellBack = shellPid !== null && identity.processPid === shellPid && identity.agent === item.identity.agent
      && front !== undefined && launchedName !== undefined && front !== launchedName;
    if (identity.agent !== null && !shellBack) return false;
    return identity.processPid !== launched
      || (item.identity.processBirth != null && identity.processBirth != null
        && Math.abs(identity.processBirth - item.identity.processBirth) > (process.platform === "darwin" ? 1000 : 0));
  }
  function closeConnection(client: Client): void {
    // Keep bounded presentation-only receipts across transient loss, not input authority.
    // Revocation/read-only transitions do not retain a resumable presentation.
    let resumable = true;
    try { authorizeSocket(client); } catch { resumable = false; }
    if (!resumable) {
      const keys = receiptKeys.get(client);
      if (keys) for (const id of keys.keys()) {
        const at = completed.findIndex((entry) => entry.id === id && entry.outcome === "held");
        if (at >= 0) completed.splice(at, 1);
      }
    }
    pending.close(client);
    holdRequested(client);
    requested.delete(client);
    for (const [paneId, items] of piTyped) {
      const drop = (item: PiTypedReceipt): boolean => item.owner === client && (!resumable || !item.resumeKey);
      for (const item of items) if (drop(item)) releasePiSlot(item);
      const retained = items.filter((item) => !drop(item));
      if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
      if (!retained.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      // Reload can attach its successor before the old socket's close reaches us.
      // Rebind presentation only; never call drainPending or recover an input lease.
      for (const successor of clients) if (successor !== client && livePiOwner(successor) && successor.data.attached.has(paneId)) {
        if (resumePi(successor, paneId, client)) {
          publishPi(paneId);
          void reconcilePiDeliveries(paneId);
        }
      }
    }
    prunePi();
  }
  function resumePi(client: Client, paneId: string, closing?: Client): boolean {
    let rebound = false;
    const key = resumeKey(client, paneId);
    if (key && connectionOf(client).mode !== "observe") {
      try {
        authorizeSocket(client);
        for (const item of piTyped.get(paneId) ?? []) {
          if (item.resumeKey !== key || livePiOwner(item.owner) && item.owner !== closing) continue;
          if (piSlots.has(item)) {
            if (!piCapacity.retain(client)) continue;
            piCapacity.remove(item.owner);
          }
          item.owner = client;
          rebound = true;
        }
        const mine = completed.filter((item) => item.paneId === paneId && item.key === key);
        const removed = [
          ...piCompleted.filter((item) => item.paneId === paneId && item.key === key).map(({ id }) => ({ id, outcome: "consumed" as const })),
          ...mine.flatMap(({ id, outcome }) => outcome === "sent" || outcome === "discarded" ? [{ id, outcome, resumed: true as const }] : []),
        ];
        const held = mine.filter(({ outcome }) => outcome === "held");
        if (removed.length || held.length) send(client, { type: "pending-messages", pane_id: paneId, messages: [], ...(removed.length ? { removed } : {}), ...(held.length ? heldPart(held) : {}) });
      } catch {}
    }
    return rebound;
  }
  function heldPart(entries: ReadonlyArray<{ id: string; at: number }>): { held: string[]; held_ms: Record<string, number>; held_until: Record<string, number>; server_time: number } {
    const now = Date.now(), left = (at: number): number => Math.max(0, at + PI_RESUME_MS - elapsed());
    return { held: entries.map(({ id }) => id), held_ms: Object.fromEntries(entries.map(({ id, at }) => [id, left(at)])),
      held_until: Object.fromEntries(entries.map(({ id, at }) => [id, now + left(at)])), server_time: now };
  }
  function pushResumed(owner: Client, paneId: string, kept: string, part: { removed: PendingRemoval[] } | ReturnType<typeof heldPart>): void {
    for (const successor of clients) {
      if (successor === owner || !livePiOwner(successor) || !successor.data.attached.has(paneId)
        || resumeKey(successor, paneId) !== kept || connectionOf(successor).mode === "observe") continue;
      try {
        authorizeSocket(successor);
        send(successor, { type: "pending-messages", pane_id: paneId, messages: [], ...part });
      } catch {}
    }
  }
  function keepReceipts(owner: Client, paneId: string, messages: PendingMessage[], removed: readonly PendingRemoval[] | undefined): void {
    let resumable = true;
    try { authorizeSocket(owner); } catch { resumable = false; }
    const key = resumable ? resumeKey(owner, paneId) : undefined;
    const keys = receiptKeys.get(owner) ?? new Map<string, string>();
    if (key) for (const message of messages) if (!keys.has(message.id)) keys.set(message.id, key);
    for (const message of messages) {
      const kept = resumable ? keys.get(message.id) : undefined;
      if (!kept) continue;
      const existing = completed.findIndex((entry) => entry.id === message.id && entry.outcome !== "sending");
      if (message.state !== "held") {
        if (existing >= 0 && completed[existing]!.outcome === "held") completed.splice(existing, 1);
        continue;
      }
      if (existing >= 0 && completed[existing]!.outcome === "held" && completed[existing]!.paneId === paneId) continue;
      if (livePiOwner(owner)) continue;
      const ended = endedPanes.get(paneId);
      if (ended !== undefined && Date.parse(message.created_at) <= ended) continue;
      if (existing >= 0) completed.splice(existing, 1);
      const at = elapsed();
      completed.push({ paneId, key: kept, id: message.id, outcome: "held", at });
      pushResumed(owner, paneId, kept, heldPart([{ id: message.id, at }]));
    }
    for (const item of removed ?? []) {
      const kept = keys.get(item.id);
      keys.delete(item.id);
      const existing = completed.findIndex((entry) => entry.id === item.id && entry.outcome !== "sending");
      if (existing >= 0 && (item.outcome !== "dismissed" || completed[existing]!.outcome === "held")) completed.splice(existing, 1);
      if (!kept || (item.outcome !== "sent" && item.outcome !== "discarded")) continue;
      completed.push({ paneId, key: kept, id: item.id, outcome: item.outcome, at: elapsed() });
      pushResumed(owner, paneId, kept, { removed: [{ id: item.id, outcome: item.outcome, resumed: true }] });
    }
    if (keys.size) receiptKeys.set(owner, keys); else receiptKeys.delete(owner);
    prunePi();
  }
  function attached(client: Client, paneId: string): void {
    prunePi();
    resumePi(client, paneId);
    const messages = [...pending.list(FIRST_MESSAGE_OWNER, paneId), ...piMessages(paneId, client)];
    const removed = firstReceipts.get(paneId) ?? [];
    if ((messages.length > 0 || removed.length > 0) && connectionOf(client).mode !== "observe") {
      send(client, { type: "pending-messages", pane_id: paneId, messages, ...(removed.length > 0 ? { removed } : {}) });
    }
    drainPending(paneId);
    if (piTyped.has(paneId)) void reconcilePiDeliveries(paneId);
  }
  function replayPendingOutcome(owner: Client, paneId: string, id: string): boolean {
    const outcome = pending.outcome(owner, paneId, id) ?? pending.outcome(FIRST_MESSAGE_OWNER, paneId, id);
    if (!outcome) return false;
    send(owner, { type: "pending-messages", pane_id: paneId, messages: pending.list(owner, paneId), removed: [{ id, outcome }] });
    return true;
  }

  const pendingFrames = {
    async submit(client: Client, message: Frame<"submit">): Promise<void> {
      const result = (ok: boolean, code?: string, text?: string, accepted?: PendingMessage, draft?: string | null, box?: string | null, typedNow = false, sendingAt?: string) => send(client, {
        type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(accepted ? { pending: accepted } : {}), ...(typedNow ? { typed_now: true as const } : {}), ...(code ? { code, message: text } : {}),
        ...(ok && sendingAt ? { sending_at: sendingAt } : {}),
        ...(draft ? { draft } : {}), ...(!draft && typeof box === "string" ? { box } : {}),
      });
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
        || typeof message.text !== "string" || typeof message.payload !== "string") {
        send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
        return;
      }
      const waits = message.delivery === "queue" || message.delivery === "hold";
      if ((message.delivery !== undefined && message.delivery !== "immediate" && !waits)
        || (waits && message.typed !== undefined && message.typed !== false)) {
        result(false, "invalid_delivery", "Use immediate delivery, or queue or hold a chat message");
        return;
      }
      if (message.clear_draft !== undefined && (typeof message.clear_draft !== "string" || !message.clear_draft
        || waits || (message.typed !== undefined && message.typed !== false))) {
        result(false, "invalid_delivery", "Clear a terminal draft only for a chat message sent at once");
        return;
      }
      if (message.send_anyway !== undefined && (message.send_anyway !== true || waits || message.clear_draft !== undefined
        || (message.typed !== undefined && message.typed !== false))) {
        result(false, "invalid_delivery", "Send anyway only a chat message sent at once, without clearing a draft");
        return;
      }
      if (message.resend_id !== undefined && (typeof message.resend_id !== "string" || !message.resend_id || message.resend_id.length > 128
        || waits || message.typed === true || message.clear_draft !== undefined || message.send_anyway !== undefined)) {
        result(false, "invalid_delivery", "Use a held-copy resend id only for an immediate chat message");
        return;
      }
      if (message.resend_generation !== undefined && (!Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0 || message.resend_id === undefined)) {
        result(false, "invalid_delivery", "A resend generation must be a nonnegative integer with a held-copy id");
        return;
      }
      if (message.agent_only !== undefined && (message.agent_only !== true || message.typed === true)) {
        result(false, "invalid_delivery", "Only a chat message can be for an agent alone, with agent_only true");
        return;
      }
      const agentOnly = message.agent_only === true
        || (typeof message.resend_id === "string" && pending.agentOnly(message.pane_id, message.resend_id));
      if (connectionOf(client).mode === "observe") {
        result(false, "read_only", "this connection is in observe mode");
        return;
      }
      if (attachments.get(message.pane_id)?.held) {
        result(false, "attach_held", ATTACH_HELD_MESSAGE);
        return;
      }
      let framed = { text: message.text, payload: message.payload };
      if (!waits) {
        try { framed = submitFraming(message.text, message.payload, message.typed === true); }
        catch (error) { const fault = pendingFault(error, options.herdrFailure); result(false, fault.code, fault.message); return; }
      }
      const arrivedAt = Date.now();
      try {
        if (waits) {
          let book = pendingRequests.get(client);
          if (!book) { book = new PendingRequestBook((reply: SubmitReply) => reply.pending !== undefined && pending.retains(client, reply.pending.id)); pendingRequests.set(client, book); }
          const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([message.pane_id, message.text, message.payload, message.delivery, agentOnly])).digest("hex");
          const previous = book.get(message.id, fingerprint);
          const lease = previous ? null : pendingLease(client, message.pane_id);
          const reply = previous ?? book.run(message.id, fingerprint, () => serialize(message.pane_id, async (): Promise<SubmitReply> => {
            const text = pendingText(message.text);
            const mark = pending.mark(message.pane_id);
            const context = await pendingContext(client, message.pane_id, lease!);
            if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "This pending message waited too long; nothing was typed");
            if (agentOnly && !context.agentInFront) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
            const held = queueHeld(message.pane_id, false);
            let waited = false;
            if (!context.working && !held) {
              if (context.identity.agent === null) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
              if (message.delivery === "queue" && !pending.waiting(message.pane_id) && !typedWhileOmpStarted(message.pane_id)) {
                const sendingAt = new Date().toISOString();
                const typed = await dispatchPendingText(client, message.pane_id, text, lease!, context.identity, false, arrivedAt, undefined, false, message.id, agentOnly, true);
                if (typed.ok || typed.code !== "pending_wait") return typed.ok ? { ...typed, sending_at: sendingAt } : typed;
                waited = true;
              }
            }
            if (!waited) pending.observe(message.pane_id, held && !context.working ? "working" : context.pane.agent_status, mark);
            const item = pending.enqueue(client, message.pane_id, message.id, text, lease!, context.identity, message.delivery === "hold", agentOnly);
            if (typedWhileOmpStarted(message.pane_id)) pending.holdQueued(message.pane_id, TYPED_WHILE_WAITING);
            return { ok: true, pending: item.message };
          }).catch((error): SubmitReply => ({ ok: false, ...pendingFault(error, options.herdrFailure) })));
          const answer = await reply;
          const accepted = answer.pending ? pending.get(client, message.pane_id, answer.pending.id)?.message : undefined;
          if (answer.pending && !accepted) replayPendingOutcome(client, message.pane_id, answer.pending.id);
          const refusal = answer.refusal;
          if (refusal && (refusal.draft || refusal.box !== null)) {
            let confirmations = draftConfirmations.get(client);
            if (!confirmations) { confirmations = new Map(); draftConfirmations.set(client, confirmations); }
            confirmations.set(message.pane_id, refusal);
          }
          const typedNow = !previous && answer.ok && answer.pending === undefined;
          result(answer.ok, answer.code, answer.message, accepted, refusal?.draft ?? null, refusal && refusal.box !== null ? shownInputBox(refusal.box) : null,
            typedNow, typedNow ? answer.sending_at : undefined);
          drainPending(message.pane_id);
          return;
        }
        let sendingAt: string | undefined;
        let behind: PendingMessage | undefined;
        const dispatch = async () => {
          if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
          if (message.typed !== true && message.resend_id === undefined && message.clear_draft === undefined && message.send_anyway !== true
            && ((ompWaits.has(message.pane_id) && pending.waiting(message.pane_id)) || typedWhileOmpStarted(message.pane_id))) {
            const lease = pendingLease(client, message.pane_id);
            const context = await pendingContext(client, message.pane_id, lease);
            behind = pending.enqueue(client, message.pane_id, message.id, pendingText(message.text), lease, context.identity, false, agentOnly).message;
            if (typedWhileOmpStarted(message.pane_id)) pending.holdQueued(message.pane_id, TYPED_WHILE_WAITING);
            return;
          }
          if (message.typed === true && ompStarts.has(message.pane_id)) linesTyped.set(message.pane_id, (linesTyped.get(message.pane_id) ?? 0) + 1);
          const current = message.typed === true ? null : await currentIdentity(message.pane_id);
          if (agentOnly && (current === null || !agentRuns(current.identity, current.recognized))) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
          const identity = current === null || (current.identity.agent === "pi" && piRunsCommand(current.pane, framed.text)) ? null : current.identity;
          const reservation = identity === null ? null : reservePiReceipt(client, identity);
          try {
            const receiptText = identity === null ? undefined : piReceiptText(identity, framed.text);
            const piAnchor = identity === null ? null : await preparePiReceipt(message.pane_id, identity).catch(() => null);
            sendingAt = new Date().toISOString();
            await submitText(message.pane_id, framed.text, framed.payload, arrivedAt, message.typed === true, () => authorizeSocket(client), message.clear_draft,
              draftConfirmations.get(client)?.get(message.pane_id), message.send_anyway === true, agentOnly, message.resend_id !== undefined);
            if (identity !== null && receiptText !== undefined) {
              try { recordPiTyped(client, message.pane_id, message.id, receiptText, identity, piAnchor, reservation, current !== null && piListsTemplate(current.pane, framed.text)); } catch {}
            }
          } finally { piCapacity.release(reservation); }
        };
        if (message.resend_id !== undefined) {
          authorizeSocket(client);
          const id = message.resend_id, pane = message.pane_id, key = resumeKey(client, pane);
          const hash = new Bun.CryptoHasher("sha256").update(framed.text).digest("hex");
          let typedNow = false;
          const answer = await serialize(pane, async () => {
            if (completed.some((entry) => entry.id === id && entry.outcome === "sending")) return { ok: false, code: "pending_busy", message: "This message is already being sent" };
            if (completed.some((entry) => entry.id === id && entry.outcome === "sent" && entry.paneId === pane && (entry.hash === undefined || entry.hash === hash))) return { ok: true };
            if (completed.some((entry) => entry.id === id && entry.outcome === "uncertain" && entry.paneId === pane)) return { ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" };
            const at = completed.findIndex((entry) => entry.id === id && entry.outcome === "held" && entry.paneId === pane && entry.key === key);
            const held = at >= 0 ? completed.splice(at, 1)[0] : undefined;
            const claim: (typeof completed)[number] = { paneId: pane, key: held?.key ?? key ?? "", id, outcome: "sending", at: elapsed() };
            completed.push(claim);
            const settle = (): void => { const at = completed.indexOf(claim); if (at >= 0) completed.splice(at, 1); };
            const restore = (): void => {
              if (!held || claim.gone) return;
              if (completed.some((entry) => entry.id === id && entry.outcome === "held")) return;
              held.paneId = claim.paneId;
              const back = completed.findIndex((entry) => entry.at > held.at);
              completed.splice(back < 0 ? completed.length : back, 0, held);
            };
            let sent: Awaited<ReturnType<typeof pending.resend>>;
            try {
              sent = await pending.resend(pane, id, hash, async () => {
                try { await dispatch(); typedNow = true; return { ok: true }; }
                catch (error) { return { ok: false, ...pendingFault(error, options.herdrFailure) }; }
              }, message.resend_generation);
            } catch (error) {
              settle();
              restore();
              throw error;
            }
            settle();
            const now = claim.paneId;
            if (sent.ok && (typedNow || held)) {
              if (!completed.some((entry) => entry.id === id && entry.outcome === "sent" && entry.paneId === now)) completed.push({ paneId: now, key: claim.key, id, outcome: "sent", at: elapsed(), hash });
              if (held) pushResumed(client, now, held.key, { removed: [{ id, outcome: "sent", resumed: true }] });
            } else if (!sent.ok && submitNotTyped(sent.code ?? "")) {
              restore();
            } else if (!sent.ok && !completed.some((entry) => entry.id === id && entry.outcome === "uncertain" && entry.paneId === now)) {
              completed.push({ paneId: now, key: claim.key, id, outcome: "uncertain", at: elapsed() });
            }
            prunePi();
            return sent;
          });
          result(answer.ok, answer.code, answer.message, undefined, undefined, undefined, answer.ok && typedNow, typedNow ? sendingAt : undefined);
          return;
        }
        await serialize(message.pane_id, dispatch);
        if (message.clear_draft !== undefined || message.send_anyway) draftConfirmations.get(client)?.delete(message.pane_id);
        result(true, undefined, undefined, behind, undefined, undefined, false, sendingAt);
        if (behind) drainPending(message.pane_id);
      } catch (error) {
        if (message.clear_draft !== undefined || message.send_anyway) draftConfirmations.get(client)?.delete(message.pane_id);
        if (error instanceof InputDraftError && error.identity && (error.draft || error.box !== null)) {
          let confirmations = draftConfirmations.get(client);
          if (!confirmations) { confirmations = new Map(); draftConfirmations.set(client, confirmations); }
          confirmations.set(message.pane_id, { draft: error.draft, identity: error.identity, box: error.box });
        }
        const fault = pendingFault(error, options.herdrFailure);
        result(false, fault.code, fault.message, undefined, error instanceof InputDraftError ? error.draft : null,
          error instanceof InputDraftError && error.identity && error.box !== null ? shownInputBox(error.box) : null);
      }
      return;
    },
    async "pending-action"(client: Client, message: Frame<"pending-action">): Promise<void> {
      const known = ({ unannounced: _, ...reply }: SubmitReply): SubmitReply => reply.code === LAUNCH_GONE.code && message.launch_ended !== true ? { ...reply, code: TARGET_CHANGED.code } : reply;
      const result = (reply: SubmitReply) => send(client, { type: "pending-result", id: message.id, pane_id: message.pane_id, pending_id: message.pending_id, ...known(reply) });
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
        || typeof message.pending_id !== "string" || !message.pending_id || !["steer", "discard"].includes(message.action)) {
        result({ ok: false, code: "invalid_pending_action", message: "Use steer or discard with a pending-message id" }); return;
      }
      if (message.resend_generation !== undefined && (!Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0)) {
        result({ ok: false, code: "invalid_pending_action", message: "A resend generation must be a nonnegative integer" }); return;
      }
      if (message.withdrawal_only !== undefined && (message.withdrawal_only !== true || message.action !== "discard")) {
        result({ ok: false, code: "invalid_pending_action", message: "Withdrawal-only applies to discarding unsent input" }); return;
      }
      const arrivedAt = Date.now();
      try {
        authorizeSocket(client);
        const lease = message.action === "steer" ? pendingLease(client, message.pane_id) : null;
        let marked: PendingItem | undefined;
        if (message.action === "discard") {
          const sending = pending.get(client, message.pane_id, message.pending_id)
            ?? (client.data.attached.has(message.pane_id) ? pending.get(FIRST_MESSAGE_OWNER, message.pane_id, message.pending_id) : undefined);
          if (sending?.inFlight) { marked = sending; withdrawn.add(sending); }
        }
        const answer = await serialize(message.pane_id, async (): Promise<SubmitReply> => {
          if (marked) withdrawn.delete(marked);
          authorizeSocket(client);
          if (!clients.has(client) || connectionOf(client).closing) throw new HerdrError("disconnected", "This connection closed");
          const piReceipt = client.data.attached.has(message.pane_id)
            ? piTyped.get(message.pane_id)?.find((candidate) => candidate.owner === client && candidate.message.id === message.pending_id) : undefined;
          if (piReceipt) {
            if (message.withdrawal_only) return { ok: false, code: "pending_uncertain", message: "This receipt cannot prove withdrawal" };
            if (message.action === "steer") return { ok: false, code: "pending_sent", message: "This message was already sent to Pi" };
            return discardPiReceipt(client, message.pane_id, message.pending_id)
              ? { ok: true } : { ok: false, code: "pending_busy", message: "Pi transcript confirmation is still pending" };
          }
          const item = pending.get(client, message.pane_id, message.pending_id)
            ?? (client.data.attached.has(message.pane_id) ? pending.get(FIRST_MESSAGE_OWNER, message.pane_id, message.pending_id) : undefined);
          if (!item) return replayPendingOutcome(client, message.pane_id, message.pending_id)
            ? { ok: true } : { ok: false, code: "pending_not_found", message: "This pending message does not belong to this connection" };
          if (message.action === "discard") return pending.discard(item, message.withdrawal_only) ? { ok: true }
            : item.message.state === "uncertain" ? { ok: false, code: "pending_uncertain", message: "Check the terminal before changing this message" }
            : { ok: false, code: "pending_busy", message: "This message is already being sent" };
          if (item.message.state === "uncertain") return { ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" };
          let dispatched = false;
          const reply = await pending.resend(item.paneId, item.message.id,
            new Bun.CryptoHasher("sha256").update(item.message.text).digest("hex"), async (): Promise<SubmitReply> => {
              try {
                const bound = await bindLaunched(item);
                if (bound === "wait") return { ok: false, code: "input_not_ready", message: "The agent started for this message is not up yet" };
                if (bound === "ended") return { ok: false, ...LAUNCH_GONE };
                await pendingContext(client, item.paneId, lease!, item.identity);
                if (!pending.claim(item, false)) return { ok: false, code: "pending_busy", message: "This message is already being sent" };
                if (isClient(item.owner)) item.lease = lease!;
                dispatched = true;
                return await dispatchPending(item, false, arrivedAt, true, client);
              } catch (error) { return { ok: false, ...pendingFault(error, options.herdrFailure) }; }
            }, message.resend_generation, (code) => code === "submit_changed");
          if (!dispatched && pending.get(client, item.paneId, item.message.id) === item && pending.claim(item, false))
            pending.settle(item, reply.ok ? undefined : { code: reply.code!, message: reply.message! }, reply.code === "submit_changed");
          if (!dispatched && !isClient(item.owner) && (reply.code === TARGET_CHANGED.code || reply.code === LAUNCH_GONE.code)) pending.rehold(item, { code: reply.code, message: reply.message! });
          takenWithPane(item, arrivedAt);
          if (reply.code === "pending_discarded" && withdrawn.has(item) && pending.discard(item)) return { ok: true };
          return reply;
        });
        result(answer);
        drainPending(message.pane_id);
      } catch (error) { result({ ok: false, ...pendingFault(error, options.herdrFailure) }); }
      return;
    },
  };

  return { pending, holdPending, holdPendingPane, movePendingPane, drainPending, pendingFrames, queueFirstMessage, attached, closeConnection, reconcilePiDeliveries };
}
