/**
 * The phone app's own copy of the client (docs/native-app.md, "The app carries its client"). The app sets
 * `window.__ovisAppShell = { bundled: true, platform, appVersion, build }` at document start, before any page
 * script, on every page it serves from its own files. A browser, an installed web app, and an app build that
 * loads the hosted or a preview shell set nothing, and nothing here changes for them. This is the one place
 * that reads it: such a copy registers no service worker, never reloads for a newer copy, and is held to the
 * oldest client a PC supports (lib/relay/skew.ts).
 */
export type AppPlatform = "android" | "ios";

export interface AppShell {
  readonly platform: AppPlatform | null;
  /** the store version: Android's versionName, iOS's MARKETING_VERSION */
  readonly appVersion: string | null;
  /** the store build: Android's versionCode, iOS's CURRENT_PROJECT_VERSION */
  readonly build: number | null;
}

export const STORE_PAGES: Readonly<Record<AppPlatform, string>> = {
  ios: "https://apps.apple.com/app/id6824664162",
  android: "https://play.google.com/store/apps/details?id=sh.ovis.app",
};

/** `bundled: true` alone makes it the app's copy; a field it cannot read is null rather than making it a hosted page. */
export function appShellOf(value: unknown): AppShell | null {
  if (typeof value !== "object" || value === null) return null;
  const { bundled, platform, appVersion, build } = value as Record<string, unknown>;
  if (bundled !== true) return null;
  return {
    platform: platform === "android" || platform === "ios" ? platform : null,
    appVersion: typeof appVersion === "string" && appVersion.length > 0 && appVersion.length <= 64 ? appVersion : null,
    build: typeof build === "number" && Number.isSafeInteger(build) && build >= 0 ? build : null,
  };
}

export function appShell(): AppShell | null {
  return appShellOf((globalThis as { __ovisAppShell?: unknown }).__ovisAppShell);
}
