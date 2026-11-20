/**
 * T51, T53, T60, T65: answer an admission with "It's me" to the admission's PC, or "Not me" with the current
 * sign-in's key, and show only PC-authenticated receipts.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import type { DeviceNotice, PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { LOCAL_MACHINE, machinePath, type Machine } from "../../shared/machines.ts";
import { canBlockAdmission, notMeBlocks, sendBlocks, type FleetBlock, type OwnKey } from "../lib/account/fleet-block.ts";
import { answerOnPc, notMeTransports } from "../lib/account/noticeAnswer.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, AccountServiceUnreachableError, indexedAccountService, sameSignIn, SignedOutError } from "../lib/account/service.ts";
import { indexedAccountStore, type AccountSession } from "../lib/account/store.ts";
import { apiFetch } from "../lib/api-request-id.ts";
import type { MachineSessionRegistry } from "../lib/machineSession.ts";
import { itsMeAnswer } from "../lib/relay/joinHold.ts";
import { useDeviceNotices, type NoticeSocket } from "../lib/useDeviceNotices.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";
import { DeviceNotices } from "./DevicePairedNotice.tsx";
import { ItsMeButton } from "./JoinWait.tsx";

const ANSWER_TIMEOUT_MS = 5000;

/** The signed-in account, with this sign-in's registered key when it has one (Not me signs with it; It's me needs none). */
async function noticeIdentity(session: AccountSession | undefined): Promise<{ readonly account: string; readonly key: OwnKey | null } | null> {
  if (session === undefined) return null;
  const kept = await indexedAccountStore.get("signin_key");
  const key = kept !== undefined && kept.no !== null && session.account === kept.account && session.sign_in_id === kept.sign_in_id
    ? { ...kept.key, no: kept.no } : null;
  return { account: session.account, key };
}

type Own = Awaited<ReturnType<typeof noticeIdentity>>;

/**
 * "It's me" (owner decision OD3, T53): sent only to the admission's own PC, whose notice id it names. That PC ends the
 * new device's hold at once only when its own checks pass for this device's session; the answer counts once that PC
 * publishes the confirmation, and one lost answer is sent again.
 */
function ItsMeAction({ notice, pc, socket, own, inFlight, changed }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly own: Own;
  /** the answers out, by PC and notice, app-wide: one at a time, also across switching PCs (T51, T53) */
  readonly inFlight: Set<string>;
  readonly changed: () => void;
}) {
  const id = `${pc.id}:${notice.id}`;
  const [refused, setRefused] = useState(false);
  const canAnswer = own !== null && notice.account === own.account && notice.kind === "admit" && notice.open && socket.accountOpensAll();

  const confirm = async () => {
    if (!canAnswer || inFlight.has(id)) return;
    inFlight.add(id);
    changed();
    setRefused(false);
    try {
      const started = await indexedAccountStore.get("session");
      if (started === undefined || started.account !== notice.account) return;
      // The notice ID is PC-local. Never send it to another PC or via the block records route.
      let unanswered = 0;
      for (let tries = 0; tries < 2; tries++) {
        const current = await indexedAccountStore.get("session");
        if (current === undefined || current.account !== notice.account || !sameSignIn(started, current) || !socket.accountOpensAll()) break;
        const [outcome] = await Promise.allSettled([answerOnPc(socket, { notice, answer: itsMeAnswer(notice) }, ANSWER_TIMEOUT_MS)]);
        if (outcome.status === "fulfilled") break;
        unanswered++;
      }
      // The PC answers a refused It's me with nothing (too new, held or not caught up): say so rather than go quiet.
      if (unanswered === 2) setRefused(true);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not read the sign-in for an admission answer", error.name);
    } finally {
      inFlight.delete(id);
      changed();
    }
  };

  return canAnswer ? <ItsMeButton sending={inFlight.has(id)} onPress={confirm} refusedBy={refused ? pc.name : null} /> : null;
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

function BlockNoticeAction({ notice, pc, socket, fleet, own, inFlight, changed, onResult }: {
  readonly notice: DeviceNotice;
  readonly pc: Machine;
  readonly socket: NoticeSocket;
  readonly fleet: NoticeFleet;
  readonly own: Own;
  readonly inFlight: Set<string>;
  readonly changed: () => void;
  readonly onResult: (result: BlockResult) => void;
}) {
  const [sending, setSending] = useState(false);
  const canAnswer = own !== null && own.key !== null && notice.account === own.account && canBlockAdmission(notice, own.key) && socket.accountOpensAll();

  const press = async () => {
    const id = `${pc.id}:${notice.id}`;
    if (!canAnswer || inFlight.has(id)) return;
    inFlight.add(id);
    setSending(true);
    changed();
    try {
      const session = await indexedAccountService.session();
      if (session === undefined) return;
      const current = await noticeIdentity(session);
      if (current === null || current.key === null || current.account !== notice.account || !socket.accountOpensAll()) return;
      const blocks = await notMeBlocks(notice, current.key);
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
      onResult({ pc: pc.id, notice, signer: current.key.public_spki, fleet: { ...sent, outcomes }, names });
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Ovis: could not sign a device block", error.name);
    } finally {
      inFlight.delete(id);
      setSending(false);
      changed();
    }
  };

  return canAnswer ? <NotMeButton sending={sending || inFlight.has(`${pc.id}:${notice.id}`)} onPress={press} /> : null;
}

/** A notice's two answers, one out at a time per PC and notice (T51, T53). */
function AdmissionActions(props: Parameters<typeof BlockNoticeAction>[0]) {
  return <>
    <ItsMeAction notice={props.notice} pc={props.pc} socket={props.socket} own={props.own} inFlight={props.inFlight} changed={props.changed} />
    <BlockNoticeAction {...props} />
  </>;
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
  // an answer that starts or ends redraws every PC's actions: the lock is app-wide
  const [, answersChanged] = useReducer((count: number) => count + 1, 0);
  const [own, setOwn] = useState<Own>(null);
  const readKey = results.size > 0 || shown?.notices.some((notice) => notice.kind === "admit" && notice.open) === true;
  useEffect(() => {
    if (!readKey) return;
    let live = true;
    let readVersion = 0;
    const read = () => {
      const version = ++readVersion;
      void indexedAccountStore.get("session").then(noticeIdentity).then(
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
    if (result.pc !== pc.id || result.signer !== own?.key?.public_spki) continue;
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
        if (result !== undefined && result.signer === own?.key?.public_spki) return renderOutcomes(id, result);
        return socket === undefined ? null : <AdmissionActions notice={notice} pc={pc} socket={socket} fleet={{ machines, machineSessions, pageServerId }} own={own}
          inFlight={sending.current} changed={answersChanged} onResult={(result) => setResults((current) => new Map(current).set(id, result))} />;
      }}
    />
    {detachedRetries.map(([id, result]) => <div key={id} role="status">{renderOutcomes(id, result, true)}</div>)}
  </>;
}
