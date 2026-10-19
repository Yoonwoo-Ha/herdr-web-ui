import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import nodePath from "node:path";
import { promisify } from "node:util";

const PAGE_LIMIT = 100;
const MAX_PAGES = 8;
const MAX_ROWS = PAGE_LIMIT * MAX_PAGES;
// A full `gjc sdk session raw global --op session.list` call measured 1.0-2.0 s on a
// loaded Apple M1 Pro, so 2 s cut off many cold lookups. The 10 s SDK budget reserves 5 s
// of the client's 15 s local chat read for other work, whose timeouts are independent.
// Status discovery keeps the old shorter budget so snapshots do not inherit cold-chat waits.
const COMMAND_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const STATUS_COMMAND_TIMEOUT_MS = 2_000;
const STATUS_TOTAL_TIMEOUT_MS = 8_000;
const MAX_BUFFER = 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;

/** Execution failed; unlike an identity rejection, this must not clear the current chat. */
export class GjcSdkLookupError extends Error {
  constructor(readonly reason: "timeout" | "unavailable") {
    super("GJC SDK lookup failed");
    this.name = "GjcSdkLookupError";
  }
}

function lookupExecutionError(error: unknown): GjcSdkLookupError {
  if (error instanceof GjcSdkLookupError) return error;
  const timedOut = isRecord(error) && (error.killed === true || error.signal === "SIGKILL"
    || error.code === "ETIMEDOUT" || error.code === "ERR_CHILD_PROCESS_TIMEOUT");
  return new GjcSdkLookupError(timedOut ? "timeout" : "unavailable");
}

export interface GjcSdkCommandOptions {
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
  shell: false;
  windowsHide: true;
}

/** A narrow seam for fixture-driven tests; production always uses execFile below. */
export type GjcSdkCommandRunner = (command: string, args: string[], options: GjcSdkCommandOptions) => Promise<string>;

export type GjcSdkWorktreeRootResolver = (cwd: string, timeoutMs: number) => Promise<string | null>;

export interface GjcSdkBinding {
  sessionId: string;
  pid: number;
  path: string;
  hostIncarnation: string;
  endpointGeneration: number;
  /** Includes retired/fence rows: a heartbeat may revive a same-pid session without registering it. */
  guardSessionIds: string[];
}

const execFileAsync = promisify(execFile);

const runGjcSdkCommand: GjcSdkCommandRunner = async (command, args, options) => {
  const execution = execFileAsync(command, args, options);
  execution.child.stdin?.end();
  const { stdout } = await execution;
  return stdout;
};

const GIT_MAX_BUFFER = 64 * 1024;

const gitWorktreeRoot: GjcSdkWorktreeRootResolver = async (cwd, timeoutMs) => {
  const execution = execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    windowsHide: true,
  });
  execution.child.stdin?.end();
  try {
    const { stdout } = await execution;
    return stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  } catch (error) {
    // Git uses 128 outside a worktree. The broker independently validates the null anchor,
    // so an unrelated Git error cannot authorize a workspace with the wrong identity.
    if (isRecord(error) && error.code === 128) return null;
    throw error;
  }
};

interface BrokerPage {
  indexSeq: number;
  sessions: unknown[];
  continuationCursor: string | null;
  savedSession: unknown;
}

