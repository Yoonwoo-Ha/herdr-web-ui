/**
 * The screen work behind a chat send, owning no server state: clearing a Claude or Hermes input
 * box before a message, the message's own shape, the refusal a draft earns, and the immediate send
 * itself (createSubmitText), handed the state it reads. Pending delivery and the immediate send
 * share them.
 */
import type { HerdrPane } from "../../shared/protocol.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { agentPrompt, HerdrError, paneGet, paneRead, paneScrollInfo, paneSendKeys, paneSendText } from "../herdr/client.ts";
import { mirrorInput } from "../mirror-input.ts";
import { paneContext } from "../pane-context.ts";
import { CLAUDE_CLEAR_INPUT_KEYS, claudeClearableDraft, claudeInputBoxContent, claudeInputDraft, claudeInputEmpty, claudeRestoredDraft, codexQuestionsCollapsed, heldCandidate, hermesInputDraft, lastChatSubmitted, modelListWaits, noteSubmitted, parseInteractivePrompt, viewportShowsLive } from "../prompt.ts";
import { type PendingIdentity, PendingInputError } from "../pending-input.ts";

const CLAUDE_INPUT_DRAFT_MESSAGE = "Claude Code's input box is not empty (a draft, bash mode, or a box that could not be read); send or clear it in the terminal, then send this message";

const HERMES_INPUT_DRAFT_MESSAGE = "Hermes' input in the terminal is not empty (a draft, or an input that could not be read); send or clear it there, then send this message";

/**
 * input_draft, naming the one-row draft the chat may offer to clear (claudeClearableDraft), or none.
 * `box`: the input box as read, whole (claudeInputBoxContent; the client is shown it cut), which a refusal naming no draft shows so the
 * user may send anyway; null where the refusal offers nothing (after a clear began).
 */
export class InputDraftError extends HerdrError {
  readonly draft: string | null;
  constructor(draft: string | null, readonly identity?: PendingIdentity, readonly box: string | null = null, message = CLAUDE_INPUT_DRAFT_MESSAGE) {
    super("input_draft", message);
    this.draft = draft;
  }
}

/** between the two Esc presses that empty Claude Code's restored copy of the chat's message */
const RESTORED_CLEAR_GAP_MS = 200;

/** after them, before the box is read again */
const RESTORED_CLEAR_SETTLE_MS = 300;

/** what a send must still have of its deadline before the copy is cleared: the clear, the box read again, then the send */
const RESTORED_CLEAR_RESERVE_MS = 2_000;

/**
 * A message whose last word is an `@file` mention leaves the agent's file suggestions open over
 * it, and the Enter after the paste takes the suggestion instead of sending: the message stays in
 * the input box (Claude Code 2.1.295, #404). A space after the mention closes them first; a
 * payload already in bracketed-paste markers gets it inside them.
 */
export const closeMention = (text: string): string => {
  const open = text.startsWith("\u001b[200~") ? "\u001b[200~" : "";
  const close = open && text.endsWith("\u001b[201~") ? "\u001b[201~" : "";
  const body = text.slice(open.length, text.length - close.length);
  return /(?:^|\s)@\S+$/.test(body) ? `${open}${body} ${close}` : text;
};

/** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
export async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
  const pane = await paneGet(paneId).catch((error: unknown) => {
    if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
    throw error;
  });
  if ((pane?.agent ?? pane?.agent_session?.agent) !== "codex") return false;
  // A collapsed queue in scrollback must not bypass an approval on the live screen.
  return codexQuestionsCollapsed((await paneRead({ paneId, source: "detection", format: "text" })).text);
}

export const pendingIdentity = (pane: HerdrPane): PendingIdentity => ({
  agent: pane.agent ?? pane.agent_session?.agent ?? null, terminalId: pane.terminal_id,
  session: pane.agent_session ? `${pane.agent_session.kind}:${pane.agent_session.source}:${pane.agent_session.value}` : null,
});

export const pendingText = (text: string): string => {
  const normalized = text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim() || normalized.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HerdrError("invalid_submit_text", "A pending chat message must be nonempty text, at most 20000 characters, without terminal control characters");
  }
  return normalized;
};

export const pendingFault = (error: unknown) => ({
  code: error instanceof HerdrError || error instanceof PendingInputError ? error.code : "submit_failed",
  message: error instanceof Error ? error.message : String(error),
});

/**
 * Hermes' input, refused with input_draft unless hermesInputDraft knows it empty. As claudeBoxReads,
 * the viewport's colors are read only for an input row with text, and count only once
 * viewportShowsLive verifies them; the live read comes last, so text typed meanwhile is in it.
 * Hermes offers nothing to clear from here: the user sends or clears it in the terminal.
 */
export async function freeHermesInput(paneId: string, identity?: PendingIdentity): Promise<void> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!hermesInputDraft(before, null)) return;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (hermesInputDraft(live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null)) {
    throw new InputDraftError(null, identity, null, HERMES_INPUT_DRAFT_MESSAGE);
  }
}

export async function claudeBoxReads(paneId: string): Promise<[string, string | null]> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!claudeInputDraft(before, null)) return [before, null];
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return [live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null];
}

/**
 * The box check both chat sends share: a Claude Code input box that is not known to be empty is
 * refused, except the chat's own last message, which Claude puts back as typed text when the send
 * right after it is cancelled. That copy, while the agent is not working, two Esc presses empty
 * again — never Ctrl+C, which would arm "press Ctrl-C again to exit" — then the box is read once
 * more before the send. Every other draft, and a box still not empty after them, refuses as before.
 * `authorize` throws once the sender may no longer send: it is asked before each Esc, and again
 * right before herdr is written to. A send with less than RESTORED_CLEAR_RESERVE_MS left before its
 * `deadline` clears nothing: it would erase the copy, then time out without sending.
 */
export async function freeClaudeBox(paneId: string, working: boolean, authorize: () => void, deadline: number): Promise<void> {
  const allowed = (): boolean => { try { authorize(); return true; } catch { return false; } };
  const [live, colors] = await claudeBoxReads(paneId);
  if (!claudeInputDraft(live, colors)) return;
  if (working || claudeRestoredDraft(live, colors, lastChatSubmitted(paneId)) === null) {
    throw new InputDraftError(claudeClearableDraft(live, colors), undefined, claudeInputBoxContent(live));
  }
  if (deadline - Date.now() < RESTORED_CLEAR_RESERVE_MS) throw new HerdrError("submit_timeout", "Too little time was left to clear Claude Code's input box and send; nothing was typed");
  // the read proved the box holds the copy: a lone Esc on an EMPTY box would open Claude's
  // rewind dialog instead
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed);
  // fixed wait: Claude Code takes the second Esc only after a gap
  await Bun.sleep(RESTORED_CLEAR_GAP_MS);
  authorize();
  await paneSendKeys(paneId, ["esc"], undefined, allowed);
  // fixed wait: the box redraws after the two Esc presses before it reads empty
  await Bun.sleep(RESTORED_CLEAR_SETTLE_MS);
  if (claudeInputDraft(...await claudeBoxReads(paneId))) throw new HerdrError("input_draft", CLAUDE_INPUT_DRAFT_MESSAGE);
}

