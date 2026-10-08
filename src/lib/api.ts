import { machinePath, type BridgeHealth, type HerdrIdentity, type Machine, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
import type {
  AgentKind,
  ConversationResponse,
  CreateWorktreeRequest,
  CreateTabRequest,
  CreateWorkspaceRequest,
  DirectoryListing,
  FileInfo,
  HealthAuth,
  InteractivePrompt,
  OmoActivity,
  OpenWorktreeRequest,
  PairedDevice,
  PairingCode,
  PaneReadResult,
  PromptAnswer,
  PushKey,
  RemoteAccess,
  RemoveWorktreeRequest,
  SessionSnapshot,
  SlashCommand,
  TabCreated,
  UsageReport,
  WorkspaceCreated,
  WorktreeListing,
  WorktreeOpened,
  WorktreeRemoved,
} from "../../shared/protocol.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import { readInstalledNotes, readUpdateNotes, type HerdrUpdateStatus, type InstalledNotes, type UpdateCommand, type UpdateNotes, type UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { TelemetryStatus } from "../../shared/telemetry.ts";
import type { VoiceConfigUpdate, VoiceStatus } from "../../shared/voice.ts";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";

/** Settings → Phone: what Tailscale on the server's PC already serves, or the command to run. */
export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

/** The sidebar's plan meters; `refresh` asks the providers again instead of the server's recent answer. */
export function fetchUsage(refresh = false): Promise<UsageReport> {
  return getJson<UsageReport>(refresh ? "/api/usage?refresh=1" : "/api/usage");
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>("/api/updates");
}

/** What the available update brings. A server older than the notes answers with an error. */
export async function fetchUpdateNotes(): Promise<UpdateNotes> {
  return readUpdateNotes(await getJson<unknown>("/api/updates/notes"));
}

/** What the last update brought. A server older than the question answers with an error. */
export async function fetchInstalledNotes(): Promise<InstalledNotes> {
  return readInstalledNotes(await getJson<unknown>("/api/updates/installed"));
}

export async function requestUpdate(command: UpdateCommand): Promise<void> {
  const url = `/api/updates/${command}`;
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Updates: herdr itself, on the PC the server runs on. */
export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

export async function requestHerdrUpdate(): Promise<void> {
  const url = "/api/herdr/update";
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Anonymous install and update counts; null from a server that sends none (404). */
export async function fetchTelemetry(): Promise<TelemetryStatus | null> {
  try { return await getJson<TelemetryStatus>("/api/telemetry"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function changeTelemetry(change: { enabled?: boolean; notice_seen?: true }): Promise<TelemetryStatus> {
  const url = "/api/telemetry";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(change) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as TelemetryStatus;
}

/**
 * A non-2xx answer from the herdr-web-ui API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** the server's own words, without the URL and status the message starts with */
  readonly detail: string;

  constructor(url: string, status: number, detail: string, code: string | null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(url, response.status, detail, code);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

export async function fetchSession(machineId = "local"): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>(machinePath(machineId, "session"));
  return body.snapshot;
}

/** PCs whose herdr rejected `recent_unwrapped`: an older herdr, read row by row from then on. */
const wrappedOnly = new Set<string>();

/**
 * GET /api/pane/read as the chat view polls it: herdr's own scrollback (up to
 * `lines`), ANSI-stripped text. herdr owns scrollback — the attach stream cannot
 * serve history, so the transcript reads it back instead. `recent_unwrapped`
 * rejoins the rows the terminal soft-wrapped, so a line reflows to the chat's
 * width instead of breaking where the pty's columns ended.
 */
export async function fetchPaneTranscript(paneId: string, lines: number, machineId = "local"): Promise<PaneReadResult> {
  const read = async (source: "recent" | "recent_unwrapped"): Promise<PaneReadResult> => {
    const query = new URLSearchParams({ pane_id: paneId, source, format: "text", lines: String(lines) });
    return (await getJson<{ read: PaneReadResult }>(machinePath(machineId, `pane/read?${query.toString()}`))).read;
  };
  if (wrappedOnly.has(machineId)) return read("recent");
  try {
    return await read("recent_unwrapped");
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid_request") throw error;
    wrappedOnly.add(machineId);
    return read("recent");
  }
}

/** Which turns (ConversationResponse.cursor): the page `before` a cursor, not past `since`; the newest ones `from` a held start. */
export type ConversationPageQuery = { before?: string; since?: string; from?: string };

/**
 * The last answer per polled conversation URL and its ETag. The chat polls every 2s
 * and a newest page can be megabytes: an unchanged one comes back as a bodyless 304,
 * and the chat gets the very same object back, which tells it nothing changed. An
 * older page (`before`) is asked for once, so it keeps no ETag and takes no slot.
 *
 * A count alone does not bound what a tab holds: sixteen polled panes is a small number of
 * bodies, each as large as the server makes it, so the cache also gives up its oldest entries
 * once the answers together pass a byte budget. The answer just fetched is never given up for
 * that (it is the one the caller is about to read), the panes after it go first.
 */
interface ConversationAnswer {
  etag: string;
  body: ConversationResponse;
  /** the body's rough size: what the count cap alone cannot bound */
  bytes: number;
}
const conversationAnswers = new Map<string, ConversationAnswer>();
const CONVERSATION_ANSWERS_KEPT = 16;
/** …and this much of them, about four ordinary conversation pages each. */
const CONVERSATION_ANSWERS_BYTES = 8 * 1024 * 1024;

/**
 * The body a cache entry carries: the server's own count when it sends one for the body as it is,
 * else the JSON we parsed. A compressed answer's length counts the bytes on the wire, not these.
 */
export function conversationAnswerBytes(body: ConversationResponse, contentLength: string | null, contentEncoding: string | null = null): number {
  const declared = Number(contentLength);
  const identity = contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  if (identity && Number.isFinite(declared) && declared > 0) return declared;
  return JSON.stringify(body)?.length ?? 0;
}

/** Drops the least recently used answers until the cache is back inside both caps. */
function trimConversationAnswers(keep: string): void {
  let total = 0;
  for (const answer of conversationAnswers.values()) total += answer.bytes;
  while (conversationAnswers.size > CONVERSATION_ANSWERS_KEPT || total > CONVERSATION_ANSWERS_BYTES) {
    const oldest = conversationAnswers.keys().next().value;
    if (oldest === undefined || oldest === keep) break;
    total -= conversationAnswers.get(oldest)!.bytes;
    conversationAnswers.delete(oldest);
  }
}

/** GET /api/pane/conversation: structured turns, or scrollback fallback; `page` as ConversationResponse.cursor describes. */
export async function fetchPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): Promise<ConversationResponse> {
  const query = new URLSearchParams({ pane_id: paneId });
  if (page.before !== undefined) query.set("before", page.before);
  if (page.since !== undefined) query.set("since", page.since);
  if (page.from !== undefined) query.set("from", page.from);
  const url = machinePath(machineId, `pane/conversation?${query.toString()}`);
  const polled = page.before === undefined;
  const known = polled ? conversationAnswers.get(url) : undefined;
  const response = await fetch(url, { cache: "no-store", ...(known ? { headers: { "if-none-match": known.etag } } : {}) });
  if (response.status === 304 && known) {
    // the pane being polled stays among the kept answers
    conversationAnswers.delete(url);
    conversationAnswers.set(url, known);
    return known.body;
  }
  if (!response.ok) throw await errorFrom(url, response);
  const body = (await response.json()) as ConversationResponse;
  const etag = response.headers.get("etag");
  if (!polled) return body;
  conversationAnswers.delete(url);
  if (etag !== null) {
    conversationAnswers.set(url, { etag, body, bytes: conversationAnswerBytes(body, response.headers.get("content-length"), response.headers.get("content-encoding")) });
    trimConversationAnswers(url);
  }
  return body;
}

export interface HealthInfo {
  ok: boolean;
  herdr: HerdrIdentity;
  web_ui?: { boot_id: string | null; revision: string | null };
  /** Absent only on a server that predates the token gate. */
  auth?: HealthAuth;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}

/**
 * POST /api/auth. Resolves once the server has set its HttpOnly session cookie;
 * there is nothing to store client-side. Throws ApiError (401 `invalid_token`) on
 * a mismatch.
 */
export async function authenticate(token: string): Promise<void> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** POST /api/devices/pair: the code shown on the PC, once; the server answers with this device's own HttpOnly cookie. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const response = await fetch("/api/devices/pair", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw await errorFrom("/api/devices/pair", response);
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  return (await getJson<{ devices: PairedDevice[] }>("/api/devices")).devices;
}

export async function startPairing(): Promise<PairingCode> {
  return (await sendJson("/api/devices/pair/start", "POST", {})).json();
}

export async function renameDevice(id: string, label: string): Promise<PairedDevice> {
  return (await sendJson(`/api/devices/${encodeURIComponent(id)}`, "PATCH", { label })).json();
}

export async function revokeDevice(id: string): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(id)}`, "DELETE", {});
}

/** DELETE /api/auth: clears the session and device cookies, so the next health check reports the gate again. */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** Chunked btoa: the naive one-liner blows the stack on multi-MB screenshots. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Megabytes to one decimal, rounded up: a file just over the limit never reads as the limit itself. */
const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** A file over the attachment limit. Its message is what the person reads: the file, its size, the limit. */
export class AttachmentTooLargeError extends Error {
  readonly fileName: string;
  readonly size: number;

  constructor(fileName: string, size: number) {
    super(t("Too large to attach: {name} ({size}). A file can be up to {limit}.", { name: fileName, size: megabytes(size), limit: megabytes(MAX_ATTACHMENT_BYTES) }));
    this.name = "AttachmentTooLargeError";
    this.fileName = fileName;
    this.size = size;
  }
}

/** Throws for a file the server would refuse, before any of it is read or sent. */
export function assertAttachable(file: Blob): void {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file instanceof File && file.name ? file.name : file.type || "file", file.size);
}

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). AttachmentTooLargeError for a file over the limit, with nothing sent;
 * ApiError 413 image_too_large from a server whose limit is lower.
 */
/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, image: Blob, machineId = "local"): Promise<string> {
  assertAttachable(image);
  const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
  const response = await fetch(machinePath(machineId, "pane/image"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64, ...(image instanceof File ? { name: image.name } : {}) }),
  });
  if (!response.ok) throw await errorFrom(machinePath(machineId, "pane/image"), response);
  return ((await response.json()) as { path: string }).path;
}

async function sendJson(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/** GET /api/pane/scroll: where the pane's viewport sits in its history (null: herdr reports none). */
export async function fetchPaneScroll(paneId: string, machineId = "local"): Promise<PaneScrollInfo | null> {
  return (await getJson<{ scroll: PaneScrollInfo | null }>(machinePath(machineId, `pane/scroll?pane_id=${encodeURIComponent(paneId)}`))).scroll;
}

/** POST /api/pane/scroll: moves the viewport; herdr redraws the attached terminal. */
export async function scrollPane(paneId: string, offsetFromBottom: number, machineId = "local"): Promise<PaneScrollInfo | null> {
  const response = await sendJson(machinePath(machineId, "pane/scroll"), "POST", { pane_id: paneId, offset_from_bottom: offsetFromBottom });
  return ((await response.json()) as { scroll: PaneScrollInfo | null }).scroll;
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** GET /api/pane/selection: the text between two history cells, both inclusive, wrapped lines joined. */
export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId });
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/rename"), "POST", { pane_id: paneId, label });
}

/** GET /api/agents: the agent kinds herdr can start, for the new-session dialog. */
export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents;
}

/** GET /api/workspace/directories: the folders in `path` (empty: home), for the folder browser. */
export async function fetchDirectories(path: string, hidden: boolean, machineId = "local", files = false, paneId: string | null = null): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}), ...(files ? { files: "1" } : {}), ...(paneId ? { pane_id: paneId } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

function fileQuery(path: string, paneId: string | null): string {
  return new URLSearchParams({ path, ...(paneId ? { pane_id: paneId } : {}) }).toString();
}

/**
 * GET /api/fs/stat: a file to open; `path` is absolute, `~/…` or relative to the pane's
 * folder. A bare name that several files under the folder end in answers with them.
 */
export async function fetchFileInfo(path: string, paneId: string | null, machineId = "local"): Promise<FileInfo | { candidates: string[] }> {
  const url = machinePath(machineId, `fs/stat?${fileQuery(path, paneId)}`);
  const response = await fetch(url);
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: { candidates?: unknown } } | null;
    if (Array.isArray(body?.error?.candidates)) return { candidates: body.error.candidates.map(String) };
  }
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as FileInfo;
}

/** GET /api/fs/file: the file itself, streamed (ranges for media); `download` saves it instead. */
export function fileUrl(path: string, paneId: string | null, machineId = "local", download = false): string {
  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);
}

export type { CreateTabRequest, CreateWorkspaceRequest } from "../../shared/protocol.ts";

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest, machineId = "local"): Promise<WorkspaceCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/create"), "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

/** POST /api/worktree/create: a git worktree of the workspace's repository, opened as a workspace grouped with it. */
export async function createWorktree(request: CreateWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/create"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** GET /api/worktree/list: every checkout of the workspace's repository, with the workspace each is open in. */
export function listWorktrees(workspaceId: string, machineId = "local"): Promise<WorktreeListing> {
  return getJson<WorktreeListing>(`${machinePath(machineId, "worktree/list")}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/** POST /api/worktree/open: an existing checkout as a workspace; the one it already has when it is open. */
export async function openWorktree(request: OpenWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/open"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** POST /api/tab/create: another tab in an existing workspace, with the same agent launch. */
export async function createTab(request: CreateTabRequest, machineId = "local"): Promise<TabCreated> {
  const response = await sendJson(machinePath(machineId, "tab/create"), "POST", request);
  return (await response.json()) as TabCreated;
}

/** POST /api/tab/rename: the tab's name in herdr; an empty one is refused. */
export async function renameTab(tabId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/rename"), "POST", { tab_id: tabId, label });
}

/** POST /api/tab/close: the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function closeTab(tabId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/close"), "POST", { tab_id: tabId });
}

export async function renameWorkspace(workspaceId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/rename"), "POST", { workspace_id: workspaceId, label });
}

/** POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order). */
export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
}

/** closeGroup takes the repository's open worktree workspaces with it; herdr refuses to close over them otherwise. */
export async function closeWorkspace(workspaceId: string, machineId = "local", closeGroup = false): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) });
}

