#!/usr/bin/env bash
# Host launcher: keeps N ephemeral runner containers alive, one job per container.
#
# Usage: scripts/self-hosted-runner/run.sh [--repo OWNER/NAME] [--count N] [--labels self-hosted-ovis]
#          [--reserved N] [--reserved-labels self-hosted-ovis-main] [--env-file FILE] [--build] [--once]
#          [--cache-dir DIR [--cache-wait SECONDS] | --no-cache] [--build-cache DIR [--build-cache-mb N] [--build-cache-writer LOGIN]]
#          [--cpuset-cpus LIST]
#          [--work-tmpfs SIZE]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="herdr-ci-runner:local"

REPO=""
COUNT=1
LABELS="self-hosted-ovis"
RESERVED=0
RESERVED_LABELS="self-hosted-ovis-main"
ENV_FILE=""
BUILD=0
ONCE=0
CACHE=1
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ovis-ci-runner"
CACHE_WAIT=120
BUILD_CACHE=""
BUILD_CACHE_MB=2048
BUILD_CACHE_WRITER=""
CPUSET_ARGS=()
WORK_TMPFS=""

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --count) COUNT="${2:?--count needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --reserved) RESERVED="${2:?--reserved needs a value}"; shift 2 ;;
    --reserved-labels) RESERVED_LABELS="${2:?--reserved-labels needs a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --once) ONCE=1; shift ;;
    --cache-dir) CACHE_DIR="${2:?--cache-dir needs a value}"; shift 2 ;;
    --cache-wait) CACHE_WAIT="${2:?--cache-wait needs a value}"; shift 2 ;;
    --no-cache) CACHE=0; shift ;;
    --build-cache) BUILD_CACHE="${2:?--build-cache needs a value}"; shift 2 ;;
    --build-cache-mb) BUILD_CACHE_MB="${2:?--build-cache-mb needs a value}"; shift 2 ;;
    --build-cache-writer) BUILD_CACHE_WRITER="${2:?--build-cache-writer needs a value}"; shift 2 ;;
    --cpuset-cpus) CPUSET_ARGS=(--cpuset-cpus "${2:?--cpuset-cpus needs a value}"); shift 2 ;;
    --work-tmpfs) WORK_TMPFS="${2:?--work-tmpfs needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$COUNT" in ''|*[!0-9]*|0) echo "--count must be a positive integer" >&2; exit 2 ;; esac
case "$RESERVED" in ''|*[!0-9]*|?????*) echo "--reserved must be a whole number up to --count" >&2; exit 2 ;; esac
if [ "$((10#$RESERVED))" -gt "$((10#$COUNT))" ]; then echo "--reserved must not exceed --count" >&2; exit 2; fi
case "$CACHE_WAIT" in ''|*[!0-9]*|?????*) echo "--cache-wait must be a whole number of seconds" >&2; exit 2 ;; esac
case "$BUILD_CACHE_MB" in ''|*[!0-9]*|??????*) echo "--build-cache-mb must be a positive whole number of MiB" >&2; exit 2 ;; esac
if [ "$((10#$BUILD_CACHE_MB))" -eq 0 ]; then echo "--build-cache-mb must be a positive whole number of MiB" >&2; exit 2; fi
case "$BUILD_CACHE_WRITER" in *[!A-Za-z0-9-]*|-*|??????????????????????????????????????*) echo "--build-cache-writer must be a GitHub login" >&2; exit 2 ;; esac
WORK_TMPFS_ARGS=()
if [ -n "$WORK_TMPFS" ]; then
  case "$WORK_TMPFS" in [1-9]*[mg]) ;; *) echo "--work-tmpfs must be a size like 4g or 4096m" >&2; exit 2 ;; esac
  case "${WORK_TMPFS%?}" in *[!0-9]*|??????*) echo "--work-tmpfs must be a size like 4g or 4096m" >&2; exit 2 ;; esac
  WORK_TMPFS_ARGS=(--tmpfs "/w:rw,exec,nosuid,size=$WORK_TMPFS,uid=1001,gid=1001,mode=0755"
    --tmpfs "/tmp:rw,exec,nosuid,size=$WORK_TMPFS,mode=1777")
