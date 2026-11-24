/**
 * The memory store of this PC, under `<stateDir>/memory/`:
 *
 *   account/<id>.md, project/<sha-256 of the key, 16 hex>/<id>.md, machine/<id>.md  confirmed notes
 *   inbox/<id>.md            notes that wait for a person (`ovis memory add`, later agents)
 *   trash/<id>.<ms>.md       discarded or removed notes, deleted 30 days after <ms>
 *   verified.json            what a screen confirmed: each note's rev and the SHA-256 of its file
 *   memory.json              this PC's memory id
 *
 * Confirmed is a proof, not a flag: a program of the same user can write `verified: true` into a
 * file, so a note counts as confirmed only while its file is byte for byte what verified.json
 * recorded when a person confirmed it on a screen; otherwise it waits for a person again. The
 * folder and the flag must agree (a confirmed folder holds `verified: true`, the inbox `false`), and
 * a file that disagrees, will not parse or is of a newer format is not read and never written over.
 * A note that fails the secret check is listed with its text withheld, so no answer carries the
 * secret, and can only be thrown away. Only the server writes here, synchronously, so two requests
 * never interleave a change.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { MEMORY_INBOX_DAYS, projectLabel, type MemoryDraft, type MemoryEdit, type MemoryErrorCode, type MemoryFlag, type MemoryItem, type MemoryProject, type MemoryScope, type MemoryState, type MemoryView } from "../../shared/memory.ts";
import { writePrivateState } from "../private-state.ts";
import { ENTRY_VERSION, formatEntry, headerFits, parseEntry, PROJECT_KEY, textProblem, type MemoryEntry } from "./entry.ts";
import { scanForSecrets } from "./secrets.ts";

const DAY_MS = 86_400_000;
const TRASH_DAYS = 30;
const LIMITS: Record<MemoryScope, number> = { account: 100, project: 200, machine: 100 };
const LEDGER_VERSION = 1;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_MAX_BYTES = 4096;

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, readonly status: number, message: string, readonly rule?: string) {
    super(message);
  }
}

export interface MemoryStoreOptions {
  dir: string;
  now: () => number;
  hostName: string;
  /** values no note may hold: the server's tokens and its environment's keys */
  knownSecrets: () => readonly string[];
  projectKeyOf: (folder: string) => Promise<string | null>;
}

interface Note {
  entry: MemoryEntry;
  path: string;
  inbox: boolean;
  proven: boolean;
  /** SHA-256 of the file: what a screen showed, and so what it may confirm */
  digest: string;
  /** the secret rule its text or its header fails */
  withheld: string | null;
}

