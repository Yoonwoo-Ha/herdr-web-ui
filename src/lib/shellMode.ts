import { SERVER_ID_PATTERN } from "../../shared/relay-id.ts";

export type ShellMode = "relay" | null;

export function shellModeOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): ShellMode {
  return document.querySelector('meta[name="ovis-shell"]')?.getAttribute("content") === "relay" ? "relay" : null;
}

export function shellMode(): ShellMode {
  return typeof document === "undefined" ? null : shellModeOf(document);
}

export function serverScopePath(serverId: string): string {
  return `/s/${serverId}/`;
}

export function serverIdOfPath(pathname: string): string | null {
  const id = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return id !== undefined && SERVER_ID_PATTERN.test(id) ? id : null;
}

/**
 * The service worker a page of the hosted shell registers: a PC's scope registers the worker
 * under its own path (`/s/<id>/sw.js`, which the host answers with /sw.js), so each PC's app has
 * a worker, a cache and a push subscription of its own; the front page registers none.
 */
export function shellServiceWorker(pathname: string): { script: string; scope: string } | null {
  const serverId = serverIdOfPath(pathname);
  if (serverId === null) return null;
  const scope = serverScopePath(serverId);
  return { script: `${scope}sw.js`, scope };
}

/** public/sw.js's FILES, the one cache its keepShell never retires (any other is deleted), and the one the page fills itself (lib/userFonts.ts) */
export const FILES_CACHE = "ovis-files-v1";

/**
 * The hosted shell's worker opens a PC's page from the shell it kept (public/sw.js), so a reload
 * meant to bring in a newer shell asks that PC's worker to go to the host first; the kept copy
 * stays its fallback. Keyed by the PC: another PC's worker on the origin does not take the request.
 */
export async function requestFreshShell(storage: Pick<CacheStorage, "open">, serverId: string): Promise<void> {
  await (await storage.open(FILES_CACHE)).put(`/__ovis-fresh-shell/${serverId}`, new Response("1"));
}

/**
 * The app's own copy of the client (lib/appShell.ts) runs under no service worker. An app updated from a build that
 * loaded the hosted shell still has that shell's workers, one per PC's scope, and one of them would open a PC's page
 * from the hosted copy it kept: each goes, with the caches they kept, the first time this copy finds them, and a page
 * one of them served loads once more, from the app, as does a page whose worker another page retired first. A page that
 * is itself a reload (`reloaded`) never reloads, so whatever a browser does, no reload follows another. A worker that goes may
 * still finish a write it began, so every start deletes a worker's cache it finds; only the files cache, which the page
 * fills itself, is kept once the workers are gone. IndexedDB and web storage, which hold the pairings, are never touched.
 */
export async function retireServiceWorkers(
  workers: Pick<ServiceWorkerContainer, "getRegistrations" | "controller">,
  storage: Pick<CacheStorage, "keys" | "delete"> | null,
  reload: () => void,
  reloaded: boolean,
): Promise<void> {
  const registrations = await workers.getRegistrations();
  const gone = await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
  if (storage !== null) {
    for (const name of await storage.keys()) if (registrations.length > 0 || name !== FILES_CACHE) await storage.delete(name);
  }
  if (workers.controller !== null && !reloaded && (gone.some(Boolean) || registrations.length === 0)) reload();
}
