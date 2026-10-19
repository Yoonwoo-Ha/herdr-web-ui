import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SkillIgnore } from "../skill-ignore.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

export interface WalkRules {
  readonly depth: "one" | "recursive";
  readonly looseMarkdown: "none" | "root" | "nested";
  readonly ignoreFiles: boolean;
  readonly requireDescription: boolean;
  readonly skipNames?: (name: string) => boolean;
}
export interface WalkedSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const FRONTMATTER = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/;

/** The YAML fields of `markdown`'s frontmatter; null without a well-formed header. */
function parseFrontmatter(markdown: string): Readonly<Record<string, unknown>> | null {
  const header = markdown.match(FRONTMATTER)?.[1];
  if (!header) return null;
  try {
    const fields: unknown = Bun.YAML.parse(header);
    return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? Object.fromEntries(Object.entries(fields)) : null;
  } catch { return null; /* malformed YAML */ }
}

// Discovery runs on the server's one thread for every menu: a skill file is read only up to this
// much, and only when it is a regular file (a link to /dev/zero or a huge file would stall it).
const MAX_SKILL_BYTES = 64 * 1024;

/** The first MAX_SKILL_BYTES of a regular file; throws when `path` is no regular file. */
export function readSkillText(path: string): string {
  if (!statSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SKILL_BYTES);
    let length = 0;
    for (let count = 1; count > 0 && length < buffer.length; length += count) count = readSync(fd, buffer, length, buffer.length - length, null);
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/** Reads only through the closing frontmatter delimiter, without reading the skill body. */
export function readFrontmatter(path: string): Readonly<Record<string, unknown>> | null {
  try {
    if (!statSync(path).isFile()) return null;
    const fd = openSync(path, "r");
    let markdown = "";
    try {
      // one buffer, bounded: a header longer than MAX_SKILL_BYTES is no frontmatter
      const buffer = Buffer.alloc(MAX_SKILL_BYTES);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, Math.min(8192, buffer.length - length), null);
        if (count === 0) break;
        length += count;
        markdown = buffer.subarray(0, length).toString("utf8");
        if (!markdown.startsWith("---") && !markdown.startsWith("\uFEFF---")) return null;
        if (/\r?\n---(?:\s*\r?\n|$)/.test(markdown)) break;
      }
    } finally { closeSync(fd); }
    return parseFrontmatter(markdown);
  } catch { return null; /* missing or unreadable */ }
}

/**
 * A command's description, whole: the frontmatter's `description` as YAML reads it (a `>-` or `|`
 * block scalar included), else the `description:` line as written, else the body's first non-empty
 * line. Agents read a header that is not strict YAML (an unquoted colon, `argument-hint: [a] [b]`)
 * line by line, so a header YAML refuses still yields its description line. The menu shortens it
 * to one sentence itself and shows the whole text in the row's tooltip, so nothing is cut here.
 */