fi
# Every slot's docker network is a /28 of this block (README "Run"), never a range docker
# picks from its own pools: with those used up docker goes on to 192.168.0.0/20, and a network made
# at boot, before the LAN's route was there, took 192.168.0.1, the home router's address.
NETWORK_BLOCK="${OVIS_CI_NETWORK_BLOCK:-10.213.0.0/16}"
NETWORK_PREFIX=28
NETWORK_SIZE=$(( 1 << (32 - NETWORK_PREFIX) ))
ip_number() {
  local part='(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])'
  [[ $1 =~ ^$part\.$part\.$part\.$part$ ]] || return 1
  echo "$(( BASH_REMATCH[1] << 24 | BASH_REMATCH[2] << 16 | BASH_REMATCH[3] << 8 | BASH_REMATCH[4] ))"
}
cidr_range() {
  local bits=32 number size
  case "$1" in */*) bits="${1#*/}" ;; esac
  case "$bits" in [0-9]|[12][0-9]|3[0-2]) ;; *) return 1 ;; esac
  number="$(ip_number "${1%/*}")" || return 1
  size=$(( 1 << (32 - bits) ))
  echo "$(( number - number % size )) $(( number - number % size + size - 1 ))"
}
inside() {
  local outer
  outer="$(cidr_range "$2")" && [ "${1% *}" -ge "${outer% *}" ] && [ "${1#* }" -le "${outer#* }" ]
}
network_block_refused() {
  echo "OVIS_CI_NETWORK_BLOCK=$NETWORK_BLOCK $1" >&2
  exit 2
}
case "$NETWORK_BLOCK" in */[89]|*/1[0-9]|*/2[0-4]) ;; *) network_block_refused "must be a network address from /8 to /24, like 10.213.0.0/16" ;; esac
if ! BLOCK_RANGE="$(cidr_range "$NETWORK_BLOCK")" || [ "${BLOCK_RANGE% *}" != "$(ip_number "${NETWORK_BLOCK%/*}")" ]; then
  network_block_refused "must be a network address from /8 to /24, like 10.213.0.0/16"
fi
if ! inside "$BLOCK_RANGE" 10.0.0.0/8 && ! inside "$BLOCK_RANGE" 172.16.0.0/16; then
  network_block_refused "must be inside 10.0.0.0/8 or 172.16.0.0/16: never 192.168.0.0/16, 100.64.0.0/10, docker's 172.17.0.0/16 to 172.31.0.0/16 or a public range"
fi
ENV_ARGS=()
if [ -n "$ENV_FILE" ]; then
  # a path starting with - (even "-" itself, which grep reads as stdin after --) is the file of that name
  case "$ENV_FILE" in -*) ENV_FILE="./$ENV_FILE" ;; esac
  [ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || { echo "--env-file: cannot read $ENV_FILE" >&2; exit 2; }
  # Only CHECK_HOST_* numbers: docker copies a bare NAME line from this launcher's own environment
  # (GH_TOKEN, say) into every container, where any job could read it. A refused line is named by its
  # number only: its value may be a credential, and stderr ends up in the journal.
  status=0
  # -a: a NUL byte would make grep call the file binary and name no line; -- : a path may start with -
  bad="$(grep -anvE -e '^[[:space:]]*(#.*)?$|^CHECK_HOST_(MAX_RUNS|TEST_SHARDS|BROWSER_WORKERS|UNIT_WORKERS)=[0-9]+$' -- "$ENV_FILE")" || status=$?
  case "$status" in
    0) echo "--env-file: $ENV_FILE may hold only CHECK_HOST_*=<number> lines; refused line(s): $(printf '%s\n' "$bad" | cut -d: -f1 | paste -sd, -)" >&2
       exit 2 ;;
    1) ;;
    *) echo "--env-file: could not read $ENV_FILE to check it" >&2; exit 2 ;;
  esac
  ENV_ARGS=(--env-file "$ENV_FILE")
fi
SLOTS_ENV=(-e CHECK_SLOTS_DIR=/check-slots
  -e "CHECK_HOST_MAX_RUNS=taken from /check-slots on this runner, which this commit's scripts/check.ts does not read: merge main into the branch and push")
if [ -n "$ENV_FILE" ]; then
  max_runs="$(sed -n 's/^CHECK_HOST_MAX_RUNS=//p' "$ENV_FILE" | tail -n 1)"
  if [ -n "$max_runs" ]; then SLOTS_ENV+=(-e "CHECK_SLOTS_MAX_RUNS=$max_runs"); fi
fi

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
HOST="$(hostname -s)"
PREFIX="herdr-ci-${HOST}-"
SLOTS="${PREFIX}check-slots"
SLOT_FILES=()
for port in $(seq 41737 41770); do SLOT_FILES+=("$port"); done

if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$SCRIPT_DIR"
fi
if [ "${#CPUSET_ARGS[@]}" -gt 0 ] && ! docker run --rm "${CPUSET_ARGS[@]}" --network none --entrypoint true "$IMAGE" >/dev/null 2>&1; then
  echo "--cpuset-cpus ${CPUSET_ARGS[1]}: docker cannot run a container on those CPUs" >&2
  exit 2
fi

# The keeper of the check slots: an idle container that holds the volume, so its files stay between
# jobs (docker unmounts a RAM volume no container uses), and in which they are made, as root with no
# capability, each time a runner is about to start: making a file that is there changes nothing.
# Fails unless the volume is in RAM and its directory is root's and closed to everyone else (a
# volume of this name made otherwise: docker keeps the one it has, and makes a plain one on disk
# for a container that names a volume that is not there) and every file is there: without them a
# job's check.ts stops rather than count only its own container, so no runner is started.
start_slots() {
  local try
  if [ "$(docker container inspect -f '{{.State.Running}}' "$SLOTS" 2>/dev/null || true)" != true ]; then
    docker rm "$SLOTS" >/dev/null 2>&1 || true
    docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} -d --rm \
      --name "$SLOTS" \
      --network none \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --user 0:0 \
      -v "$SLOTS:/check-slots" \
      --entrypoint sleep \
      "$IMAGE" infinity >/dev/null 2>&1 || true
    for try in $(seq 1 25); do
      [ "$(docker container inspect -f '{{.State.Running}}' "$SLOTS" 2>/dev/null || true)" = true ] && break
      sleep 0.2
    done
  fi
  docker exec "$SLOTS" sh -c 'cd /check-slots && [ "$(stat -c %u:%a .)" = 0:755 ] && [ "$(stat -f -c %T .)" = tmpfs ] || exit 1
    for file; do : >> "$file" || exit 1; done; chmod 0666 "$@"' sh "${SLOT_FILES[@]}" </dev/null >/dev/null 2>&1
}
if ! docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m,mode=0755,uid=0,gid=0 "$SLOTS" >/dev/null || ! start_slots; then
  echo "cannot set up the check slots (the volume and the container $SLOTS): no runner starts without them, since its jobs would not count against one run limit. A volume of that name that is not in RAM, or whose directory is not root's alone, must be removed first." >&2
  docker rm -f "$SLOTS" >/dev/null 2>&1 || true
  exit 2
fi

MIRROR=""
BUN_CACHES=""
REPO_CACHE=""
CACHE_CONTAINER="${PREFIX}cache"
case "$REPO" in
  .*|*/.*|*/*/*|*[!A-Za-z0-9._/-]*|*/|/*) [ "$CACHE" = 1 ] && echo "[cache] $REPO is not an OWNER/NAME this launcher can keep caches for: running without them" >&2; CACHE=0 ;;
  */*) ;;
  *) [ "$CACHE" = 1 ] && echo "[cache] $REPO is not an OWNER/NAME this launcher can keep caches for: running without them" >&2; CACHE=0 ;;
