import { createContext } from "react";

/**
 * File paths in the chat, as agents write them ("saved to docs/demo.mp4", `~/out/x.png`),
 * opened in the file viewer. A bare path needs a folder in it and an extension, so words
 * like "and/or" or "e.g." stay text; code spans need only look like one file name.
 */

// a path starts where a run of its characters starts, `+` among them: a line of plus signs is
// otherwise tried as a path from every one of them, to its end. `~/` still starts one after a
// plus sign (`+~/notes/a.md`, a line of a diff)
const BARE_PATH = /(?<![\w/.@~-])(?<!\+(?!~))((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)+[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8})(?![\w/])/g;
const CODE_PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8}$/;

/**
 * A bare dotted name that is code or a host, not a file: what agents write in backticks all the
 * time (`process.env`, `Math.random`, `tool.monitor`). Named one
 * by one, not by the word before the dot: `tool.vue`, `os.conf` and `std.lock` are files, and
 * so is anything else with an extension, as a list of extensions always misses some.
 */
const CODE_NAME = /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|tool\.(?:monitor|read|bash|grep|write|edit)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/;
function isCodeName(name: string): boolean {
  return !name.includes("/") && CODE_NAME.test(name);
}

/** Text split into plain runs and the file paths in it. */
export function splitFilePaths(text: string): (string | { path: string })[] {
  const parts: (string | { path: string })[] = [];
  let offset = 0;
  for (const match of text.matchAll(BARE_PATH)) {
    const index = match.index ?? 0;
    // a version number or a domain is not a path: one of its segments must hold a letter
    if (!/[A-Za-z]/.test(match[1]!.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push({ path: match[1]! });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}

/** A code span that is a single file name or path (`README.md`, `src/app.ts`). */
export function codeIsFilePath(code: string): boolean {
  return CODE_PATH.test(code) && !isCodeName(code) && /[A-Za-z]/.test(code.replace(/\.[A-Za-z0-9]{1,8}$/, "")) && !/^\d+(?:\.\d+)+$/.test(code);
}

/** Opens a path in the file viewer; null where nothing can open one (paths stay text). */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

/**
 * A path in the three parts a viewer shows apart: the folder (the root itself for a file in it,
 * empty for a bare name), and the name as stem and extension, so a long name can be cut inside the
 * stem and still show its type. A dotfile (`.gitignore`) or a name ending in a dot has no extension.
 */
export function pathParts(path: string): { folder: string; stem: string; extension: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(cut + 1);
  const head = cut < 0 ? "" : path.slice(0, cut);
  // "/c.md" and "C:\c.md" live in the root: keep its separator, or it reads as a relative folder
  const folder = cut >= 0 && (head === "" || /^[A-Za-z]:$/.test(head)) ? path.slice(0, cut + 1) : head;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? { folder, stem: name.slice(0, dot), extension: name.slice(dot) }
    : { folder, stem: name, extension: "" };
}