interface SessionBinding {
  sessionId: string;
  pid: number;
  hostIncarnation: string;
  endpointGeneration: number;
  canonicalCwd: string;
  locatorCwd: string;
  worktreeRoot: string | null;
  stateRoot: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function definitivelyRetired(row: Record<string, unknown>): boolean {
  return row.live === false
    || row.deleted === true
    || (row.terminal === true && row.terminalUncertain === false);
}

function collectGuardSessionIds(rows: readonly unknown[], pids: ReadonlySet<number>, sessionIds: Set<string>): void {
  for (const row of rows) {
    if (isRecord(row) && typeof row.pid === "number" && pids.has(row.pid) && nonEmptyString(row.sessionId)) {
      sessionIds.add(row.sessionId);
    }
  }
}

/**
 * GJC also publishes a generation-zero direct-session GC fence at the agent root.
 * It has no endpoint authority and can remain live after /new. Only this proven
 * shape is ignored; foreign-root, uncertain and malformed zero-generation rows
 * must still prevent a binding (SDK session-index.ts: isDirectSessionGcFenceRow).
 */
function directSessionFence(row: Record<string, unknown>, agentDir: string): boolean {
  if (!isRecord(row.locator)) return false;
  const root = canonicalPath(agentDir);
  return root !== null && canonicalPath(row.locator.stateRoot) === root
    && nonEmptyString(row.sessionId) && row.live === true
    && row.endpointGeneration === 0
    && row.terminal === false && row.terminalUncertain === false && row.ambiguous === false
    && row.identityProvenance === "composite"
    && nonEmptyString(row.hostIncarnation) && row.processIncarnation === row.hostIncarnation
    && row.endpointMtimeMs === undefined && row.endpointFileId === undefined && row.endpointIncarnation === undefined;
}

function canonicalPath(value: unknown): string | null {
  if (typeof value !== "string" || !nodePath.isAbsolute(value)) return null;
  try {
    const canonical = realpathSync.native(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return null;
  }
}

function parseBrokerPage(text: string): BrokerPage | null {
  try {
    const envelope: unknown = JSON.parse(text);
    if (!isRecord(envelope) || envelope.type !== "broker_response" || envelope.ok !== true || !isRecord(envelope.result)) return null;
    const result = envelope.result;
    if (typeof result.indexSeq !== "number" || !Number.isSafeInteger(result.indexSeq) || result.indexSeq < 0 || !Array.isArray(result.sessions)) return null;

    let continuationCursor: string | null = null;
    if (Object.hasOwn(result, "continuationCursor") && result.continuationCursor !== null) {
      if (typeof result.continuationCursor !== "string"
        || result.continuationCursor.length === 0
        || result.continuationCursor.length > MAX_CURSOR_LENGTH
        || result.continuationCursor.trim() !== result.continuationCursor
        || /[\u0000-\u001f\u007f]/.test(result.continuationCursor)) return null;
      continuationCursor = result.continuationCursor;
    }

    return {
      indexSeq: result.indexSeq as number,
      sessions: result.sessions,
      continuationCursor,
      savedSession: result.savedSession,
    };
  } catch {
    return null;
  }
}

function bindingFromRow(value: unknown, pids: ReadonlySet<number>, cwd: string, worktreeRoot: string | null): SessionBinding | null {
  if (!isRecord(value)) return null;
  const locator = value.locator;
  if (!isRecord(locator)
    || !Object.hasOwn(locator, "worktreeRoot")
    || !Object.hasOwn(locator, "stateRoot")
    || !(locator.worktreeRoot === null || typeof locator.worktreeRoot === "string")
    || !(locator.stateRoot === null || typeof locator.stateRoot === "string")) return null;

  const canonicalCwd = canonicalPath(locator.cwd);
  if (canonicalCwd === null || canonicalCwd !== cwd || canonicalPath(locator.worktreeRoot) !== worktreeRoot) return null;
  if (locator.worktreeRoot !== null && canonicalPath(locator.worktreeRoot) === null) return null;
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !pids.has(value.pid)
    || !nonEmptyString(value.sessionId)
    || typeof value.endpointGeneration !== "number" || !Number.isSafeInteger(value.endpointGeneration) || value.endpointGeneration <= 0
    || !nonEmptyString(value.hostIncarnation)
    || value.identityProvenance !== "composite"
    || value.live !== true
    || value.terminal !== false
    || value.terminalUncertain !== false
    || value.ambiguous !== false
    || value.deleted === true) return null;

  return {
    sessionId: value.sessionId,
    pid: value.pid,
    hostIncarnation: value.hostIncarnation,
    endpointGeneration: value.endpointGeneration,
    canonicalCwd,
    locatorCwd: locator.cwd as string,
    worktreeRoot: locator.worktreeRoot,
    stateRoot: locator.stateRoot,
  };
}

function sameBinding(row: unknown, expected: SessionBinding, pids: ReadonlySet<number>, cwd: string, worktreeRoot: string | null): boolean {
  const actual = bindingFromRow(row, pids, cwd, worktreeRoot);
  return actual !== null
    && actual.sessionId === expected.sessionId
    && actual.pid === expected.pid
    && actual.hostIncarnation === expected.hostIncarnation
    && actual.endpointGeneration === expected.endpointGeneration
    && actual.canonicalCwd === expected.canonicalCwd
    && actual.worktreeRoot === expected.worktreeRoot
    && actual.stateRoot === expected.stateRoot;
}

function sdkArgs(agentDir: string, jsonInput?: Record<string, unknown>): string[] {
  const args = [
    "sdk", "session", "raw", "global",
    "--op", "session.list",
    "--page", "--limit", String(PAGE_LIMIT),
    "--agent-dir", agentDir,
    "--attach-only", "--json",
  ];
  if (jsonInput !== undefined) args.push("--json-input", JSON.stringify(jsonInput));
  return args;
}

async function runBounded(
  runner: GjcSdkCommandRunner,
  args: string[],
  deadline: number,
  commandTimeoutMs: number,
): Promise<string> {
  const remaining = Math.min(commandTimeoutMs, deadline - Date.now());
  if (remaining <= 0) throw new GjcSdkLookupError("timeout");

  const options: GjcSdkCommandOptions = {
    env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
    encoding: "utf8",
    timeout: remaining,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
    shell: false,
    windowsHide: true,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => runner("gjc", args, options)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), remaining);
      }),
    ]);
  } catch (error) {
    // only a timeout is worth retrying; a missing or failing gjc stays the fallback it was
    const failure = lookupExecutionError(error);
    throw failure.reason === "timeout" ? failure : error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveWorktreeRoot(
  resolver: GjcSdkWorktreeRootResolver,
  cwd: string,
  deadline: number,
  commandTimeoutMs: number,
): Promise<string | null | undefined> {
  const timeoutMs = Math.min(commandTimeoutMs, deadline - Date.now());
  if (timeoutMs <= 0) throw new GjcSdkLookupError("timeout");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const root = await Promise.race([
      Promise.resolve().then(() => resolver(cwd, timeoutMs)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GjcSdkLookupError("timeout")), timeoutMs);
      }),
    ]);
    return root === null ? null : canonicalPath(root) ?? undefined;
  } catch (error) {
    const failure = lookupExecutionError(error);
    if (failure.reason === "timeout") throw failure;
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveTranscript(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  runner: GjcSdkCommandRunner,
  worktreeRootResolver: GjcSdkWorktreeRootResolver,
  purpose: "chat" | "status",
): Promise<GjcSdkBinding | null> {
  try {
    if (!Array.isArray(pids) || pids.length === 0 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
      || typeof cwd !== "string" || cwd === ""
      || typeof agentDir !== "string" || agentDir === "") return null;

    const commandTimeoutMs = purpose === "status" ? STATUS_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    const deadline = Date.now() + (purpose === "status" ? STATUS_TOTAL_TIMEOUT_MS : TOTAL_TIMEOUT_MS);
    const canonicalCwd = canonicalPath(cwd);
    if (canonicalCwd === null) return null;
    const canonicalWorktreeRoot = await resolveWorktreeRoot(worktreeRootResolver, canonicalCwd, deadline, commandTimeoutMs);
    if (canonicalWorktreeRoot === undefined) return null;
    const wantedPids = new Set(pids);
    const seenCursors = new Set<string>();
    const rows: unknown[] = [];
    const guardSessionIds = new Set<string>();
    let indexSeq: number | null = null;
    let cursor: string | null = null;
    const scope = {
      version: 1,
      requested: "pwd",
      requestAnchor: { cwd: canonicalCwd, worktreeRoot: canonicalWorktreeRoot },
    } as const;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const input = cursor === null ? { scope } : { scope, cursor };
      const output = await runBounded(runner, sdkArgs(agentDir, input), deadline, commandTimeoutMs);
      const response = parseBrokerPage(output);
      if (response === null || response.sessions.length > PAGE_LIMIT) return null;
      if (indexSeq !== null && response.indexSeq !== indexSeq) return null;
      indexSeq = response.indexSeq;
      if (rows.length + response.sessions.length > MAX_ROWS) return null;
      rows.push(...response.sessions);
      collectGuardSessionIds(response.sessions, wantedPids, guardSessionIds);

      cursor = response.continuationCursor;
      if (cursor === null) break;
      if (seenCursors.has(cursor)) return null;
      seenCursors.add(cursor);
      if (page === MAX_PAGES - 1) return null;
    }

    const candidates: SessionBinding[] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.pid !== "number" || !wantedPids.has(row.pid) || definitivelyRetired(row)) continue;
      if (directSessionFence(row, agentDir)) continue;
      if (row.live !== true) return null;
      const binding = bindingFromRow(row, wantedPids, canonicalCwd, canonicalWorktreeRoot);
      if (binding === null) return null;
      candidates.push(binding);
    }
    if (candidates.length !== 1) return null;
    const expected = candidates[0]!;

    const lookup = await runBounded(runner, sdkArgs(agentDir, { cwd: expected.locatorCwd, resolveSessionId: expected.sessionId }), deadline, commandTimeoutMs);
    const exact = parseBrokerPage(lookup);
    if (exact === null || exact.continuationCursor !== null || indexSeq === null || exact.indexSeq < indexSeq) return null;

    collectGuardSessionIds(exact.sessions, wantedPids, guardSessionIds);
    const samePidRows = exact.sessions.filter((row) => isRecord(row)
      && row.pid === expected.pid
      && !definitivelyRetired(row) && !directSessionFence(row, agentDir));
    if (samePidRows.length !== 1 || !sameBinding(samePidRows[0], expected, wantedPids, canonicalCwd, canonicalWorktreeRoot)) return null;
    if (!isRecord(samePidRows[0]) || samePidRows[0].sessionId !== expected.sessionId) return null;
    if (!isRecord(exact.savedSession) || exact.savedSession.id !== expected.sessionId
      || typeof exact.savedSession.path !== "string" || !nodePath.isAbsolute(exact.savedSession.path)) return null;

    guardSessionIds.add(expected.sessionId);
    return {
      sessionId: expected.sessionId,
      pid: expected.pid,
      path: exact.savedSession.path,
      hostIncarnation: expected.hostIncarnation,
      endpointGeneration: expected.endpointGeneration,
      guardSessionIds: [...guardSessionIds],
    };
  } catch (error) {
    if (error instanceof GjcSdkLookupError) throw error;
    // Invalid identity data still fails closed; only sanitized execution failures propagate.
    return null;
  }
}

/** Resolves the current readable GJC transcript for one of the pane's known GJC processes. */
export function gjcSdkTranscript(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  purpose: "chat" | "status" = "chat",
): Promise<GjcSdkBinding | null> {
  return resolveTranscript(pids, cwd, agentDir, runGjcSdkCommand, gitWorktreeRoot, purpose);
}

/** Fixture-injection entry point; production callers should use gjcSdkTranscript. */
export function gjcSdkTranscriptWithRunner(
  pids: readonly number[],
  cwd: string,
  agentDir: string,
  runner: GjcSdkCommandRunner,
  worktreeRootResolver: GjcSdkWorktreeRootResolver = gitWorktreeRoot,
  purpose: "chat" | "status" = "chat",
): Promise<GjcSdkBinding | null> {
  return resolveTranscript(pids, cwd, agentDir, runner, worktreeRootResolver, purpose);
}
