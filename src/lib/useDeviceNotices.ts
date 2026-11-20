import { useCallback, useEffect, useState } from "react";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { noticeSeen, withNoticeAcked, withNoticeDecided, withNoticeReplay, type PcNotices } from "./deviceNotices.ts";

/** What this hook needs of a PC's socket (HerdrSocket): its frames, and a send that only a PC offering it takes. */
export interface NoticeSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  accountOpensAll(): boolean;
  sendNotice(message: NoticeSeen | NoticeAnswer): boolean;
}

/**
 * Each PC's journal notices (device table P15, T57): kept per PC as its socket replays and adds them, acknowledged
 * up to the newest one shown once that PC takes it, and dismissed here only; a dismiss sends nothing, and an open
 * admission is not dismissed (it stays until its PC says it was decided).
 */
export function useDeviceNotices(sockets: readonly { id: string; socket: NoticeSocket }[], selectedPcId: string) {
  const [retained, setRetained] = useState<ReadonlyMap<string, PcNotices>>(new Map());
  useEffect(() => {
    const offs = sockets.flatMap(({ id, socket }) => {
      const hide = () => setRetained((current) => {
        const notices = current.get(id);
        if (notices === undefined) return current;
        return new Map(current).set(id, { ...notices, notices: notices.notices.filter((item) => item.kind === "admit" && item.open), cut: 0 });
      });
      return [socket.onDisconnect(hide), socket.on((message) => {
        if (message.type === "features" || message.type === "snapshot") {
          if (socket.accountOpensAll()) setRetained((current) => current.has(id) ? new Map(current) : current);
          else hide();
          return;
        }
        if (!socket.accountOpensAll()) {
          return;
        }
        if (message.type !== "device-notice-replay" && message.type !== "device-notice") return;
        setRetained((current) => {
          const was = current.get(id);
          const replay = message.type === "device-notice-replay" ? message.replay : { notices: [message.notice], cut: was?.cut ?? 0 };
          return new Map(current).set(id, withNoticeReplay(was, replay));
        });
      })];
    });
    return () => { for (const off of offs) off(); };
  }, [sockets]);
  const selectedSocket = sockets.find(({ id }) => id === selectedPcId)?.socket;
  const byPc = new Map<string, PcNotices>();
  for (const { id, socket } of sockets) {
    const notices = retained.get(id);
    if (notices !== undefined && socket.accountOpensAll()) byPc.set(id, notices);
  }
  const shown = byPc.get(selectedPcId);
  const acknowledgeShown = useCallback((seq: number) => {
    const seen = shown === undefined ? null : noticeSeen(shown, seq);
    if (seen === null || !selectedSocket?.sendNotice(seen)) return;
    setRetained((current) => {
      const notices = current.get(selectedPcId);
      if (notices === undefined) return current;
      return new Map(current).set(selectedPcId, withNoticeAcked(notices, seen.seq));
    });
  }, [shown, selectedPcId, selectedSocket]);
  const dismiss = useCallback((id: string, notice: DeviceNotice) => {
    setRetained((current) => {
      const notices = current.get(id);
      if (notices === undefined || !notices.notices.some((item) => item.id === notice.id && !item.open)) return current;
      return new Map(current).set(id, withNoticeDecided(notices, notice.id));
    });
  }, []);
  return { byPc, dismiss, acknowledgeShown, cut: shown?.cut ?? 0 };
}
