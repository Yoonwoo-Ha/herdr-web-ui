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

/** The composer never queues: this cap keeps one send inside a single WS frame. */
export const MAX_COMPOSER_CHARS = 20_000;

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Trailing newlines are dropped first: the submit CR is the composer's, not the text's. */
export function composerPayload(text: string, bracketedPaste: boolean): string {
  const body = text
    .replace(/[\r\n]+$/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "\r");
  if (bracketedPaste) return PASTE_START + body + PASTE_END + "\r";
  return body + "\r";
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
 * keeps the message parked for the user's own `Send now`.
 */
export const QUEUE_READY_STATUS: Record<string, true> = { blocked: true, done: true, idle: true };
