/**
 * Preloaded (BUN_OPTIONS) into every command scripts/plugin.test.ts runs, and the Bun processes those start: serving
 * on, connecting to or fetching from a port this PC's own Ovis may be on (REAL_PORTS) throws instead, before anything
 * reaches it, and is written to OVIS_TEST_REAL_PORTS_LOG, which the test checks. A command that would fall back to
 * DEFAULT_PORT on a path the test did not foresee is stopped there, even when it catches the error.
 */
import { appendFileSync } from "node:fs";

import { REAL_PORTS } from "./quiet-port.ts";

const log = process.env["OVIS_TEST_REAL_PORTS_LOG"];

function refuse(port: unknown, what: string): void {
  if (!REAL_PORTS.includes(Number(port))) return;
  const said = `${what} port ${String(port)} (pid ${process.pid}: ${process.argv.slice(1).join(" ")})`;
  if (log) appendFileSync(log, `${said}\n`);
  throw new Error(`test guard: ${said}, where this PC's own Ovis may be`);
}

const { serve, listen, connect } = Bun;
const options = (given: unknown): { port?: unknown } => (typeof given === "object" && given !== null ? given : {}) as { port?: unknown };
Object.assign(Bun, {
  serve: ((given: Parameters<typeof serve>[0]) => { refuse(options(given).port, "serving on"); return serve(given); }) as typeof serve,
  listen: ((given: Parameters<typeof listen>[0]) => { refuse(options(given).port, "listening on"); return listen(given); }) as typeof listen,
  connect: ((given: Parameters<typeof connect>[0]) => { refuse(options(given).port, "connecting to"); return connect(given); }) as typeof connect,
});

const ownFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  refuse(url.port === "" ? null : url.port, "fetching from");
  return ownFetch(input, init);
}, ownFetch);
