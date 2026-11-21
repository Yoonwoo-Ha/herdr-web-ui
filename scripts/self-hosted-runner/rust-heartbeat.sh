#!/usr/bin/env bash
# Rust runners' heartbeat (README "The Rust PTY host job"): while any runner carrying the label
# self-hosted-ovis-rust is online, sets the repository variable CI_RUST_RUNNER_SEEN to the current epoch
# seconds, which scripts/ci-runner-route.sh requires to be fresh before it sends the Rust PTY host job to
# those runners. Listing runners needs a token with administration access, which the workflow token lacks,
# so this runs outside Actions (a systemd user timer on the maintainer PC, every minute) with the
# maintainer's `gh`. No such runner online, or a failed call, writes nothing: the value ages and the
# route goes hosted.
set -euo pipefail

repo="${REPO:-devswha/ovis}"
label="${RUST_RUNNER_LABEL:-self-hosted-ovis-rust}"

online=$(gh api --paginate "repos/$repo/actions/runners?per_page=100" |
  jq -s --arg label "$label" '[.[].runners[] | select(.status == "online" and any(.labels[]; (.name | ascii_downcase) == $label))] | length')
if [[ "$online" == 0 ]]; then
  echo "no runner labelled $label is online: heartbeat not written" >&2
  exit 0
fi
gh variable set CI_RUST_RUNNER_SEEN --repo "$repo" --body "${HEARTBEAT_NOW:-$(date +%s)}"
