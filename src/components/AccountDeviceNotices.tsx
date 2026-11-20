/** T51, T60, T65: answer an admission with the current sign-in's key and show only PC-authenticated receipts. */
import { useEffect, useRef, useState } from "react";
import type { DeviceNotice, PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { LOCAL_MACHINE, machinePath, type Machine } from "../../shared/machines.ts";
import { canBlockAdmission, notMeBlocks, sendBlocks, type FleetBlock, type OwnKey } from "../lib/account/fleet-block.ts";
import { notMeTransports } from "../lib/account/noticeAnswer.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, AccountServiceUnreachableError, indexedAccountService, SignedOutError } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import type { MachineSessionRegistry } from "../lib/machineSession.ts";
import { useDeviceNotices, type NoticeSocket } from "../lib/useDeviceNotices.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";
import { DeviceNotices } from "./DevicePairedNotice.tsx";

const ANSWER_TIMEOUT_MS = 5000;

async function registeredKey(session: AccountSession | undefined): Promise<(OwnKey & { readonly account: string }) | null> {
  if (session === undefined) return null;
  const kept = await indexedAccountStore.get("signin_key");
  if (kept === undefined || kept.no === null ||
      session.account !== kept.account || session.sign_in_id !== kept.sign_in_id) return null;
  return { ...kept.key, no: kept.no, account: kept.account };
}

type NoticeFleet = {
  readonly machines: readonly Machine[];
  readonly machineSessions: MachineSessionRegistry;
  readonly pageServerId: string | undefined;
};

type BlockResult = {
  readonly pc: string;
  readonly notice: DeviceNotice;
  readonly signer: string;
  readonly fleet: FleetBlock;
  readonly names: ReadonlyMap<string, string>;
};

function BlockNoticeAction({ notice, pc, socket, fleet, own, inFlight, onResult }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly fleet: NoticeFleet;
  readonly own: Awaited<ReturnType<typeof registeredKey>>;
  readonly inFlight: Set<string>;
  readonly onResult: (result: BlockResult) => void;
}) {
  const [sending, setSending] = useState(false);
  const canAnswer = own !== null && notice.account === own.account && canBlockAdmission(notice, own) && socket.accountOpensAll();

  const press = async () => {
    const id = `${pc.id}:${notice.id}`;
    if (!canAnswer || inFlight.has(id)) return;
    inFlight.add(id);
    setSending(true);
    try {
      const session = await indexedAccountService.session();
      if (session === undefined) return;
      const current = await registeredKey(session);
      if (current === null || current.account !== notice.account || !socket.accountOpensAll()) return;
      const blocks = await notMeBlocks(notice, current);
      if (blocks.length === 0) return;

      const serverIdOf = (machine: Machine) =>
        (machine.id === LOCAL_MACHINE ? fleet.pageServerId : undefined) ?? machine.server_id ?? machine.relay?.server_id;
      const pagePc = fleet.machines.find((machine) => machine.id === LOCAL_MACHINE);
      const pageId = pagePc === undefined ? undefined : serverIdOf(pagePc);
      const ownServerId = serverIdOf(pc);
      const ownId = ownServerId ?? pc.id;
      const rows = new Map([[ownId, pc]]);
      for (const machine of fleet.machines) {
        if (!fleet.machineSessions.peek(machine.id)?.socket.accountOpensAll()) continue;
        const serverId = serverIdOf(machine);
        const key = serverId ?? machine.id;
        if (!rows.has(key)) rows.set(key, machine);
      }
      const post = (id: string) => (path: string, body: unknown) => {
          const machine = rows.get(id);
          if (machine === undefined || !fleet.machineSessions.peek(machine.id)?.socket.accountOpensAll()) {
            return Promise.reject(new RangeError("PC does not offer account block delivery"));
          }
          return apiFetch(machinePath(machine.id, path.slice("/api/".length)), {
            method: "POST",
            headers: { "content-type": "application/json", "x-herdr-machine": "1" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
          });
      };
      const routes = notMeTransports(notice, ownId, [...rows.keys()], {
        socket: () => socket,
        post,
        // The page's carrier can authenticate its own records reply, not a roster PC's.
        channel: (id) => id === pageId && rows.get(id)?.id === LOCAL_MACHINE ? post(id) : undefined,
        timeoutMs: ANSWER_TIMEOUT_MS,
      });
      // The app's one carrier (native or relay) is to the page's PC. Other roster sockets are proxied.
      if (pc.id !== LOCAL_MACHINE || ownServerId === undefined) {
        const answer = routes.pcs.get(ownId);
        if (answer !== undefined) routes.relayed = new Map([[ownId, answer], ...routes.relayed]);
        routes.pcs.delete(ownId);
      }
      const service = indexedAccountService.forSignIn(session);
      // Every route to a skipped PC: one that is open and reports no capability decides its line, whatever the order.
      const skipped = new Map<string, Machine[]>();
      for (const machine of fleet.machines) {
        const serverId = serverIdOf(machine);
        if (serverId !== undefined && !rows.has(serverId)) skipped.set(serverId, [...skipped.get(serverId) ?? [], machine]);
      }
      // Directory lookup supplies display rows only; never put it in front of block delivery.
      const directory = service.listPcs(AbortSignal.timeout(ANSWER_TIMEOUT_MS)).catch((error: unknown) => {
        if (error instanceof AccountServiceError || error instanceof AccountServiceUnreachableError || error instanceof SignedOutError ||
            error instanceof SyntaxError || (error instanceof DOMException && error.name === "TimeoutError")) return [];
        throw error;
      });
      const [sent, roster] = await Promise.all([sendBlocks(blocks, {
        ...routes,
        service: async (records) => { await Promise.all(records.map((record) => service.postSafetyRecord(record))); },
      }), directory]);
      const outcomes = new Map<string, PcBlockOutcome>(sent.outcomes);
      const names = new Map([...rows].map(([id, machine]) => [id, machine.name]));
      // Every PC of the account gets a line, including one this browser has never listed; none of them gets a request.
      for (const { server_id, label } of roster) {
        if (rows.has(server_id) || outcomes.has(server_id)) continue;
        const routes = skipped.get(server_id) ?? [];
        const unsupported = routes.some((machine) => {
          const remote = fleet.machineSessions.peek(machine.id)?.socket;
          return remote?.connected && remote.featuresListed() && !remote.accountOpensAll();
        });
        outcomes.set(server_id, { server_id, state: unsupported ? "unsupported" : "unreachable" });
        names.set(server_id, routes[0]?.name ?? label);
      }
      onResult({ pc: pc.id, notice, signer: current.public_spki, fleet: { ...sent, outcomes }, names });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not sign a device block", error.name);
    } finally {
      inFlight.delete(id);
      setSending(false);
    }
  };

  return canAnswer ? <NotMeButton sending={sending || inFlight.has(`${pc.id}:${notice.id}`)} onPress={press} /> : null;
}

/** Subscribe alongside the App's roster hooks so opening the pane does not miss a notice replay. */
export function useAccountDeviceNotices({ machines, machineSessions, selectedMachineId, pageServerId }: NoticeFleet & {
  readonly selectedMachineId: string;
}) {
  const sockets = machines.flatMap(({ id }) => {
    const socket = machineSessions.peek(id)?.socket;
    return socket === undefined ? [] : [{ id, socket }];
  });
  const feed = useDeviceNotices(sockets, selectedMachineId);
  const shown = feed.byPc.get(selectedMachineId);
  // A block can close its notice or the socket before the account replies. Keep the result at App scope.
  const [results, setResults] = useState<ReadonlyMap<string, BlockResult>>(new Map());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const sending = useRef(new Set<string>());
  const [own, setOwn] = useState<Awaited<ReturnType<typeof registeredKey>>>(null);
  const readKey = results.size > 0 || shown?.notices.some((notice) => notice.kind === "admit" && notice.open) === true;
  useEffect(() => {
    if (!readKey) return;
    let live = true;
    let readVersion = 0;
    const read = () => {
      const version = ++readVersion;
      void indexedAccountStore.get("session").then(registeredKey).then(
        (key) => { if (live && version === readVersion) setOwn(key); },
        () => { if (live && version === readVersion) setOwn(null); },
      );
    };
    read();
    window.addEventListener("focus", read);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, read);
    };
  }, [readKey, shown?.notices]);

  const pc = machines.find((machine) => machine.id === selectedMachineId);
  const socket = sockets.find(({ id }) => id === selectedMachineId)?.socket;
  if (pc === undefined) return null;
  const notices = new Map(shown?.notices.map((notice) => [notice.id, notice]));
  const detachedRetries: [string, BlockResult][] = [];
  for (const [id, result] of results) {
    if (result.pc !== pc.id || result.signer !== own?.public_spki) continue;
    if (hidden.has(id)) {
      if (result.fleet.retryService !== undefined) detachedRetries.push([id, result]);
    } else if (!notices.has(result.notice.id)) notices.set(result.notice.id, result.notice);
  }
  for (const id of notices.keys()) {
    if (hidden.has(`${pc.id}:${id}`)) notices.delete(id);
  }
  const renderOutcomes = (id: string, result: BlockResult, dismissed = false) => {
    const { retryService, ...delivered } = result.fleet;
    return <BlockOutcomes outcomes={dismissed ? [] : [...result.fleet.outcomes.values()]} names={result.names} {...(retryService === undefined ? {} : {
      accountRetry: async () => {
        if (!await retryService()) return;
        setResults((current) => {
          const latest = current.get(id);
          return latest?.fleet.retryService !== retryService ? current : new Map(current).set(id, { ...latest, fleet: delivered });
        });
      },
    })} />;
  };
  if (notices.size === 0 && feed.cut === 0 && detachedRetries.length === 0) return null;
  return <>
    <DeviceNotices key={pc.id} pc={pc.name} notices={[...notices.values()]} cut={feed.cut}
      onDismiss={(notice) => feed.dismiss(pc.id, notice)}
      onHide={(notice) => setHidden((current) => new Set([...current, `${pc.id}:${notice.id}`]))}
      onShown={feed.acknowledgeShown}
      actions={(notice) => {
        const id = `${pc.id}:${notice.id}`;
        const result = results.get(id);
        if (result !== undefined && result.signer === own?.public_spki) return renderOutcomes(id, result);
        return socket === undefined ? null : <BlockNoticeAction notice={notice} pc={pc} socket={socket} fleet={{ machines, machineSessions, pageServerId }} own={own} inFlight={sending.current}
          onResult={(result) => setResults((current) => new Map(current).set(id, result))} />;
      }}
    />
    {detachedRetries.map(([id, result]) => <div key={id} role="status">{renderOutcomes(id, result, true)}</div>)}
  </>;
}
