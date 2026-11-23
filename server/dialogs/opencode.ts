import type { OpenCodePermissionDecision, OpenCodePermissionRequest } from "../opencode-service.ts";
import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type AnswerStep, CARD_BODY_MAX, type CardWords, KEY, editorRowsMatch, finishPrompt, keySteps, own, type ParsedPrompt, type TypedEditorAnswer } from "./shared.ts";

/**
 * OpenCode v2's questions are forms its service holds (GET /api/session/{id}/form), read for the
 * exact session herdr reports for the pane and answered through POST .../reply (prompt.ts), never
 * from the screen.
 */
export const nativeQuestionReader: DialogReader = {
  id: "opencode-question",
  agents: ["opencode"],
  priority: 0,
  parse: () => null,
  // the reply re-checks the pane's session and the form's revision before it is sent
  reread: "before-commit",
  list: "none",
};

/**
 * OpenCode 2's permission requests are held by its service (GET /api/session/{id}/permission) for the session herdr
 * reports for the pane, answered through POST .../reply (prompt.ts), never from the screen. Its TUI shows the same
 * request and may answer it first: the request then leaves the list, and the card with it.
 */
export const nativePermissionReader: DialogReader = {
  id: "opencode-permission",
  agents: ["opencode"],
  priority: 0,
  parse: () => null,
  // the reply re-checks the pane's session, and the request is read again before it
  reread: "before-commit",
  list: "none",
};

/** What the request asks for, as OpenCode's TUI presents it (tui/src/util/permission.ts at 2.2.2): the command, the patch, the URL, the tool's input. */
function permissionWords({ action, resources, metadata }: OpenCodePermissionRequest): { question: CardWords; body: string | null } | null {
  const listed = resources.filter((resource) => resource !== "*");
  if (action === "shell") return { question: own("Run a shell command"), body: listed.map((command) => `$ ${command}`).join("\n") || null };
  if (action === "edit") {
    // every file's patch, or no card: a card showing some of an edit would have its user allow the rest unseen
    const files = Array.isArray(metadata?.files) ? metadata.files as unknown[] : [];
    const patches = files.flatMap((file) => typeof file === "object" && file !== null && typeof (file as Record<string, unknown>).patch === "string" ? [(file as Record<string, string>).patch!] : []);
    if (files.length === 0 || patches.length !== files.length) return null;
    return { question: own("Edit {file}", { file: listed.join(", ") }), body: patches.join("\n") };
  }
  if (action === "webfetch") return { question: own("Fetch {url}", { url: typeof metadata?.url === "string" ? metadata.url : listed.join(", ") }), body: null };
  if (action === "external_directory") return { question: own("Access a folder outside the project"), body: listed.join("\n") || null };
  // an MCP tool (`<server>_<tool>`) and every other tool: its name, and the input OpenCode sent with it
  const input = metadata?.input;
  return { question: own("Use the tool {tool}", { tool: action }), body: input === undefined ? listed.join("\n") || null : JSON.stringify(input, null, 2) };
}

/**
 * The card for a pending request, or null for one it cannot show whole (an edit without each file's patch, a command,
 * patch or input longer than a card shows): the card would have its user allow what they never saw, so the terminal
 * answers it.
 */
