/**
 * A message typed in the chat while an agent's prompt waits answers that prompt,
 * the way the agent's own menu reads keys: an option's number, its label, or the
 * letter it binds ("Yes, proceed (y)"); several numbers for a multiple choice.
 * Anything else is the prompt's own "type something" answer when it has one.
 */
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";

export type TypedAnswer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

/** The options a typed number can pick, by the number the agent shows (index + 1). */
function choices(prompt: InteractivePrompt): number[] {
  return prompt.options.flatMap((_, index) => index === prompt.custom_option_index ? [] : [index]);
}

/** "Yes, proceed (y)" binds y; "No, and tell Codex what to do differently (esc)" binds nothing typeable. */
function boundLetter(label: string): string | null {
  return label.match(/\(([a-z])\)$/i)?.[1]?.toLowerCase() ?? null;
}

function bareLabel(label: string): string {
  return label.replace(/\s*\((?:[a-z]|esc|recommended)\)$/i, "").trim().toLowerCase();
}

/** null: the prompt only takes its options, and the text names none of them. */
export function answerFromText(prompt: InteractivePrompt, text: string): TypedAnswer | null {
  const value = text.trim();
  if (!value) return null;
  const valid = choices(prompt);
  const byNumber = (token: string): number | null => {
    if (!/^\d+$/.test(token)) return null;
    const index = Number(token) - 1;
    return valid.includes(index) ? index : null;
  };
  if (prompt.multi_select) {
    const indices = value.split(/[\s,]+/).filter(Boolean).map(byNumber);
    return indices.every((index) => index !== null) ? { option_indices: [...new Set(indices as number[])] } : null;
  }
  const numbered = byNumber(value);
  if (numbered !== null) return { option_index: numbered };
  const lower = value.toLowerCase();
  const named = valid.find((index) => {
    const label = prompt.options[index]!.label;
    return label.toLowerCase() === lower || bareLabel(label) === lower || boundLetter(label) === lower;
  });
  if (named !== undefined) return { option_index: named };
  return prompt.custom_option_index !== null ? { custom_text: value } : null;
}

function range(prompt: InteractivePrompt): string {
  const numbers = choices(prompt).map((index) => index + 1);
  return numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : String(numbers[0] ?? 1);
}

/** How a typed message answers this prompt: the composer's placeholder while it waits. */
export function answerHint(prompt: InteractivePrompt): string {
  if (prompt.multi_select) return "Answer above: type the numbers you choose, e.g. 1 3";
  // a free-form question (Codex's queue) has no options to number
  if (choices(prompt).length === 0) return "Answer above: type your reply…";
  return prompt.custom_option_index !== null
    ? `Answer above: type ${range(prompt)} or your own reply…`
    : `Answer above: type ${range(prompt)} to choose…`;
}

/** Why a message was not sent: the prompt takes only its options (answerFromText gave null). */
export function answerRefusal(prompt: InteractivePrompt): string {
  return prompt.multi_select
    ? "Choose with the option numbers above, e.g. 1 3."
    : `Choose one of the options above: type ${range(prompt)}.`;
}

/**
 * A typed message picking an approval's option (or a plan's) could run a command or
 * a plan on a stray "yes" or "1": the card asks for a tap on Confirm first. A tap on
 * an option in the card is explicit already, and a plan's own reply is feedback.
 */
export function needsConfirmation(prompt: InteractivePrompt, answer: TypedAnswer): boolean {
  return (prompt.kind === "approval" || prompt.kind === "plan") && answer.option_index !== undefined;
}
