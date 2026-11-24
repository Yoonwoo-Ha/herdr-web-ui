import { describe, expect, it } from "bun:test";

import { compareVersions, parseVersion } from "../../src/lib/relay/skew.ts";
import { MIN_SUPPORTED_CLIENT_VERSION } from "./client-floor.ts";
import live from "./store-app-versions.json";

interface StoreBuild { readonly version: string; readonly build: number; readonly live_since: string; readonly client: string | null }
type StoreBuilds = Readonly<Record<"android" | "ios", readonly StoreBuild[]>>;

/** Every client that reaches a PC through the relay is from this release or newer: a floor at or below it turns no one away. */
const FIRST_RELAY_CLIENT = "0.4.21";
const SETTLED_DAYS = 14;
const DAY_MS = 86_400_000;

function version(text: string): readonly [number, number, number] {
  const parsed = parseVersion(text);
  if (parsed === null) throw new Error(`not a version: ${text}`);
  return parsed;
}

/**
 * Why `floor` may not be the oldest client a PC supports yet, or null when it may (docs/development.md, "The phone
 * app's client"): on each store, a build that carries the client of `floor` or a newer one has been live at least
 * 14 days. A build that loads the hosted shell carries none (`client` null), so it lets no floor above the first relay release.
 */
function floorProblem(floor: string, stores: StoreBuilds, now: number): string | null {
  if (compareVersions(version(floor), version(FIRST_RELAY_CLIENT)) <= 0) return null;
  for (const [store, builds] of Object.entries(stores)) {
    const settled = builds.some((build) => build.client !== null && compareVersions(version(build.client), version(floor)) >= 0
      && now - Date.parse(`${build.live_since}T00:00:00Z`) >= SETTLED_DAYS * DAY_MS);
    if (!settled) return `no ${store} build carrying client ${floor} or newer has been live for ${SETTLED_DAYS} days`;
  }
  return null;
}

describe("the oldest client a PC supports", () => {
  it("is never above the client of an app build live on both stores for 14 days", () => {
    expect(floorProblem(MIN_SUPPORTED_CLIENT_VERSION, live, Date.now())).toBeNull();
  });

  it("lists the builds live on each store, oldest first, with the day each went live and the client it carries", () => {
    for (const builds of Object.values(live as StoreBuilds)) {
      expect(builds.length).toBeGreaterThan(0);
      for (const build of builds) {
        expect(parseVersion(build.version)).not.toBeNull();
        expect(Number.isSafeInteger(build.build) && build.build > 0).toBe(true);
        expect(build.live_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Date.parse(`${build.live_since}T00:00:00Z`)).toBeLessThanOrEqual(Date.now());
        if (build.client !== null) expect(parseVersion(build.client)).not.toBeNull();
      }
      expect(builds.map((build) => build.build)).toEqual([...builds.map((build) => build.build)].sort((a, b) => a - b));
    }
  });

  describe("the guard", () => {
    const now = Date.parse("2026-12-31T12:00:00Z");
    const hosted: StoreBuilds = { android: [{ version: "1.0.5", build: 13, live_since: "2026-11-21", client: null }], ios: [{ version: "1.0.2", build: 11, live_since: "2026-11-20", client: null }] };
    const carrying = (android: string, ios: string, client = "0.6.0"): StoreBuilds => ({
      android: [...hosted.android, { version: "1.1.0", build: 15, live_since: android, client }],
      ios: [...hosted.ios, { version: "1.1.0", build: 12, live_since: ios, client }],
    });

    it("lets a floor at or below the first relay release stand while every store build loads the hosted shell", () => {
      expect(floorProblem("0.4.20", hosted, now)).toBeNull();
      expect(floorProblem(FIRST_RELAY_CLIENT, hosted, now)).toBeNull();
      expect(floorProblem("0.4.22", hosted, now)).toMatch(/android/);
    });

    it("lets it rise to a client both stores have carried for 14 days, and no further", () => {
      expect(floorProblem("0.6.0", carrying("2026-12-10", "2026-12-17"), now)).toBeNull();
      expect(floorProblem("0.5.9", carrying("2026-12-10", "2026-12-17"), now)).toBeNull();
      expect(floorProblem("0.6.1", carrying("2026-12-10", "2026-12-17"), now)).toMatch(/android/);
    });

    it("waits for the later store", () => {
      expect(floorProblem("0.6.0", carrying("2026-12-10", "2026-12-18"), now)).toMatch(/ios/);
      expect(floorProblem("0.6.0", carrying("2026-12-18", "2026-12-10"), now)).toMatch(/android/);
    });
  });
});
