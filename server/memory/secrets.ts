/**
 * The check a memory note passes before it is stored, edited or confirmed: a note goes into every
 * agent's prompt and so into the model provider's logs, and a secret must not. It stops a secret
 * pasted by mistake; an agent set on hiding one can still reword it, which is why an agent's note
 * waits for a person anyway. Refusals name the rule, never the value.
 *
 * In order: the shape of the text (an `.env` file, a long code block), known credential formats,
 * a secret-looking name with a value, a secret this server knows (also reversed, in hex, in base64
 * or cut in half), and last a long random-looking string, which only asks: real facts (bucket names,
 * flag keys) look like that too.
 */

export type SecretScan = { verdict: "clean" } | { verdict: "refuse" | "ask"; rule: string };

const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S/;
const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
const CODE_BLOCK_MAX_LINES = 10;

const FORMATS: readonly [rule: string, pattern: RegExp][] = [
  ["private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["api_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["stripe_key", /\b[rs]k_live_[0-9A-Za-z]{16,}/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{30,}/],
  ["age_key", /AGE-SECRET-KEY-1[0-9A-Z]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["url_credentials", /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

const ASSIGNMENT = /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth)\b["']?\s*[:=]\s*(?:bearer\s+|basic\s+)?["']?[^\s"']{8,}/i;

const RANDOM_CANDIDATE = /[A-Za-z0-9_+/=-]{20,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RANDOM_BITS_PER_CHAR = 3.5;
const KNOWN_MIN = 8;

function entropy(word: string): number {
  const counts = new Map<string, number>();
  for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / word.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

function looksRandom(word: string): boolean {
  if (UUID.test(word) || ULID.test(word)) return false;
  return /[A-Za-z]/.test(word) && /\d/.test(word) && entropy(word) >= RANDOM_BITS_PER_CHAR;
}

function variants(secret: string): string[] {
  const bytes = Buffer.from(secret);
  const shapes = [secret, [...secret].reverse().join(""), bytes.toString("hex"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url")];
  if (secret.length >= KNOWN_MIN * 2) {
    const half = Math.floor(secret.length / 2);
    shapes.push(secret.slice(0, half), secret.slice(half));
  }
  return shapes;
}

export function scanForSecrets(text: string, known: readonly string[]): SecretScan {
  if (text.split("\n").filter((line) => ENV_LINE.test(line)).length >= 3) return { verdict: "refuse", rule: "env_file" };
  for (const [, code = ""] of text.matchAll(FENCE)) {
    if (code.split("\n").filter((line) => line.trim() !== "").length > CODE_BLOCK_MAX_LINES) return { verdict: "refuse", rule: "long_code_block" };
  }
  for (const [rule, pattern] of FORMATS) if (pattern.test(text)) return { verdict: "refuse", rule };
  if (ASSIGNMENT.test(text)) return { verdict: "refuse", rule: "secret_assignment" };
  const lowered = text.toLowerCase();
  for (const secret of known) {
    if (secret.length < KNOWN_MIN) continue;
    if (variants(secret).some((shape) => text.includes(shape) || (/^[0-9a-f]+$/.test(shape) && lowered.includes(shape)))) return { verdict: "refuse", rule: "known_secret" };
  }
  if ((text.match(RANDOM_CANDIDATE) ?? []).some(looksRandom)) return { verdict: "ask", rule: "random_string" };
  return { verdict: "clean" };
}

/** The values a note must never hold that this server can name: its own tokens and its environment's keys. */
export function knownSecrets(env: Record<string, string | undefined>, own: readonly string[]): string[] {
  const named = Object.entries(env).filter(([name, value]) => value !== undefined && /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(name)).map(([, value]) => value!);
  return [...own, ...named].filter((value) => value.length >= KNOWN_MIN);
}