esac
if [ "$CACHE" = 1 ]; then
  if REPO_CACHE="$(umask 022 && mkdir -p "$CACHE_DIR/$REPO" && cd "$CACHE_DIR/$REPO" && pwd -P)"; then
    MIRROR="$REPO_CACHE/git/repo.git"
    BUN_CACHES="$REPO_CACHE/bun"
  else
    echo "[cache] cannot use $CACHE_DIR/$REPO: running without host caches" >&2
    CACHE=0
  fi
fi
BUILD_CACHE_ROOT=""
BUILD_CACHE_OUTBOXES=""
BUILD_CACHE_LOCKS="${PREFIX}build-cache-locks"
if [ -n "$BUILD_CACHE" ]; then
  case "$REPO" in
    .*|*/.*|*/*/*|*[!A-Za-z0-9._/-]*|*/|/*) echo "[build-cache] $REPO is not an OWNER/NAME: running without it" >&2 ;;
    */*)
      outboxes="${XDG_STATE_HOME:-$HOME/.local/state}/ovis-ci-runner/build-outbox/$REPO"
      if BUILD_CACHE_ROOT="$(umask 022 && mkdir -p "$BUILD_CACHE/$REPO/entries" "$BUILD_CACHE/$REPO/used" && cd "$BUILD_CACHE/$REPO" && pwd -P)" &&
        BUILD_CACHE_OUTBOXES="$(umask 022 && mkdir -p "$outboxes" && cd "$outboxes" && pwd -P)" &&
        docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=16m,mode=1777 "$BUILD_CACHE_LOCKS" >/dev/null; then
        :
      else
        echo "[build-cache] cannot use $BUILD_CACHE/$REPO, its outboxes or the $BUILD_CACHE_LOCKS volume: running without it" >&2
        BUILD_CACHE_ROOT=""
      fi ;;
    *) echo "[build-cache] $REPO is not an OWNER/NAME: running without it" >&2 ;;
  esac
