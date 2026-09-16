import type { SessionSnapshot } from "../../shared/protocol.ts";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${url} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as T;
}

export async function fetchSession(): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>("/api/session");
  return body.snapshot;
}

export interface HealthInfo {
  ok: boolean;
  herdr: { version: string; protocol: number };
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}
