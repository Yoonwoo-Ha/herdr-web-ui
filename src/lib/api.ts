import type {
  AgentKind,
  ConversationResponse,
  HealthAuth,
  InteractivePrompt,
  PaneReadResult,
  PromptAnswer,
  PushKey,
  SessionSnapshot,
  SlashCommand,
  WorkspaceCreated,
} from "../../shared/protocol.ts";

/**
 * A non-2xx answer from the herdr-web-ui API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(url: string, status: number, detail: string, code: string | null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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

export async function fetchSession(): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>("/api/session");
  return body.snapshot;
}

/**
 * GET /api/pane/read as the chat view polls it: herdr's own scrollback (up to
 * `lines`), ANSI-stripped text. herdr owns scrollback — the attach stream cannot
 * serve history, so the transcript reads it back instead.
 */
export async function fetchPaneTranscript(paneId: string, lines: number): Promise<PaneReadResult> {
  const query = new URLSearchParams({
    pane_id: paneId,
    source: "recent",
    format: "text",
    lines: String(lines),
  });
  const body = await getJson<{ read: PaneReadResult }>(`/api/pane/read?${query.toString()}`);
  return body.read;
}

/** GET /api/pane/conversation: structured turns, or scrollback fallback. */
export async function fetchPaneConversation(paneId: string): Promise<ConversationResponse> {
  const query = new URLSearchParams({ pane_id: paneId });
  return await getJson<ConversationResponse>(`/api/pane/conversation?${query.toString()}`);
}

export interface HealthInfo {
  ok: boolean;
  herdr: { version: string; protocol: number };
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** DELETE /api/auth: clears the session cookie, so the next health check reports the gate again. */
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

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). ApiError 413 image_too_large / 415 unsupported_media_type on bad input.
 */
export async function uploadPaneImage(paneId: string, image: Blob): Promise<string> {
  const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
  const response = await fetch("/api/pane/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64 }),
  });
  if (!response.ok) throw await errorFrom("/api/pane/image", response);
  return ((await response.json()) as { path: string }).path;
}

async function sendJson(url: string, method: "POST" | "DELETE", body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string): Promise<void> {
  await sendJson("/api/pane/close", "POST", { pane_id: paneId });
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string): Promise<void> {
  await sendJson("/api/pane/rename", "POST", { pane_id: paneId, label });
}

/** GET /api/agents: the agent kinds herdr can start, for the new-session dialog. */
export async function fetchAgentKinds(): Promise<AgentKind[]> {
  return (await getJson<{ agents: AgentKind[] }>("/api/agents")).agents;
}

export interface CreateWorkspaceRequest {
  cwd?: string | null;
  label?: string | null;
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceCreated> {
  const response = await sendJson("/api/workspace/create", "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

export async function renameWorkspace(workspaceId: string, label: string): Promise<void> {
  await sendJson("/api/workspace/rename", "POST", { workspace_id: workspaceId, label });
}

/** POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order). */
export async function moveWorkspace(workspaceId: string, insertIndex: number): Promise<void> {
  await sendJson("/api/workspace/move", "POST", { workspace_id: workspaceId, insert_index: insertIndex });
}

export async function closeWorkspace(workspaceId: string): Promise<void> {
  await sendJson("/api/workspace/close", "POST", { workspace_id: workspaceId });
}

/** GET /api/pane/commands: the slash commands the pane's agent understands (built-in + custom). */
export async function fetchPaneCommands(paneId: string): Promise<SlashCommand[]> {
  return (await getJson<{ commands: SlashCommand[] }>(`/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`)).commands;
}

/** GET /api/pane/files: paths under the pane's cwd matching `query`, for @-mentions. */
export async function fetchPaneFiles(paneId: string, query: string, limit = 20): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(`/api/pane/files?${params.toString()}`)).files;
}

/** GET /api/pane/prompt: the agent's interactive menu currently on screen, or null. */
export async function fetchPanePrompt(paneId: string): Promise<InteractivePrompt | null> {
  return (await getJson<{ prompt: InteractivePrompt | null }>(`/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`)).prompt;
}

/** POST /api/pane/prompt/answer: ApiError 409 `prompt_changed` when the menu moved on. */
export async function answerPanePrompt(answer: PromptAnswer): Promise<void> {
  await sendJson("/api/pane/prompt/answer", "POST", answer);
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

export async function registerPushSubscription(subscription: PushSubscriptionJSON): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", { subscription });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}
