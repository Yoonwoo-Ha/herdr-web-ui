/**
 * The tabs of the selected pane's workspace, above its pane, as herdr's own tab row: shown once
 * the workspace has more than one pane (a second tab, or a tab split in the TUI), with a `+`
 * that opens the New tab dialog. A tab opens the pane last viewed in it, else the one herdr has
 * focused there, else its first. The app shows one pane at a time, so a tab with several panes
 * carries a picker of them beside its name.
 *
 * A tab is renamed and closed here, as herdr's prefix+shift+t and prefix+shift+x. With a mouse:
 * an x on the tab under the pointer and on the open one, a double-click on the name to type a
 * new one, a right-click for the menu. On a touch screen the open tab's chevron opens the same
 * menu as a sheet. With keys: F2 and Delete on a focused tab. A close asks first only when it
 * costs more than the tab: an agent still at work in it, or the workspace's last tab.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, Pencil, Plus, Terminal, X } from "lucide-react";

import "./TabStrip.css";

import type { HerdrTab, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import { customTabLabel, tabLabel } from "../lib/tabName.ts";
import { STRIP_AT_REST, stripPlaced, stripScrolled, stripSelected, type StripScroll } from "../lib/tabStripScroll.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "../lib/paneRegion.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { knownStatus } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

/** the pane each tab was last seen on, per PC: a tab clicked again opens where it was left */
const lastViewed = new Map<string, string>();

export interface TabStripProps {
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  selectedPane: PaneInfo;
  onSelectPane: (paneId: string) => void;
  onNewTab: () => void;
  /** the panel the tabs control: each half of a split view has its own (lib/split.ts) */
  panelId?: string;
}

