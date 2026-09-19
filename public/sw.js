// Service worker for herdr web ui. Policy: navigations are network-first (so a
// fresh build always wins when online) falling back to the cached shell when
// offline; static assets (hashed bundles, icons, manifest, favicons) are
// cache-first since they are content-addressed or rarely change. API and
// websocket traffic is never intercepted so live workspace data is always fresh.
const CACHE_NAME = "herdr-web-ui-v1";

const CACHE_FIRST_PATHS = new Set([
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
]);

function isCacheFirst(pathname) {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) return true;
  return CACHE_FIRST_PATHS.has(pathname);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put("/", response.clone());
          }
          return response;
        } catch (err) {
          const cached = await caches.match("/");
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (isCacheFirst(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

// Web push (server/push.ts sends, shared/protocol.ts PushPayload is the JSON). Every
// push shows a notification: Safari revokes a subscription whose pushes stay silent.
// A window of the app that is visible right now already shows the change in its
// sidebar, so the notification then arrives without sound or vibration.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((client) => client.visibilityState === "visible");
      await self.registration.showNotification(payload.title || "herdr", {
        body: payload.body || "",
        tag: payload.tag || "herdr",
        renotify: !watching,
        silent: watching,
        data: { pane_id: payload.pane_id || null },
        icon: "/icons/icon-192.png",
      });
    })(),
  );
});

// Tap: bring the app forward on that pane - an open window is told which pane
// (App listens), a closed app opens on /?pane=<id>.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const paneId = event.notification.data ? event.notification.data.pane_id : null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = windows.find((client) => client.focused) || windows[0];
      if (target) {
        await target.focus();
        if (paneId) target.postMessage({ type: "select-pane", pane_id: paneId });
        return;
      }
      await self.clients.openWindow(paneId ? `/?pane=${encodeURIComponent(paneId)}` : "/");
    })(),
  );
});

// The browser rotated the subscription (Firefox does; Chrome rarely): hand the server
// the new endpoint and drop the old one, or pushes stop until the app is next opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  const post = (method, body) =>
    fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let fresh = event.newSubscription;
      if (!fresh) {
        const key = previous && previous.options.applicationServerKey
          ? previous.options.applicationServerKey
          : (await (await fetch("/api/push")).json()).public_key;
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await post("POST", { subscription: fresh.toJSON() });
      if (previous) await post("DELETE", { endpoint: previous.endpoint });
    })(),
  );
});
