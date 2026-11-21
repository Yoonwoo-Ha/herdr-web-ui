#!/usr/bin/env bash
# winvm-runner.sh [--once]: winvm's runner for ci.yml's Native Windows install (README "Windows runner (winvm)").
# Runs on the maintainer's PC, beside the `winvm` command, as user unit ovis-winvm-runner; one copy at a time (a lock
# file). Each round, one job:
#   1. takes the winvm lease and keeps it while it runs: a lane that holds the VM keeps the runner off (CI then takes
#      windows-latest), and a lane that wants the VM stops this unit first;
#   2. fences the VM (winvm-fence.ps1 -IncludeOwn over ssh: the other repositories' runner services kept in its
#      snapshot are stopped, each once it is not in a job, and a job of this runner still running counts too) and only
#      on its answer "FENCE 0 0", `winvm reset` and `winvm start`: every job starts from the snapshot. Without that
#      answer it resets nothing and tries again later. A fence that stopped a service has touched the VM;
#   3. fences the VM again, as the reset started those services again: they stay stopped for the round. Then copies the
#      newest actions/runner package and this folder's winvm-*.ps1 into the VM, and registers one ephemeral
#      runner (labels self-hosted, self-hosted-ovis-win) in the VM's desktop session through Invoke-InSession, as the
#      Windows checks need; the registration token goes over ssh's stdin into a file the VM script deletes;
#   4. while that runner listens and no other runner in the VM is in a job, writes the Unix time into the repository
#      variable CI_WINVM_READY every minute, which ci-runner-route.sh reads; a job's start sets it to 0.
# An idle runner is recycled after 100 minutes (Invoke-InSession ends its task after two hours). A stop waits for a job
# in progress; an idle runner first clears the mark and waits for a job a route sent before (a route takes a mark up
# to three minutes old, and its Detect changes job ends within five), then is deleted, which GitHub refuses while it
# is in a job. A session that does not listen within 10 minutes is ended. Before it ends, a stop waits until every
# route that could have read the last offer has queued its job, then reads the queue: a job queued for winvm's
# label, or a queue it cannot read, gets another round (three at most; then it fails). Then, if it touched the VM,
# it fences and resets it, and releases the lease. When the VM cannot be fenced and reset, or the lease not
# released, the lease stays held and the script fails, so a lane sees it.
# --once: one round, then the same stop; it fails when that round failed.
set -uo pipefail
REPO=${OVIS_WINVM_REPO:-devswha/ovis}
NAME=ovis-winvm
LABEL=self-hosted-ovis-win
LEASE=ci-winvm-runner
VAR=CI_WINVM_READY
HERE=$(cd "$(dirname "$0")" && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/winvm-runner
VM_DIR='C:\ProgramData\winvm\ovis-runner'
IDLE_LIMIT=6000
LISTEN_LIMIT=600
# ci-runner-route.sh takes a mark up to this old; a route's Detect changes job ends within five minutes (DRAIN)
MARK_AGE=180
DRAIN=330
once=0
failed=0
capped=0
[ "${1:-}" = --once ] && once=1
mkdir -p "$CACHE"
exec 9>"$CACHE/launcher.lock"
flock -n 9 || { echo "winvm-runner.sh: another copy runs (the unit ovis-winvm-runner?)" >&2; exit 1; }
RUN=$(mktemp -d "$CACHE/run.XXXXXX")
log() { echo "$(date -Is) $*"; }
mark() { gh variable set "$VAR" --repo "$REPO" --body "$1" >/dev/null 2>&1 || log "could not set $VAR to $1"; }
vm() { ssh -o BatchMode=yes -o ConnectTimeout=10 winvm "$@" 2>/dev/null; }
stopping() { [ -e "$RUN/stop" ]; }
pause() { local i; for ((i = 0; i < $1; i++)); do stopping && return 1; sleep 1; done; }

# the newest actions/runner for Windows x64 in the cache; prints its version
runner_package() {
  local tag version file
  tag=$(gh api repos/actions/runner/releases/latest --jq .tag_name) || return 1
  version=${tag#v}
  file=$CACHE/actions-runner-win-x64-$version.zip
  if [ ! -f "$file" ]; then
    curl -fsSL -o "$file.part" "https://github.com/actions/runner/releases/download/$tag/actions-runner-win-x64-$version.zip" || return 1
    mv "$file.part" "$file"
    find "$CACHE" -name 'actions-runner-win-x64-*.zip' ! -name "${file##*/}" -delete
  fi
  echo "$version"
}

# how many Runner.Worker processes of the other repositories' runners the VM has; fails when it does not answer
foreign_workers() {
  local n
  n=$(vm "@(Get-Process Runner.Worker -ErrorAction SilentlyContinue | Where-Object Path -notlike 'C:\\actions-runners\\ovis-win\\*').Count") || return 1
  n=${n//[[:space:]]/}
  [[ $n =~ ^[0-9]+$ ]] && echo "$n"
}

# winvm offered to the route: only while no other runner in it is in a job; the time it was last offered kept
offer() {
  local n
  if ! stopping && [ ! -e "$RUN/job" ] && n=$(foreign_workers) && [ "$n" = 0 ]; then
    date +%s >"$RUN/offered"
    mark "$(date +%s)"
    [ -e "$RUN/job" ] && mark 0
  else
    mark 0
  fi
}

# Waits until every route that could have read the last offer has queued its job: a route takes a mark up to
# MARK_AGE old, and its Detect changes job ends within DRAIN.
routes_wait() {
  local offered left
  offered=$(cat "$RUN/offered" 2>/dev/null || echo 0)
  left=$(( offered + MARK_AGE + DRAIN - $(date +%s) ))
  if (( left > 0 )); then
    log "waiting ${left}s for a job a route sent before winvm was last offered"
    sleep "$left"
  fi
}

# A reset must not kill another runner's job, nor one it takes right before, nor this runner's own job (the ssh that
# watched it can end while it goes on). fence_vm <seconds> [stop]: 0 once the VM is off, or winvm-fence.ps1
# -IncludeOwn answered "FENCE 0 0" (no other runner service left to take a job, no job running); 1 after <seconds>
# without that (or at a stop, with "stop"). A service it stopped stays stopped until a reset: the VM is touched.
fence_vm() {
  local state out rc answer waited=0 script
  script=$({ printf '& {\n'; cat "$HERE/winvm-fence.ps1"; printf '\n} -IncludeOwn\n'; } | iconv -f UTF-8 -t UTF-16LE | base64 -w 0) || return 1
  while :; do
    state=$(winvm status | head -1)
    [ "$state" = "shut off" ] && return 0
    answer=
    if [ "$state" = running ]; then
      out=$(vm "pwsh -NoProfile -EncodedCommand $script" </dev/null)
      rc=$?
      if grep -q '^Stopped ' <<<"$out"; then touch "$RUN/touched"; fi
      (( rc == 0 )) && answer=$(tail -n 1 <<<"$out" | tr -d '\r')
      [ "$answer" = "FENCE 0 0" ] && return 0
    fi
    if (( waited % 300 == 0 )); then log "winvm is ${state:-unknown}, ${answer:-no answer}; not resetting yet"; fi
    if (( waited >= $1 )) || { [ "${2:-}" = stop ] && stopping; }; then return 1; fi
    sleep 30; waited=$((waited + 30))
  done
}

# how many jobs that name winvm's label wait for a runner
queued_jobs() {
  local ids id total=0 n
  ids=$(for status in queued in_progress; do
    gh api --paginate "repos/$REPO/actions/runs?status=$status&per_page=100" --jq '.workflow_runs[].id' || exit 1
  done) || return 1
  for id in $ids; do
    n=$(gh api --paginate "repos/$REPO/actions/runs/$id/jobs?filter=latest&per_page=100" \
      --jq "[.jobs[] | select(.status == \"queued\" and (.labels | index(\"$LABEL\")))] | length" | awk '{s += $1} END {print s + 0}') || return 1
    total=$((total + n))
  done
  echo "$total"
}
runner_id() { gh api --paginate "repos/$REPO/actions/runners" --jq ".runners[] | select(.name == \"$NAME\") | .id"; }

# While the runner listens: the mark every minute (0 while another runner in the VM is in a job), the lease renewed.
# An idle runner is recycled and a stop drains it: the mark cleared, a wait for a job a route sent before, then the
# registration deleted, which GitHub refuses for a runner in a job (that job then goes on).
heartbeat() {
  local ssh_pid=$1 since=$SECONDS id
  while kill -0 "$ssh_pid" 2>/dev/null; do
    if [ ! -e "$RUN/listening" ] && (( SECONDS - since > LISTEN_LIMIT )); then
      log "runner $NAME did not listen within $((LISTEN_LIMIT / 60)) minutes; ending its session"
      kill "$ssh_pid" 2>/dev/null
      return
    fi
    if [ -e "$RUN/listening" ] && [ ! -e "$RUN/job" ]; then
      if stopping || (( SECONDS - since > IDLE_LIMIT )); then
        mark 0
        # the session this ends counts as a round that went well, unless a job came
        touch "$RUN/drained"
        log "no new job routes here now"
        routes_wait
        for _ in 1 2 3; do
          [ -e "$RUN/job" ] && break
          if id=$(runner_id) && [ -n "$id" ] && gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1; then
            log "no job came; runner $NAME deleted"
            break
          fi
          sleep 20
        done
        # GitHub refuses the delete of a runner in a job: that job goes on. Any other refusal ends the listener anyway;
        # a job given to it right then is queued again, and the stop serves it (main loop)
        if [ ! -e "$RUN/job" ]; then
          vm "Get-Process Runner.Listener -ErrorAction SilentlyContinue | Where-Object Path -like 'C:\\actions-runners\\ovis-win\\*' | Stop-Process -Force"
          kill "$ssh_pid" 2>/dev/null
        fi
        return
      fi
      offer
      winvm lease "$LEASE" >/dev/null
    fi
    sleep 60
  done
}

round() {
  local version token ssh_pid beat_pid busy rc desktop=0
  until busy=$(winvm lease "$LEASE"); do
    log "$busy"
    (( once )) && return 0
    pause 60 || return 0
  done
  touch "$RUN/leased"
  version=$(runner_package) || { log "could not fetch the actions/runner package"; return 1; }
  if ! fence_vm 3600 stop; then
    stopping || log "winvm was not shown free of jobs; not resetting it, trying again later"
    return 1
  fi
  touch "$RUN/touched"
  winvm reset >/dev/null && winvm start >/dev/null || { log "winvm reset/start failed"; return 1; }
  for _ in $(seq 100); do
    if vm "if (Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\devswha') { 'UP' }" | grep -q UP; then desktop=1; break; fi
    sleep 3
  done
  (( desktop )) || { log "winvm's desktop session did not come up"; return 1; }
  # the reset started the other repositories' runner services again: fenced for the whole round, so none takes a job
  # between an offer and this runner's job (the hook would wait for it and fail the required check)
  if ! fence_vm 3600 stop; then
    stopping || log "winvm's other runners were not fenced after the reset; not registering, trying again later"
    return 1
  fi
  vm "New-Item -ItemType Directory -Force -Path '$VM_DIR' | Out-Null" || { log "ssh winvm failed"; return 1; }
  scp -q -o BatchMode=yes "$CACHE/actions-runner-win-x64-$version.zip" "$HERE/winvm-runner.ps1" "$HERE/winvm-job-started.ps1" "$HERE/winvm-fence.ps1" \
    "winvm:${VM_DIR//\\//}/" 2>/dev/null || { log "copying into winvm failed"; return 1; }
  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token) || { log "no registration token"; return 1; }
  printf '%s\n' "$token" | vm "pwsh -NoProfile -Command \"[Console]::In.ReadLine() | Set-Content -NoNewline -LiteralPath '$VM_DIR\\token'\"" \
    || { log "could not hand the token over"; return 1; }
  unset token
  rm -f "$RUN/listening" "$RUN/job" "$RUN/drained"
  : >"$RUN/out"
  ssh -o BatchMode=yes winvm "pwsh -File C:\\ProgramData\\winvm\\Invoke-InSession.ps1 -Command '& $VM_DIR\\winvm-runner.ps1 -Version $version -Repository $REPO -Name $NAME'" \
    >"$RUN/out" 2>&1 </dev/null &
  ssh_pid=$!
  heartbeat "$ssh_pid" &
  beat_pid=$!
  while IFS= read -r line; do
    echo "winvm| $line"
    case $line in
      *"Listening for Jobs"*)
        touch "$RUN/listening"
        offer
        log "runner $NAME listens (runner $version)" ;;
      *"Running job:"*) touch "$RUN/job"; mark 0 ;;
    esac
  done < <(tail -n +1 -f --pid="$ssh_pid" "$RUN/out")
  wait "$ssh_pid"
  rc=$?
  log "runner $NAME ended ($rc)"
  kill "$beat_pid" 2>/dev/null
  wait "$beat_pid" 2>/dev/null
  mark 0
  # a session the drain ended went well; any other failure (one that never listened, a dropped ssh) is a failed round
  (( rc == 0 )) || { [ -e "$RUN/drained" ] && [ ! -e "$RUN/job" ]; }
}

