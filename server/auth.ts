/**
 * Optional shared-token gate for herdr-web-ui.
 *
 * There is no user database here: the token is the whole authorization decision,
 * and whoever holds it can type into live terminals. Hence constant-time compares
 * (a length-leaking `===` is enough to guess a token over a LAN), an HttpOnly +
 * SameSite=Strict cookie so page JavaScript can never read it back, and a `Secure`
 * flag whenever the request arrived over TLS or through a TLS-terminating proxy.
 *
 * An empty token disables the gate entirely - that is the loopback default, and
 * index.ts is the one that warns when it is combined with a public bind address.
 */

import { timingSafeEqual } from "node:crypto";

import { badRequest, jsonResponse } from "./http.ts";

const COOKIE_NAME = "herdr_web_token";
const COOKIE_MAX_AGE_SECONDS = 31536000;
const BEARER_PREFIX = "bearer ";
const encoder = new TextEncoder();

/** Malformed pairs are skipped: a junk cookie from another app must not deny the user. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1).trim()));
    } catch (error) {
      if (error instanceof URIError) continue;
      throw error;
    }
  }
  return cookies;
}

function matches(candidate: string, token: string): boolean {
  const left = encoder.encode(candidate);
  const right = encoder.encode(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAuthenticated(request: Request, token: string): boolean {
  if (token === "") return true;
  const cookie = parseCookies(request.headers.get("cookie")).get(COOKIE_NAME);
  if (cookie !== undefined && matches(cookie, token)) return true;
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  return matches(authorization.slice(BEARER_PREFIX.length), token);
}

/** /api/health and /api/auth stay open so a client can discover the gate and pass it. */
export function requiresAuth(pathname: string): boolean {
  if (pathname === "/ws") return true;
  if (!pathname.startsWith("/api/")) return false;
  return pathname !== "/api/health" && pathname !== "/api/auth";
}

export function unauthorizedJson(): Response {
  return jsonResponse({ error: { code: "unauthorized", message: "token required" } }, 401);
}

function isSecureRequest(request: Request): boolean {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function sessionCookie(token: string, secure: boolean): string {
  const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes}${secure ? "; Secure" : ""}`;
}

function noContent(setCookie?: string): Response {
  return new Response(null, { status: 204, ...(setCookie ? { headers: { "set-cookie": setCookie } } : {}) });
}

export async function handleAuthRequest(request: Request, token: string): Promise<Response> {
  if (request.method === "DELETE") {
    return noContent(`${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST or DELETE");
  // Gate off: answering 204 without a cookie lets one client flow work either way.
  if (token === "") return noContent();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (typeof payload !== "object" || payload === null || !("token" in payload)) {
    return badRequest("missing_token", "token is required");
  }
  const offered = payload.token;
  if (typeof offered !== "string") return badRequest("missing_token", "token is required");
  if (!matches(offered, token)) {
    return jsonResponse({ error: { code: "invalid_token", message: "token does not match" } }, 401);
  }
  return noContent(sessionCookie(token, isSecureRequest(request)));
}
