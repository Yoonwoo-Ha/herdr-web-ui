/**
 * /api/memory: Settings → Memory's reads and a person's changes to this PC's memory store.
 *
 *   GET  /api/memory?folder=<absolute path>  MemoryView; the folder names the project the screen is in
 *   POST /api/memory/add          MemoryDraft             → MemoryItem, confirmed
 *   POST /api/memory/edit         MemoryEdit              → MemoryItem, confirmed
 *   POST /api/memory/confirm      { id, digest, notSecret? } → MemoryItem, confirmed
 *   POST /api/memory/remove       { id }                  → { ok: true }, a confirmed note to the trash
 *   POST /api/memory/discard      { id }                  → { ok: true }, an unconfirmed one to the trash
 *   POST /api/memory/discard-run  { run }                 → { discarded: n }
 *
 * Every change here comes from a client that drives this PC (D26-a): dispatch.ts lets in a signed-in
 * browser, the app, or a paired device that drives, never the connection server's bridge token and
 * never a watching device; nothing else writes a confirmed note. A program of the same user that
 * holds this PC's access token or a paired device's key can do what that screen can: telling a
 * person's press from it needs the confirming device's signature, a later step. Confirm and edit
 * name the digest of the note as it was listed, so a note that changed since is refused. A watching device reads the notes but not the
 * folder's project, which would run git in a path it names.
 */
import { isAbsolute } from "node:path";

import { MEMORY_KINDS, MEMORY_SCOPES, type MemoryDraft, type MemoryEdit, type MemoryKind, type MemoryScope } from "../../shared/memory.ts";
import { MEMORY_POSTS } from "../dispatch-routes.ts";
import { errorResponse, isJsonObject, jsonResponse, setRequestRoute } from "../http.ts";
import { isEntryId } from "./entry.ts";
import { MemoryError, type MemoryStore } from "./store.ts";

const NO_STORE = { "cache-control": "no-store" };

const invalid = (message: string) => new MemoryError("invalid_memory", 400, message);

function parseDraft(body: Record<string, unknown>): MemoryDraft {
  const { scope, project, kind, title, body: text, expires, notSecret } = body;
  if (!(MEMORY_SCOPES as readonly unknown[]).includes(scope)) throw invalid("Name the note's scope: account, project or machine");
  if (!(MEMORY_KINDS as readonly unknown[]).includes(kind)) throw invalid("Name the note's kind");
  if (typeof title !== "string" || typeof text !== "string") throw invalid("Send the note's title and body as text");
  if (project !== null && typeof project !== "string") throw invalid("The project is a project key or null");
  if (expires !== null && typeof expires !== "string") throw invalid("The expiry is a date or null");
  if (notSecret !== undefined && typeof notSecret !== "boolean") throw invalid("notSecret is true or false");
  return { scope: scope as MemoryScope, project, kind: kind as MemoryKind, title: title.trim(), body: text.replace(/\r\n/g, "\n").trimEnd(), expires, ...(notSecret === undefined ? {} : { notSecret }) };
}

function idOf(body: Record<string, unknown>): string {
  if (!isEntryId(body["id"])) throw invalid("Name the note by its id");
  return body["id"];
}

function digestOf(body: Record<string, unknown>): string {
  const digest = body["digest"];
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) throw invalid("Name the digest of the note that was shown");
  return digest;
}

function revOf(body: Record<string, unknown>): number {
  const rev = body["rev"];
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) throw invalid("Name the revision that was shown");
  return rev;
}

function answer(error: unknown): Response {
  if (error instanceof MemoryError) return jsonResponse({ error: { code: error.code, message: error.message, ...(error.rule === undefined ? {} : { rule: error.rule }) } }, error.status, NO_STORE);
  return errorResponse(error);
}

/** `by`: who confirms, as verified_by records it (a paired device's id, else how the browser signed in) */
export async function handleMemoryRequest(request: Request, url: URL, store: MemoryStore, caller: { readOnly: boolean; by: string }): Promise<Response> {
  const { pathname } = url;
  if (pathname === "/api/memory") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/memory" } }, 405, { allow: "GET" });
    const folder = url.searchParams.get("folder");
    try { return jsonResponse(await store.view(!caller.readOnly && folder !== null && isAbsolute(folder) ? folder : null), 200, NO_STORE); }
    catch (error) { return answer(error); }
  }
  const action = pathname.slice("/api/memory/".length);
  if (!MEMORY_POSTS.includes(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  setRequestRoute(pathname);
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: `Use POST ${pathname}` } }, 405, { allow: "POST" });
  let body: unknown;
  try { body = await request.json(); } catch { return answer(invalid("Send a JSON object")); }
  if (!isJsonObject(body)) return answer(invalid("Send a JSON object"));
  try {
    switch (action) {
      case "add": return jsonResponse(store.add(parseDraft(body), caller.by), 200, NO_STORE);
      case "edit": {
        const edit: MemoryEdit = { ...parseDraft(body), id: idOf(body), rev: revOf(body), digest: digestOf(body) };
        return jsonResponse(store.edit(edit, caller.by), 200, NO_STORE);
      }
      case "confirm": return jsonResponse(store.confirm(idOf(body), digestOf(body), caller.by, body["notSecret"] === true), 200, NO_STORE);
      case "remove": store.remove(idOf(body)); return jsonResponse({ ok: true }, 200, NO_STORE);
      case "discard": store.discard(idOf(body)); return jsonResponse({ ok: true }, 200, NO_STORE);
      default: {
        const run = body["run"];
        if (typeof run !== "string" || run === "") throw invalid("Name the run");
        return jsonResponse({ discarded: store.discardRun(run) }, 200, NO_STORE);
      }
    }
  } catch (error) {
    return answer(error);
  }
}
