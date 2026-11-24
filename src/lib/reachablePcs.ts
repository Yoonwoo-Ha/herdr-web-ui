import type { Machine } from "../../shared/machines.ts";
import type { SshCandidate } from "./api.ts";

/**
 * One way this PC can reach another over SSH, as Add a connection's Tailscale and relay tabs list it: one row a machine,
 * by its machine name, as Tailscale's own machine list draws them. The ssh config aliases the server resolved to a PC of
 * this PC's Tailscale login fold into one row only when they reach it the same way: the same User, and ssh's port. An
 * alias on another port (an sshd in WSL or a container) or as another user is a row of its own, by its alias, and so is
 * one whose User a Match may set. Any other config host is a row of its own: two aliases of one HostName may still part
 * by Port or ProxyJump.
 */
export interface ReachablePc {
  readonly key: string;
  /** Tailscale's machine name for that PC reached the plain way, else the alias */
  readonly name: string;
  readonly way: "tailscale" | "ssh_config";
  /** what Add and Connect open, shown before the press: the alias when the name is not it, the user, the address, a port */
  readonly address: string;
  /** what Add and Connect open: the alias named as the machine, else the first in config order, else the MagicDNS name */
  readonly destination: string;
  readonly tailnet?: string;
  /** the PC itself reached the plain way, and the only such row for it: that PC's own Tailscale answer is this row's */
  readonly machine?: true;
  /** the found entries it stands for: its state comes from these alone */
  readonly found: readonly SshCandidate[];
}

const dnsName = (name: string): string => name.toLowerCase().replace(/\.$/, "");
const plainPort = (port: number | undefined): boolean => port === undefined || port === 22;
const reach = (user: string | null | undefined, host: string, port: number | undefined): string =>
  `${typeof user === "string" ? `${user}@` : ""}${host}${plainPort(port) ? "" : `:${port}`}`;

export function reachablePcs(found: readonly SshCandidate[]): ReachablePc[] {
  const groups = new Map<string, SshCandidate[]>();
  for (const pc of found) {
    const folds = pc.tailnet !== undefined && plainPort(pc.port) && pc.user !== null;
    const key = folds ? `tailnet:${dnsName(pc.tailnet!)}\n${pc.user ?? ""}` : `ssh:${pc.source}:${pc.destination}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [pc]);
    else group.push(pc);
  }
  // how many users each Tailscale PC is reached as the plain way: with one, that row is the PC itself
  const ways = new Map<string, number>();
  for (const [key, [pc]] of groups) if (key.startsWith("tailnet:")) ways.set(dnsName(pc!.tailnet!), (ways.get(dnsName(pc!.tailnet!)) ?? 0) + 1);
  return [...groups].map(([key, pcs]): ReachablePc => {
    const first = pcs[0]!;
    if (first.tailnet === undefined) return { key, name: first.name, way: "ssh_config", address: reach(null, first.detail ?? first.destination, first.port), destination: first.destination, found: pcs };
    const tailnet = dnsName(first.tailnet);
    if (!key.startsWith("tailnet:")) return { key, name: first.name, way: "tailscale", address: reach(first.user, tailnet, first.port), destination: first.destination, tailnet, found: pcs };
    const machineName = tailnet.split(".")[0]!;
    const aliases = pcs.filter((pc) => pc.source === "ssh_config");
    const opens = aliases.find((pc) => pc.name.toLowerCase() === machineName) ?? aliases[0] ?? first;
    const machine = ways.get(tailnet) === 1;
    const name = machine || opens.source === "tailscale" ? machineName : opens.name;
    const reached = reach(opens.user, tailnet, opens.port);
    const address = opens.source === "tailscale" || opens.name.toLowerCase() === name.toLowerCase() ? reached : `${opens.name} · ${reached}`;
    return { key, name, way: "tailscale", address, destination: opens.destination, tailnet, ...(machine ? { machine: true as const } : {}), found: pcs };
  });
}

/**
 * - `in-account`: its relay ID is one of the account's PCs.
 * - `added`: this app has it already, at one of its addresses as Add would add it, or (with the account's PCs given)
 *   by its relay ID through the relay. With the account's PCs given, a PC this app has at that address whose relay ID
 *   is known and not the account's is offered Add again (an add over SSH that stopped short of the account), on that
 *   same PC (savedAt).
 * - `outdated`: its Ovis is older than 0.5. `waiting`: a Tailscale PC whose Ovis is not known yet.
 */
export type ReachableState = "in-account" | "added" | "outdated" | "waiting" | "open";

export interface ReachableFacts {
  readonly machines: readonly Machine[];
  /** the Tailscale PCs' own answers (GET /api/machines/tailnet), by MagicDNS name; `read` once that list came or failed */
  readonly tailnet: { readonly read: boolean; readonly pcs: ReadonlyMap<string, { readonly outdated: boolean; readonly server_id: string | null }> };
  /** the relay IDs of the account's PCs: given only where the row adds a PC to the account */
  readonly accountPcs?: ReadonlySet<string>;
}

/** This app's PC at one of the row's addresses as Add would add it (port 22, no herdr session named), if any. */
export function savedAt(row: ReachablePc, machines: readonly Machine[]): Machine | undefined {
  return machines.find(({ target }) => target !== undefined && (target.port ?? 22) === 22 && target.session === undefined && row.found.some((pc) => pc.destination === target.destination));
}

export function reachableState(row: ReachablePc, { machines, tailnet, accountPcs }: ReachableFacts): ReachableState {
  const at = savedAt(row, machines);
  // that PC's Ovis on Tailscale answers for the PC reached the plain way, not for another sshd or user there
  const answer = row.machine === true ? tailnet.pcs.get(row.tailnet!) : undefined;
  const ids = [at?.server_id, answer?.server_id].filter((id): id is string => typeof id === "string");
  if (accountPcs !== undefined && ids.some((id) => accountPcs.has(id))) return "in-account";
  if (at !== undefined && (accountPcs === undefined || at.server_id === undefined)) return "added";
  if (accountPcs !== undefined && ids.some((id) => machines.some((machine) => machine !== at && machine.kind !== "local" && (machine.relay?.server_id ?? machine.server_id) === id))) return "added";
  if (answer?.outdated === true) return "outdated";
  if (row.machine === true && !tailnet.read) return "waiting";
  return "open";
}
