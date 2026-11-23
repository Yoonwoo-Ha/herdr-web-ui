import { readFileSync } from "node:fs";

import { DEFAULT_PORT } from "../shared/protocol.ts";
import { FALLBACK_PORTS } from "./plugin-port.ts";

/**
 * Ports a real Ovis on this PC may be on, which a test never hands to a program: the app's own and the ones it falls
 * back to, and the maintainer's main preview (7421, served over Tailscale on 17421).
 */
export const REAL_PORTS: readonly number[] = [DEFAULT_PORT, ...FALLBACK_PORTS, 7421, 17421];

/**
 * The ports the system hands out for port 0, first and last. Linux says them, and a host can set
 * them; elsewhere, and where that cannot be read, every port from Linux's default first one up
 * counts (macOS and Windows hand out 49152 and up).
 */
function handedOut(): [number, number] {
  try {
    const [first, last] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
    if (Number.isInteger(first) && Number.isInteger(last) && first! >= 1 && first! <= last! && last! <= 65535) return [first!, last!];
  } catch { /* not Linux, or not to be read */ }
  return [32768, 65535];
}

/** From 20000 up when that fits: server/updater.test.ts picks its own below it. */
export function quietRange(first: number, last: number): [number, number] | null {
  const stretches: [number, number][] = [[20_000, first - 1], [last + 1, 65_535], [1024, Math.min(first - 1, 19_999)]];
  return stretches.find(([from, to]) => to - from + 1 >= 1000) ?? null;
}

const given = new Set<number>();

/**
 * A loopback port for a test to hand to a program that opens it later, or never: free now, never
 * given twice in one process, and outside the ports the system hands out for port 0. A port taken
 * with port 0 and let go can be handed to another test's server before the program gets to it, and
 * what the program then sends there (scripts/plugin.ts asks its PORT for /api/health, with no
 * token) arrives in that test instead.
 */
export function quietPort(): number {
  const range = quietRange(...handedOut());
  if (range === null) {
    for (;;) {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = probe.port;
      probe.stop(true);
      if (!REAL_PORTS.includes(port)) return port;
    }
  }
  const [from, to] = range;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = from + Math.floor(Math.random() * (to - from + 1));
    if (given.has(port) || REAL_PORTS.includes(port)) continue;
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      given.add(port);
      return port;
    } catch {}
  }
  throw new Error(`no free port from ${from} to ${to}`);
}
