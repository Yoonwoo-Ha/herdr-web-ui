import type { CLIProxyLogin, CLIProxyLoginStatus, CLIProxyProvider } from "../shared/protocol.ts";
import { CLIProxyError, CLIProxyService, proxyInvalid } from "./cliproxy.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";

type Session = { readonly provider: CLIProxyProvider; readonly expires: number };
/** Pending OAuth sessions belong to this app, not arbitrary state values on the proxy. */
export class CLIProxyRoutes {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly service: CLIProxyService) {}

  private session(state: string | null): Session {
    const pending = state ? this.sessions.get(state) : undefined;
    if (!pending || Date.now() >= pending.expires) {
      if (state) this.sessions.delete(state);
      throw new CLIProxyError("cliproxy_login_expired", 400, "Hub login expired. Start again.");
    }
    return pending;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const state = url.searchParams.get("state");
    const reply = (value: unknown) => jsonResponse(value, 200, { "cache-control": "no-store" });
    try {
      if (path === "/api/cliproxy") {
        setRequestRoute(path);
        switch (request.method) {
          case "GET": return reply(await this.service.check());
          case "PUT": {
            const result = await this.service.save(await request.json());
            this.sessions.clear();
            return reply(result);
          }
          case "DELETE": this.sessions.clear(); return reply(this.service.remove());
        }
      }
      if (path === "/api/cliproxy/login") {
        setRequestRoute(path);
        switch (request.method) {
          case "POST": {
            const body: unknown = await request.json();
            if (!isJsonObject(body) || (body["provider"] !== "claude" && body["provider"] !== "codex")) throw proxyInvalid();
            for (const [key, pending] of this.sessions) if (pending.expires <= Date.now()) this.sessions.delete(key);
            if (this.sessions.size >= 8) throw new CLIProxyError("cliproxy_login_busy", 409, "Cancel an existing Hub login first");
            const answer = await this.service.call(`/oauth/auth-url?provider=${body["provider"]}&is_webui=true`);
            if (typeof answer["url"] !== "string" || typeof answer["state"] !== "string" || !answer["state"] || answer["status"] !== "ok") throw proxyInvalid();
            const auth = new URL(answer["url"]);
            if (!["https:", "http:"].includes(auth.protocol) || auth.username || auth.password) throw proxyInvalid();
            this.sessions.set(answer["state"], { provider: body["provider"], expires: Date.now() + 5 * 60_000 });
            return reply({ url: auth.href, state: answer["state"] } satisfies CLIProxyLogin);
          }
          case "GET": {
            this.session(state);
            const answer = await this.service.call(`/oauth/status?state=${encodeURIComponent(state ?? "")}`);
            switch (answer["status"]) {
              case "wait": return reply({ status: "wait" } satisfies CLIProxyLoginStatus);
              case "ok": this.sessions.delete(state ?? ""); this.service.invalidate(); return reply({ status: "ok" } satisfies CLIProxyLoginStatus);
              case "error": this.sessions.delete(state ?? ""); throw new CLIProxyError("cliproxy_login_failed", 502, "Hub login failed. Start again.");
              default: throw proxyInvalid();
            }
          }
          case "DELETE":
            this.session(state);
            await this.service.call(`/oauth/session?state=${encodeURIComponent(state ?? "")}`, { method: "DELETE" });
            this.sessions.delete(state ?? "");
            return reply({ status: "ok" });
        }
      }
      if (path === "/api/cliproxy/callback" && request.method === "POST") {
        setRequestRoute(path);
        const body: unknown = await request.json();
        if (!isJsonObject(body) || typeof body["state"] !== "string" || typeof body["redirect_url"] !== "string" || body["redirect_url"].length > 8000) throw proxyInvalid();
        const pending = this.session(body["state"]);
        if (body["provider"] !== pending.provider) throw proxyInvalid();
        let redirect: URL;
        try { redirect = new URL(body["redirect_url"]); } catch { throw proxyInvalid(); }
        if (redirect.searchParams.get("state") !== body["state"] || !["http:", "https:"].includes(redirect.protocol)) throw proxyInvalid();
        if (!redirect.searchParams.get("code") && !redirect.searchParams.get("error")) throw proxyInvalid();
        const answer = await this.service.call("/oauth/callback", { method: "POST", body: JSON.stringify({
          provider: pending.provider, state: body["state"], redirect_url: redirect.href,
        }) });
        if (answer["status"] !== "ok") throw new CLIProxyError("cliproxy_login_failed", 502, "Hub login failed. Start again.");
        return reply({ status: "ok" });
      }
      return jsonResponse({ error: { code: "method_not_allowed", message: "Unknown Hub operation" } }, 405);
    } catch (error) {
      const safe = error instanceof CLIProxyError ? error : proxyInvalid();
      return jsonResponse({ error: { code: safe.code, message: safe.message } }, safe.status, { "cache-control": "no-store" });
    }
  }
}