interface Ledger {
  v: number;
  notes: Record<string, { rev: number; hash: string }>;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const projectFolder = (key: string): string => sha256(key).slice(0, 16);

function ulid(now: number): string {
  let time = "";
  for (let rest = now, index = 0; index < 10; index += 1, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32]! + time;
  return time + [...randomBytes(16)].map((byte) => CROCKFORD[byte % 32]).join("");
}

function flagsOf(entry: MemoryEntry): MemoryFlag[] {
  const text = `${entry.title}\n${entry.body}`;
  const flags: MemoryFlag[] = [];
  if (entry.origin.exposure === "web") flags.push("web");
  if (/`[^`]+`|(?:^|\s)\$\s|\.(?:sh|ps1|py|bat|cmd)\b|(?:^|\s)--?[a-z][\w-]*|\b(?:rm|curl|wget|sudo|chmod|bash|eval|npx|bunx)\s/i.test(text)) flags.push("command");
  if (/항상|절대|무시|\b(?:always|never|ignore)\b/i.test(text)) flags.push("absolute");
  if (/\b(?:https?|ftp):\/\//i.test(text)) flags.push("address");
  return flags;
}

function metaText(entry: MemoryEntry): string {
  const { origin } = entry;
  return [entry.key, entry.project, entry.source_ref, entry.replaces, entry.verified_at, entry.verified_by, entry.updated_at, entry.updated_on, entry.expires, ...Object.values(origin)]
    .filter((value): value is string => typeof value === "string").join("\n");
}

function keyFrom(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").trim().split(/\s+/).filter((word) => word !== "").slice(0, 6).join(".").slice(0, 60);
}

export class MemoryStore {
  constructor(private readonly options: MemoryStoreOptions) {}

  private get dir(): string { return this.options.dir; }
  private today(): string { return new Date(this.options.now()).toISOString().slice(0, 10); }

  private machine(): string {
    const path = join(this.dir, "memory.json");
    if (existsSync(path)) {
      let stored: unknown;
      try { stored = JSON.parse(readFileSync(path, "utf8")); } catch { throw new MemoryError("memory_too_new", 409, "memory.json could not be read; nothing was changed"); }
      const { v, machine } = (stored ?? {}) as { v?: unknown; machine?: unknown };
      if (v !== 1 || typeof machine !== "string") throw new MemoryError("memory_too_new", 409, "memory.json is from a newer Ovis; nothing was changed");
      return machine;
    }
    const machine = `m_${randomBytes(8).toString("hex")}`;
    writePrivateState(path, { v: 1, machine });
    return machine;
  }

  private readLedger(): Ledger | null {
    const path = join(this.dir, "verified.json");
    if (!existsSync(path)) return { v: LEDGER_VERSION, notes: {} };
    try {
      const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
      if (ledger.v !== LEDGER_VERSION || typeof ledger.notes !== "object" || ledger.notes === null || Array.isArray(ledger.notes)) return null;
      const proofs = Object.values(ledger.notes as Record<string, unknown>);
      return proofs.every((proof) => typeof proof === "object" && proof !== null && Number.isSafeInteger((proof as { rev?: unknown }).rev) && /^[0-9a-f]{64}$/.test(String((proof as { hash?: unknown }).hash))) ? ledger : null;
    } catch {
      return null;
    }
  }

  /** A damaged or newer verified.json leaves every note waiting for a person and refuses every change. */
  private writableLedger(): Ledger {
    const ledger = this.readLedger();
    if (ledger === null) throw new MemoryError("memory_too_new", 409, "verified.json is damaged or from a newer Ovis; nothing was changed");
    return ledger;
  }

/** a folder of the store: under its root, made 0700 when missing, and a real folder all the way down (never a link) */
  private folder(...parts: string[]): string {
    // each step is checked before the next is made, so nothing is ever created through a link
    let path = this.dir;
    for (const part of ["", ...parts]) {
      path = part === "" ? path : join(path, part);
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) mkdirSync(path, { mode: 0o700, recursive: part === "" });
      if (!this.contained(path)) throw new MemoryError("memory_too_new", 409, "The memory folder holds a link or a file where a folder belongs; nothing was changed");
    }
    return path;
  }

  private contained(path: string): boolean {
    const inner = relative(this.dir, path);
    if (inner.startsWith("..") || inner.split(sep).includes("..")) return false;
    let at = this.dir;
    for (const part of ["", ...(inner === "" ? [] : inner.split(sep))]) {
      at = part === "" ? at : join(at, part);
      const stats = lstatSync(at, { throwIfNoEntry: false });
      if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    return true;
  }

  /** the regular .md files of a store folder; a linked folder or file is not read */
  private files(folder: string): string[] {
    if (!existsSync(folder) || !this.contained(folder)) return [];
    try { return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(folder, entry.name)); } catch { return []; }
  }

  private notes(): Note[] {
    const ledger = this.readLedger();
    const known = this.options.knownSecrets();
    const read = (path: string, inbox: boolean, folderScope: MemoryScope | null, folderProject: string | null): Note[] => {
      let text: string;
      try {
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.size > FILE_MAX_BYTES) return [];
        text = readFileSync(path, "utf8");
      } catch { return []; }
      const parsed = parseEntry(text);
      if (!parsed.ok) return [];
      const { entry } = parsed;
      if (!path.endsWith(`${entry.id}.md`) || entry.verified === inbox) return [];
      if (folderScope !== null && (entry.scope !== folderScope || (folderProject !== null && projectFolder(entry.project ?? "") !== folderProject))) return [];
      const scan = scanForSecrets(`${entry.title}\n${entry.body}`, known);
      const meta = scanForSecrets(metaText(entry), known);
      const withheld = scan.verdict === "refuse" ? scan.rule : meta.verdict === "refuse" ? meta.rule : null;
      const digest = sha256(text);
      const proof = ledger?.notes[entry.id];
      return [{ entry, path, inbox, proven: !inbox && proof !== undefined && proof.rev === entry.rev && proof.hash === digest, digest, withheld }];
    };
    const projects = join(this.dir, "project");
    const projectFolders = existsSync(projects) && this.contained(projects) ? readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
    return [
      ...this.files(join(this.dir, "account")).flatMap((path) => read(path, false, "account", null)),
      ...projectFolders.flatMap((folder) => this.files(join(this.dir, "project", folder)).flatMap((path) => read(path, false, "project", folder))),
      ...this.files(join(this.dir, "machine")).flatMap((path) => read(path, false, "machine", null)),
      ...this.files(join(this.dir, "inbox")).flatMap((path) => read(path, true, null, null)),
    ];
  }

  private stateOf(note: Note): MemoryState {
    if (note.inbox) return "unconfirmed";
    if (!note.proven || note.withheld !== null) return "changed";
    return note.entry.expires !== null && note.entry.expires < this.today() ? "stale" : "confirmed";
  }

  private item(note: Note): MemoryItem {
    const { entry, withheld, digest } = note;
    const state = this.stateOf(note);
    const shown = withheld === null;
    return {
      id: entry.id, scope: entry.scope, project: shown ? entry.project : null, kind: entry.kind, key: shown ? entry.key : "",
      title: shown ? entry.title : "", body: shown ? entry.body : "", withheld, state, digest,
      expires: entry.expires, rev: entry.rev, updated_at: entry.updated_at, verified_at: entry.verified && shown ? entry.verified_at : null,
      verified_by: entry.verified && shown ? entry.verified_by : null, source_ref: shown ? entry.source_ref : null,
      origin: shown ? entry.origin : { by: entry.origin.by, at: entry.origin.at },
      flags: shown && (state === "unconfirmed" || state === "changed") ? flagsOf(entry) : [],
    };
  }

/** true when an inbox note left: the notes read before are then out of date */
  private sweep(notes: Note[]): boolean {
    const now = this.options.now();
    const expired = notes.filter((note) => note.inbox && Date.parse(note.entry.origin.at) + MEMORY_INBOX_DAYS * DAY_MS < now);
    for (const note of expired) this.toTrash(note.path, note.entry.id);
    for (const path of this.files(join(this.dir, "trash"))) {
      const at = Number(/\.(\d+)(?:\.[0-9a-f]+)?\.md$/.exec(path)?.[1]);
      if (Number.isFinite(at) && at + TRASH_DAYS * DAY_MS < now) rmSync(path, { force: true });
    }
    return expired.length > 0;
  }

  private toTrash(path: string, id: string): void {
    const trash = this.folder("trash");
    let target = join(trash, `${id}.${this.options.now()}.md`);
    if (existsSync(target)) target = join(trash, `${id}.${this.options.now()}.${randomBytes(4).toString("hex")}.md`);
    renameSync(path, target);
  }

  private write(entry: MemoryEntry, ledger: Ledger, replacing: string | null): MemoryItem {
    if (!headerFits(entry)) throw new MemoryError("invalid_memory", 400, "The note is too long to store; shorten it");
    const folder = entry.scope === "project" ? this.folder("project", projectFolder(entry.project!)) : this.folder(entry.scope);
    const path = join(folder, `${entry.id}.md`);
    // a file there that this version did not read (a newer format's, say) is never written over
    if (path !== replacing && lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw new MemoryError("memory_conflict", 409, "Another file of this note is in the way; nothing was changed");
    const text = formatEntry(entry);
    const staged = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(staged, text, { mode: 0o600, flag: "wx" });
    // the file first, its proof after: a failure in between leaves the old note as it was, or the new one waiting for a person
    try { renameSync(staged, path); } catch (error) { rmSync(staged, { force: true }); throw error; }
    const moving = replacing !== null && replacing !== path;
    try { writePrivateState(join(this.dir, "verified.json"), { v: LEDGER_VERSION, notes: { ...ledger.notes, [entry.id]: { rev: entry.rev, hash: sha256(text) } } } satisfies Ledger); }
    catch (error) {
      // a note moving to another scope stays where it was, so the same id is never in two folders
      if (moving) rmSync(path, { force: true });
      throw error;
    }
    if (moving) rmSync(replacing, { force: true });
    return this.item({ entry, path, inbox: false, proven: true, digest: sha256(text), withheld: null });
  }

  private check(draft: Pick<MemoryDraft, "title" | "body" | "notSecret">): void {
    const scan = scanForSecrets(`${draft.title}\n${draft.body}`, this.options.knownSecrets());
    if (scan.verdict === "refuse") throw new MemoryError("secret_found", 422, "This looks like a secret, which a note must not hold. Write where it is kept instead.", scan.rule);
    if (scan.verdict === "ask" && draft.notSecret !== true) throw new MemoryError("secret_suspected", 409, "This holds a random-looking string. Save it only if it is not a secret.", scan.rule);
  }

  private validate(draft: MemoryDraft): void {
    const problem = textProblem(draft.title, draft.body);
    if (problem !== null) throw new MemoryError("invalid_memory", 400, `The note's ${problem.replace("_", " ")} cannot be stored`);
    if (draft.scope === "project" ? draft.project === null || !PROJECT_KEY.test(draft.project) : draft.project !== null) throw new MemoryError("invalid_memory", 400, "A project note names its project, and only a project note does");
    if (draft.expires !== null && !DATE.test(draft.expires)) throw new MemoryError("invalid_memory", 400, "The expiry is a date, YYYY-MM-DD");
  }