export function createSubmitText({ options, lastTyped, attachments, terminalAttach, SUBMIT_DEADLINE_MS, TYPED_SETTLE_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS, SUBMIT_DELAY_MS }: {
  options: { submitDeadlineMs?: number; submitDelayMs?: number };
  lastTyped: Map<string, number>;
  attachments: ReadonlyMap<string, { cols: number }>;
  terminalAttach: () => Promise<boolean>;
  SUBMIT_DEADLINE_MS: number;
  TYPED_SETTLE_MS: number;
  DRAFT_CLEAR_WAIT_MS: number;
  DRAFT_CLEAR_POLL_MS: number;
  SUBMIT_DELAY_MS: number;
}) {
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

  /**
   * `clearDraft`: the draft an input_draft refusal named, which the user asked to clear and send
   * over. It goes only while the box still holds exactly that, and the message only once the box
   * reads empty.
   * `sendAnyway`: the user saw the box a refusal naming no draft showed and chose to send: only into
   * the Claude terminal and session that refusal was for (`confirmation` with no draft), and only while
   * the box still shows what they saw or reads empty. Never typed instead of agent.prompt.
   */
  async function submitText(paneId: string, text: string, payload: string, arrivedAt: number, fromTerminal = false, authorize: () => void = () => {},
    clearDraft?: string, confirmation?: { draft: string | null; identity: PendingIdentity; box?: string | null }, sendAnyway = false): Promise<void> {
    let clearedDraft = false;
    const inTime = (reserve = 0): void => {
      authorize();
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS) - reserve) {
        throw new HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
      }
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    // fixed wait: herdr holds a lone ESC typed through the attach pty and says nothing when it lets go
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // the terminal's input line stands in for the keyboard: it types what the user wrote, an
    // answer into an open menu included, where agent.prompt would refuse
    try {
      if (!fromTerminal) {
        const pane = await paneGet(paneId).catch((error: unknown) => {
          if (error instanceof HerdrError && error.code === "pane_not_found") return undefined;
          throw error;
        });
        inTime();
        const identity = pane ? pendingIdentity(pane) : null;
        const sameClaude = (current: PendingIdentity | null): boolean => current?.agent === "claude"
          && confirmation !== undefined && confirmation.draft === clearDraft
          && current.terminalId === confirmation.identity.terminalId && current.session === confirmation.identity.session;
        if (clearDraft !== undefined && !sameClaude(identity)) {
          throw new HerdrError("pending_target_changed", "The named draft's Claude terminal or session changed; nothing was cleared or sent");
        }
        if (sendAnyway && !(identity?.agent === "claude" && confirmation !== undefined && confirmation.draft === null
          && identity.terminalId === confirmation.identity.terminalId && identity.session === confirmation.identity.session)) {
          throw new HerdrError("pending_target_changed", "The refused message's Claude terminal or session changed, or nothing was refused; nothing was sent");
        }
        if (sendAnyway) {
          // only over the box the user was shown: anything typed there since is refused again, and shown
          const reads = await claudeBoxReads(paneId);
          inTime();
          const box = claudeInputBoxContent(reads[0]);
          // a box that cannot be read whole cannot be compared: it is refused, and offers no send anyway
          if (claudeInputDraft(...reads) && (box === null || box !== confirmation!.box)) throw new InputDraftError(claudeClearableDraft(...reads), identity ?? undefined, box);
          // the reads waited on herdr: the pane may hold another Claude by now, checked again right before the write
          const now = pendingIdentity(await paneGet(paneId));
          inTime();
          if (now.agent !== "claude" || now.terminalId !== confirmation!.identity.terminalId || now.session !== confirmation!.identity.session) {
            throw new HerdrError("pending_target_changed", "The refused message's Claude terminal or session changed; nothing was sent");
          }
        }
        if ((pane?.agent ?? pane?.agent_session?.agent) === "claude" && !sendAnyway) {
          if (clearDraft === undefined) {
            try {
              await freeClaudeBox(paneId, pane?.agent_status === "working", authorize, arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS));
            } catch (error) {
              if (error instanceof InputDraftError) throw new InputDraftError(error.draft, identity ?? undefined, error.box);
              throw error;
            }
          }
          let reads = await claudeBoxReads(paneId);
          inTime();
          // reads the pane's state first, then the screen the checks and the caller use, so a prompt
          // that opens while the state is read is on that screen
          const clearScreenReady = async (): Promise<void> => {
            const current = await paneGet(paneId);
            if (clearDraft !== undefined && !sameClaude(pendingIdentity(current))) {
              throw new HerdrError("pending_target_changed", "The named draft's Claude terminal or session changed; nothing was cleared or sent");
            }
            reads = await claudeBoxReads(paneId);
            if (secretPrompt(reads[0], attachments.get(paneId)?.cols) !== null
              || parseInteractivePrompt("claude", reads[0], null, true, [], heldCandidate(paneId)) !== null
              || modelListWaits("claude", reads[0]) || current.agent_status === "blocked") {
              throw new HerdrError("agent_blocked", "The terminal is waiting for an answer; its draft was not cleared");
            }
            if (!["working", "idle", "done"].includes(current.agent_status)) {
              throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
            }
          };
          if (clearDraft !== undefined) await clearScreenReady();
          if (claudeInputDraft(...reads)) {
            // only the draft the user was shown goes, never what has since replaced it
            const draft = claudeClearableDraft(...reads);
            if (clearDraft === undefined || draft !== clearDraft) throw new InputDraftError(draft, identity ?? undefined, clearDraft === undefined ? claudeInputBoxContent(reads[0]) : null);
            const reserve = DRAFT_CLEAR_WAIT_MS + 500;
            inTime(reserve);
            // A confirmation names the earlier draft, not text typed while it was inspected.
            await clearScreenReady();
            inTime(reserve);
            const currentDraft = claudeClearableDraft(...reads);
            if (currentDraft !== clearDraft) throw new InputDraftError(currentDraft, identity ?? undefined);
            // The final draft comparison and clearing keys are not atomic (herdr has no compare-and-clear),
            // so terminal text another client types moments after the user's explicit "Clear it and send"
            // click can also be cleared.
            // Connecting to herdr also yields: check the budget and authority again at the write.
            const allowed = (): boolean => {
              try { inTime(reserve); clearedDraft = true; return true; } catch { return false; }
            };
            try {
              await paneSendKeys(paneId, CLAUDE_CLEAR_INPUT_KEYS, undefined, allowed);
            } catch (error) {
              if (error instanceof HerdrError && error.code === "cancelled") inTime(reserve);
              throw error;
            }
            clearedDraft = true;
            for (const deadline = Date.now() + DRAFT_CLEAR_WAIT_MS; await clearScreenReady(), claudeInputDraft(...reads);) {
              if (Date.now() >= deadline) throw new InputDraftError(claudeClearableDraft(...reads));
              await Bun.sleep(DRAFT_CLEAR_POLL_MS);
            }
            await clearScreenReady();
            if (!claudeInputEmpty(...reads)) throw new InputDraftError(null);
            inTime();
          }
          if (clearDraft !== undefined && !claudeInputEmpty(...reads)) throw new InputDraftError(null);
        }
        // a clear request or send anyway reached a Hermes pane only to be refused above: both are Claude's
        if ((pane?.agent ?? pane?.agent_session?.agent) === "hermes") {
          await freeHermesInput(paneId, identity ?? undefined);
          inTime();
        }
        try {
          await agentPrompt(paneId, closeMention(text));
          noteSubmitted(paneId, text);
          return;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (clearDraft !== undefined || sendAnyway) throw error;
          const queuedOnly = error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
          if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
        }
      }
      inTime();
      // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
      // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
      // asked only for such a block, so a one-line message never waits on it.
      const shaped = await mirrorInput(closeMention(payload), async () => await terminalAttach() ? null : (await paneContext(paneId)).agent);
      inTime();
      await paneSendText(paneId, shaped);
      // fixed wait: a TUI busy with the paste takes an Enter in the same chunk for a newline (SUBMIT_DELAY_MS)
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      authorize();
      await paneSendKeys(paneId, ["Enter"]);
      noteSubmitted(paneId, text);
    } catch (error) {
      if (clearedDraft) {
        throw new HerdrError("submit_partial", "Claude Code's terminal draft was cleared or may have changed, but sending was not confirmed. Your chat text stayed here. Check the terminal before sending again.");
      }
      throw error;
    }
  }
  return submitText;
}
