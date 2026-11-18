import { basename, dirname } from "node:path";
import type { SkillActivity } from "../shared/protocol.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null;

/** No filesystem lookup: evidence belongs to the bound transcript, including remote PCs. */
export function skillDocument(path: unknown): SkillActivity | null {
  if (typeof path !== "string" || path.length > 4096 || /[\r\n]/.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.endsWith("/SKILL.md")) return null;
  const name = label(basename(dirname(normalized)));
  return name && name !== "." ? { name, path, evidence: "instructions", status: "loaded" } : null;
}

/** Codex's explicitly selected skill is injected as one complete user-context envelope. */
export function selectedSkill(text: string): SkillActivity | null {
  const match = /^<skill>\s*<name>([^<>\r\n]+)<\/name>\s*<path>([^<>\r\n]+)<\/path>[\s\S]*<\/skill>$/.exec(text.trim());
  if (!match) return null;
  const name = label(match[1]);
  const document = skillDocument(match[2]);
  return name && document ? { ...document, name } : null;
}

const SKILL_INSTRUCTION = /^The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill-instruction>/;
const LEGACY_SKILL = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** pi names the skill file it loaded: a SKILL.md, or a standalone `.md` skill (`--skill review.md`). */
function loadedSkill(name: string | undefined, location: string | undefined): SkillActivity | null {
  const skill = label(name);
  if (skill === null || typeof location !== "string" || location.length === 0 || location.length > 4096 || /[\r\n]/.test(location)) return null;
  return { name: skill, path: location, evidence: "instructions", status: "loaded" };
}

/**
 * The prompt omp/omo record when the user invokes a skill (`/skill:name`, `$name`, a keyword): the
 * whole SKILL.md before the request, tens of KB the user never typed. Mirrors pi's own
 * `parseSkillBlock` (core/skill-invocation.ts): chained invocations, then `<user-request>`, or the
 * legacy `<skill name location>` form. Anything else is left as the user's text.
 */
export function skillInvocationPrompt(text: string): { skills: SkillActivity[]; request: string } | null {
  const skills: SkillActivity[] = [];
  let remainder = text;
  let match = SKILL_INSTRUCTION.exec(remainder);
  while (match !== null) {
    const skill = match[1] === match[2] ? loadedSkill(match[1], match[3]) : null;
    if (skill === null) return null;
    skills.push(skill);
    remainder = remainder.slice(match[0].length);
    if (!remainder.startsWith("\n\nThe user explicitly invoked the ")) break;
    remainder = remainder.slice(2);
    match = SKILL_INSTRUCTION.exec(remainder);
    if (match === null) return null;
  }
  if (skills.length > 0) {
    if (remainder.length === 0) return { skills, request: "" };
    const request = /^\n\n<user-request>\n([\s\S]*?)\n<\/user-request>$/.exec(remainder);
    return request ? { skills, request: request[1]!.trim() } : null;
  }
  const legacy = LEGACY_SKILL.exec(text);
  const skill = legacy ? loadedSkill(legacy[1], legacy[2]) : null;
  return skill ? { skills: [skill], request: legacy![3]?.trim() ?? "" } : null;
}

/** omp and gjc keep the user's invocation in details, separate from the expanded body. */
export function skillPromptMessage(value: unknown): { skills: SkillActivity[]; request: string } | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.customType !== "skill-prompt" || entry.display === false) return null;
  const details = record(entry.details);
  const name = label(details.name);
  if (name === null || (details.args !== undefined && typeof details.args !== "string")) return null;
  const skill: SkillActivity = { name, evidence: "instructions", status: "loaded" };
  if (typeof details.path === "string") skill.path = details.path;
  return { skills: [skill], request: `/skill:${name}${details.args ? ` ${details.args}` : ""}` };
}