# Leaves the VM as a lane expects it: reset to the snapshot and running if a round touched it, no runner of this
# script registered, the lease free. Ownership is this run's own record, not a status read. Without a fenced VM
# within 10 minutes (another repository's job still running, so the stop stays inside the unit's TimeoutStopSec),
# a successful reset or a successful release, it keeps what it holds and fails.
cleanup() {
  local id ok=0
  mark 0
  if [ -e "$RUN/leased" ]; then
    if [ -e "$RUN/touched" ] && ! { fence_vm 600 && winvm reset >/dev/null && winvm start >/dev/null; }; then
      ok=1
      log "winvm was not reset; the lease stays with $LEASE. Once no job runs in it: winvm reset && winvm start && winvm release"
    elif ! winvm release >/dev/null; then
      ok=1
      log "winvm release failed; the lease may still name $LEASE"
    fi
  fi
  if id=$(runner_id); then
    for i in $id; do gh api -X DELETE "repos/$REPO/actions/runners/$i" >/dev/null || ok=1; done
  else
    ok=1
    log "the runners could not be read; runner $NAME may still be registered"
  fi
  rm -rf "$RUN"
  log "stopped"
  return "$ok"
}

# true when a job may still come for winvm's label: one is queued, or the queue cannot be read. First waits until every
# route that read the last offer has queued its job (routes_wait).
jobs_may_come() {
  local n
  routes_wait
  for _ in 1 2 3; do
    if n=$(queued_jobs); then
      (( n > 0 )) && log "$n job(s) queued for $LABEL"
      (( n > 0 ))
      return
    fi
    sleep 10
  done
  log "the queue of $LABEL could not be read"
  return 0
}

# a stop never kills a job: it drains a listening runner (heartbeat) and waits for one in a job
trap 'touch "$RUN/stop"; log "stopping"' TERM INT
extra=0
while :; do
  if ! round; then
    failed=1
    pause 60
  fi
  (( once )) && touch "$RUN/stop"
  if stopping; then
    # a job routed here before the mark was cleared waits for this label alone: serve it (a round while stopping offers
    # nothing and drains its runner at once)
    if [ -e "$RUN/leased" ] && jobs_may_come; then
      if (( extra >= 3 )); then
        log "a job may still wait for $LABEL after 3 more rounds; cancel it and re-run all jobs of its run (the route then takes windows-latest)"
        capped=1
        break
      fi
      extra=$((extra + 1))
      log "one more round"
      continue
    fi
    break
  fi
done
cleanup || exit 1
(( capped )) && exit 1
(( once )) && exit "$failed"
exit 0
