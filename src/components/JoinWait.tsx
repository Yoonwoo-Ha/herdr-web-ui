import { useEffect, useState } from "react";
import { X } from "lucide-react";

import "./JoinWait.css";

import type { HoldState } from "../../shared/account-devices-api.ts";
import { holdWaitMs } from "../lib/relay/joinHold.ts";
import { useT } from "../lib/i18n.ts";

/** The new device's wait on one PC (device table P17, T53, T67): that PC's own deadline, nothing when it holds nothing. */
export function JoinWait({ pc, hold, now }: { readonly pc: string; readonly hold: HoldState | undefined; readonly now?: number | undefined }) {
  if (hold === undefined) return null;
  return <HoldLine key={JSON.stringify([pc, hold.reason])} pc={pc} hold={hold} now={now} />;
}

function HoldLine({ pc, hold, now }: { readonly pc: string; readonly hold: HoldState; readonly now: number | undefined }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const until = hold.reason === "join_hold" ? hold.until : null;
  useEffect(() => {
    if (now !== undefined || until === null || hidden) return;
    const end = Date.parse(until);
    const tick = () => setClock(Date.now());
    tick();
    if (end <= Date.now()) return;
    const timer = setInterval(() => {
      tick();
      if (Date.now() >= end) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [hidden, now, until]);
  if (hidden) return null;
  const left = holdWaitMs(hold, now ?? clock);
  const line = left !== null ? t("{pc} opens in {seconds} s", { pc, seconds: Math.ceil(left / 1000) })
    : hold.reason === "join_hold" ? t("{pc} is telling your other devices first", { pc })
    : hold.reason === "frozen" ? t("{pc} holds this device after a Not me from another device", { pc })
    : t("{pc} is checking your account first", { pc });
  return (
    <div className="join-wait" role="status">
      <span>{line}</span>
      <button type="button" className="icon-button" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setHidden(true)}><X /></button>
    </div>
  );
}