export function description(markdown: string): string {
  const frontmatter = markdown.match(FRONTMATTER);
  const found = parseFrontmatter(markdown)?.description;
  const raw = frontmatter?.[1]?.match(/^description:[ \t]*(.+?)\s*$/m)?.[1]?.trim();
  // a block scalar's indicator alone is no description: its text is on the lines below it
  const line = raw && !/^[>|][-+]?\d?$/.test(raw) ? raw.replace(/^(["'])(.*)\1$/, "$2") : undefined;
  // YAML takes ` #` in a plain value as a comment (`Issue #102 ...` reads as `Issue`); the line
  // as written is what the person meant there, and what the line-reading loaders showed before
  if (typeof found === "string" && found.trim()) return line && !/^["']/.test(raw!) && line.length > found.trim().length && line.startsWith(found.trim()) ? line : found.trim();
  if (line) return line;
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}
export function walkSkills(root: string, rules: WalkRules): WalkedSkill[] {
  const result: WalkedSkill[] = [];
  const ignore = new SkillIgnore();
  const ancestors = new Set<string>();
  const load = (path: string): void => {
    const fields = readFrontmatter(path) ?? {};
    if (rules.requireDescription && (typeof fields.description !== "string" || !fields.description.trim())) return;
    try {
      // The original one-level loaders use their permissive name parser and short body fallback.
      const markdown = rules.requireDescription ? "" : readSkillText(path);
      const name = rules.requireDescription
        ? typeof fields.name === "string" && fields.name ? fields.name : basename(dirname(path))
        : skillName(markdown, basename(dirname(path)));
      result.push({ name, description: rules.requireDescription && typeof fields.description === "string" ? fields.description : description(markdown), path, fields });
    } catch { return; /* unreadable skill */ }
  };
  if (rules.depth === "one") {
    if (!existsSync(root)) return result;
    if (rules.ignoreFiles) {
      for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
        try { ignore.add(readFileSync(join(root, filename), "utf8")); } catch { /* optional ignore file */ }
      }
    }
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || rules.skipNames?.(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        if (statSync(directory).isDirectory() && !ignore.ignores(entry.name + "/")) load(join(directory, "SKILL.md"));
        else if (rules.looseMarkdown === "root" && entry.name.endsWith(".md") && statSync(directory).isFile() && !ignore.ignores(entry.name)) load(directory);
      } catch { continue; /* broken links or missing skill */ }
    }
    return result;
  }
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      const prefix = relative(root, directory).split(sep).join("/");
      for (const filename of rules.ignoreFiles ? [".gitignore", ".ignore", ".fdignore"] : []) {
        try { ignore.add(readFileSync(join(directory, filename), "utf8"), prefix ? `${prefix}/` : ""); }
        catch { continue; /* optional ignore file */ }
      }
      const entries = readdirSync(directory, { withFileTypes: true });
      const declared = join(directory, "SKILL.md");
      if (entries.some((entry) => entry.name === "SKILL.md") && !ignore.ignores(relative(root, declared).split(sep).join("/"))) {
        try {
          if (statSync(declared).isFile()) { load(declared); return; }
        } catch { /* a broken SKILL.md link does not hide other entries */ }
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || rules.skipNames?.(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          const relativePath = relative(root, path).split(sep).join("/");
          if (ignore.ignores(relativePath + (target.isDirectory() ? "/" : ""))) continue;
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md") && (rules.looseMarkdown === "root" ? directory === root : rules.looseMarkdown === "nested" && directory !== root)) load(path);
        } catch { continue; /* broken links and unreadable directories are skipped */ }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}

/** Existing one-level command mapping, kept separate from each agent's root selection. */
/** A process environ block (`NAME=value` lines) as a record; entries without `=` are skipped. */
export function environRecord(env: readonly string[] | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of env ?? []) {
    const equal = entry.indexOf("=");
    if (equal > 0) result[entry.slice(0, equal)] = entry.slice(equal + 1);
  }
  return result;
}

/** One variable of a process environ block; unset and empty both read as undefined. */
export function environValue(env: readonly string[] | null | undefined, name: string): string | undefined {
  return env?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) || undefined;
}

/** A parsed config value as a plain record; anything else is empty. */
export function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** JSONC as JSON: comments and trailing commas removed outside strings (URLs and escaped quotes kept). */
export function stripJsonc(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (part) => part.startsWith('"') ? part : "")
    .replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (_part, quoted: string | undefined) => quoted ?? "");
}

export function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  // Guard only the current ancestry: sibling links can expose different command namespaces.
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
            result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}


/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
export function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      markdown = readSkillText(join(root, entry.name));
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source });
  }
  return result;
}


/** The nearest repository boundary wins; the home directory is never a project ancestor. */
export function ancestorsToRepoRoot(cwd: string): string[] {
  const start = resolve(cwd);
  const home = resolve(process.env.HOME ?? "");
  if (start === home || home.startsWith(start.endsWith(sep) ? start : start + sep)) return [];
  const result: string[] = [];
  for (let directory = start; directory !== home && directory !== dirname(directory); directory = dirname(directory)) {
    result.push(directory);
    if (existsSync(join(directory, ".git"))) return result;
  }
  return [cwd];
}
