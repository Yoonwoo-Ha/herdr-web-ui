/**
 * The desktop app's built-in browser: tabs drawn by the main process (WebContentsView) where the
 * Ovis page keeps their place, in one of two profiles that share no cookie or storage: `mine`, the
 * tabs a person opens, and `agent`, the tabs an agent drives. Every request, navigation, redirect,
 * frame and socket of either profile is decided by shared/browser-policy.ts before it leaves the PC.
 * A tab carries no preload and no bridge to the app; a window it opens is a tab of its profile. A
 * tab is listed only once an address it committed was allowed, with that address shown without
 * its query.
 */
import { BrowserWindow, session as sessions, WebContentsView, type Session, type WebContents } from "electron";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isIP } from "node:net";
import { canonicalHost, decide, machineHost, ovisAt, shownAddress, urlPort, type Allowed, type BrowserPolicy } from "../../../shared/browser-policy.ts";
import { hostForm } from "./browserState.ts";

export const BROWSER_PROFILES = ["mine", "agent"] as const;
export type BrowserProfile = (typeof BROWSER_PROFILES)[number];
export const MAX_BROWSER_TABS = 8;
/** a download larger than this is cancelled, and a profile keeps at most MAX_DOWNLOADS from one start of the app */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_DOWNLOADS = 50;
/**
 * The BrowserTabs each session answers to now (a setting turned off and on makes a new BrowserTabs). Its
 * request and permission handlers are set again by each new one; its download listener, an event, is added once.
 */
const owners = new WeakMap<Session, BrowserTabs>();
/** the sessions whose download listener (an event, which would stack) is added */
const downloadsWatched = new WeakSet<Session>();
const downloads = new WeakMap<Session, number>();

export interface BrowserTab {
  id: number;
  profile: BrowserProfile;
  address: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** an agent tab a person holds: the agent's tools wait, and the tab takes the person's input */
  held: boolean;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Tab {
  id: number;
  profile: BrowserProfile;
  view: WebContentsView;
  allowed: Allowed | null;
  title: string;
  held: boolean;
}

const PARTITION: Record<BrowserProfile, string> = { mine: "persist:ovis-browser-mine", agent: "persist:ovis-browser-agent" };
/** what a page of the person's own tabs may use; an agent tab gets nothing it would have to ask for */
const MINE_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

export class BrowserTabs {
  private tabs = new Map<number, Tab>();
  private nextId = 1;
  private shown: number | null = null;
  /** the sessions this BrowserTabs has guarded: webRequest and permission handlers replace the previous ones */
  private guarded = new Set<Session>();

  constructor(
    private window: () => BrowserWindow | null,
    private policy: BrowserPolicy,
    private downloads: string,
    private changed: (tabs: BrowserTab[]) => void,
    /** this PC's addresses outside loopback, read on each request (Wi-Fi, a VPN or Tailscale may come up any time) */
    private ownAddresses: () => readonly string[] = () => [],
    /** told of each request as its name starts to resolve (browserTabs.test.ts orders its steps by it) */
    private waiting: (url: string) => void = () => {},
    private maxDownloadBytes = MAX_DOWNLOAD_BYTES,
  ) {}

  /** A new policy applies to every request from now on; a tab whose page it now refuses closes. */
  setPolicy(policy: BrowserPolicy): void {
    this.policy = policy;
    for (const tab of [...this.tabs.values()]) {
      const url = tab.view.webContents.getURL();
      if (url !== "" && !this.decide(url, null).allowed) this.close(tab.id);
    }
  }

  list(): BrowserTab[] {
    return [...this.tabs.values()].flatMap((tab) => tab.allowed === null ? [] : [{
      id: tab.id,
      profile: tab.profile,
      address: shownAddress(tab.allowed),
      title: tab.title,
      loading: tab.view.webContents.isLoading(),
      canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
      canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
      held: tab.held,
    }]);
  }

  /** a tab of `profile` on `url`, or null when the address is refused or the tabs are at their limit */
  open(url: string, profile: BrowserProfile): number | null {
    // each profile has its own limit: a person's tabs never leave an agent without one, nor the other way round
    const sameProfile = [...this.tabs.values()].filter((tab) => tab.profile === profile).length;
    if (sameProfile >= MAX_BROWSER_TABS || !this.decide(url, null).allowed) return null;
    const partition = sessions.fromPartition(PARTITION[profile]);
    this.guard(partition, profile);
    const view = new WebContentsView({ webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, safeDialogs: true } });
    const tab: Tab = { id: this.nextId++, profile, view, allowed: null, title: "", held: false };
    this.tabs.set(tab.id, tab);
    this.watch(tab);
    void view.webContents.loadURL(url).catch(() => {});
    return tab.id;
  }

