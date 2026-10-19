import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenCodeServiceConfig {
  baseUrl: string;
  port: number;
  pid: number;
  password: string;
}

export interface OpenCodeFormFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface OpenCodeFormField {
  key: string;
  type: "string" | "multiselect" | string;
  title?: string;
  description?: string;
  required?: boolean;
  options?: OpenCodeFormFieldOption[];
  custom?: boolean;
}

export interface OpenCodeFormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: OpenCodeFormField[];
}

export function opencodeStateDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "opencode");
}

export function readOpenCodeService(stateDir?: string, env: Record<string, string | undefined> = process.env, home = homedir()): OpenCodeServiceConfig | null {
  const dir = stateDir ?? opencodeStateDir(env, home);
  const path = join(dir, "service.json");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const maxBytes = 65_536;
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= maxBytes; size += read) read = readSync(fd, buffer, size, buffer.length - size, null);
    if (size > maxBytes) return null;
    const raw = buffer.toString("utf8", 0, size);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { port, pid, password, url } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof password !== "string" || !password) return null;
    try { process.kill(pid, 0); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") return null;
    }

    let baseUrl = "";
    let resolvedPort = 0;

    if (url !== undefined) {
      if (typeof url !== "string") return null;
      const u = new URL(url);
      if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password) return null;
      baseUrl = u.origin;
      resolvedPort = u.port ? Number(u.port) : 80;
    } else if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
      resolvedPort = port;
      baseUrl = `http://127.0.0.1:${port}`;
    }

    if (!baseUrl || resolvedPort <= 0) return null;
    return { baseUrl, port: resolvedPort, pid, password };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function opencodeAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

export const OPENCODE_HTTP_TIMEOUT_MS = 1_500;

/** node:http does not use Bun fetch's proxy environment, including on Bun 1.4.2. */
function openCodeRequest(config: OpenCodeServiceConfig, path: string, signal?: AbortSignal, body?: string): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = request(new URL(path, config.baseUrl), {
      agent: false,
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: opencodeAuthHeader(config.password),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.any([AbortSignal.timeout(OPENCODE_HTTP_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.once("error", () => resolve(null));
      response.once("aborted", () => resolve(null));
      // Replies need only their acknowledgement; errors and redirects have no usable form body.
      // Destroy rather than drain a body we will not use, so it cannot hold the request open.
      if (body !== undefined || status < 200 || status >= 300) {
        resolve({ status, body: "" });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          resolve(null);
          response.destroy();
          req.destroy();
        } else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", () => resolve(null));
    req.end(body);
  });
}

export async function listPendingQuestionForms(
  config: OpenCodeServiceConfig,
  sessionID: string,
  signal?: AbortSignal,
): Promise<OpenCodeFormInfo[] | null> {
  try {
    const response = await openCodeRequest(config, `/api/session/${encodeURIComponent(sessionID)}/form`, signal);
    if (!response || response.status < 200 || response.status >= 300) return null;
    const body = JSON.parse(response.body) as unknown;
    const items = Array.isArray(body)
      ? body
      : (typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : []);

    return items.filter((item): item is OpenCodeFormInfo => {
      if (typeof item !== "object" || item === null) return false;
      const { id, sessionID: formSession, title, metadata, fields } = item as Record<string, unknown>;
      if (typeof id !== "string" || formSession !== sessionID || typeof title !== "string" || !Array.isArray(fields) || fields.length > 64 || JSON.stringify(item).length > 65_536) return false;
      const keys = new Set<string>();
      for (const field of fields) {
        if (typeof field !== "object" || field === null || typeof field.key !== "string" || !field.key || keys.has(field.key)
          || !["string", "select", "multiselect"].includes(field.type)
          || (field.title !== undefined && typeof field.title !== "string")
          || (field.description !== undefined && typeof field.description !== "string")
          || (field.custom !== undefined && typeof field.custom !== "boolean")) return false;
        keys.add(field.key);
        if (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option: unknown) =>
          typeof option !== "object" || option === null || !("value" in option) || typeof option.value !== "string"
          || !("label" in option) || typeof option.label !== "string"
          || ("description" in option && typeof option.description !== "string")))) return false;
      }
      const meta = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : undefined;
      return meta?.kind === "question";
    });
  } catch {
    return null;
  }
}

export async function replyOpenCodeForm(
  config: OpenCodeServiceConfig,
  sessionID: string,
  formID: string,
  answers: Record<string, string | string[]>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await openCodeRequest(config, `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, signal, JSON.stringify({ answer: answers }));
    const status = response?.status ?? 0;
    return { ok: status === 200 || status === 204, status };
  } catch {
    return { ok: false, status: 0 };
  }
}
