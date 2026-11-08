/**
 * Name lookups for the SSH tab's list (server/ssh-candidates.ts): the addresses a config host's name resolves to,
 * bounded in time and in lookups running at once, each answer kept briefly.
 */
import { isIP } from "node:net";

/** how long the list waits on every name lookup together; a name still unanswered then claims no PC */
export const RESOLVE_TIMEOUT_MS = 1500;
/** how long one lookup holds its slot before it gives up, so a hung one never stops the names waiting behind it */
const LOOKUP_TIMEOUT_MS = 1500;
/** name lookups running at most across every listing, so hung ones never pile up; the rest wait for a free slot */
const MAX_LOOKUPS = 16;
/** how long a name's answer is kept, so reopening the list does not look everything up again */
const ANSWER_TTL_MS = 30_000;

export type Resolve = (host: string) => Promise<string[]>;
export interface Lookup {
  resolve: Resolve;
  now: () => number;
  /** how long the listing waits for every name together */
  timeoutMs: number;
  /** settles when one running lookup has waited long enough */
  deadline: () => Promise<void>;
}

/**
 * One spelling per address: `FD7A:0:0::1` is `fd7a::1` and `::ffff:100.64.0.1` is `100.64.0.1`. A zone id stays, so
 * the same address on two links never compares equal.
 */
export const canonicalIp = (ip: string): string => {
  const zoneAt = ip.indexOf("%");
  const [address, zone] = zoneAt < 0 ? [ip, ""] : [ip.slice(0, zoneAt), ip.slice(zoneAt)];
  if (isIP(address) !== 6) return ip;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped === null) return canonical + zone;
  const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}${zone}`;
};

export const systemResolve: Resolve = async (host) => (await Bun.dns.lookup(host, { backend: "system" })).map(({ address }) => address);

export const lookupDeadline = (): Promise<void> => new Promise((done) => { setTimeout(done, LOOKUP_TIMEOUT_MS).unref(); });

/**
 * Each resolver's lookups by name, waiting or running (a hung one holds its slot until its own deadline), its recent
 * answers, and the lookups waiting for one of its MAX_LOOKUPS slots
 */
interface Lookups { pending: Map<string, Promise<string[]>>; answers: Map<string, { addresses: string[]; at: number }>; running: number; waiting: (() => void)[] }
const lookupsOf = new WeakMap<Resolve, Lookups>();

/** the addresses `name` resolves to: a recent answer, the lookup already pending, or a new one once a slot is free */
function lookupOnce({ resolve, now, deadline }: Lookup, name: string): Promise<string[]> {
  const state: Lookups = lookupsOf.get(resolve) ?? { pending: new Map(), answers: new Map(), running: 0, waiting: [] };
  lookupsOf.set(resolve, state);
  const answer = state.answers.get(name);
  if (answer !== undefined && now() - answer.at < ANSWER_TTL_MS) return Promise.resolve(answer.addresses);
  const known = state.pending.get(name);
  if (known !== undefined) return known;
  const lookup = (async () => {
    if (state.running < MAX_LOOKUPS) state.running++; else await new Promise<void>((start) => state.waiting.push(start));
    try {
      const addresses = await Promise.race([Promise.resolve().then(() => resolve(name)), deadline().then(() => null)]);
      if (addresses === null) return [];
      state.answers.set(name, { addresses, at: now() });
      return addresses;
    } catch { return []; } finally {
      // the slot goes straight to the next waiting lookup
      const next = state.waiting.shift();
      if (next === undefined) state.running--; else next();
      state.pending.delete(name);
    }
  })();
  state.pending.set(name, lookup);
  return lookup;
}

/** the addresses each name resolves to, waiting `timeoutMs` at most for all of them; a name that fails or is late is left out */
export async function resolveWithin(names: string[], lookup: Lookup): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((done) => { timer = setTimeout(done, lookup.timeoutMs); });
  const lookups = names.map(async (name) => {
    const addresses = await lookupOnce(lookup, name);
    if (addresses.length > 0) found.set(name, addresses.map(canonicalIp));
  });
  await Promise.race([Promise.all(lookups), deadline]);
  clearTimeout(timer);
  return new Map(found);
}
