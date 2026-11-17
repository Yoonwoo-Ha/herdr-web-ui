import { stripVTControlCharacters } from "node:util";

import type { UsageLoginPromptText } from "../shared/usage-login.ts";

/**
 * A private login's PTY output as the text it shows: OSC sequences go whole (a hyperlink's hidden target
 * would otherwise stay beside its visible text), then every other escape, and lines end in \n.
 */
export function screenText(raw: string): string {
  return stripVTControlCharacters(raw.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")).replace(/\r\n?/g, "\n");
}

export type PromptProvider = "claude" | "codex";

const SIGN_IN_HOSTS: Readonly<Record<PromptProvider, readonly string[]>> = {
  claude: ["claude.com", "claude.ai", "anthropic.com"],
  codex: ["auth.openai.com", "chatgpt.com"],
};

function trusted(provider: PromptProvider, address: string): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  return SIGN_IN_HOSTS[provider].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export function loginPrompt(provider: PromptProvider, text: string): UsageLoginPromptText {
  const addresses = [...text.matchAll(/https?:\/\/[^\s<>"'`\u0007\u001b]+/g)].map((match) => match[0].replace(/[.,;:)\]]+$/, ""));
  const last = addresses.at(-1);
  const url = last !== undefined && trusted(provider, last) ? last : null;
  let userCode: string | null = null;
  if (provider === "codex") {
    const after = text.slice(text.lastIndexOf("one-time code"));
    userCode = text.includes("one-time code") ? after.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ?? null : null;
  }
  const wantsCode = provider === "claude" && url !== null && /Paste code here if prompted >\s*$/.test(text);
  return { url, user_code: userCode, wants_code: wantsCode };
}