/** POST /api/worktree/remove: deletes the checkout and closes its workspace; the branch stays. */
export async function removeWorktree(request: RemoveWorktreeRequest, machineId = "local"): Promise<WorktreeRemoved> {
  const response = await sendJson(machinePath(machineId, "worktree/remove"), "POST", request);
  return (await response.json()) as WorktreeRemoved;
}

/** GET /api/pane/commands: the slash commands the pane's agent understands (built-in + custom). */
export async function fetchPaneCommands(paneId: string, machineId = "local"): Promise<SlashCommand[]> {
  return (await getJson<{ commands: SlashCommand[] }>(machinePath(machineId, `pane/commands?pane_id=${encodeURIComponent(paneId)}`))).commands;
}

/** GET /api/pane/omo-tasks: the background tasks and workflows the pane's OmO session started, and that PC's clock. */
export async function fetchPaneOmoActivity(paneId: string, machineId = "local"): Promise<{ tasks: OmoActivity["tasks"]; runs: OmoActivity["runs"]; serverTime: string | null }> {
  const activity = await getJson<Partial<OmoActivity>>(machinePath(machineId, `pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`));
  // a bridge from before workflows answers tasks only
  return { tasks: activity.tasks ?? [], runs: activity.runs ?? [], serverTime: activity.server_time ?? null };
}