fi

build_cache_args() {
  local outbox="$BUILD_CACHE_OUTBOXES/$1"
  BUILD_CACHE_ARGS=()
  [ -n "$BUILD_CACHE_ROOT" ] || return 0
  if [ -d "$outbox" ]; then
    find "$outbox" -mindepth 1 -maxdepth 1 ! -type d -delete 2>/dev/null || true
    find "$outbox" -mindepth 1 -maxdepth 1 -type d -name 'judged-*' -user "$(id -u)" -empty -delete 2>/dev/null || true
    if [ -n "$(find "$outbox" -mindepth 1 -print -quit 2>/dev/null)" ]; then
      docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --network none --security-opt no-new-privileges --cap-drop ALL --user 1001:1001 \
        -v "$outbox:/outbox" --entrypoint sh "$IMAGE" -c 'chmod -R u+rwX /outbox 2>/dev/null; find /outbox -mindepth 1 -delete' </dev/null >/dev/null 2>&1 || true
    fi
    if [ -n "$(find "$outbox" -mindepth 1 -maxdepth 1 ! -type d -print -quit 2>/dev/null)" ]; then
      echo "[$1] its build cache outbox could not be emptied: starting it without the build cache" >&2
      return 0
    fi
  fi
  mkdir -p "$outbox" && chmod 1777 "$outbox" || return 0
  BUILD_CACHE_ARGS=(-v "$BUILD_CACHE_ROOT/entries:/build-cache:ro" -v "$BUILD_CACHE_LOCKS:/build-cache-locks"
    -v "$outbox:/build-cache-outbox" -e OVIS_BUILD_CACHE_DIR=/build-cache -e OVIS_BUILD_CACHE_LOCKS=/build-cache-locks
    -e OVIS_BUILD_CACHE_OUTBOX=/build-cache-outbox ${BUILD_CACHE_WRITER:+-e "OVIS_BUILD_CACHE_WRITER=$BUILD_CACHE_WRITER"})
}

