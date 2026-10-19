import { ApiError, fetchProjectFavicon } from "./api.ts";

/** One cache entry per PC and folder: the same folder on two PCs is two projects. */
export function faviconKey(machineId: string, root: string): string {
  return `${machineId}\u0000${root}`;
}

const probes = new Map<string, Promise<string | null>>();

/**
 * The path of the icon the project in `root` keeps on that PC, or null. The PC looks through every
 * place an icon is kept and answers once (GET /api/fs/favicon), so a folder costs one request, and
 * one without an icon is an answer rather than an error. A folder is probed once: later asks (a
 * remount, another row) get the first answer back. A check that failed (the PC was not reachable,
 * a proxy's rate limit) is not an answer: it is forgotten, so the next ask probes again.
 */
export function probeFavicon(machineId: string, root: string): Promise<string | null> {
  const key = faviconKey(machineId, root);
  const known = probes.get(key);
  if (known) return known;
  const probe = fetchProjectFavicon(root, machineId).then((icon) => icon?.path ?? null, (error: unknown) => {
    // the PC answered that it will not tell (a watching device, a bridge from before the route): a
    // miss to remember. Offline, a bridge error or a 429 from a proxy in front is no answer
    if (error instanceof ApiError && error.status < 500 && error.status !== 429) return null;
    if (probes.get(key) === probe) probes.delete(key);
    return null;
  });
  probes.set(key, probe);
  return probe;
}

export function forgetFaviconProbes(): void {
  probes.clear();
}
