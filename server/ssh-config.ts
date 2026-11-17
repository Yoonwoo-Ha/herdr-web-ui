import { userInfo } from "node:os";

import { globMatch, listMatches } from "./ssh-glob.ts";

const MAX_INCLUDE_DEPTH = 4;
export const MAX_HOSTS = 200;
const MAX_WEIGHED = 2 * MAX_HOSTS;
const EFFECTIVE_KEYS = ["hostname", "addressfamily", "proxycommand", "proxyjump", "user", "canonicalizehostname"] as const;
const ROUTE_KEYS = ["hostname", "addressfamily", "proxycommand", "proxyjump"] as const;
const WEIGHED = ["host", "originalhost", "user", "localuser"] as const;

export interface ConfigHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  addressFamily?: "inet" | "inet6";
  proxied?: true;
  undetermined?: true;
}

export type Included = string | { text: string; unclaimed: true } | null;

const plainAlias = (pattern: string): boolean => pattern !== "" && !/[*?!]/.test(pattern);

/**
 * The words of a line's arguments as ssh splits them (argv_split): `"` and `'` quote, a backslash escapes a quote, a
 * backslash or (outside quotes) a space, and a word that starts with `#` ends the line (`Host lab # work` names `lab`)
 */
function words(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === " " || text[index] === "\t") continue;
    if (text[index] === "#") break;
    let [word, quote] = ["", ""];
    for (; index < text.length; index++) {
      const [char, next] = [text[index]!, text[index + 1]];
      if (char === "\\" && (next === "'" || next === "\"" || next === "\\" || (quote === "" && next === " "))) word += text[++index];
      else if (quote === "" && (char === " " || char === "\t")) break;
      else if (quote === "" && (char === "\"" || char === "'")) quote = char;
      else if (char === quote) quote = "";
      else word += char;
    }
    found.push(word);
  }
  return found;
}

function keyword(line: string): { key: string; values: string[]; raw: string } | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (match === null) return null;
  return { key: match[1]!.toLowerCase(), values: words(match[2]!), raw: match[2]! };
}

type Criterion = { negate: boolean } & ({ on: "all" | "unknown" } | { on: "final"; asksFinal: boolean } | { on: (typeof WEIGHED)[number]; patterns: string[] });
type Block =
  | { kind: "host"; patterns: string[]; aliases: string[]; within?: Block; unclaimed?: true }
  | { kind: "match"; criteria: Criterion[]; within?: Block };
type HostBlock = Extract<Block, { kind: "host" }>;
type MatchBlock = Extract<Block, { kind: "match" }>;
type Entry = { kind: "option"; block: Block; key: string; value: string; unclaimed?: true } | { kind: "match"; block: MatchBlock } | { kind: "unread"; block: Block };

const isWeighed = (on: string): on is (typeof WEIGHED)[number] => (WEIGHED as readonly string[]).includes(on);

function matchCriteria(values: string[]): Criterion[] {
  const criteria: Criterion[] = [];
  for (let index = 0; index < values.length; index++) {
    const negate = values[index]!.startsWith("!");
    const word = values[index]!.slice(negate ? 1 : 0);
    const equals = word.indexOf("=");
    const on = (equals < 0 ? word : word.slice(0, equals)).toLowerCase();
    if (on === "all" || on === "canonical" || on === "final") { criteria.push(on === "all" ? { negate, on } : { negate, on: "final", asksFinal: on === "final" && !negate }); continue; }
    const patterns = equals < 0 ? values[++index] ?? "" : word.slice(equals + 1);
    criteria.push(isWeighed(on) ? { negate, on, patterns: (on === "host" || on === "originalhost" ? patterns.toLowerCase() : patterns).split(",") } : { negate, on: "unknown" });
  }
  return criteria;
}

interface Weighing {
  alias: string; target: string; localUser: string | null; final: boolean;
  effective: Map<string, string | null>; applies: Map<Block, boolean | null>; wantsFinal: boolean | null;
  unclaimed: boolean;
  finalPass?: Weighing;
}
const passOf = (alias: string, target: string, localUser: string | null, final: boolean): Weighing =>
  ({ alias, target, localUser, final, effective: new Map(), applies: new Map(), wantsFinal: false, unclaimed: false });

const expandHost = (hostname: string, alias: string): string => hostname.replace(/%([%h])/g, (_, token: string) => token === "h" ? alias : "%");
const allOf = (verdicts: (boolean | null)[]): boolean | null => verdicts.includes(false) ? false : verdicts.includes(null) ? null : true;

