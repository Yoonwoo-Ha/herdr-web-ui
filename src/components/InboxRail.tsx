import { tally, usageCounters } from "../lib/usageCounters.ts";
import { Bell, BellOff, CircleHelp, Inbox, Monitor, Settings } from "lucide-react";

import { connectionWord, type HeaderConnection } from "../lib/headerConnection.ts";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import "./InboxRail.css";

export interface InboxRailProps {
  onExit(): void;
  onInbox(): void;
  waiting: { count: number; open(): void } | null;
  alerts: { on: boolean; title: string; toggle(): void };
  onSettings(): void;
  connection: HeaderConnection;
  saidByThread: boolean;
  shortcutTitle(label: string, id: "settings"): string;
}

export function InboxRail({ onExit, onInbox, waiting, alerts, onSettings, connection, saidByThread, shortcutTitle }: InboxRailProps) {
  const t = useT();
  const AlertsGlyph = alerts.on ? Bell : BellOff;
  // The same word is announced from a line that is in the document before it (lib/useAnnouncedText.ts):
  // a button's name is not read out when it changes.
  const dot = saidByThread ? null : connection;
  const announced = useAnnouncedText(dot === null ? null : connectionWord(dot, t));
  // the monitor stands for the main view's PCs: while their stream is lost its name says so, as its dot draws it
  const mainLabel = connection === "reconnecting" || connection === "failed" ? `${t("Back to main view")} · ${connectionWord(connection, t)}` : t("Back to main view");
  return (
    <nav className="inbox-rail" aria-label={t("Inbox mode")}>
      <div className="inbox-rail-group is-top">
        <button type="button" className="icon-button inbox-rail-item inbox-rail-place" aria-label={t("Agent inbox")} title={t("Agent inbox")} aria-current="page" onClick={() => { tally(() => usageCounters.count("inbox_rail_inbox")); onInbox(); }}>
          <Inbox aria-hidden="true" />
        </button>
      </div>
      {/* Settings is the rail's last button, as the sidebar's gear ends its foot; the main view is the one above it */}
      <div className="inbox-rail-group is-lower">
        {waiting !== null && (
          <button type="button" className="icon-button inbox-rail-item inbox-rail-waiting" aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={() => { tally(() => usageCounters.count("inbox_rail_waiting")); waiting.open(); }}>
            <CircleHelp aria-hidden="true" />
            <span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="icon-button inbox-rail-item inbox-rail-alerts" aria-label={t("Alerts")} title={alerts.title} aria-pressed={alerts.on} onClick={() => { tally(() => usageCounters.count("inbox_rail_alerts")); alerts.toggle(); }}>
          <AlertsGlyph aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-main" aria-label={mainLabel} title={mainLabel} onClick={onExit}>
          <Monitor aria-hidden="true" />
          {dot !== null && <span className={`inbox-rail-dot is-${dot}`} aria-hidden="true" />}
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-settings" aria-label={t("Settings")} title={shortcutTitle(t("Settings"), "settings")} onClick={() => { tally(() => usageCounters.count("inbox_rail_settings")); tally(() => usageCounters.count("settings_by_button")); onSettings(); }}>
          <Settings aria-hidden="true" />
        </button>
      </div>
      <p className="visually-hidden" role="status">{announced}</p>
    </nav>
  );
}

export function InboxRailBlank() {
  return <div className="inbox-rail" />;
}