export function openCodePermissionPrompt(request: OpenCodePermissionRequest): ParsedPrompt | null {
  const words = permissionWords(request);
  if (!words || (words.body !== null && words.body.length > CARD_BODY_MAX)) return null;
  const { question, body } = words;
  const save = request.save ?? [];
  const choices: { label: CardWords; description: CardWords | null; decision: OpenCodePermissionDecision }[] = [
    { label: own("Allow once"), description: null, decision: "once" },
    // OpenCode offers Always allow only for a request that names what it would save
    ...(save.length === 0 ? [] : [{
      label: own("Always allow"),
      description: save.length === 1 && save[0] === "*"
        ? own("Allows every {action} request in this project from now on", { action: request.action })
        : own("Allows these in this project from now on: {patterns}", { patterns: save.join(", ") }),
      decision: "always" as const,
    }]),
    { label: own("Deny"), description: null, decision: "reject" },
  ];
  return finishPrompt("opencode", {
    kind: "approval", title: own("Permission request"), question, body,
    options: choices.map(({ label, description }) => ({ label, description })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "opencode-permission", menuLabels: [], selectedIndex: 0, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    openCodePermission: { requestID: request.id, sessionID: request.sessionID, decisions: choices.map(({ decision }) => decision) },
  }, { call: `${request.sessionID}:${request.id}` });
}

/** the TUI's own text for a typed answer's row (routes/session/question.tsx at v1.2.27) */
const CUSTOM_LABEL = "Type your own answer";
const ROW_RE = /^ *┃(?: {2}(.*))?$/u;
const OPTION_RE = /^(\d+)\. (.+)$/u;
/** a single question's footer: one row wide, or wrapped into a key row and a word row on a narrow pane */
const FOOTER_RE = /^↑↓ select {2}enter submit {2}esc dismiss$/u;
const FOOTER_KEYS_RE = /^↑↓ +enter +esc$/u;
const FOOTER_WORDS_RE = /^select +submit +dismiss$/u;
/** OpenCode 2's form shares the footer under this header; its questions are read natively */
const V2_FORM_HEADER_RE = /^(?:Field \d+ of \d+|Review)(?: · |$)/u;

/**
 * OpenCode 1.x's question prompt (#1386), as recorded from 1.2.27 at 40 and 120 columns (fixtures
 * opencode-question-1.2.27-*): a box drawn with a left border `┃`, holding the question, its numbered
 * options (each with its description indented under it, the last "Type your own answer" when a
 * typed answer is allowed) and the footer, which ends the screen. Only a single question that is not
 * a multiple choice: its footer says `enter submit`, and a digit picks that row and submits it
 * (`pick` in question.tsx), so the answer never depends on where the cursor is (drawn only in color).
 * 1.x keeps no form a service could answer: these keys are the only way.
 */
export function parseOpenCodeV1Question(screen: string): ParsedPrompt | null {
  return readOpenCodeV1Question(screen);
}

function readOpenCodeV1Question(screen: string, answer?: TypedEditorAnswer): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && (lines[end] === "" || ROW_RE.exec(lines[end]!)?.[1] === undefined && ROW_RE.test(lines[end]!))) end--;
  const row = (index: number): string | undefined => {
    const match = ROW_RE.exec(lines[index] ?? "");
    return match ? match[1] ?? "" : undefined;
  };
  let footer = end;
  if (FOOTER_RE.test(row(end) ?? "")) footer = end;
  else if (FOOTER_WORDS_RE.test(row(end) ?? "") && FOOTER_KEYS_RE.test(row(end - 1) ?? "")) footer = end - 1;
  else return null;
  if (row(footer - 1) !== "") return null;
  let top = footer - 1;
  while (top > 0 && row(top - 1) !== undefined) top--;
  const body = lines.slice(top, footer - 1).map((line) => ROW_RE.exec(line)![1] ?? "");
  if (body.some((text) => V2_FORM_HEADER_RE.test(text))) return null;
  const first = body.findIndex((text) => OPTION_RE.test(text));
  if (first < 2 || body[first - 1] !== "") return null;
  const question = body.slice(0, first - 1).filter(Boolean).join(" ").trim();
  if (!question) return null;
  const options: { label: string; description: string | null }[] = [];
  for (const [index, text] of body.entries()) {
    if (index < first) continue;
    const option = OPTION_RE.exec(text);
    if (option) {
      if (Number(option[1]) !== options.length + 1) return null;
      options.push({ label: option[2]!.trim(), description: null });
      if (answer && options.length - 1 === answer.prompt.customMenuIndex) {
        // the custom row read for a typed answer is its editor, or the answer is not where it was typed
        if (option[2]!.trim() !== CUSTOM_LABEL) return null;
        // The textarea sits below Other, with the description indent. At its six-row limit
        // the visible rows no longer prove the full value; the placeholder isn't a value either.
        const field = body.slice(index + 1);
        if (field.length >= 6 || !field.every((line) => line.startsWith("   ") || line === "")) return null;
        const rows = field.map((line) => line.slice(3));
        if (!editorRowsMatch(rows, answer.text) || editorRowsMatch(rows, CUSTOM_LABEL)) return null;
        break;
      }
    } else if (/^ {3}\S/u.test(text) && options.length > 0) {
      const last = options.at(-1)!;
      last.description = `${last.description ? `${last.description} ` : ""}${text.trim()}`;
    } else if (text !== "") return null;
  }
  // digits reach the first nine rows only
  if (options.length < 2 || options.length > 9) return null;
  const custom = options.at(-1)!.label === CUSTOM_LABEL ? options.length - 1 : null;
  const digit = (index: number): AnswerStep => ({ text: String(index + 1) });
  return finishPrompt("opencode", {
    kind: "question", title: own("Question"), question, body: null, options, multi_select: false, custom_option_index: custom,
  }, {
    responder: "opencode-v1-question",
    menuLabels: options.map((option) => option.label),
    selectedIndex: 0,
    checkedOptionIndices: [],
    customMenuIndex: custom,
    rejectWithEscapeIndex: null,
    optionSteps: options.map((_, index) => [digit(index)]),
    // the custom row's digit opens its text box; Enter there submits the typed answer
    ...(custom !== null ? { customSteps: (text: string) => [digit(custom), { text }, ...keySteps([KEY.enter])] } : {}),
  });
}

export function openCodeV1CustomEditorMatches(screen: string, answer: TypedEditorAnswer): boolean {
  const shown = readOpenCodeV1Question(screen, answer);
  return shown?.id === answer.prompt.id && shown.customMenuIndex === answer.prompt.customMenuIndex;
}

export const openCodeV1QuestionActive = (screen: string): boolean => parseOpenCodeV1Question(screen) !== null;

export const v1QuestionReader: DialogReader = {
  id: "opencode-v1-question",
  agents: ["opencode"],
  priority: 90,
  reread: "none",
  list: "none",
  parse: (screen) => parseOpenCodeV1Question(screen),
};

export const readers: readonly DialogReader[] = [nativeQuestionReader, nativePermissionReader, v1QuestionReader];