function holds({ alias, target, localUser, final, effective }: Weighing, criterion: Criterion): boolean | null {
  const user = effective.get("user") === undefined ? localUser : effective.get("user")!;
  const hostname = effective.get("hostname");
  let verdict: boolean | null;
  switch (criterion.on) {
    case "all": verdict = true; break;
    case "final": verdict = final; break;
    case "unknown": verdict = null; break;
    case "originalhost": verdict = listMatches(criterion.patterns, alias); break;
    case "host": verdict = hostname === null ? null : listMatches(criterion.patterns, hostname === undefined ? target : expandHost(hostname, alias).toLowerCase()); break;
    case "user": verdict = user === null ? null : listMatches(criterion.patterns, user); break;
    case "localuser": verdict = localUser === null ? null : listMatches(criterion.patterns, localUser); break;
    default: { const unreachable: never = criterion; throw new Error(`unknown Match criterion ${JSON.stringify(unreachable)}`); }
  }
  return verdict === null || !criterion.negate ? verdict : !verdict;
}

function applies(weighing: Weighing, block: Block): boolean | null {
  const known = weighing.applies.get(block);
  if (known !== undefined) return known;
  const outer = block.within === undefined ? true : applies(weighing, block.within);
  const own = outer === false ? false : block.kind === "match" ? allOf(block.criteria.map((criterion) => holds(weighing, criterion))) :
    listMatches(block.patterns, weighing.target);
  const verdict = allOf([outer, own]);
  weighing.applies.set(block, verdict);
  return verdict;
}

const leaveUnknown = (effective: Map<string, string | null>): void => { for (const key of EFFECTIVE_KEYS) if (!effective.has(key)) effective.set(key, null); };

function pass(entries: Entry[], weighing: Weighing): void {
  for (const entry of entries) {
    switch (entry.kind) {
      case "match": {
        // ssh reads every condition of every Match line, an included file's too when its Include's block does not apply
        // (read as never matching), so an unnegated `final` anywhere asks for the final pass
        if (entry.block.criteria.some((criterion) => criterion.on === "final" && criterion.asksFinal)) weighing.wantsFinal = true;
        applies(weighing, entry.block);
        break;
      }
      case "option": {
        // ssh sets the HostName to the name it connects to before the final pass, so a HostName there changes nothing
        if (weighing.effective.has(entry.key) || (weighing.final && entry.key === "hostname")) break;
        // a ProxyJump other than `none` is ignored once a ProxyCommand (`none` too) is set, and sets it to `none` itself
        const jumps = entry.key === "proxyjump" && entry.value !== "none";
        if (jumps && weighing.effective.has("proxycommand")) break;
        const verdict = applies(weighing, entry.block);
        if (verdict !== false) weighing.effective.set(entry.key, verdict === true ? entry.value : null);
        if (verdict !== false && entry.unclaimed === true) weighing.unclaimed = true;
        if (verdict !== false && jumps) weighing.effective.set("proxycommand", verdict === true ? "none" : null);
        break;
      }
      case "unread": {
        if (applies(weighing, entry.block) !== false) leaveUnknown(weighing.effective);
        // ssh reads it even when its block does not apply, and a `Match final` in it would ask for the final pass
        else if (weighing.wantsFinal === false) weighing.wantsFinal = null;
        break;
      }
      default: { const unreachable: never = entry; throw new Error(`unknown config entry ${JSON.stringify(unreachable)}`); }
    }
  }
}

function weigh(entries: Entry[], alias: string, localUser: string | null): Weighing {
  const first = passOf(alias, alias, localUser, false);
  pass(entries, first);
  const { effective } = first;
  const canonical = effective.get("canonicalizehostname");
  const canonicalizes = canonical === null ? null : canonical !== undefined && canonical.toLowerCase() !== "no";
  if (canonicalizes === false && first.wantsFinal === false) return first;
  const hostname = effective.get("hostname");
  if (canonicalizes !== false || first.wantsFinal === null || hostname === null) { leaveUnknown(effective); return first; }
  const final: Weighing = { ...passOf(alias, hostname === undefined ? alias : expandHost(hostname, alias).toLowerCase(), localUser, true), effective };
  pass(entries, final);
  first.finalPass = final;
  first.unclaimed ||= final.unclaimed;
  return first;
}

const appliesOnEither = (weighing: Weighing, block: Block): boolean | null => {
  const first = applies(weighing, block);
  return first !== false || weighing.finalPass === undefined ? first : applies(weighing.finalPass, block);
};

function ruledOut(block: Block, alias: string, localUser: string | null): boolean {
  const bare = passOf(alias, alias, localUser, false);
  const cheap = (criterion: Criterion): boolean => criterion.on === "all" || criterion.on === "originalhost" || criterion.on === "localuser";
  for (let outer: Block | undefined = block; outer !== undefined; outer = outer.within) {
    if (outer.kind === "host" ? listMatches(outer.patterns, alias) === false : outer.criteria.some((criterion) => cheap(criterion) && holds(bare, criterion) === false)) return true;
  }
  return false;
}

