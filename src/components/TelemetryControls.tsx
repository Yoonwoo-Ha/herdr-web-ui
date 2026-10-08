import { useEffect, useState } from "react";

import type { TelemetryStatus } from "../../shared/telemetry.ts";
import { changeTelemetry, fetchTelemetry } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

/**
 * The one-time line about anonymous install and update counts. Showing it is what lets the
 * server send (shared/telemetry.ts), so it is recorded once it has been painted in a visible
 * tab, and the server still waits a while before the first event so Turn off here stops it.
 * Closing it only hides it in this tab.
 */
export function TelemetryNotice({ enabled, onOpen }: { enabled: boolean; onOpen: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [closed, setClosed] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [offFailed, setOffFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetchTelemetry().then((status) => {
      if (live && status && !status.notice_seen && status.enabled && !status.blocked_by_env) setShown(true);
    }, (error: unknown) => console.error("telemetry status", error));
    return () => { live = false; };
  }, [enabled]);
  useEffect(() => {
    if (!shown) return;
    let recorded = false;
    let frame = 0;
    // two frames after the commit the line has been painted; a hidden tab paints nothing
    const afterPaint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(record); });
    };
    const record = () => {
      if (recorded || document.visibilityState !== "visible") return;
      recorded = true;
      changeTelemetry({ notice_seen: true }).catch((error: unknown) => console.error("telemetry notice", error));
    };
    const onVisibility = () => { if (document.visibilityState === "visible") afterPaint(); };
    afterPaint();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { recorded = true; cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", onVisibility); };
  }, [shown]);
  if (!shown || closed) return null;
  const turnOff = () => {
    setTurningOff(true);
    setOffFailed(false);
    // the line stays until the server has the switch off, so a failure is seen and can be retried
    changeTelemetry({ enabled: false }).then(() => setClosed(true), (error: unknown) => {
      console.error("telemetry off", error);
      setOffFailed(true);
    }).finally(() => setTurningOff(false));
  };
  return <div className="update-notice" role="status">
    <span>{t("herdr web ui sends an anonymous count when it is installed and updated: the version, the OS and a random ID. Nothing else.")}</span>
    {offFailed && <span role="alert">{t("Could not turn it off. Try again.")}</span>}
    <button type="button" className="btn btn-ghost" onClick={() => { setClosed(true); onOpen(); }}>{t("What is sent")}</button>
    <button type="button" className="btn btn-ghost" onClick={turnOff} disabled={turningOff}>{t("Turn off")}</button>
    <button type="button" className="btn btn-ghost" onClick={() => setClosed(true)}>{t("Dismiss")}</button>
  </div>;
}

/** Settings → About: the switch and the event as it would be sent. Hidden on a server that sends none. */
export function TelemetryControls() {
  const t = useT();
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    fetchTelemetry().then((next) => { if (live) setStatus(next); }, (failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { live = false; };
  }, []);
  if (!status) return error ? <p className="settings-item settings-hint" role="alert">{error}</p> : null;
  const toggle = (enabled: boolean) => {
    // one change at a time: two answers out of order would leave the switch showing what the server does not hold
    if (saving) return;
    setSaving(true);
    setError(null);
    changeTelemetry({ enabled }).then(setStatus, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))).finally(() => setSaving(false));
  };
  return (
    <SettingsGroup title={t("Anonymous usage counts")} className="settings-telemetry">
      {status.blocked_by_env
        ? <p className="settings-item settings-hint">{t("Turned off on this PC by HERDR_WEB_TELEMETRY=0, DO_NOT_TRACK or a CI environment.")}</p>
        : <SettingsRow label={t("Send install and update counts")} description={t("Once when the app is installed and once per update. No IP address is stored, and nothing about your terminals, agents or files is sent.")}>
          <Toggle label={t("Send install and update counts")} checked={status.enabled} onChange={toggle} disabled={saving} />
        </SettingsRow>}
      {error && <p className="settings-item settings-hint" role="alert">{error}</p>}
      <details className="settings-item">
        <summary>{t("What is sent")}</summary>
        {status.next
          ? <pre className="update-output">{JSON.stringify(status.next, null, 2)}</pre>
          : <p className="settings-hint">{t("This version has already been counted. The next event is sent after an update.")}</p>}
      </details>
    </SettingsGroup>
  );
}
