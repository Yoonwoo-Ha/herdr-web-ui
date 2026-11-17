import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppUpdater } from "electron-updater";
import { readUpdateChannel, type UpdateChannel } from "../../../shared/update.ts";

type Env = Record<string, string | undefined>;

export const BETA_FEED = "https://github.com/devswha/ovis/releases/download/desktop-beta";
const CHANNEL_FILE = "update-channel";

export type Installer = "default" | "appimage" | "deb";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; channel: UpdateChannel; installer: Installer };

/**
 * `file` is electron-updater's installerPath, escaped for one shell except for `'`. Behind the
 * prompt (`prompted`) it runs the command as `bash -c '<command>'`, where a `'` would end the
 * quotes: it goes in as `\'\''`. Run as root, one shell reads the command, and `\'` is enough.
 */
export function debInstallCommand(file: string, prompted: boolean): string[] {
  return ["apt-get", "install", "-y", "--no-remove", file.replace(/'/g, prompted ? "\\'\\''" : "\\'")];
}

export function updateChannel(env: Env, stateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(stateDir, CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; channel?: UpdateChannel; linuxPackage?: string | null; execPath?: string; writable?: (folder: string) => boolean }): UpdatePlan {
  const { env } = options;
  const channel = options.channel ?? "stable";
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  // without app-update.yml electron-updater finds an update but fails to download it. Asked first:
  // a Linux package gets its package-type file only from a build with a feed
  if (!options.builtWithFeed) return { enabled: false, reason: "this build has no update feed" };
  let installer: Installer = "default";
  if (options.platform === "linux") {
    // chosen here, not by electron-updater: it goes by the package-type file alone, and electron-builder
    // writes that file into the folder the AppImage is also built from (whether the AppImage gets it
    // depends on which target builds first). An AppImage only when this program runs from its mount:
    // APPIMAGE alone may be left over from another AppImage that started this one, and the
    // AppImage updater would overwrite that file.
    const mount = env["APPDIR"]?.replace(/\/+$/, "");
    if (env["APPIMAGE"] && mount && options.execPath?.startsWith(`${mount}/`)) {
      const folder = dirname(env["APPIMAGE"]);
      if (options.writable && !options.writable(folder)) return { enabled: false, reason: `the AppImage is in a folder that cannot be written (${folder}), so it cannot replace itself there` };
      installer = "appimage";
    }
    else if (options.linuxPackage === "deb") installer = "deb";
    else return { enabled: false, reason: "only the AppImage and the .deb install update themselves" };
  }
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, channel, installer };
  }
  if (channel === "beta" && options.platform === "win32") return { enabled: true, feed: null, channel: "stable", installer };
  return { enabled: true, feed: channel === "beta" ? BETA_FEED : null, channel, installer };
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface HeldUpdate {
  version: string;
  file: string;
}

/**
 * A downloaded update on its way to Restart to Update. Everywhere but a Mac the downloaded file is
 * all an install needs, and the update is `ready` at once. On a Mac electron-updater's
 * "update-downloaded" only means the zip was handed to Squirrel, which still has to take it, check
 * its signature and unpack it, and says so with an event of its own: until then the update is
 * `staging`. Offered before that, Restart to Update stops the server and waits for a Squirrel that
 * may have failed for good (an app run from its disk image or translocated, a signature it
 * refuses).
 */
export interface UpdateOffer {
  staging: HeldUpdate | null;
  ready: HeldUpdate | null;
}

export const NO_OFFER: UpdateOffer = { staging: null, ready: null };

export type UpdaterEvent = { is: "downloaded"; update: HeldUpdate } | { is: "staged" } | { is: "error" };

export function nextOffer(offer: UpdateOffer, event: UpdaterEvent, platform: string): UpdateOffer {
  if (event.is === "downloaded") return platform === "darwin" ? { ...offer, staging: event.update } : { staging: null, ready: event.update };
  if (offer.staging === null) return offer;
  return event.is === "staged" ? { staging: null, ready: offer.staging } : { ...offer, staging: null };
}

export function stillHeld<Held extends HeldUpdate>(held: Held | null, exists: (file: string) => boolean): Held | null {
  return held !== null && exists(held.file) ? held : null;
}

export function downloadsUpdate(check: { found: string; held: HeldUpdate | null; failed: boolean; exists: (file: string) => boolean }): boolean {
  return check.failed || stillHeld(check.held, check.exists)?.version !== check.found;
}

/**
 * The updater's error event already reports a failed download (a cancelled one is no error): the
 * promise of that download is only caught, where left alone it was logged a second time as an
 * unhandled rejection (#2831). A download that fails before it begins (a feed that names a version
 * with no file for this app) throws instead, with no event, and is logged here.
 */
export async function checkForUpdates(updater: Pick<AppUpdater, "checkForUpdates" | "downloadUpdate">, log: (line: string) => void, wanted: (version: string) => boolean = () => true): Promise<void> {
  const told = (error: unknown) => error instanceof Error ? error.message : String(error);
  const result = await updater.checkForUpdates().catch((error: unknown) => {
    log(`Update check failed: ${told(error)}`);
    return null;
  });
  if (!result?.isUpdateAvailable || !wanted(result.updateInfo.version)) return;
  let download: Promise<unknown>;
  try {
    download = updater.downloadUpdate(result.cancellationToken);
  } catch (error) {
    log(`Update download failed: ${told(error)}`);
    return;
  }
  await download.catch(() => {});
}

export interface UpdateNotices {
  notified: string | null;
  closed: string | null;
}

export function readUpdateNotices(path: string): UpdateNotices {
  const saved = ((): Partial<Record<keyof UpdateNotices, unknown>> | null => {
    try { return JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof UpdateNotices, unknown>> | null; } catch { return null; }
  })();
  const version = (value: unknown) => typeof value === "string" && value !== "" ? value : null;
  return { notified: version(saved?.notified), closed: version(saved?.closed) };
}

export function writeUpdateNotices(path: string, notices: UpdateNotices): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(notices));
  renameSync(temporary, path);
}

export function updateNotice(version: string, said: UpdateNotices): { notify: boolean; line: boolean } {
  return { notify: said.notified !== version, line: said.closed !== version };
}
