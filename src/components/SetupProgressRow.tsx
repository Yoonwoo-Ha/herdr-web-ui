import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, FolderPlus, Palette, Smartphone, X } from "lucide-react";
import { browserStorage as storage, hideSetupRow, SETUP_ROW_KEY, setupRowState } from "../lib/firstHints.ts";
import { useT } from "../lib/i18n.ts";
import { setupLeft, type SetupFacts } from "../lib/setupGuideFlow.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import "./SetupProgressRow.css";

/** What each part left opens on its own: a new workspace, Add a connection on the Ovis relay tab, alerts turned on. */
export interface SetupActions {
  readonly workspace: () => void;
  readonly phone: () => void;
  readonly alerts: () => void;
}

/**
 * The sidebar's setup reminder: a checklist of the guide's parts, each one left opening its own setting directly, the
 * done ones ticked and inert; never the whole guide again. Its X hides it for good.
 */
export function SetupProgressRow({ facts, actions }: { facts: SetupFacts; actions: SetupActions }) {
  const t = useT();
  const [hidden, setHidden] = useState(() => { const store = storage(); return store === null || setupRowState(store) !== "on"; });
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === SETUP_ROW_KEY || event.key === null) { const store = storage(); setHidden(store === null || setupRowState(store) !== "on"); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const left = setupLeft(facts);
  if (hidden || left.at === null) return null;
  const count = left.total - left.done;
  const hide = (): void => {
    setHidden(true);
    const store = storage();
    if (store !== null) hideSetupRow(store);
  };
  const part = (id: string, label: string, icon: RowMenuItem["icon"], done: boolean, run: () => void): RowMenuItem =>
    ({ id, label, icon, checked: done, ...(done ? { disabled: true } : {}), run });
  const items = [
    part("workspace", t("Open a workspace"), FolderPlus, facts.workspace, actions.workspace),
    // the guide's theme step is done by its default theme
    part("theme", t("Choose a theme"), Palette, true, () => {}),
    part("phone", t("Connect your phone"), Smartphone, facts.phone, actions.phone),
    part("alerts", t("Turn on alerts"), Bell, facts.alerts, actions.alerts),
  ];
  return (
    <div className="setup-row">
      <button ref={button} type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc setup-row-open" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <svg className="setup-row-ring" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" pathLength={left.total} />
          <circle className="is-done" cx="8" cy="8" r="6.5" pathLength={left.total} strokeDasharray={`${left.done} ${left.total}`} />
        </svg>
        <span className="sidebar-footer-pc-name">{t("Setup: {count} left", { count })}</span>
      </button>
      <button type="button" className="icon-button setup-row-hide" aria-label={t("Hide setup reminder")} title={t("Hide setup reminder")} onClick={hide}><X aria-hidden="true" /></button>
      {open && button.current !== null && <RowMenu anchor={button.current} title={t("Setup: {count} left", { count })} align="start" items={items} onClose={close} />}
    </div>
  );
}
