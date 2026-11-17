export const LINK_SCHEME = "ovis";

const NAMES = ["machine", "ws", "pane", "view"] as const;
const VALUE_MAX = 256;

export function openLinkQuery(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== `${LINK_SCHEME}:` || url.hostname.toLowerCase() !== "open" || url.username || url.password || url.port) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  const query = new URLSearchParams();
  for (const name of NAMES) {
    const named = url.searchParams.get(name)?.trim();
    if (!named) continue;
    if (named.length > VALUE_MAX || /[\u0000-\u001f\u007f]/.test(named)) return null;
    query.set(name, named);
  }
  if (!query.has("pane")) return null;
  return `?${query.toString()}`;
}

export function argvLinkQuery(argv: readonly string[]): string | null {
  for (let at = argv.length - 1; at >= 0; at -= 1) {
    const arg = argv[at]!;
    if (arg.toLowerCase().startsWith(`${LINK_SCHEME}:`)) return openLinkQuery(arg);
  }
  return null;
}

export type LinkPage = { ours: boolean; loadingMainFrame: boolean };

export function tellsLink(pending: string | null, page: LinkPage | null, loaded: boolean): boolean {
  return pending !== null && page !== null && page.ours && (loaded || !page.loadingMainFrame);
}

export function linkHold(): { receive(query: unknown): void; onOpen(listener: (query: string) => void): void } {
  let held: string | null = null;
  let listening: ((query: string) => void) | null = null;
  return {
    receive(query) {
      if (typeof query !== "string") return;
      if (listening) listening(query);
      else held = query;
    },
    onOpen(listener) {
      listening = listener;
      const waiting = held;
      held = null;
      if (waiting !== null) listener(waiting);
    },
  };
}
