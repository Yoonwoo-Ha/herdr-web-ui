#!/usr/bin/env bash
# The browser lane of CI: the lockfile's Playwright Chromium, then the scripts that drive it.
# BROWSER_PARALLEL=1: run scripts concurrently (see ci-browser-parallel.ts)
# BROWSER_WORKERS: worker count for parallel mode (default: min(cores/2, 6))
set -euo pipefail

if [ "${BROWSER_PARALLEL:-}" = "1" ]; then
  exec bun scripts/ci-browser-parallel.ts
fi
timings=""
HERDR_DEMO_BUILD=""
finish() {
  local code=$?
  # Reporting or cleanup must not replace the lane's exit code.
  set +e
  printf '\nBrowser script summary\n%-60s %7s %5s\n' "script" "seconds" "exit"
  printf '%s' "$timings"
  printf 'Browser lane total: seconds=%s exit=%s\n' "$SECONDS" "$code"
  if [ -n "$HERDR_DEMO_BUILD" ]; then rm -rf "$HERDR_DEMO_BUILD"; fi
  exit "$code"
}
trap finish EXIT

run_script() {
  local started=$SECONDS code=0 evidence="${UI_EVIDENCE_DIR:-}"
  if [ -n "${CI:-}${CHECK_DIR:-}" ]; then
    # These evidence branches add viewport changes, assertions or font waits, not just captures.
    case "$1" in
      scripts/ui-regression.ts|scripts/key-bar-customization-demo-regression.ts) evidence="";;
    esac
  fi
  UI_EVIDENCE_DIR="$evidence" bun "$@" || code=$?
  local seconds=$((SECONDS - started))
  printf 'TIMING %s seconds=%s exit=%s\n' "$1" "$seconds" "$code"
  timings="${timings}$(printf '%-60s %7s %5s' "$1" "$seconds" "$code")"$'\n'
  return "$code"
}

if [ -n "${CI:-}${CHECK_DIR:-}" ]; then
  export UI_EVIDENCE_DIR="${CHECK_DIR:-.ci}/browser-evidence"
  export CHECK_BROWSER_EVIDENCE_DIR="${CHECK_DIR:-.ci}/browser-evidence"
  mkdir -p "$UI_EVIDENCE_DIR" "$CHECK_BROWSER_EVIDENCE_DIR"
fi
# CI's runner image has none of Chromium's system libraries; a PC is not asked for sudo
if [ -n "${CI:-}" ]; then
  # as root, so a timed-out attempt's apt can be killed (an unprivileged timeout cannot SIGKILL root's apt)
  sudo bash scripts/ci-bounded-retry.sh 300 "$(command -v bun)" node_modules/playwright-core/cli.js install-deps chromium
  bun node_modules/playwright-core/cli.js install chromium
else
  bun node_modules/playwright-core/cli.js install chromium
fi
CHROME_PATH="$(bun -e 'console.log(require("playwright-core").chromium.executablePath())')"
export CHROME_PATH
# The demo scripts below all show the same client: it is built once here and each copies it
# (scripts/demo-build.ts), instead of each building it again.
HERDR_DEMO_BUILD="$(mktemp -d)"
export HERDR_DEMO_BUILD
run_script scripts/demo-build.ts "$HERDR_DEMO_BUILD"
run_script scripts/ui-regression.ts
run_script scripts/workspace-rows-regression.ts
run_script scripts/pending-pane-switch-regression.ts
run_script scripts/terminal-dispose-browser-qa.ts
run_script scripts/sticky-modifiers-regression.ts
run_script scripts/terminal-arrows-clicks-regression.ts
run_script scripts/terminal-viewport-regression.ts
run_script scripts/key-bar-customization-demo-regression.ts
run_script scripts/key-bar-hold-repeat-regression.ts
run_script scripts/settings-pages-demo-regression.ts
run_script scripts/deep-link-demo-regression.ts
run_script scripts/chat-history-browser-qa.ts
run_script scripts/chat-fallback-browser-qa.ts
run_script scripts/grok-chat-browser-qa.ts
run_script scripts/agy-chat-browser-qa.ts
run_script scripts/math-browser-qa.ts
run_script scripts/file-viewer-regression.ts
run_script scripts/file-preview-text-browser-qa.ts
run_script scripts/keyboard-viewport-regression.ts
run_script scripts/file-viewer-mobile-regression.ts
run_script scripts/droplet-demo-regression.ts
run_script scripts/chat-greeting-demo-regression.ts
run_script scripts/restored-draft-demo-regression.ts
run_script scripts/composer-fit-demo-regression.ts
run_script scripts/held-rows-demo-regression.ts
run_script scripts/sidebar-activity-demo-regression.ts
run_script scripts/sidebar-spacing-demo-regression.ts
run_script scripts/workspace-touch-reorder-demo-regression.ts
run_script scripts/prompt-dock-demo-regression.ts
run_script scripts/plugin-actions-demo-regression.ts
run_script scripts/palette-machines-demo-regression.ts
run_script scripts/narrow-pane-demo-regression.ts
run_script scripts/touch-long-press-demo-regression.ts
run_script scripts/phone-split-grid-demo-regression.ts
run_script scripts/recent-folders-regression.ts
run_script scripts/preferences-sync-regression.ts
run_script scripts/machine-dialog-regression.ts
run_script scripts/machine-conflict-regression.ts
run_script scripts/herdr-profiles-browser-qa.ts
