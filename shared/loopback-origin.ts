/** Normalize a local HTTP origin without credentials, a path, a query or a fragment. */
export function loopbackOrigin(given: string): string | null {
  let url: URL;
  try { url = new URL(given); } catch { return null; }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ? url.origin : null;
}
