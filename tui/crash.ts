/**
 * The crash record: after an error nothing expected, a short file that says what the screen was doing, in the screen's
 * state folder (mode 0700, each file 0600, the newest CRASH_RECORDS_KEPT kept). It holds codes and shapes only: the
 * version, hc's version and features, the size, the mode, the last action codes and where the error was thrown. Never
 * a pane's bytes or anything typed: no field takes free text from input or from a pane.
 */

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LoopReport } from "./loop.ts";
import { CRASH_RECORDS_KEPT } from "./model/deadlines.ts";

export interface CrashRecord {
  at: string;
  version: string;
  hc: LoopReport["hc"];
  size: LoopReport["size"];
  mode: LoopReport["mode"];
  link: LoopReport["link"];
  actions: string[];
  /** the error's stable code (an HcError's or an emulator error's kind, a system error's code), its class, and the stack's frames without its message */
  error: { code: string; name: string; frames: string[] };
}

const PREFIX = "crash-";

/** The error's stable code: `kind` (HcError, an emulator error), else `code` (a system error), else `unexpected`. */
export function errorCode(error: unknown): string {
  const fields = typeof error === "object" && error !== null ? error as { kind?: unknown; code?: unknown } : {};
  if (typeof fields.kind === "string" && /^[a-z_]{1,40}$/.test(fields.kind)) return fields.kind;
  if (typeof fields.code === "string" && /^[A-Za-z_]{1,40}$/.test(fields.code)) return fields.code;
  return "unexpected";
}

export function crashRecord(version: string, report: LoopReport | null, error: unknown, now: Date): CrashRecord {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  return {
    at: now.toISOString(),
    version,
    hc: report?.hc ?? null,
    size: report?.size ?? { cols: 0, rows: 0 },
    mode: report?.mode ?? { name: "terminal", locked: false, armed: false, overlays: [] },
    link: report?.link ?? { kind: "Connecting", code: null },
    actions: report?.actions ?? [],
    error: {
      code: errorCode(error),
      name: error instanceof Error ? error.constructor.name : typeof error,
      // only the frames: the first line holds the message, which may quote anything
      frames: stack.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("at ")).slice(0, 20),
    },
  };
}

let written = 0;

/** Writes `record` into `folder` (made 0700 if needed), the file 0600; keeps the newest CRASH_RECORDS_KEPT. Answers its path. */
function writeCrashRecord(folder: string, record: CrashRecord, pid: number): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const name = `${PREFIX}${record.at.replaceAll(":", "-")}-${pid}-${String(written++).padStart(4, "0")}.json`;
  const path = join(folder, name);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  const records = readdirSync(folder).filter((file) => file.startsWith(PREFIX) && file.endsWith(".json")).sort();
  for (const old of records.slice(0, Math.max(0, records.length - CRASH_RECORDS_KEPT))) rmSync(join(folder, old), { force: true });
  return path;
}

/** After an unexpected error: the terminal is given back FIRST (else the runtime prints onto the alternate screen), then the record is written. */
export function recordCrash(leave: () => void, folder: string, record: CrashRecord, pid: number): string {
  try {
    leave();
  } catch {
    // a terminal that cannot even be given back still gets its record: it says what happened
  }
  return writeCrashRecord(folder, record, pid);
}