clean_taken() {
  [ -n "$(find "$BUILD_CACHE_OUTBOXES/.taken" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ] || return 0
  docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --network none --security-opt no-new-privileges --cap-drop ALL --cap-add DAC_OVERRIDE --user 0:0 \
    -v "$BUILD_CACHE_OUTBOXES/.taken:/taken" --entrypoint find "$IMAGE" /taken -mindepth 1 -delete </dev/null >/dev/null 2>&1 || true
}

promote_loop() {
  trap 'exit 143' TERM
  local names=() slot
  for slot in $(seq 1 "$COUNT"); do names+=("${PREFIX}${slot}"); done
  while true; do
    bash "$SCRIPT_DIR/build-cache-promote.sh" "$REPO" "$BUILD_CACHE_ROOT" "$BUILD_CACHE_OUTBOXES" "$BUILD_CACHE_WRITER" "$((10#$BUILD_CACHE_MB))" "${names[@]}" || true
    clean_taken
    sleep 1
  done
}

STATE_DIR=""
# timeout without --foreground runs git in a process group of its own and signals all of it at the
# deadline, transport helpers included. That group is outside the cache loop's, which cleanup stops:
# the trap passes the stop on, then waits for timeout, which kills a git that ignores it 5 s later,
# and kills what is left of the group, so the launcher outlives every part of it. A signal is handled between commands, so once `&` has started
# timeout, $! names it: before its setpgid the process itself, after it the whole group.
git_net() (
  limit="$1" status=0; shift
  # a no-op job first, so a stop before timeout starts never signals an older job's reused pid
  : &
  trap 'kill -TERM "$!" 2>/dev/null || true; kill -TERM -- "-$!" 2>/dev/null || true; wait "$!" || true
    kill -KILL -- "-$!" 2>/dev/null || true; exit 143' TERM
  GIT_TERMINAL_PROMPT=0 timeout -k 5 "$limit" \
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 "$@" &
  wait "$!" || status=$?
  kill -KILL -- "-$!" 2>/dev/null || true
  exit "$status"
)

refresh_mirror() {
  local tmp head dir url="https://github.com/$REPO.git"
  DEFAULT_REF=""
  if [ -d "$MIRROR/objects" ] && [ "$(git -C "$MIRROR" config remote.origin.url)" != "$url" ]; then
    echo "[cache] $MIRROR does not mirror $url: setting it up again" >&2
    rm -rf "$MIRROR" || return 1
  fi
  for dir in "$REPO_CACHE"/git/.new-*; do
    if [ -d "$dir" ] && [ -n "$(find "$dir" -maxdepth 0 -mmin +60)" ]; then rm -rf "$dir"; fi
  done
  if [ ! -d "$MIRROR/objects" ]; then
    mkdir -p "$REPO_CACHE/git" && tmp="$(mktemp -d "$REPO_CACHE/git/.new-XXXXXX")" || return 1
    # gc.pruneExpire never: a job reads objects from the mirror without copying them, so an object
    # of a deleted or force-pushed branch must stay while a job may still need it
    if ! { git -c init.defaultBranch=main init -q --bare "$tmp" &&
      git -C "$tmp" config remote.origin.url "$url" &&
      git -C "$tmp" config remote.origin.fetch '+refs/heads/*:refs/heads/*' &&
      git -C "$tmp" config --add remote.origin.fetch '+refs/tags/*:refs/tags/*' &&
      git -C "$tmp" config gc.pruneExpire never &&
      git -C "$tmp" config gc.auto 0 &&
      git -C "$tmp" config maintenance.auto false &&
      git -C "$tmp" config fetch.unpackLimit 1 &&
      chmod 0755 "$tmp" && mv -T "$tmp" "$MIRROR"; }; then
      rm -rf "$tmp"
      [ -d "$MIRROR/objects" ] || return 1
    fi
  fi
  git_net 900 -C "$MIRROR" fetch --quiet --prune --no-write-fetch-head origin || return 1
  git_net 120 -C "$MIRROR" ls-remote --symref origin HEAD > "$STATE_DIR/default-branch" || return 1
  head="$(sed -n 's|^ref: \(refs/heads/[^[:space:]]*\)[[:space:]]*HEAD$|\1|p' "$STATE_DIR/default-branch")"
  case "$head" in refs/heads/?*) ;; *) return 1 ;; esac
  git -C "$MIRROR" rev-parse --verify -q "$head^{commit}" >/dev/null || return 1
  if [ "$(git -C "$MIRROR" symbolic-ref -q HEAD)" != "$head" ]; then
    git -C "$MIRROR" symbolic-ref HEAD "$head" || return 1
  fi
  if [ "$(find "$MIRROR/objects/pack" -name '*.pack' | wc -l)" -gt 50 ]; then
    git -C "$MIRROR" repack -q -a -d --keep-unreachable || return 1
  fi
  DEFAULT_REF="$head"
}