/** GET /api/pane/files: paths under the pane's cwd matching `query`, for @-mentions. */
export async function fetchPaneFiles(paneId: string, query: string, limit = 20, machineId = "local"): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(machinePath(machineId, `pane/files?${params.toString()}`))).files;
}

/** GET /api/pane/prompt: the agent's interactive menu currently on screen, or null. */
export async function fetchPanePrompt(paneId: string, machineId = "local"): Promise<InteractivePrompt | null> {
  return (await fetchPanePromptState(paneId, machineId)).prompt;
}

/** The waiting prompt, and with none, the next prompt the agent suggests (older servers send no suggestion). */
export async function fetchPanePromptState(paneId: string, machineId = "local"): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null }> {
  const body = await getJson<{ prompt: InteractivePrompt | null; suggestion?: string | null }>(machinePath(machineId, `pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
  return { prompt: body.prompt, suggestion: typeof body.suggestion === "string" && body.suggestion !== "" ? body.suggestion : null };
}

/** POST /api/pane/prompt/answer: ApiError 409 `prompt_changed` when the menu moved on. */
export async function answerPanePrompt(answer: PromptAnswer, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/prompt/answer"), "POST", answer);
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

/** `alerts`: what this device wants to hear about; the server applies it to every alert it sends here. */
export async function registerPushSubscription(subscription: PushSubscriptionJSON, alerts?: AlertPrefs): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", alerts === undefined ? { subscription } : { subscription, alerts });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}

export function fetchBridgeHealth(): Promise<BridgeHealth> { return getJson("/api/health?scope=bridge"); }
export async function fetchMachines(signal?: AbortSignal): Promise<Machine[]> {
  const response = await fetch("/api/machines", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return ((await response.json()) as { machines: Machine[] }).machines;
}
export async function machineRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/machines${path}`, { method, headers: { "content-type": "application/json", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return response.json();
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);

/** GET /api/voice: whether the server holds a key; the key itself never comes back. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const response = await fetch("/api/voice", { cache: "no-store" });
  if (!response.ok) throw await errorFrom("/api/voice", response);
  return (await response.json()) as VoiceStatus;
}

/** PUT /api/voice/config: ApiError 409 `key_from_env` when the key comes from HERDR_WEB_OPENAI_API_KEY. */
export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceStatus> {
  const response = await fetch("/api/voice/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  if (!response.ok) throw await errorFrom("/api/voice/config", response);
  return (await response.json()) as VoiceStatus;
}