function describe(alias: string, effective: Map<string, string | null>, named: boolean): ConfigHost {
  const [hostname, user] = [effective.get("hostname"), effective.get("user")];
  const family = effective.get("addressfamily")?.toLowerCase();
  const proxied = ["proxycommand", "proxyjump"].some((key) => (effective.get(key) ?? "none") !== "none");
  // a canonical name only DNS gives (CanonicalDomains) may lead elsewhere, even with every route option set
  const canonical = effective.get("canonicalizehostname");
  const undetermined = !named || ROUTE_KEYS.some((key) => effective.get(key) === null) || (canonical !== undefined && canonical?.toLowerCase() !== "no");
  return {
    alias, hostname: hostname == null ? null : expandHost(hostname, alias), user: user ?? null,
    ...(family === "inet" || family === "inet6" ? { addressFamily: family } : {}), ...(proxied ? { proxied: true as const } : {}),
    ...(undetermined ? { undetermined: true as const } : {}),
  };
}

const currentUser = (): string | null => { try { return userInfo().username; } catch { return null; } };

export async function sshConfigHosts(text: string, include: (pattern: string) => Promise<Included[]> = async () => [], localUser = currentUser()): Promise<ConfigHost[]> {
  const blocks: HostBlock[] = [];
  const entries: Entry[] = [];
  // lines before the first Host apply to every host, as in ssh
  let current: Block = { kind: "host", patterns: ["*"], aliases: [] };
  const walk = async (text: string, depth: number, within?: Block, unclaimed = false): Promise<void> => {
    for (const line of text.split(/\r?\n/)) {
      const parsed = keyword(line);
      if (parsed === null) continue;
      if (parsed.key === "host") {
        // `Host valid server-*` still names `valid`; a negated pattern on the line leaves out each alias it matches
        // (`Host web01 !web*` names nothing), as ssh never applies the block to that host
        const patterns = parsed.values.map((value) => value.toLowerCase());
        const negated = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
        const block: HostBlock = { kind: "host", patterns, aliases: parsed.values.filter((value) => plainAlias(value) && !negated.some((pattern) => globMatch(pattern, value.toLowerCase()) === true)), within, ...(unclaimed ? { unclaimed: true as const } : {}) };
        blocks.push(block);
        current = block;
      } else if (parsed.key === "match") {
        const block: MatchBlock = { kind: "match", criteria: matchCriteria(parsed.values), within };
        entries.push({ kind: "match", block });
        current = block;
      } else if (parsed.key === "include") {
        // as ssh reads it: an included file goes on in the block the Include sits in (its options before a Host line
        // of its own are that block's), and the including file's block goes on after it. Each file starts in the
        // Include's own block: a Host line in one file does not carry into the next
        const outer: Block = current;
        if (depth >= MAX_INCLUDE_DEPTH) entries.push({ kind: "unread", block: outer });
        else for (const pattern of parsed.values) {
          for (const included of await include(pattern)) {
            if (included === null) { entries.push({ kind: "unread", block: outer }); continue; }
            current = outer;
            await walk(typeof included === "string" ? included : included.text, depth + 1, outer, unclaimed || typeof included !== "string");
          }
        }
        current = outer;
      } else if ((EFFECTIVE_KEYS as readonly string[]).includes(parsed.key) && parsed.values[0] !== undefined) {
        // a proxy is off only for the bare word none: `'none' || ssh -W %h:%p bastion` still proxies, as in ssh
        const value = parsed.key === "proxycommand" || parsed.key === "proxyjump" ? parsed.raw : parsed.values[0];
        entries.push({ kind: "option", block: current, key: parsed.key, value, ...(unclaimed ? { unclaimed: true as const } : {}) });
      }
    }
  };
  await walk(text, 0);
  const blocksOf = new Map<string, HostBlock[]>();
  for (const block of blocks) {
    for (const alias of block.aliases) {
      const named = blocksOf.get(alias);
      if (named === undefined) blocksOf.set(alias, [block]);
      else named.push(block);
    }
  }
  const weighings = new Map<string, Weighing>();
  const seen = new Set<string>();
  const hosts: ConfigHost[] = [];
  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (hosts.length >= MAX_HOSTS) return hosts;
      if (seen.has(alias) || ruledOut(block, alias.toLowerCase(), localUser)) continue;
      let weighing = weighings.get(alias);
      if (weighing === undefined) {
        if (weighings.size >= MAX_WEIGHED) return hosts;
        weighing = weigh(entries, alias.toLowerCase(), localUser);
        weighings.set(alias, weighing);
      }
      if (appliesOnEither(weighing, block) === false) continue;
      seen.add(alias);
      const named = blocksOf.get(alias)!.some((named) => appliesOnEither(weighing, named) === true);
      hosts.push({ ...describe(alias, weighing.effective, named), ...(block.unclaimed === true || weighing.unclaimed ? { undetermined: true as const } : {}) });
    }
  }
  return hosts;
}