refresh_bun_cache() {
  local lock commit version tmp failed old dir status
  [ -n "$DEFAULT_REF" ] || return 1
  lock="$(git -C "$MIRROR" rev-parse --verify -q "$DEFAULT_REF:bun.lock")" || return 0
  commit="$(git -C "$MIRROR" rev-parse --verify -q "$DEFAULT_REF^{commit}")" || return 1
  version="$BUN_CACHES/$lock"
  failed="$BUN_CACHES/.failed-$lock"
  mkdir -p "$BUN_CACHES" || return 1
  if [ ! -d "$version" ]; then
    [ -n "$(find "$failed" -mmin -30 2>/dev/null)" ] && return 1
    tmp="$(mktemp -d "$BUN_CACHES/.new-XXXXXX")" || return 1
    docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
    # --foreground keeps it in this process group, which the launcher's exit stops whole; --init gives
    # the container a PID 1 that passes the deadline's SIGTERM on (a bare PID 1 ignores it), and -k
    # ends the client if it still waits. Whatever ended it, docker rm -f below ends the container.
    status=0
    timeout --foreground -k 5 900 docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm --init \
      --name "$CACHE_CONTAINER" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp \
      -e BUN_INSTALL_CACHE_DIR=/cache/bun \
      -e COMMIT="$commit" \
      -v "$MIRROR:/cache/git/repo.git:ro" \
      -v "$tmp:/cache/bun" \
      --entrypoint bash \
      "$IMAGE" -c 'set -e
        git clone -q --shared --no-checkout /cache/git/repo.git /tmp/src
        cd /tmp/src
        git checkout -q --detach "$COMMIT"
        bun install --frozen-lockfile --ignore-scripts' </dev/null >/dev/null || status=$?
    if [ "$status" != 0 ]; then
      docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
      rm -rf "$tmp"
      if [ ! -e "$STATE_DIR/stopping" ]; then touch "$failed"; fi
      return 1
    fi
    rm -f "$failed"
    chmod -R a+rX "$tmp"
    mv -T "$tmp" "$version" 2>/dev/null || rm -rf "$tmp"
  fi
  old="$(readlink "$BUN_CACHES/current" 2>/dev/null || true)"
  if [ "$old" != "$lock" ]; then
    if [ -n "$old" ] && [ -d "$BUN_CACHES/$old" ]; then touch "$BUN_CACHES/$old"; fi
    ln -sfn "$lock" "$BUN_CACHES/.current-new" && mv -T "$BUN_CACHES/.current-new" "$BUN_CACHES/current"
  fi
  for dir in "$BUN_CACHES"/* "$BUN_CACHES"/.new-*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ "${dir##*/}" != "$lock" ] || continue
    if [ -n "$(find "$dir" -maxdepth 0 -mmin +60)" ]; then rm -rf "$dir"; fi
  done
  find "$BUN_CACHES" -maxdepth 1 -name '.failed-*' -mmin +60 -delete 2>/dev/null || true
}

refresh_caches() (
  umask 022
  trap 'exit 143' TERM
  if ! refresh_mirror; then
    echo "[cache] could not refresh the git mirror $MIRROR from github.com/$REPO, or GitHub named no default branch it holds" >&2
  elif ! refresh_bun_cache; then
    echo "[cache] could not build the Bun cache in $BUN_CACHES for the default branch's bun.lock" >&2
  fi
  return 0
)

cache_loop() {
  trap 'exit 143' TERM
  refresh_caches
  : > "$STATE_DIR/warm"
  [ "$ONCE" = 1 ] && return 0
  while true; do
    sleep 60
    refresh_caches
  done
}

cache_args() {
  CACHE_ARGS=()
  [ "$CACHE" = 1 ] || return 0
  CACHE_ARGS=(-v "$REPO_CACHE:/cache:ro")
  if [ -d "$MIRROR/objects" ]; then
    CACHE_ARGS+=(-e GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects)
  fi
}

host_ranges() {
  local routes addrs words dest range
  routes="$(ip -4 route show table all)" && addrs="$(ip -4 -o addr show)" || return 1
  HOST_RANGES=()
  while read -r -a words; do
    [ "${#words[@]}" -gt 0 ] || continue
    case "${words[0]}" in
      broadcast|multicast) continue ;;
      local|unicast|anycast|unreachable|blackhole|prohibit|throw|nat) words=("${words[@]:1}") ;;
    esac
    dest="${words[0]:-}"
    case "$dest" in default|0.0.0.0/0|*/[0-7]) continue ;; esac
    if range="$(cidr_range "$dest")"; then HOST_RANGES+=("$range"); fi
  done <<< "$routes"
  while read -r -a words; do
    [ "${words[2]:-}" = inet ] || continue
    if range="$(cidr_range "${words[3]:-}")"; then HOST_RANGES+=("$range"); fi
  done <<< "$addrs"
}

host_overlap() {
  local range
  for range in ${HOST_RANGES[@]+"${HOST_RANGES[@]}"}; do
    if [ "${range% *}" -le "${1#* }" ] && [ "${range#* }" -ge "${1% *}" ]; then
      OVERLAP_END="${range#* }"
      return 0
    fi
  done
  return 1
}

