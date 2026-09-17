import type { HealthAuth, SessionSnapshot } from "../../shared/protocol.ts";

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
