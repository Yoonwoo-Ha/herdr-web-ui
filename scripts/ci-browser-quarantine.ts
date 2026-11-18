/**
 * Browser scripts whose pass on the lane's second run still counts as a pass, each until its end
 * date (inclusive, UTC) and with an issue about it. Any other script that fails and
 * then passes when run again fails the lane (scripts/ci-browser-parallel.ts). An entry ends at most
 * QUARANTINE_MAX_DAYS ahead; once a script has stopped flaking, its entry goes.
 */
export interface QuarantineEntry {
  readonly until: string;
  readonly issue: number;
}

export const QUARANTINE_MAX_DAYS = 30;

export const QUARANTINE: Readonly<Record<string, QuarantineEntry>> = {
  "scripts/agent-lock-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/agent-skill-menu-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/agent-state-groups-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/application-paging-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/chat-history-browser-qa.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/chat-virtual-browser-qa.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/chat-working-line-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/docked-file-link-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/file-text-size-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/file-viewer-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/gjc-status-browser-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/inbox-mode-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/inbox-mode-rail-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/omo-question-wheel-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/pane-mute-captures-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/pane-mute-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/phone-glass-header-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/phone-worktree-sheet-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/prompt-dock-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/push-health-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/relay-dashboard-browser-qa.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/relay-media-browser-qa.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/relay-pairing-prompt-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/render-crash-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/reply-comments-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/settings-pages-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/settings-segmented-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/setup-dialog-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/sheet-outside-tap-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/sidebar-activity-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/sidebar-declutter-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/sidebar-filter-demo-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/sidebar-heads-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/sidebar-peek-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/terminal-arrows-clicks-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/terminal-autoswitch-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/terminal-cjk-punctuation-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/terminal-ghostty-demo-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/terminal-served-font-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/terminal-switch-resize-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/terminal-touch-burst-history-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/ui-access-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/ui-contexts-layout-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/ui-contexts-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/ui-ime-regression.ts": { until: "2026-12-02", issue: 4026 },
  "scripts/ui-regression.ts": { until: "2026-12-18", issue: 4026 },
  "scripts/web-panel-mobile-regression.ts": { until: "2026-12-02", issue: 4026 },
};