export function TabStrip({ snapshot, workspace, selectedPane, onSelectPane, onNewTab, panelId = PANE_TABPANEL_ID }: TabStripProps) {
  const t = useT();
  const machineId = useMachineId();
  const { closeTab, renameTab } = useMachineApi();
  const strip = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<{ anchor: HTMLElement; tab: HerdrTab } | null>(null);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  // the name just sent, shown until herdr's snapshot carries it
  const [sent, setSent] = useState<{ tabId: string; label: string } | null>(null);
  const [confirm, setConfirm] = useState<{ tab: HerdrTab; title: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the tab whose name field just went: its button takes the focus back in the same commit, so the next key lands on it
  const refocus = useRef<string | null>(null);
  // tabs whose close is on its way: a second press, or a held Delete, does not send another
  const closing = useRef(new Set<string>());
  // a close that herdr has done but the snapshot does not show yet: the closed tab, and the one beside it
  const closed = useRef<{ tabId: string; beside: string } | null>(null);
  // what is on screen now, for a close that answers after the selection or the PC has moved on
  const latest = useRef({ machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id });
  latest.current = { machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id };
  const panes = rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id), selectedPane.pane_id);
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).sort((a, b) => a.number - b.number);
  const nameOf = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : tabLabel(tab, t, tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1);

  useEffect(() => {
    lastViewed.set(`${machineId}:${selectedPane.tab_id}`, selectedPane.pane_id);
  }, [machineId, selectedPane.tab_id, selectedPane.pane_id]);

  // a picker, a name field or a question whose tab left (closed in the TUI) goes with it
  useEffect(() => {
    const here = (tabId: string): boolean => tabs.some((tab) => tab.tab_id === tabId);
    if (picker && !here(picker.tab.tab_id)) setPicker(null);
    if (editing && !here(editing.tabId)) setEditing(null);
    if (confirm && !here(confirm.tab.tab_id)) setConfirm(null);
    if (sent && tabs.find((tab) => tab.tab_id === sent.tabId)?.label.trim() === sent.label) setSent(null);
  });
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [editing]);
  // once the snapshot has lost a closed tab, the focus it held goes to the tab beside it, or,
  // when the strip went with it (one pane left), where a closed row's focus goes
  useLayoutEffect(() => {
    const was = closed.current;
    if (!was || tabs.some((tab) => tab.tab_id === was.tabId)) return;
    closed.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !strip.current?.contains(active)) return;
    const beside = strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(was.beside)}"]`);
    if (beside) beside.focus(); else focusWorkspaceListToggle();
  });
  // a name herdr never showed back (renamed again elsewhere) does not stay on the tab
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sent]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // the open tab is in view: a pane opened from the sidebar, the palette or an alert can be on a
  // tab scrolled out of a phone's strip. Only the strip scrolls, never the page around it.
  const shown = panes.length >= 2;
  const scroll = useRef<StripScroll>(STRIP_AT_REST);
  const bringOpenTab = (): void => {
    const row = strip.current;
    if (!row) { scroll.current = STRIP_AT_REST; return; }
    const open = row.querySelector<HTMLElement>(".tab-strip-item.is-active");
    if (!open) return;
    const view = row.getBoundingClientRect();
    const item = open.getBoundingClientRect();
    const end = row.querySelector<HTMLElement>(".tab-strip-add")?.getBoundingClientRect().left ?? view.right;
    const before = row.scrollLeft;
    if (item.left < view.left) row.scrollLeft -= view.left - item.left;
    else if (item.right > end) row.scrollLeft += item.right - end;
    // where the browser really left it; a strip that did not have to move may hold a scroll of
    // the user's whose event is still to come, and that one is left for the event to tell
    if (row.scrollLeft !== before || scroll.current.at === null) scroll.current = stripPlaced(scroll.current, row.scrollLeft);
  };
  useLayoutEffect(() => {
    scroll.current = stripSelected(scroll.current);
  }, [selectedPane.tab_id]);
  useLayoutEffect(bringOpenTab, [selectedPane.tab_id, tabs.length, shown]);
  // A face that arrives after that (lib/fontFaces.ts) redraws every name wider or narrower with
  // no tab added or opened, so the open tab is brought into view again for each: unless the user
  // has scrolled the strip themselves since a tab was last opened (lib/tabStripScroll.ts), and is
  // looking at other tabs. A chunk can come long after the page, with the first Korean on it.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    if (!scroll.current.moved) bringOpenTab();
  }, [faces]);
  const onScroll = (): void => {
    const row = strip.current;
    if (row) scroll.current = stripScrolled(scroll.current, row.scrollLeft, row.scrollWidth - row.clientWidth);
  };

  if (!shown) return null;

  const panesOf = (tab: HerdrTab): PaneInfo[] => panes.filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => {
    const own = panesOf(tab);
    const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
    return pick(lastViewed.get(`${machineId}:${tab.tab_id}`))
      ?? pick(snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id)
      ?? own.find((pane) => pane.focused)
      ?? own[0];
  };

  const focusTab = (tabId: string): void => {
    window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tabId)}"]`)?.focus());
  };

  const beginRename = (tab: HerdrTab): void => {
    setError(null);
    setEditing({ tabId: tab.tab_id, value: sent?.tabId === tab.tab_id ? sent.label : customTabLabel(tab, tabs.indexOf(tab) + 1) ?? "" });
  };
  // an empty name is not sent: herdr would keep it, and its own tab row would show nothing
  const saveRename = (tab: HerdrTab): void => {
    const label = editing?.value.trim() ?? "";
    refocus.current = tab.tab_id;
    setEditing(null);
    if (label === "" || label === nameOf(tab)) return;
    setSent({ tabId: tab.tab_id, label });
    void renameTab(tab.tab_id, label).catch((reason: unknown) => {
      setSent((current) => current?.tabId === tab.tab_id ? null : current);
      setError(t("Rename failed: {reason}", { reason: said(reason) }));
    });
  };

  // the tab beside a closed one takes its place: the open pane moves there, and the focus with it
  const close = async (tab: HerdrTab): Promise<void> => {
    const index = tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
    const beside = tabs[index + 1] ?? tabs[index - 1];
    if (closing.current.has(tab.tab_id)) return;
    closing.current.add(tab.tab_id);
    try { await closeTab(tab.tab_id); }
    finally { closing.current.delete(tab.tab_id); }
    // the answer may come after another tab, workspace or PC was picked: the open pane, and the focus, then stay
    if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
    // the last tab took its workspace, and the strip, with it: focus goes where a closed row's goes
    if (!beside) { focusWorkspaceListToggle(); return; }
    closed.current = { tabId: tab.tab_id, beside: beside.tab_id };
    const pane = paneFor(beside);
    if (latest.current.tabId === tab.tab_id && pane) onSelectPane(pane.pane_id);
    if (strip.current?.contains(document.activeElement) || document.activeElement === document.body) focusTab(beside.tab_id);
  };
  const requestClose = (tab: HerdrTab): void => {
    setError(null);
    const busy = panesOf(tab).some((pane) => { const status = knownStatus(pane.agent_status); return status === "working" || status === "blocked"; });
    if (tabs.length > 1 && !busy) {
      void close(tab).catch((reason: unknown) => setError(t("Close failed: {reason}", { reason: said(reason) })));
      return;
    }
    setConfirm({
      tab,
      title: t("Close tab {name}?", { name: nameOf(tab) }),
      body: tabs.length > 1
        ? t("An agent in it is still at work, and stops with the tab.")
        : t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: workspace.label }),
    });
  };

  // arrows move between the tabs; Enter or Space on one opens it, as any button; F2 names it, Delete closes it
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (event.key === "F2" || event.key === "Delete") {
      // a held key is one press: the focus moves to the tab beside a closed one
      if (event.repeat) { event.preventDefault(); return; }
      const tab = tabs.find((candidate) => candidate.tab_id === buttons[index]?.dataset["tabId"]);
      if (!tab) return;
      event.preventDefault();
      if (event.key === "F2") beginRename(tab); else requestClose(tab);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const openPicker = (event: MouseEvent<HTMLElement>, tab: HerdrTab): void => {
    setPicker(picker?.tab.tab_id === tab.tab_id ? null : { anchor: event.currentTarget, tab });
  };

  // a tab's menu: its panes when it has several, then its name and its close
  const pickerItems = (tab: HerdrTab): RowMenuItem[] => {
    // the tab may have changed under the open menu: the items act on what it is now
    const now = tabs.find((candidate) => candidate.tab_id === tab.tab_id) ?? tab;
    const own = panesOf(now);
    return [
      ...(own.length > 1 ? own.map((pane) => ({
        id: pane.pane_id,
        label: displayPaneTitle(pane),
        icon: Terminal,
        glyph: pane.agent ? <AgentMark agent={pane.agent} size={16} /> : undefined,
        current: pane.pane_id === selectedPane.pane_id,
        run: () => onSelectPane(pane.pane_id),
      })) : []),
      { id: "rename-tab", label: t("Rename tab"), icon: Pencil, divider: own.length > 1, run: () => beginRename(now) },
      { id: "close-tab", label: t("Close tab"), icon: X, danger: true, divider: true, run: () => requestClose(now) },
    ];
  };

  // the pane region every tab governs, as App names it. App gives that region the tabpanel role
  // only while the pane's own tab is in this snapshot (paneTabPanelLabel); the same call answers
  // here, so a tab never claims to control a panel that is not standing there as one.
  const panePanel = paneTabPanelLabel(snapshot, selectedPane, t) !== null ? panelId : undefined;
  return (
    <>
      <div ref={strip} className="tab-strip" role="tablist" aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} onKeyDown={onKeyDown} onScroll={onScroll}>
        {tabs.map((tab) => {
          const active = tab.tab_id === selectedPane.tab_id;
          const own = panesOf(tab);
          const status = knownStatus(tab.agent_status);
          const pickerOpen = picker?.tab.tab_id === tab.tab_id;
          const name = nameOf(tab);
          return (
            <div className={`tab-strip-item${active ? " is-active" : ""}${own.length > 1 ? " has-panes" : ""}${editing?.tabId === tab.tab_id ? " is-editing" : ""}`} key={tab.tab_id}>
              {editing?.tabId === tab.tab_id ? (
                <input
                  className="input tab-strip-rename"
                  aria-label={t("Tab name")}
                  autoFocus
                  size={Math.max(8, editing.value.length + 1)}
                  maxLength={80}
                  placeholder={name}
                  value={editing.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ tabId: tab.tab_id, value: event.target.value })}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    // an IME's Enter and Escape are the composition's, not the field's
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Enter") saveRename(tab);
                    if (event.key === "Escape") { refocus.current = tab.tab_id; setEditing(null); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  className="tab-strip-tab"
                  data-tab-id={tab.tab_id}
                  aria-selected={active}
                  aria-controls={panePanel}
                  tabIndex={active ? 0 : -1}
                  title={own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length })}
                  onClick={() => {
                    const pane = paneFor(tab);
                    if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
                  }}
                  onDoubleClick={() => beginRename(tab)}
                  // dragged over the pane area, the tab opens its pane in half of it (lib/split.ts)
                  draggable
                  onDragStart={(event) => {
                    const pane = paneFor(tab);
                    if (!pane) { event.preventDefault(); return; }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId: pane.pane_id }));
                  }}
                  onContextMenu={(event) => { event.preventDefault(); openPicker(event, tab); }}
                  // the middle button closes a tab, as it does a browser's
                  onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); requestClose(tab); } }}
                >
                  {(status === "working" || status === "blocked" || status === "done") && <span className="tab-strip-dot" data-status={status} aria-hidden="true" />}
                  <span className="tab-strip-label">{name}</span>
                </button>
              )}
              <button type="button" className="tab-strip-panes" aria-label={own.length > 1 ? t("Panes in {tab}", { tab: name }) : t("Actions for {tab}", { tab: name })} aria-haspopup="menu" aria-expanded={pickerOpen} onClick={(event) => openPicker(event, tab)}>
                <ChevronDown aria-hidden="true" />
              </button>
              <button type="button" className="tab-strip-close" aria-label={t("Close tab {name}", { name })} title={t("Close tab")} onClick={() => requestClose(tab)}>
                <X aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button type="button" className="tab-strip-add" aria-label={t("New tab")} title={t("New tab")} onClick={onNewTab}>
          <Plus aria-hidden="true" />
        </button>
        {error && <span className="tab-strip-error" role="alert">{error}</span>}
      </div>
      {picker && <RowMenu anchor={picker.anchor} title={panesOf(picker.tab).length > 1 ? t("Panes in {tab}", { tab: nameOf(picker.tab) }) : nameOf(picker.tab)} items={pickerItems(picker.tab)} align="start" onClose={() => setPicker(null)} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(confirm.tab); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </>
  );
}
