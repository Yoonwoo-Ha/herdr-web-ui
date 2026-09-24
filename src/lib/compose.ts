/**
 * Composer -> pty byte shaping. The composer sends "one message", but the pane's
 * program defines what a safe submission is, so the payload follows the pane's own
 * bracketed-paste mode (term.modes.bracketedPasteMode):
 * - mode on (agent TUIs): the text goes out as ONE bracketed paste - newlines stay
 *   literal inside the message - and a bare CR submits it, exactly like paste+Enter.
 * - mode off (plain shell): classic paste semantics - every newline submits its own
 *   line, and the trailing CR runs the last one.
 * Pure logic, DOM-free, so the policy is unit-testable (see compose.test.ts).
 */

import type { AgentStatus, SlashCommand } from "../../shared/protocol.ts";
import { knownStatus, STATUS_WORD } from "./status.ts";

/** The composer never queues: this cap keeps one send inside a single WS frame. */
export const MAX_COMPOSER_CHARS = 20_000;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** A composer message as written: trailing newlines are the composer's, not the text's; CRLF reads as one newline. */
export function composerMessage(text: string): string {
  return text.replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
}

/** The text a composer message types, without its submit (HerdrSocket.submit adds the Enter). */
export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = composerMessage(text).replace(/\n/g, "\r");
  return bracketedPaste ? PASTE_START + body + PASTE_END : body;
}

/** Why a composer message did not go (SubmitResult's code): the composer keeps the text and says this. */
export function submitNote(code: string, message: string): string {
  if (code === "agent_blocked") return "Not sent: the agent is waiting for an answer in the terminal. Answer it first.";
  if (code === "read_only") return "Not sent: this view only watches the pane.";
  if (code === "submit_timeout") return "Not sent: it waited too long behind an earlier message, and nothing was typed. Send it again.";
  if (code === "disconnected" || code === "timeout") return "Not confirmed: the pane did not confirm this message. Check the terminal before sending it again.";
  return `Not sent: ${message}`;
}

/**
 * How a stored image is referenced in the prompt: the agent TUI reads the file from
 * its path, so the mention is plain text the user can still edit before sending.
 */
export function imageMention(path: string): string {
  return `@${path} `;
}

/**
 * Agent states that mean "the run is over, the next line is wanted", and so let a
 * parked message auto-dispatch. Deliberately an allow-list: `unknown` is what a pane
 * reports before the status collector has seen it (and during a reconnect), and
 * herdr's AgentStatus is widened with `(string & {})`, so a state a newer herdr
 * invents must never fire the queue into a still-running agent. Anything unrecognized
 * keeps the message parked for the user's own `Send now`. `blocked` may be an
 * approval or question menu, so it must never receive an automatic submission.
 */
export const QUEUE_READY_STATUS: Readonly<Partial<Record<string, true>>> = { done: true, idle: true };

/** The composer's status word: the shared vocabulary, with a blank state reading as READY (a shell is always ready). */
export function composerStatusWord(status?: AgentStatus): string {
  const known = knownStatus(status);
  return known === "unknown" ? "READY" : STATUS_WORD[known];
}

/** Herdr agent ids are machine-friendly; the composer presents a short human label. */
export function agentDisplayLabel(agent: string | null): string {
  if (!agent) return "Shell";
  return agent
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Filter by command prefix and prefer commands the user has selected most often. */
export function rankSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  usage: Readonly<Partial<Record<string, number>>>,
): SlashCommand[] {
  const needle = query.toLocaleLowerCase();
  return commands
    .filter((command) => command.name.toLocaleLowerCase().startsWith(needle))
    .sort((left, right) => {
      const frequency = (usage[right.name] ?? 0) - (usage[left.name] ?? 0);
      return frequency || left.name.localeCompare(right.name);
    });
}
