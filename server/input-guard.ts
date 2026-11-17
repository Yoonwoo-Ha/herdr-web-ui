export interface SeenAttachment<Client> {
  clients: { has(client: Client): boolean };
  ready: boolean;
  held?: boolean;
  process: unknown;
  kind: "pty" | "mirror";
  cols: number;
}

export interface SightingFacts {
  attached: boolean;
  origin: boolean;
  sameAttachment: boolean;
  samePty: boolean;
  sameClaim: boolean;
  claimed: boolean;
  member: boolean;
  ready: boolean;
  held: boolean;
  currentHeld: boolean;
  mirror: boolean;
  cols: number | undefined;
}

export function sightingFacts<Client, Attachment extends SeenAttachment<Client>>(
  seen: { attachment: Attachment | undefined; process: unknown; claim: unknown; member: boolean },
  now: { attachment: Attachment | undefined; claim: unknown },
  client: Client,
): SightingFacts {
  return {
    attached: now.attachment !== undefined,
    origin: seen.member,
    sameAttachment: now.attachment === seen.attachment,
    samePty: seen.attachment?.process === seen.process,
    sameClaim: now.claim === seen.claim,
    claimed: now.claim !== undefined,
    member: seen.attachment?.clients.has(client) === true,
    ready: seen.attachment?.ready === true,
    held: seen.attachment?.held === true,
    currentHeld: now.attachment?.held === true,
    mirror: seen.attachment?.kind === "mirror",
    cols: seen.attachment?.cols,
  };
}

export function sameOrigin(facts: SightingFacts): boolean {
  return facts.origin ? facts.sameAttachment && facts.member : !facts.attached;
}

/**
 * The checks made of what a connection saw, again right before herdr or the pty is written to. They
 * differ on purpose and are not merged: each is the condition its input path always had. The
 * connection's own part (it may type, its role is the one it had) is checked beside them.
 */
export const typingGuards = {
  herdrTyping: (facts: SightingFacts): boolean => facts.sameClaim && sameOrigin(facts),
  queuedTyping: (facts: SightingFacts): boolean => facts.sameAttachment && facts.samePty && facts.sameClaim && facts.member
    && facts.ready && !facts.held,
  keys: (facts: SightingFacts): boolean => !facts.currentHeld && (!facts.origin || (facts.sameAttachment && facts.samePty
    && facts.ready && facts.sameClaim && facts.member)),
  mirrorSecret: (facts: SightingFacts): boolean => facts.sameAttachment && facts.samePty && facts.sameClaim && facts.member,
  pendingLease: (facts: SightingFacts): boolean => facts.sameAttachment && facts.samePty && facts.claimed && facts.member && facts.ready,
};

/** One or more mouse reports as xterm sends them: SGR (`CSI < b ; x ; y M|m`) or the default `CSI M` plus three bytes. */
const MOUSE_REPORTS = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

/**
 * Whether `text` is nothing but mouse reports (a click, a wheel). The attach input reads them as
 * the terminal's mouse and encodes them for the program's own mouse mode, while `pane.send_text`
 * would type their bytes literally into a program that may never have asked for them (#667).
 */
export function isMouseReport(text: string): boolean {
  return MOUSE_REPORTS.test(text);
}

/** One or more of the answers a herdr-core attach takes out of the input (`takeReplies`): colours, cell size, DA1, focus. */
const TERMINAL_REPLIES = /^(?:\x1b\]1[012];[^\x07\x1b\r\n?]*(?:\x07|\x1b\\)|\x1b\[6;\d+;\d+t|\x1b\[\?[\d;]*c|\x1b\[[IO])+$/;

/**
 * Whether `text` is nothing but the terminal's own answers to what its attach asked. The attach
 * takes them out of what reaches the program, while `pane.send_text` would type them into it (#2816).
 */
export function isTerminalReply(text: string): boolean {
  return TERMINAL_REPLIES.test(text);
}