/** Hermes puts a single skill's instruction last, but a bundle's instruction before its bodies. */
export function hermesSkillPrompt(text: string): { skills: SkillActivity[]; request: string } | null {
  const single = /^\[IMPORTANT: The user has invoked the "([^"\r\n]+)" skill, indicating they want you to follow its instructions\. The full skill content is loaded below\.\]\n\n/.exec(text);
  const bundle = /^\[IMPORTANT: The user has invoked the "([^"\r\n]+)" skill bundle, loading (\d+) skills together\. Treat every skill below as active guidance for this turn\.\]\n\n/.exec(text);
  const name = label(single?.[1] ?? bundle?.[1]);
  if (name === null) return null;
  const skills: SkillActivity[] = [];
  let instruction = "";
  if (single !== null) {
    const marker = "\n\nThe user has provided the following instruction alongside the skill invocation: ";
    // Hermes appends the instruction after the skill directory; the same words in a skill body are not one.
    const last = text.lastIndexOf(marker);
    const directoryLine = /\n\[Skill directory: ([^\r\n]+)\]\n/;
    const index = last >= 0 && directoryLine.test(text.slice(0, last)) ? last : -1;
    const directory = directoryLine.exec(index < 0 ? text : text.slice(0, index));
    const skill = directory ? loadedSkill(name, `${directory[1]}/SKILL.md`) : null;
    if (skill === null) return null;
    skills.push(skill);
    if (index >= 0) instruction = text.slice(index + marker.length).trim();
  } else if (bundle !== null) {
    const marker = `\n\n[Loaded as part of the "${name}" skill bundle.]\n\n`;
    const blocks = text.slice(bundle[0].length).split(marker);
    const header = blocks.shift() ?? "";
    const metadata = /^Bundle: ([^\r\n]+)\nSkills loaded: ([^\r\n]+)(?:\n\nUser instruction: ([\s\S]*))?$/.exec(header);
    if (metadata === null || metadata[1] !== name || blocks.length !== Number(bundle[2])) return null;
    const names = metadata[2]?.split(", ") ?? [];
    if (names.length !== blocks.length) return null;
    for (const [index, body] of blocks.entries()) {
      const directory = /\n\[Skill directory: ([^\r\n]+)\]\n/.exec(body);
      const skill = directory ? loadedSkill(names[index], `${directory[1]}/SKILL.md`) : null;
      if (skill === null) return null;
      skills.push(skill);
    }
    instruction = metadata[3]?.trim() ?? "";
  }
  return { skills, request: `/${name}${instruction ? ` ${instruction}` : ""}` };
}

export function invokedSkill(name: string, input: Record<string, unknown>): SkillActivity | null {
  if (name !== "Skill") return null;
  const skill = label(input.skill);
  return skill ? { name: skill, evidence: "invocation", status: "requested" } : null;
}

/** Codex records parsed read paths even for commands executed inside code-mode tools.
 * Unknown shell scripts stay unknown: a mention/search of SKILL.md is not a read. */
export function codexReadSkills(value: unknown): SkillActivity[] {
  const item = record(value);
  if (item.type !== "CommandExecution" || !Array.isArray(item.parsed_cmd)) return [];
  if (item.status !== "completed" && item.status !== "failed") return [];
  const status = item.exit_code === 0 ? "loaded" : typeof item.exit_code === "number" ? "failed" : null;
  if (!status) return [];
  return item.parsed_cmd.flatMap((value) => {
    const command = record(value);
    const skill = command.type === "read" ? skillDocument(command.path) : null;
    return skill ? [{ ...skill, status }] : [];
  });
}

/** Older Codex rollouts only record tool calls. Recognize a literal, single file
 * read; shell scripts, searches, writes, interpolated paths and mentions stay out. */
export function codexReadCall(name: string, args: Record<string, unknown>): SkillActivity | null {
  if (name === "read_file" || name === "Read") {
    const skill = skillDocument(args.file_path ?? args.path);
    return skill ? { ...skill, status: "requested" } : null;
  }
  if (name !== "exec_command" && name !== "shell_command" && name !== "shell") return null;
  const cmd = args.cmd ?? args.command;
  if (typeof cmd !== "string" || /[\n;&|<>`$]/.test(cmd)) return null;
  const match = /^(?:cat|head(?:\s+-n\s+\d+)?|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*$/.exec(cmd.trim());
  const skill = match ? skillDocument(match[1] ?? match[2] ?? match[3]) : null;
  return skill ? { ...skill, status: "requested" } : null;
}
