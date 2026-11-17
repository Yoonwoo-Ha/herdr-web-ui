#!/usr/bin/env bash
# stays on ubuntu-24.04. "Room" is counted from the Actions API, since the workflow token cannot
# list runners: CI_SELF_HOSTED_CAPACITY (default 10) minus the queued and running jobs of every
# workflow that could take those runners must leave at least the jobs one run needs. When that count
# fails, the pull request stays hosted. Setting the variable to labels sends every pull request to
set -euo pipefail

hosted='"ubuntu-24.04"'
default_labels='["self-hosted","self-hosted-ovis"]'
event="${EVENT_NAME:-}"
requested="${REQUESTED_LABELS:-}"
configured="${CONFIGURED_LABELS:-}"
configured_from=CI_SELF_HOSTED_LABELS
if [[ ("$event" == pull_request || ("$event" == push && "${REF:-}" == refs/heads/*)) && -n "${LINUX_LABELS:-}" && -n "${LINUX_LABELS//[[:space:]]/}" ]]; then
  configured=$LINUX_LABELS
  configured_from=CI_LINUX_SELF_HOSTED_LABELS
fi
main_configured="${MAIN_LABELS:-}"
capacity="${SELF_HOSTED_CAPACITY:-}"
linux_jobs=6

choose_labels() {
  local source="$1" value="$2" compact
  if ! compact=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$value" 2>/dev/null); then
    echo "::error::$source must be a JSON array of strings that contains \"self-hosted\", got: $value" >&2
    exit 1
  fi
  echo "Runner: self-hosted $compact (from $source)" >&2
  echo "linux=$compact"
}

pool_labels='["self-hosted","linux","x64","self-hosted-ovis"]'
light_job_names='["Detect changes","herdr-core live contract","Integration and browser","Pull request title","bundle-windows"]'

# hosted fallback is printed well inside Detect changes' five minutes; each attempt is bounded by a
# minute or what is left, with timeout or gtimeout where there is one (stock macOS has neither: there
# an attempt is unbounded, and only the shared budget stops further ones).
API_BUDGET=240
bound=""
if command -v timeout >/dev/null 2>&1; then bound=timeout
elif command -v gtimeout >/dev/null 2>&1; then bound=gtimeout
fi
api() {
  local out errors left
  errors=$(mktemp)
  for _ in 1 2 3; do
    left=$((API_BUDGET - SECONDS))
    if [ "$left" -le 0 ]; then break; fi
    if [ "$left" -gt 60 ]; then left=60; fi
    if out=$(${bound:+$bound "$left"} gh api --paginate "$1" 2>"$errors"); then rm -f "$errors"; printf '%s\n' "$out"; return 0; fi
    cat "$errors" >&2
    if grep -q 'HTTP 4[0-9][0-9]' "$errors"; then break; fi
  done
  rm -f "$errors"
  return 1
}

busy_jobs() {
  local limit="$1" ids id jobs n total=0
  ids=$(for status in in_progress queued; do
    api "repos/$REPOSITORY/actions/runs?status=$status&per_page=100" | jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    jobs=$(api "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || return 1
    n=$(jq -s -e --argjson pool "$pool_labels" --argjson light "$light_job_names" '[.[].jobs[] | select(.status != "completed" and (.name as $name | $light | index($name)) == null)
      | [.labels[] | ascii_downcase] | select(index("self-hosted") != null and all(.[]; . as $x | $pool | index($x) != null))]
      | length' <<<"$jobs") || return 1
    total=$((total + n))
    if (( total > limit )); then break; fi
  done
  echo "$total"
}

route_pull_request() {
  local busy
  if [[ -z "${capacity//[[:space:]]/}" ]]; then
    capacity=10
  elif ! [[ "$capacity" =~ ^[0-9]{1,4}$ ]]; then
    echo "::error::repository variable CI_SELF_HOSTED_CAPACITY must be a whole number, got: $capacity" >&2
    exit 1
  fi
  capacity=$((10#$capacity))
  if ! busy=$(busy_jobs $((capacity - linux_jobs))); then
    echo "::warning::could not count the self-hosted runners' jobs; using ubuntu-24.04" >&2
    echo "linux=$hosted"
  elif (( capacity - busy >= linux_jobs )); then
    echo "Runner: self-hosted $default_labels ($busy of $capacity busy, pull request)" >&2
    echo "linux=$default_labels"
  else
    echo "Runner: ubuntu-24.04 (at least $busy of $capacity self-hosted busy, pull request)" >&2
    echo "linux=$hosted"
  fi
}

route_linux() {
if [[ "${HOSTED_ONLY:-}" == true ]]; then
  echo "Runner: ubuntu-24.04 (called with hosted_only)" >&2
  echo "linux=$hosted"
elif [[ ("$event" == "pull_request" || "$event" == "pull_request_target") && "${HEAD_REPO:-}" != "${REPOSITORY:-}" ]]; then
  echo "Runner: ubuntu-24.04 (pull request from fork ${HEAD_REPO:-unknown})" >&2
  echo "linux=$hosted"
elif [[ -n "${requested//[[:space:]]/}" ]]; then
  choose_labels "workflow_dispatch input self_hosted_labels" "$requested"
elif [[ "${configured//[[:space:]]/}" == "$hosted" ]]; then
  echo "Runner: ubuntu-24.04 (from repository variable $configured_from)" >&2
  echo "linux=$hosted"
elif [[ "$event" == push && "${REF:-}" == refs/heads/main && -n "${main_configured//[[:space:]]/}" ]]; then
  if [[ "${main_configured//[[:space:]]/}" == "$hosted" ]]; then
    echo "Runner: ubuntu-24.04 (push to main, from repository variable CI_MAIN_SELF_HOSTED_LABELS)" >&2
    echo "linux=$hosted"
  else
    choose_labels "repository variable CI_MAIN_SELF_HOSTED_LABELS" "$main_configured"
  fi
elif [[ -n "${configured//[[:space:]]/}" ]]; then
  choose_labels "repository variable $configured_from" "$configured"
elif [[ "$event" == push ]]; then
  choose_labels "default for $event (CI_SELF_HOSTED_LABELS unset)" "$default_labels"
elif [[ "$event" == pull_request ]]; then
  route_pull_request
else
  echo "Runner: ubuntu-24.04 ($event, CI_SELF_HOSTED_LABELS unset)" >&2
  echo "linux=$hosted"
fi
}

line=$(route_linux)
echo "$line"
linux=${line#linux=}
fast=$linux
fast_labels="${FAST_LABELS:-}"
if [[ ("$event" == pull_request || "$event" == push) && "$linux" == *'"ovis-vm"'* && -n "${fast_labels//[[:space:]]/}" ]]; then
  if chosen=$(jq -ce 'if type == "array" and length > 0 and all(.[]; type == "string") and any(.[]; . == "self-hosted") then . else error("invalid") end' <<<"$fast_labels" 2>/dev/null); then
    echo "Fast checks: self-hosted $chosen (from repository variable CI_FAST_SELF_HOSTED_LABELS)" >&2
    fast=$chosen
  else
    echo "::warning::repository variable CI_FAST_SELF_HOSTED_LABELS must be a JSON array of strings that contains \"self-hosted\", got: $fast_labels; Fast checks follow the Linux jobs" >&2
  fi
fi
echo "fast=$fast"
