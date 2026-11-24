/**
 * What a build of the phone apps takes from its environment, for the app's pages and the native code alike.
 * The hosted shell's origin: OVIS_APP_URL, for a test build whose relay pairing links point at a shell served
 * elsewhere, else each part keeps its own https://app.ovis.sh. The first screen: OVIS_APP_HOME (appHome). Where the
 * apps take the shell from: OVIS_APP_SHELL (bundled-shell.ts appShell).
 * build-web.ts gives the origin to the app's pages (APP_ORIGIN in web/shell.js) and, through the files below, both to
 * the native code: BuildConfig.APP_ORIGIN, HOME_HOSTED and SHELL_BUNDLED on Android (android/app/build.gradle reads
 * hosted-origin.properties), OvisAppOrigin, OvisAppHome and OvisAppShell in the iOS app's Info.plist (ios/hosted-origin.xcconfig
 * includes hosted-origin.generated.xcconfig), so a build cannot give them two origins.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `value` when it is an https origin with no path whose host is a DNS name or an IPv4 address, null when it is unset or
 * empty; anything else throws. URL takes a host such as `stage"blue` or `stage$(channel)`, which would end the Java
 * string gradle writes or be expanded by the xcconfig, so the native code would trust another origin than the pages.
 */
export function appOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL | null = null;
  try { parsed = new URL(value); } catch {}
  if (parsed?.protocol !== "https:" || parsed.origin !== value) throw new Error(`OVIS_APP_URL must be an https origin with no path, such as https://app.ovis.sh: ${value}`);
  if (!/^[a-z0-9.-]+$/.test(parsed.hostname)) throw new Error(`OVIS_APP_URL's host must be a DNS name or an IPv4 address (letters, digits, dots and hyphens): ${value}`);
  return value;
}

/**
 * The app's first screen: OVIS_APP_HOME, `hosted` (the hosted shell's Connect a PC screen, the app's own page standing
 * in for it when it does not load) or `bundled` (the app's own page, as before the hosted one). Unset, it is hosted,
 * except in a build without the account (`account` false, OVIS_APP_ACCOUNT=0), which has no hosted screen to open first.
 */
export function appHome(value: string | undefined, account: boolean): "hosted" | "bundled" {
  if (!value) return account ? "hosted" : "bundled";
  if (value !== "hosted" && value !== "bundled") throw new Error(`OVIS_APP_HOME must be hosted or bundled: ${value}`);
  return value;
}

/**
 * Writes `origin`, the first screen (`home`) and where the shell comes from (`shell`) where the native builds of `app`
 * read them: only what differs from their own defaults (null, hosted and bundled), and no file when nothing does.
 */
export function writeNativeOrigin(app: string, origin: string | null, home: "hosted" | "bundled" = "hosted", shell: "bundled" | "hosted" = "bundled"): void {
  const android = join(app, "android/app/hosted-origin.properties");
  const ios = join(app, "ios/hosted-origin.generated.xcconfig");
  const bundled = home === "bundled";
  const androidLines = `${origin === null ? "" : `appOrigin=${origin}\n`}${bundled ? "appHome=bundled\n" : ""}${shell === "hosted" ? "appShell=hosted\n" : ""}`;
  if (androidLines === "") rmSync(android, { force: true });
  else writeFileSync(android, androidLines);
  // "//" starts a comment in an xcconfig file; "$()" expands to nothing
  const iosLines = `${origin === null ? "" : `OVIS_APP_ORIGIN = ${origin.replace("//", "/$()/")}\n`}${bundled ? "OVIS_APP_HOME = bundled\n" : ""}${shell === "hosted" ? "OVIS_APP_SHELL = hosted\n" : ""}`;
  if (iosLines === "") rmSync(ios, { force: true });
  else writeFileSync(ios, iosLines);
}
