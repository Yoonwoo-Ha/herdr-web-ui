#!/usr/bin/env bash
# First of all: a write to a closed output (an error message on a stderr nobody reads) must not
# end this shell with SIGPIPE before the refusal below can run.
trap '' PIPE
if [ -z "${BASH_VERSION:-}" ]; then
  set +e
  trap '' HUP INT TERM
  echo "::error::job-started.sh runs under bash only; refusing this job; this hook blocks (pid $$)." 2>/dev/null
  while :; do /bin/sleep 3600 || sleep 3600; done
fi
set -euo pipefail

proc=/proc ps=/bin/ps
if [[ -r $proc/$$/stat ]]; then os=linux; else os=mac; fi

allowed=0
reason="the guard failed before it could check the job"
refusal=""

say() {
  echo "::error::$1" 2>/dev/null
  if [[ -d $proc/1 ]]; then
    echo "[job-started] $1" 2>/dev/null >"$proc/1/fd/2"
  else
    logger -t ovis-runner-guard "$1" 2>/dev/null
  fi
}

block() {
  local now me
  say "$refusal Its parent is not proven to be the job's Runner.Worker ($1), so nothing was killed; this hook blocks (pid $$) until its parent is gone."
  while :; do
    if [[ $os == linux ]]; then
      stat_of self && [[ $stat_ppid != "$PPID" ]] && read -r me _ 2>/dev/null <"$proc/self/stat" && [[ $me == "$$" ]] && exit 1
    else
      now=$(ps_of ppid $$) && is_pid "$now" && [[ $now != "$PPID" ]] && exit 1
    fi
    /bin/sleep 5 || sleep 5
  done
}

is_pid() { [[ $1 =~ ^[1-9][0-9]{0,9}$ ]]; }

# Linux: the parent and start time of pid $1, from the fields after the last ")" of its stat (the
# name before it may hold any character): stat_ppid is field 4, stat_start field 22.
stat_of() {
  local line
  IFS= read -r line 2>/dev/null <"$proc/$1/stat" || return 1
  line=${line##*) }
  set -f
  # shellcheck disable=SC2086 # split into its fields on purpose
  set -- $line
  set +f
  stat_ppid=${2-} stat_start=${20-}
  is_pid "$stat_ppid" && [[ $stat_start =~ ^[0-9]+$ ]]
}

ps_of() {
  local value
  value=$("$ps" -o "$1=" -p "$2" 2>/dev/null) || return 1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  [[ -n $value ]] && printf '%s\n' "$value"
}

refuse() {
  set +eu
  [[ "$allowed" == 1 ]] && return
  # nothing may stop this before the kill: a closed output (SIGPIPE) or a signal ends the shell
  # inside its EXIT trap, and the worker would go on
  trap '' PIPE HUP INT TERM
  local worker own_start worker_start exe name key ruid euid uid_ok=0
  refusal="This self-hosted runner only runs code from ${GITHUB_REPOSITORY:-its own repository}; refusing ${GITHUB_EVENT_NAME:-this} job${GITHUB_RUN_ID:+ $GITHUB_RUN_ID}: $reason."
  # A failing hook only fails its own step: runner v2.338 still runs the job's `if: always()` and
  # `if: failure()` steps and its actions' post steps. So end the job first: SIGKILL the
  # Runner.Worker that runs it. The runner starts this hook as the worker's direct child, so the
  # only candidate is the parent this shell had at its start ($PPID), and only while every check
  # holds: it is still this shell's parent, its executable is Runner.Worker, it runs as this user,
  # and it is the same process from the first check to the kill. No other pid is ever signalled.
  worker=$PPID
  is_pid "$worker" && (( worker > 1 && worker != $$ )) || block "no parent process"
  if [[ $os == linux ]]; then
    stat_of $$ && [[ $stat_ppid == "$worker" ]] || block "it is no longer this hook's parent"
    own_start=$stat_start
    # the kernel's path of its executable, which a process cannot rename, and its name
    exe=$(/bin/readlink "$proc/$worker/exe" 2>/dev/null) && [[ ${exe##*/} == Runner.Worker ]] || block "its executable is not Runner.Worker"
    IFS= read -r name 2>/dev/null <"$proc/$worker/comm" && [[ $name == Runner.Worker ]] || block "its name is not Runner.Worker"
    while IFS=$' \t' read -r key ruid euid _; do
      if [[ $key == Uid: ]]; then
        [[ $ruid == "$UID" && $euid == "$UID" ]] && uid_ok=1
        break
      fi
    done 2>/dev/null <"$proc/$worker/status"
    [[ $uid_ok == 1 ]] || block "it runs as another user"
    stat_of "$worker" && (( stat_start <= own_start )) || block "it started after this hook"
    worker_start=$stat_start
    stat_of "$worker" && [[ $stat_start == "$worker_start" ]] && stat_of $$ && [[ $stat_ppid == "$worker" ]] || block "it changed during the checks"
  else
    [[ $(ps_of ppid $$) == "$worker" ]] || block "it is no longer this hook's parent"
    # macOS's ps names a process by the path it was started from
    name=$(ps_of comm "$worker") && [[ ${name##*/} == Runner.Worker ]] || block "its executable is not Runner.Worker"
    [[ $(ps_of ruid "$worker") == "$UID" && $(ps_of uid "$worker") == "$UID" ]] || block "it runs as another user"
    # to the second only: the same start time, as this shell's parent all along, is the same process
    worker_start=$(ps_of lstart "$worker") || block "its start time cannot be read"
    [[ $(ps_of lstart "$worker") == "$worker_start" && $(ps_of ppid $$) == "$worker" ]] || block "it changed during the checks"
  fi
  builtin kill -KILL "$worker" 2>/dev/null || block "the kill failed"
  say "$refusal"
  exit 1
}
trap refuse EXIT

repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
event_path="${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
event="${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"

# The head repository, by the event's name as well as by what the payload holds: every pull_request*
# event and workflow_run must name it, and issue_comment must hold its issue and comment (it runs
# the default branch's workflow); a payload that does not is refused, never taken for this
# repository's. Any other event runs this repository's code. jq compares the names itself, so no
# character of one is lost on the way to the shell.
reason="its event file $event_path could not be read as JSON"
verdict="$(jq -r --arg repo "$repository" --arg event "$event" '
  (if ($event | startswith("pull_request")) or has("pull_request") then .pull_request.head.repo.full_name
   elif $event == "workflow_run" or has("workflow_run") then .workflow_run.head_repository.full_name
   elif $event == "issue_comment" then (if (.issue | type) == "object" and (.comment | type) == "object" then $repo else null end)
   else $repo end) as $head
  | if $head == $repo then "allow" elif $head == null then "an unknown repository" else ($head | tojson) end' "$event_path")"

if [[ "$verdict" != allow ]]; then
  reason="its code comes from ${verdict:-an unknown repository}"
  exit 1
fi

allowed=1
echo "Runner guard: $event from $repository"
