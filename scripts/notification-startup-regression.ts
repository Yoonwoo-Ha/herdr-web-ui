import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";

type ProbeWindow = Window & { ready: boolean; messages: Array<{ type?: string; pane?: string; url?: string; error?: string }>; selections: unknown[] };

export async function checkNotificationStartup(browser: Browser, upstream: string, olderPane: string, newerPane: string): Promise<void> {
  let releaseJS!: () => void;
  const jsGate = new Promise<void>((resolve) => { releaseJS = resolve; });
  let requestedJS!: () => void;
  const jsRequested = new Promise<void>((resolve) => { requestedJS = resolve; });
  const context = await browser.newContext({ locale: "en-US" });
  // The shipped click handler uses a real WindowClient returned by the driver.
  // Controlling open/focus avoids OS notification and transient-activation policy.
  const worker = `
    const nativeAdd = self.addEventListener.bind(self);
    let notificationClick;
    self.addEventListener = (type, listener, ...rest) => {
      if (type === "notificationclick") notificationClick = listener;
      return nativeAdd(type, listener, ...rest);
    };
    const nativeMatch = self.clients.matchAll.bind(self.clients);
    self.clients.matchAll = async (options) => (await nativeMatch(options)).filter((client) => new URL(client.url).pathname !== "/probe-controller").map((client) => {
      client.focus = async () => client;
      return client;
    });
    let pendingOpen;
    self.clients.openWindow = async (url) => {
      const drivers = await nativeMatch({ type: "window", includeUncontrolled: true });
      const driver = drivers.find((client) => new URL(client.url).pathname === "/probe-controller");
      const opened = new Promise((resolve) => { pendingOpen = { url, resolve }; });
      driver.postMessage({ type: "probe-open-request", url });
      return opened;
    };
  ` + readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8") + `
    nativeAdd("message", (event) => {
      if (event.data?.type === "probe-open-created") {
        // the browser's own openWindow answers once the new window is a listed client; a page that
        // has committed can still be missing from matchAll for a moment, so this one looks again
        if (!pendingOpen) {
          event.source?.postMessage({ type: "probe-error", error: "the worker holds no openWindow call: it was started again" });
          return;
        }
        const wanted = new URL(pendingOpen.url, self.location).href;
        event.waitUntil((async () => {
          const deadline = Date.now() + 10000;
          let seen = [];
          while (Date.now() < deadline) {
            const clients = await nativeMatch({ type: "window", includeUncontrolled: true });
            const opened = clients.find((client) => client.url === wanted);
            if (opened) return pendingOpen.resolve(opened);
            seen = clients.map((client) => client.url);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          event.source?.postMessage({ type: "probe-error", error: "cold page is not a discoverable WindowClient; windows: " + JSON.stringify(seen) });
        })());
        return;
      }
      if (event.data?.type !== "probe-click") return;
      let completion;
      notificationClick({
        notification: { data: { pane_id: event.data.pane, machine_id: "local" }, close() {} },
        waitUntil(promise) { completion = promise; },
      });
      event.waitUntil(completion.then(
        () => event.source?.postMessage({ type: "probe-done", pane: event.data.pane }),
        (error) => event.source?.postMessage({ type: "probe-error", error: String(error) }),
      ));
    });
  `;
  const controller = `<!doctype html><html><body>
    <button id="old">old</button><button id="new">new</button><script>
      window.messages = [];
      navigator.serviceWorker.addEventListener("message", (event) => window.messages.push(event.data));
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => window.ready = true);
      document.querySelector("#old").onclick = () => navigator.serviceWorker.controller.postMessage({ type: "probe-click", pane: ${JSON.stringify(olderPane)} });
      document.querySelector("#new").onclick = () => navigator.serviceWorker.controller.postMessage({ type: "probe-click", pane: ${JSON.stringify(newerPane)} });
    </script></body></html>`;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/sw.js") return new Response(worker, { headers: { "content-type": "application/javascript", "cache-control": "no-store" } });
    if (url.pathname === "/probe-controller") return new Response(controller, { headers: { "content-type": "text/html" } });
    if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js")) { requestedJS(); await jsGate; }
    // REST lists only the caller's owned panes; never attach to or input into PTYs.
    if (url.pathname === "/ws") return new Response("startup probe does not attach terminals", { status: 503 });
    const headers = new Headers(request.headers);
    headers.delete("host");
    // the server gzips for a browser that asks; fetch would unzip the body and keep the header,
    // so this pass-through asks for the plain body it hands on (fetch adds gzip to a missing header)
    headers.set("accept-encoding", "identity");
    return fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body });
  } });
  try {
    await context.addInitScript(() => {
      const selections: unknown[] = [];
      (window as ProbeWindow).selections = selections;
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "select-pane") selections.push(event.data);
      });
    });
    const origin = `http://127.0.0.1:${proxy.port}`;
    const driver = await context.newPage();
    await driver.goto(`${origin}/probe-controller`);
    await driver.waitForFunction(() => (window as ProbeWindow).ready && !!navigator.serviceWorker.controller);
    await driver.locator("#old").click();
    await driver.waitForFunction(() => (window as ProbeWindow).messages.some((message) => message.type === "probe-open-request"));
    const request = await driver.evaluate(() => (window as ProbeWindow).messages.find((message) => message.type === "probe-open-request")!);
    const app = await context.newPage();
    const errors: string[] = [];
    app.on("pageerror", (error) => errors.push(error.message));
    await app.goto(`${origin}${request.url}`, { waitUntil: "commit" });
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([jsRequested, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("cold app JS was not requested")), 15000); })]);
    } finally { clearTimeout(timeout); }
    const answered = async (pane: string): Promise<void> => {
      await driver.waitForFunction((pane) => (window as ProbeWindow).messages.some((message) => message.type === "probe-error" || (message.type === "probe-done" && message.pane === pane)), pane);
      assert.deepEqual(await driver.evaluate(() => (window as ProbeWindow).messages.filter((message) => message.type === "probe-error")), [], `the worker answered the click for ${pane}`);
    };
    await driver.evaluate(() => navigator.serviceWorker.controller!.postMessage({ type: "probe-open-created" }));
    await answered(olderPane);
    await driver.locator("#new").click();
    await answered(newerPane);
    releaseJS();
    await app.waitForLoadState("load");
    await app.waitForFunction((pane) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id === pane, newerPane);
    const result = await app.evaluate(() => ({ selection: JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null"), selections: (window as ProbeWindow).selections }));
    assert.deepEqual(result.selection, { machine_id: "local", pane_id: newerPane });
    assert.deepEqual(result.selections.at(-1), { type: "select-pane", machine_id: "local", pane_id: newerPane, view: "chat" });
    assert.deepEqual(errors, []);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await app.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "notification-cold-start.png") });
    }
    console.log("PASS notification startup: real worker messages retain the newest pane before App subscribes");
  } finally {
    releaseJS();
    await context.close();
    proxy.stop(true);
  }
}