  private roomIn(scope: MemoryScope, project: string | null, notes: Note[], except: string | null): void {
    const held = notes.filter((note) => !note.inbox && note.entry.scope === scope && note.entry.project === project && note.entry.id !== except).length;
    if (held >= LIMITS[scope]) throw new MemoryError("memory_full", 409, `This scope holds ${LIMITS[scope]} notes, its most. Remove one first.`);
  }

/** the note's key, made unique among the confirmed notes of the scope it goes to */
  private freeKey(key: string, scope: MemoryScope, project: string | null, notes: Note[], except: string | null): string {
    const taken = new Set(notes.filter((note) => !note.inbox && note.entry.scope === scope && note.entry.project === project && note.entry.id !== except).map((note) => note.entry.key));
    let free = key;
    for (let suffix = 2; taken.has(free); suffix += 1) free = `${key.slice(0, 58)}-${suffix}`;
    return free;
  }

  private find(id: string, notes: Note[]): Note {
    const note = notes.find((candidate) => candidate.entry.id === id);
    if (note === undefined) throw new MemoryError("memory_not_found", 404, "No such note");
    return note;
  }

  async view(folder: string | null): Promise<MemoryView> {
    let notes = this.notes();
    if (this.sweep(notes)) notes = this.notes();
    const hereKey = folder === null ? null : await this.options.projectKeyOf(folder);
    const keys = new Set(notes.flatMap((note) => note.entry.project === null || note.withheld !== null ? [] : [note.entry.project]));
    if (hereKey !== null) keys.add(hereKey);
    const project = (key: string): MemoryProject => ({ key, label: projectLabel(key) });
    let machine = "";
    try { machine = existsSync(join(this.dir, "memory.json")) ? this.machine() : ""; } catch {}
    return {
      machine: { id: machine, name: this.options.hostName },
      here: hereKey === null ? null : project(hereKey),
      projects: [...keys].sort().map(project),
      items: notes.map((note) => this.item(note)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
    };
  }

  /** a note a person wrote on a screen: confirmed as it is written */
  add(draft: MemoryDraft, by: string): MemoryItem {
    this.validate(draft);
    this.check(draft);
    const ledger = this.writableLedger();
    const notes = this.notes();
    this.roomIn(draft.scope, draft.project, notes, null);
    const at = new Date(this.options.now()).toISOString();
    const machine = this.machine();
    const id = ulid(this.options.now());
    const key = this.freeKey(keyFrom(draft.title) || `note.${id.slice(-8).toLowerCase()}`, draft.scope, draft.project, notes, null);
    return this.write({
      v: ENTRY_VERSION, id, scope: draft.scope, project: draft.project, kind: draft.kind, key, title: draft.title, verified: true, verified_at: at, verified_by: by,
      expires: draft.expires, rev: 1, updated_at: at, updated_on: machine, source_ref: null, replaces: null,
      origin: { by: "human", surface: "screen", machine, at }, body: draft.body, extra: {},
    }, ledger, null);
  }

  /** a person's edit on a screen: the text they saved is what they confirm */
  edit(edit: MemoryEdit, by: string): MemoryItem {
    this.validate(edit);
    this.check(edit);
    const ledger = this.writableLedger();
    const notes = this.notes();
    const note = this.find(edit.id, notes.filter((candidate) => !candidate.inbox));
    if (note.entry.rev !== edit.rev || note.digest !== edit.digest) throw new MemoryError("memory_conflict", 409, "The note changed since it was opened. Open it again.");
    if (note.withheld !== null) throw new MemoryError("secret_found", 422, "This note looks like it holds a secret, so it cannot be edited. Remove it.", note.withheld);
    if (note.entry.scope !== edit.scope || note.entry.project !== edit.project) this.roomIn(edit.scope, edit.project, notes, note.entry.id);
    const at = new Date(this.options.now()).toISOString();
    return this.write({
      ...note.entry, scope: edit.scope, project: edit.project, kind: edit.kind, title: edit.title, body: edit.body, expires: edit.expires,
      key: this.freeKey(note.entry.key, edit.scope, edit.project, notes, note.entry.id),
      rev: note.entry.rev + 1, verified: true, verified_at: at, verified_by: by, updated_at: at, updated_on: this.machine(),
    }, ledger, note.path);
  }

  /** a person confirms a waiting note, or one whose file changed outside Ovis, on a screen */
  confirm(id: string, digest: string, by: string, notSecret = false): MemoryItem {
    const ledger = this.writableLedger();
    const notes = this.notes();
    const note = this.find(id, notes);
    if (note.digest !== digest) throw new MemoryError("memory_conflict", 409, "The note changed since it was shown. Look at it again.");
    if (note.withheld !== null) throw new MemoryError("secret_found", 422, "This note looks like it holds a secret, so it cannot be confirmed. Discard it.", note.withheld);
    if (note.proven) return this.item(note);
    this.check({ ...note.entry, notSecret });
    if (note.inbox) this.roomIn(note.entry.scope, note.entry.project, notes, null);
    const at = new Date(this.options.now()).toISOString();
    const key = this.freeKey(note.entry.key, note.entry.scope, note.entry.project, notes, note.entry.id);
    return this.write({ ...note.entry, key, rev: note.inbox ? note.entry.rev : note.entry.rev + 1, verified: true, verified_at: at, verified_by: by, updated_at: at, updated_on: this.machine() }, ledger, note.path);
  }

  remove(id: string): void {
    const ledger = this.writableLedger();
    const note = this.find(id, this.notes().filter((candidate) => !candidate.inbox));
    const kept = Object.fromEntries(Object.entries(ledger.notes).filter(([noted]) => noted !== id));
    writePrivateState(join(this.dir, "verified.json"), { v: LEDGER_VERSION, notes: kept } satisfies Ledger);
    this.toTrash(note.path, id);
  }

  discard(id: string): void {
    const note = this.find(id, this.notes().filter((candidate) => candidate.inbox));
    this.toTrash(note.path, id);
  }

  /** everything one run wrote that still waits; what a person confirmed stays */
  discardRun(run: string): number {
    const written = this.notes().filter((note) => note.inbox && note.entry.origin.run === run);
    for (const note of written) this.toTrash(note.path, note.entry.id);
    return written.length;
  }
}