  close(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    if (this.shown === id) this.hide();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tell();
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  /** Draws the tab in `bounds` of the window (in the page's CSS pixels), over the place the page keeps for it. */
  show(id: number, bounds: BrowserBounds): void {
    const tab = this.tabs.get(id);
    const window = this.window();
    if (!tab || tab.allowed === null || !window) return;
    if (this.shown !== null && this.shown !== id) this.hide();
    const zoom = window.webContents.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom)), y = Math.max(0, Math.round(bounds.y * zoom));
    tab.view.setBounds({ x, y, width: Math.max(0, Math.min(Math.round(bounds.width * zoom), width - x)), height: Math.max(0, Math.min(Math.round(bounds.height * zoom), height - y)) });
    // a window made anew (the old one closed) holds no view yet
    if (!window.contentView.children.includes(tab.view)) window.contentView.addChildView(tab.view);
    this.shown = id;
  }

  hide(): void {
    const tab = this.shown === null ? undefined : this.tabs.get(this.shown);
    this.shown = null;
    const window = this.window();
    if (tab && window && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
  }

  navigate(id: number, url: string): boolean {
    const tab = this.tabs.get(id);
    if (!tab || !this.decide(url, null).allowed) return false;
    void tab.view.webContents.loadURL(url).catch(() => {});
    return true;
  }

  go(id: number, step: "back" | "forward" | "reload" | "stop"): void {
    const contents = this.tabs.get(id)?.view.webContents;
    if (!contents) return;
    if (step === "back") contents.navigationHistory.goBack();
    else if (step === "forward") contents.navigationHistory.goForward();
    else if (step === "reload") contents.reload();
    else contents.stop();
  }

  /** A person takes an agent tab (its input becomes theirs, the agent's tools wait) or hands it back. */
  hold(id: number, held: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.profile !== "agent" || tab.held === held) return;
    tab.held = held;
    this.tell();
  }

  private decide(url: string, frameOrigin: string | null) {
    return decide(url, this.policy, frameOrigin);
  }

  /**
   * Whether an address the policy allowed reaches an Ovis server after all: at any port on one of this PC's own
   * addresses (`tailscale serve` or a proxy may front the server on any port of them), or at a name that resolves,
   * in the profile's own resolver, to one of those or to an Ovis server of the policy. A loopback name was decided
   * by the policy, and a dev server is reached under it. A name this PC cannot resolve is let through: the browser
   * cannot resolve it either, so it reaches no address of this PC except through a proxy, which sees no loopback.
   */
  private async reachesOvis(partition: Session, address: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }
    if (url.protocol === "blob:" || url.protocol === "filesystem:") return false;
    const host = canonicalHost(url.hostname);
    if (this.ownAddresses().includes(host)) return true;
    if (host === "" || machineHost(host) === "localhost" || isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
    const port = urlPort(url);
    try {
      const { endpoints } = await partition.resolveHost(host);
      // read once the answer is in: an interface may have come up while the name resolved
      const own = new Set(this.ownAddresses());
      return endpoints.some(({ address: resolved }) => {
        const form = hostForm(resolved);
        return own.has(form) || ovisAt(form, port, this.policy);
      });
    } catch {
      return false;
    }
  }

  private tell(): void {
    this.changed(this.list());
  }

  /** The profile's own guards, once per session: requests, permissions and downloads. */
  private guard(partition: Session, profile: BrowserProfile): void {
    owners.set(partition, this);
    if (this.guarded.has(partition)) return;
    this.guarded.add(partition);
    // every request of the profile: pages, frames, redirects (each hop comes here again), subresources and sockets. The one
    // guard: a navigation reaches the network only through it, and refusing a frame's navigation earlier (will-frame-navigate)
    // takes down its page in Electron 45
    partition.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, answer) => {
      const initiator = details.initiatorOrigin ?? null;
      if (!this.decide(details.url, initiator).allowed) return answer({ cancel: true });
      // decided again once its name has resolved: the policy may have changed meanwhile (a site blocked)
      this.waiting(details.url);
      void this.reachesOvis(partition, details.url)
        .then((ovis) => answer({ cancel: ovis || !this.decide(details.url, initiator).allowed }), () => answer({ cancel: true }));
    });
    const allowed = (permission: string) => profile === "mine" && MINE_PERMISSIONS.has(permission);
    partition.setPermissionRequestHandler((_contents, permission, answer) => answer(allowed(permission)));
    partition.setPermissionCheckHandler((_contents, permission) => allowed(permission));
    partition.setDevicePermissionHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, answer) => answer({}));
    // a download is kept in the app's folder for it and never opened; no site fills the disk: a size and a count cap
    if (downloadsWatched.has(partition)) return;
    downloadsWatched.add(partition);
    partition.on("will-download", (_event, item) => {
      const tabs = owners.get(partition);
      const count = (downloads.get(partition) ?? 0) + 1;
      downloads.set(partition, count);
      if (!tabs || count > MAX_DOWNLOADS || item.getTotalBytes() > tabs.maxDownloadBytes) return item.cancel();
      item.on("updated", () => { if (item.getReceivedBytes() > tabs.maxDownloadBytes) item.cancel(); });
      const folder = join(tabs.downloads, profile);
      mkdirSync(folder, { recursive: true });
      item.setSavePath(join(folder, `${Date.now()}-${basename(item.getFilename()).replace(/[^\w.-]+/g, "_").slice(-120) || "download"}`));
    });
  }

  private watch(tab: Tab): void {
    const contents: WebContents = tab.view.webContents;
    if (tab.profile === "agent") contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.tabs.has(tab.id)) return { action: "deny" };
      this.open(url, tab.profile);
      this.tell();
      return { action: "deny" };
    });
    const committed = (url: string) => {
      const decision = this.decide(url, null);
      if (!decision.allowed) {
        this.close(tab.id);
        return;
      }
      tab.allowed = decision;
      this.tell();
    };
    contents.on("did-navigate", (_event, url) => committed(url));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) committed(url); });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title.slice(0, 200);
      this.tell();
    });
    contents.on("did-start-loading", () => this.tell());
    // a first navigation that ends without a page (a 204, a refused or failed load) leaves a tab nobody can see: it goes
    contents.on("did-stop-loading", () => {
      if (tab.allowed === null) this.close(tab.id);
      else this.tell();
    });
    // an agent's tab takes no input from a person until they hold it
    const ignored = () => tab.profile === "agent" && !tab.held;
    contents.on("before-input-event", (event) => { if (ignored()) event.preventDefault(); });
    contents.on("before-mouse-event", (event) => { if (ignored()) event.preventDefault(); });
    contents.on("render-process-gone", () => this.close(tab.id));
    contents.on("destroyed", () => { if (this.tabs.get(tab.id) === tab) this.close(tab.id); });
  }
}
