import { useState, type ReactNode, type Ref } from "react";
import { ChevronDown, ChevronRight, Monitor } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { serverIdOfPath, shellMode } from "../lib/shellMode.ts";

/**
 * Where a PC's folded header is kept: by its id, and in the hosted app also by the PC whose page this is, as every PC
 * there names its own machine "local".
 */
export function collapsedKey(machineId: string, page: { relayShell: boolean; pathname: string } = { relayShell: shellMode() === "relay", pathname: window.location.pathname }): string {
  const server = page.relayShell ? serverIdOfPath(page.pathname) : null;
  return server === null ? `ovis:pc-collapsed:${machineId}` : `ovis:pc-collapsed:${server}:${machineId}`;
}

/** A PC's fold, one for the sidebar and the agent inbox alike: folded in one, it is folded in the other. */
export function useMachineFold(machineId: string): [collapsed: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(collapsedKey(machineId)) === "1"; } catch { return false; } });
  const toggle = (): void => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(collapsedKey(machineId), collapsed ? "0" : "1"); } catch {}
  };
  return [collapsed, toggle];
}

export interface MachineHeaderProps {
  machine: Machine;
  folded: boolean;
  onToggle(): void;
  compact: boolean;
  agents: { count: number; words: string } | null;
  dot: { state: string; title: string } | null;
  current?: boolean;
  /** drawn in place of the name (the sidebar's rename field): the title is then no button */
  name?: ReactNode;
  titleRef?: Ref<HTMLButtonElement>;
  actions?: ReactNode;
  end?: ReactNode;
}

export function MachineHeader({ machine, folded, onToggle, compact, agents, dot, current = false, name, titleRef, actions, end }: MachineHeaderProps) {
  const t = useT();
  const foldLabel = folded ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name });
  const body = <>
    <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
    {name ?? <span className="machine-name" title={machine.name}>{machine.name}</span>}
    {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
    {machine.view_only === true && <span className="machine-kind">{t("View only")}</span>}
    {dot !== null && <span className={`machine-dot is-${dot.state}`} title={dot.title} aria-hidden="true" />}
  </>;
  return <header className={`machine-header${compact ? " is-compact" : ""}`}>
    {name !== undefined
      ? <div className="machine-title">{body}</div>
      : <button ref={titleRef} type="button" className={`machine-title${current ? " is-current" : ""}`} aria-expanded={!folded} aria-label={foldLabel} title={machine.name} aria-current={current ? "true" : undefined} onClick={onToggle}>{body}</button>}
    {agents !== null && <span className="machine-agent-count"><span aria-hidden="true">{agents.count}</span><span className="visually-hidden">{agents.words}</span></span>}
    {actions}
    <button className="sidebar-row-action machine-toggle" tabIndex={-1} aria-hidden="true" aria-expanded={!folded} aria-label={foldLabel} title={foldLabel} onClick={onToggle}>{folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
    {end}
  </header>;
}