host_routed() {
  ip -4 route get 1.1.1.1 >/dev/null 2>&1
}

slot_network() {
  local name="$1" slot="$2" found fields subnet range ranges=() first last start candidate refused=0 wrapped=0
  local unrouted="this host has no default route yet: not making a docker network ($name)"
  NETWORK_PROBLEM="could not make the docker network $name"
  if ! host_routed; then NETWORK_PROBLEM="$unrouted"; return 1; fi
  if found="$(docker network inspect -f '{{len .Containers}}{{range .IPAM.Config}} {{.Subnet}}{{end}}' "$name" 2>/dev/null)"; then
    read -r -a fields <<< "$found"
    for subnet in ${fields[@]+"${fields[@]:1}"}; do
      case "$subnet" in *:*) ;; *) ranges+=("$subnet") ;; esac
    done
    if [ "${#ranges[@]}" = 1 ] && [ "${ranges[0]#*/}" = "$NETWORK_PREFIX" ] && range="$(cidr_range "${ranges[0]}")" &&
      inside "$range" "$NETWORK_BLOCK"; then
      return 0
    fi
    if [ "${fields[0]:-}" != 0 ]; then
      found="${fields[*]:1}"
      NETWORK_PROBLEM="the docker network $name (${found:-no address range}) is not a /28 of $NETWORK_BLOCK, and a container is on it: leaving it as it is"
      return 1
    fi
    docker network rm "$name" >/dev/null 2>&1 || return 1
    if ! host_routed; then NETWORK_PROBLEM="$unrouted"; return 1; fi
  fi
  if ! host_ranges; then
    NETWORK_PROBLEM="could not read this host's routes and addresses (ip -4) to choose a range for the docker network $name"
    return 1
  fi
  read -r first last <<< "$BLOCK_RANGE"
  start=${SEARCH_FROM:-$(( first + (slot - 1) % ((last - first + 1) / NETWORK_SIZE) * NETWORK_SIZE ))}
  candidate=$start
  while [ "$refused" -lt 16 ]; do
    if [ "$candidate" -gt "$last" ]; then
      [ "$wrapped" = 0 ] || break
      candidate=$first wrapped=1
    fi
    if [ "$wrapped" = 1 ] && [ "$candidate" -ge "$start" ]; then break; fi
    if host_overlap "$candidate $(( candidate + NETWORK_SIZE - 1 ))"; then
      candidate=$(( (OVERLAP_END / NETWORK_SIZE + 1) * NETWORK_SIZE ))
      continue
    fi
    subnet="$(( candidate >> 24 & 255 )).$(( candidate >> 16 & 255 )).$(( candidate >> 8 & 255 )).$(( candidate & 255 ))/$NETWORK_PREFIX"
    if docker network create --driver bridge --subnet "$subnet" "$name" >/dev/null 2>&1; then
      unset SEARCH_FROM
      return 0
    fi
    refused=$(( refused + 1 ))
    candidate=$(( candidate + NETWORK_SIZE ))
  done
  if [ "$refused" -ge 16 ]; then
    if [ "$candidate" -gt "$last" ]; then SEARCH_FROM=$first; else SEARCH_FROM=$candidate; fi
    return 1
  fi
  unset SEARCH_FROM
  NETWORK_PROBLEM="no /28 of $NETWORK_BLOCK is free for the docker network $name: this host's routes and addresses, or docker's networks, cover all of it (OVIS_CI_NETWORK_BLOCK names another block, inside 10.0.0.0/8 or 172.16.0.0/16)"
  return 1
}

