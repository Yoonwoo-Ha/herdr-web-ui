import { startBunRelay } from "../../relay/bun.ts";
import { FakeAccountService, type SignInProvider } from "../../shared/account-service-fake.ts";

const bind = process.env["JOIN_BIND"];
if (!bind) throw new Error("JOIN_BIND (this container's address) is required");

const service = new FakeAccountService();
service.offerLinkPage(["github", "google"]);
const relay = startBunRelay({ port: 8787, hostname: bind, limits: { perAddressPerMinute: 100_000, globalPerMinute: 100_000, maxSocketsPerAddress: 4096, maxAddresses: 4096 } });

const account = Bun.serve({
  hostname: bind, port: 9080, idleTimeout: 60,
  fetch(incoming) {
    const url = new URL(incoming.url);
    return service.fetch(new Request(new URL(`${url.pathname}${url.search}`, "https://account.join.test:9443"), incoming));
  },
});

const kit = Bun.serve({
  hostname: bind, port: 9180,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`/srv${path}`);
    return /^\/kit[a-z-]*\//.test(path) && !path.includes("..") && await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  },
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const control = Bun.serve({
  hostname: bind, port: 9090,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
    const who = String(body["account"] ?? url.searchParams.get("account") ?? "");
    switch (url.pathname) {
      case "/approveLink": service.approveOnLinkPage(String(body["userCode"]), who, (body["provider"] ?? "github") as SignInProvider); return json({ ok: true });
      case "/pcs": return json(service.pcs(who));
      default: return json({ error: "unknown control route" }, 404);
    }
  },
});

console.log(JSON.stringify({ event: "ready", relay: relay.port, account: account.port, kit: kit.port, control: control.port }));
const stop = () => { void Promise.all([relay.stop(), account.stop(true), kit.stop(true), control.stop(true)]).then(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
