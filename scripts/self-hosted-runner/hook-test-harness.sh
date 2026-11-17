#!/usr/bin/env bash
set -u

marker=/opt/runner-hooks/ovis-runner-image

in_own_namespace() {
  local token=$1 arg found=0 args pids
  [[ $$ == 1 ]] || { why="not PID 1 of a new PID namespace (pid $$)"; return 1; }
  [[ ${#token} -ge 32 ]] || { why="no run token"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  for arg in "${args[@]}"; do [[ $arg == "$token" ]] && found=$((found + 1)); done
  [[ $found == 1 ]] || { why="PID 1 of /proc does not carry this run's token: /proc is not this namespace's"; return 1; }
  pids=(/proc/[0-9]*)
  [[ ${pids[*]} == /proc/1 ]] || { why="other processes are visible (${#pids[@]})"; return 1; }
}

in_runner_container() {
  local init args ns
  [[ -f $marker && ! -L $marker && ! -w $marker && ! -w ${marker%/*} ]] || { why="no read-only marker of the runner image ($marker)"; return 1; }
  [[ $(stat -c %u "$marker" "${marker%/*}" 2>/dev/null) == $'0\n0' ]] || { why="$marker is not root's"; return 1; }
  [[ -f /.dockerenv ]] || { why="not in a docker container (/.dockerenv)"; return 1; }
  IFS= read -r init 2>/dev/null </proc/1/comm || { why="/proc/1/comm cannot be read"; return 1; }
  mapfile -d '' args 2>/dev/null </proc/1/cmdline || { why="/proc/1/cmdline cannot be read"; return 1; }
  [[ ($init == tini || $init == docker-init) && ${args[0]##*/} == "$init" ]] || { why="PID 1 is $init, not the container's init"; return 1; }
  [[ $$ != 1 ]] || { why="this harness is PID 1"; return 1; }
  ns=$(/bin/readlink "/proc/$$/ns/pid" 2>/dev/null) || { why="its PID namespace cannot be read"; return 1; }
  [[ $ns =~ ^pid:\[[0-9]+\]$ && $ns != 'pid:[4026531836]' ]] || { why="in the host's initial PID namespace ($ns)"; return 1; }
}

alone_in_namespace() {
  local -A line_of_mine=()
  local pid=$$ stat entry
  while [[ $pid =~ ^[1-9][0-9]*$ ]]; do
    line_of_mine[$pid]=1
    IFS= read -r stat 2>/dev/null <"/proc/$pid/stat" || { why="/proc/$pid/stat cannot be read"; return 1; }
    stat=${stat##*) }
    stat=${stat#* }
    pid=${stat%% *}
  done
  for entry in /proc/[0-9]*; do
    [[ -n ${line_of_mine[${entry#/proc/}]-} ]] || { why="a process that is neither this harness nor above it is visible (pid ${entry#/proc/})"; return 1; }
  done
}

why=""
guard=${1-}
if [[ $guard == container ]]; then
  in_runner_container || { echo "not isolated: $why" >&2; exit 97; }
  if [[ ${2-} == probe ]]; then alone_in_namespace || { echo "not isolated: $why" >&2; exit 97; }; fi
else
  in_own_namespace "$guard" || { echo "not isolated: $why" >&2; exit 97; }
fi
parent=${2-} output=${3-}

# Sets ppid_of and start_of from /proc/<pid>/stat (fields 4 and 22, after the last ")")
stat_of() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || return 1
  line=${line##*) }
  read -r _ ppid_of _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ start_of _ <<<"$line"
}

persists() {
  local hook_pid=$1 first="" children child comm polls=0
  while (( polls++ < 150 )); do
    [[ $(state "$hook_pid") == running && $(state "$pid") == running ]] || return 1
    children=""
    IFS= read -r children 2>/dev/null <"/proc/$hook_pid/task/$hook_pid/children"
    for child in $children; do
      IFS= read -r comm 2>/dev/null <"/proc/$child/comm" || continue
      [[ $comm == sleep ]] || continue
      if [[ -z $first ]]; then first=$child; elif [[ $child != "$first" ]]; then return 0; fi
    done
    read -r -t 0.1 _ <&5
  done
  return 1
}

state() {
  local line
  IFS= read -r line 2>/dev/null <"/proc/$1/stat" || { echo gone; return; }
  line=${line##*) }
  if [[ ${line%% *} == Z ]]; then echo gone; else echo running; fi
}

above=()
pid=$$
while stat_of "$pid" && [[ $ppid_of =~ ^[1-9][0-9]*$ ]] && (( ${#above[@]} < 64 )); do
  pid=$ppid_of
  stat_of "$pid" && above+=("$pid:$start_of")
done

dir=$HARNESS_DIR
mkdir -p "$dir/exe" "$dir/decoys"
mkfifo "$dir/hold"
exec 5<>"$dir/hold"

if [[ $guard == container ]]; then
  ( "$BASH" -c 'read -r _ <"$0"' "$dir/hold" 5>&- & echo "$!" >"$dir/orphan" )
  IFS= read -r orphan <"$dir/orphan"
  stat_of "$orphan" && [[ $ppid_of == "$$" ]] || { echo "not isolated: an orphan of this harness went to ${ppid_of:-nobody}, not to it" >&2; exit 97; }
fi
if [[ $parent == probe ]]; then echo isolated; exit 0; fi

cp "$BASH" "$dir/decoys/Runner.Worker"
cp "$BASH" "$dir/decoys/Runner.Worker2"
decoys=()
for decoy in Runner.Worker Runner.Worker2; do
  "$dir/decoys/$decoy" -c 'read -r _ <"$0"' "$dir/hold" </dev/null >/dev/null 2>&1 5>&- &
  decoys+=($!)
done

run='bash "$0"'
prefix=""
case $parent in
  worker) exe=Runner.Worker ;;
  nested) exe=Runner.Worker run='bash -c '\''bash "$0"; :'\'' "$0"' ;;
  renamed) exe=Runner.Worker prefix='printf systemd >"/proc/$$/comm" && ' ;;
  posing) exe=systemd prefix='printf Runner.Worker >"/proc/$$/comm" && ' ;;
  named:*) exe=${parent#named:} ;;
  gone) exe=parent ;;
  leaves) exe=systemd ;;
  *) echo "unknown parent: $parent" >&2; exit 2 ;;
esac
cp "$BASH" "$dir/exe/$exe"
if [[ $output == closed ]]; then
  script="${prefix}mkfifo \"\$1\" && exec 4<>\"\$1\" 5>\"\$1\" 4<&- && $run >&5 2>&5; echo \"next step ran\""
elif [[ $parent == gone || $parent == leaves ]]; then
  script="$run & read -r _ <\"\$1\"; exit 0"
  mkfifo "$dir/fifo"
  if [[ $parent == gone ]]; then mkfifo "$GITHUB_EVENT_PATH"; fi
else
  script="$prefix$run; echo \"next step ran\""
fi
mkfifo "$dir/out"
PATH=$HOOK_PATH "$dir/exe/$exe" -c "$script" "$HOOK" "$dir/fifo" >"$dir/out" 2>&1 </dev/null 5>&- &
pid=$!
exec 3<"$dir/out"

parent_status=""
if [[ $parent == gone ]]; then
  exec 4>"$GITHUB_EVENT_PATH"
  : >"$dir/fifo"
  wait "$pid"
  parent_status=$?
  cat "$dir/event.json" >&4
  exec 4>&-
fi

blocks_line='this hook blocks \(pid ([0-9]+)\)'
hook=silent next=no
while :; do
  if IFS= read -r -t 20 line <&3; then
    printf '%s\n' "$line" >>"$dir/output"
    [[ $line == 'next step ran' ]] && next=ran
    if [[ $line =~ $blocks_line ]]; then
      if [[ $parent == leaves ]]; then
        : >"$dir/fifo"
        wait "$pid"
        parent_status=$?
      elif [[ $parent != gone ]]; then
        if persists "${BASH_REMATCH[1]}"; then hook=blocked; else hook=unproven; fi
        while IFS= read -r -t 0.1 line <&3; do
          printf '%s\n' "$line" >>"$dir/output"
          [[ $line == 'next step ran' ]] && next=ran
        done
        break
      fi
    fi
  else
    (( $? > 128 )) || hook=ended
    break
  fi
done

if [[ -n $parent_status ]]; then
  parent_report=$parent_status
elif [[ $hook == ended ]]; then
  wait "$pid"
  parent_report=$?
else
  parent_report=$(state "$pid")
fi
decoy_report=alive
for decoy in "${decoys[@]}"; do
  [[ $(state "$decoy") == running ]] || decoy_report=dead
done
above_report=alive
for entry in "${above[@]}"; do
  stat_of "${entry%%:*}" && [[ $start_of == "${entry#*:}" ]] || above_report=dead
done
echo "report parent=$parent_report hook=$hook next=$next decoys=$decoy_report above=$above_report"
