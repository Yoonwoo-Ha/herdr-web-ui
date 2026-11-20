/**
 * The desktop app's built-in browser as its bridge tells this page (app/electron/src/preload.ts,
 * `window.ovisBrowser`): the tabs main lists once their address was allowed, and what the browser
 * kept (downloads, an agent's screenshots). Null without the desktop app or while its setting is
 * off, where main answers null. Main is the authority on every field; this only reads them.
 */
import { useEffect, useState } from "react";

export type DesktopBrowserProfile = "mine" | "agent";

export interface DesktopBrowserTab {
  id: number;
  profile: DesktopBrowserProfile;
  /** the address without its query, as main shows it */
  address: string;
  title: string;
  loading: boolean;
  /** an agent tab a person holds: the agent's tools wait */
  held: boolean;
  /** the pane (on this PC) whose agent opened an agent tab; null for a person's own tab */
  owner: string | null;
}

export interface DesktopBrowserResult {
  id: string;
  kind: "download" | "screenshot";
  name: string;
  /** ms since the epoch */
  at: number;
  bytes: number | null;
  done: boolean;
  tab: number | null;
  profile: DesktopBrowserProfile;
}

export interface DesktopBrowser {
  tabs: DesktopBrowserTab[];
  results: DesktopBrowserResult[];
}

interface Bridge {
  current(): Promise<unknown>;
  onChange(listener: (browser: unknown) => void): () => void;
  close(id: number): void;
  thumbnail?(id: number): Promise<unknown>;
  reveal?(id: string): void;
}

function bridge(): Bridge | undefined {
  const found = typeof window === "undefined" ? undefined : (window as Window & { ovisBrowser?: Partial<Bridge> }).ovisBrowser;
  return typeof found?.current === "function" && typeof found.onChange === "function" && typeof found.close === "function" ? found as Bridge : undefined;
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const profile = (value: unknown): DesktopBrowserProfile | null => value === "mine" || value === "agent" ? value : null;

function tab(value: unknown): DesktopBrowserTab | null {
  const row = record(value);
  const kind = profile(row?.["profile"]);
  if (!row || kind === null || typeof row["id"] !== "number" || typeof row["address"] !== "string") return null;
  return {
    id: row["id"],
    profile: kind,
    address: row["address"],
    title: typeof row["title"] === "string" ? row["title"] : "",
    loading: row["loading"] === true,
    held: row["held"] === true,
    owner: typeof row["owner"] === "string" ? row["owner"] : null,
  };
}

const validTime = (value: unknown): value is number => typeof value === "number" && !Number.isNaN(new Date(value).getTime());

function result(value: unknown): DesktopBrowserResult | null {
  const row = record(value);
  const kind = row?.["kind"];
  const owner = profile(row?.["profile"]);
  if (!row || (kind !== "download" && kind !== "screenshot") || owner === null || typeof row["id"] !== "string" || typeof row["name"] !== "string" || !validTime(row["at"])) return null;
  return {
    id: row["id"],
    kind,
    name: row["name"],
    at: row["at"],
    bytes: typeof row["bytes"] === "number" && Number.isFinite(row["bytes"]) && row["bytes"] >= 0 ? row["bytes"] : null,
    done: row["done"] === true,
    tab: typeof row["tab"] === "number" ? row["tab"] : null,
    profile: owner,
  };
}

/** The bridge's view as this page reads it; a field main does not send yet reads as empty. */
export function desktopBrowserView(value: unknown): DesktopBrowser | null {
  const view = record(value);
  if (!view) return null;
  const list = <T,>(rows: unknown, read: (row: unknown) => T | null): T[] => Array.isArray(rows) ? rows.map(read).filter((row): row is T => row !== null) : [];
  return { tabs: list(view["tabs"], tab), results: list(view["results"], result) };
}

/** The built-in browser while the desktop app has it on, else null. */
export function useDesktopBrowser(): DesktopBrowser | null {
  const [browser, setBrowser] = useState<DesktopBrowser | null>(null);
  useEffect(() => {
    const found = bridge();
    if (!found) return;
    let alive = true;
    // a change main sent (off included) is newer than any answer still on its way
    let changed = false;
    const stop = found.onChange((next) => {
      changed = true;
      if (alive) setBrowser(desktopBrowserView(next));
    });
    found.current().then((next) => { if (alive && !changed) setBrowser(desktopBrowserView(next)); }, () => undefined);
    return () => { alive = false; stop(); };
  }, []);
  return browser;
}

export function closeBrowserTab(id: number): void {
  bridge()?.close(id);
}

/** shows a kept file in its folder (main never opens it); false where main has no way to */
export function revealBrowserResult(id: string): boolean {
  const reveal = bridge()?.reveal;
  if (typeof reveal !== "function") return false;
  reveal(id);
  return true;
}

/** A small picture of an allowed tab, taken by main when asked and kept nowhere; null while main draws none of it. */
export async function browserTabThumbnail(id: number): Promise<string | null> {
  const thumbnail = bridge()?.thumbnail;
  if (typeof thumbnail !== "function") return null;
  const picture = await thumbnail(id).catch(() => null);
  return typeof picture === "string" && picture.startsWith("data:image/") ? picture : null;
}