slot_loop() {
  local slot="$1" name token container_status running problem labels="$LABELS"
  name="${PREFIX}${slot}"
  if [ "$slot" -le "$((10#$RESERVED))" ]; then labels="$RESERVED_LABELS"; fi
  delay=30
  while true; do
    while running="$(docker container inspect -f '{{.State.Running}}' "$name" 2>/dev/null)"; do
      [ "$running" = true ] && { sleep 5; continue; }
      echo "[$name] removing a container left in this slot's name that is not running" >&2
      docker rm -f "$name" >/dev/null 2>&1 || true
      break
    done
    sleep 2
    problem=""
    if ! start_slots; then problem="could not make the check slots in $SLOTS"
    elif ! slot_network "$name-net" "$slot"; then problem="$NETWORK_PROBLEM"
    elif ! token="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)"; then problem="could not fetch a registration token"
    fi
    if [ -n "$problem" ]; then
      echo "[$name] $problem; retrying in ${delay}s" >&2
      [ "$ONCE" = 1 ] && return 1
      sleep "$delay"
      delay=$(( delay * 2 > 600 ? 600 : delay * 2 ))
      continue
    fi
    delay=30
    cache_args
    build_cache_args "$name"
    if printf '%s\n' "$token" | docker run ${CPUSET_ARGS[@]+"${CPUSET_ARGS[@]}"} --rm -i \
      --name "$name" \
      --network "$name-net" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --pids-limit 8192 \
      --shm-size 2g \
      --ulimit core=0 \
      -v "$SLOTS:/check-slots" \
      -e RUNNER_URL="https://github.com/$REPO" \
      -e RUNNER_NAME="$name" \
      -e RUNNER_LABELS="$labels" \
      ${CACHE_ARGS[@]+"${CACHE_ARGS[@]}"} \
      ${BUILD_CACHE_ARGS[@]+"${BUILD_CACHE_ARGS[@]}"} \
      ${WORK_TMPFS_ARGS[@]+"${WORK_TMPFS_ARGS[@]}"} \
      "${SLOTS_ENV[@]}" \
      ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      "$IMAGE"; then
      container_status=0
    else
      container_status=$?
      echo "[$name] container exited with status $container_status" >&2
    fi
    token=""
    [ "$ONCE" = 1 ] && return "$container_status"
  done
}

PIDS=()
CACHE_PID=""
PROMOTE_PID=""
cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return
  cleaned=1
  trap '' INT TERM
  echo "stopping runner slots..." >&2
  if [ -n "$STATE_DIR" ]; then : > "$STATE_DIR/stopping"; fi
  if [ -n "$CACHE_PID" ]; then kill -TERM -- "-$CACHE_PID" 2>/dev/null || true; fi
  if [ -n "$PROMOTE_PID" ]; then kill -TERM -- "-$PROMOTE_PID" 2>/dev/null || true; fi
  docker stop -t 5 "$CACHE_CONTAINER" >/dev/null 2>&1 || true
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  for slot in $(seq 1 "$COUNT"); do
    docker stop -t 30 "${PREFIX}${slot}" >/dev/null 2>&1 || true
  done
  wait 2>/dev/null || true
  docker rm -f "$CACHE_CONTAINER" >/dev/null 2>&1 || true
  for slot in $(seq 1 "$COUNT"); do
    docker network rm "${PREFIX}${slot}-net" >/dev/null 2>&1 || true
  done
  docker stop -t 5 "$SLOTS" >/dev/null 2>&1 || true
  docker stop -t 5 "${PREFIX}net" >/dev/null 2>&1 || true
  ids="$(gh api "repos/$REPO/actions/runners" --paginate \
    --jq ".runners[] | select(.name | startswith(\"$PREFIX\")) | .id" 2>/dev/null || true)"
  for id in $ids; do
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null 2>&1 || true
  done
  if [ -n "$STATE_DIR" ]; then rm -rf "$STATE_DIR"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$CACHE" = 1 ]; then
  STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ovis-ci-runner.XXXXXX")"
  set -m
  cache_loop &
  CACHE_PID="$!"
  set +m
  deadline=$((SECONDS + 10#$CACHE_WAIT))
  while [ ! -e "$STATE_DIR/warm" ] && kill -0 "$CACHE_PID" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
  done
  if [ ! -e "$STATE_DIR/warm" ]; then
    echo "[cache] the caches are not ready after ${CACHE_WAIT}s: starting the runners without waiting for them" >&2
  fi
fi

if [ -n "$BUILD_CACHE_ROOT" ]; then
  clean_taken
  set -m
  promote_loop &
  PROMOTE_PID="$!"
  set +m
fi

for slot in $(seq 1 "$COUNT"); do
  slot_loop "$slot" &
  PIDS+=("$!")
done

if [ "$ONCE" = 1 ]; then
  rc=0
  for pid in "${PIDS[@]}"; do
    wait "$pid" || rc=$?
  done
  exit "$rc"
fi

wait
