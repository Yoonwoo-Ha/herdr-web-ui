#!/usr/bin/env bash
# Moves the client builds that trusted jobs left in their slots' outboxes into the build cache
# (README "Build cache"). Runner containers get the cache read-only: a job only writes its own
# slot's outbox, `<key>.tar` and then `<key>.claim` (its GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT). This
# runs on the host, as the launcher's user, and takes a build only when GitHub says the slot is
# running a job of that run and the run is trusted: a push to the default branch, or a pull request
# from this repository that --writer opened and pushed. Every other outbox file is deleted.
#
# Usage: build-cache-promote.sh REPO CACHE_ROOT OUTBOXES WRITER MAX_MB SLOT_NAME...
#   CACHE_ROOT holds entries/ (the cache) and used/ (when each was last restored), both written only
#   here; OUTBOXES holds a directory per runner, named after it; WRITER may be empty. A restore says it used an entry
#   with an empty outbox file used-<key>, of which only the name is read.
set -euo pipefail

REPO="$1" ROOT="$2" OUTBOXES="$3" WRITER="$4" MAX_MB="$5"
shift 5
ENTRIES="$ROOT/entries"
USED="$ROOT/used"

log() { echo "[build-cache] $*" >&2; }

# Whether the runner named $1 is running a job of run $2 (attempt $3), and that run is trusted.
trusted() {
  local name="$1" run="$2" attempt="$3" info default pulls number pull
  # every call has a deadline: one GitHub request that hangs must not stop the promotion of every slot
  timeout 20 gh api "repos/$REPO/actions/runs/$run/attempts/$attempt/jobs?per_page=100" |
    jq -e --arg name "$name" 'any(.jobs[]; .runner_name == $name and .status == "in_progress")' >/dev/null || { log "run $run has no job running on $name"; return 1; }
  info="$(timeout 20 gh api "repos/$REPO/actions/runs/$run")" || return 1
  [ "$(jq -r '.head_repository.full_name // ""' <<<"$info")" = "$REPO" ] || { log "run $run is not from $REPO"; return 1; }
  case "$(jq -r '.event // ""' <<<"$info")" in
    push)
      default="$(timeout 20 gh api "repos/$REPO" --jq .default_branch)" || return 1
      [ -n "$default" ] && [ "$(jq -r '.head_branch // ""' <<<"$info")" = "$default" ] || { log "run $run pushed another branch than $default"; return 1; }
      ;;
    pull_request)
      [ -n "$WRITER" ] || { log "run $run is a pull request, and no --build-cache-writer is set"; return 1; }
      [ "$(jq -r '.triggering_actor.login // ""' <<<"$info")" = "$WRITER" ] || { log "run $run was not started by $WRITER"; return 1; }
      pulls="$(jq -r '[.pull_requests[]?.number] | map(tostring) | join(" ")' <<<"$info")"
      [ -n "$pulls" ] || { log "run $run names no pull request"; return 1; }
      for number in $pulls; do
        case "$number" in ''|*[!0-9]*) return 1 ;; esac
        pull="$(timeout 20 gh api "repos/$REPO/pulls/$number")" || return 1
        jq -e --arg writer "$WRITER" --arg sha "$(jq -r '.head_sha // ""' <<<"$info")" \
          '.user.login == $writer and .head.sha == $sha' >/dev/null <<<"$pull" || { log "pull request $number of run $run is not $WRITER's"; return 1; }
      done
      ;;
    *) log "run $run is neither a push nor a pull request"; return 1 ;;
  esac
}

# Unpacks $1 (a tar of regular files and directories only) as the entry $2, with the manifest
# readers check every file against. Fails, leaving nothing, on anything else.
admit() {
  local tar="$1" key="$2" staging types
  types="$(timeout 60 tar -tvf "$tar" | cut -c1 | sort -u | tr -d '\n')" || return 1
  case "$types" in ''|*[!d-]*) log "refused $key: the build holds something other than files and directories"; return 1 ;; esac
  # its own file of that name would be taken for the manifest
  if timeout 60 tar -tf "$tar" | grep -qxE '(\./)?\.manifest'; then log "refused $key: the build holds a .manifest of its own"; return 1; fi
  staging="$(mktemp -d "$ENTRIES/.new-XXXXXX")" || return 1
  if timeout 60 tar -xf "$tar" -C "$staging" --no-same-owner --no-same-permissions &&
    [ -z "$(find "$staging" -mindepth 1 ! -type f ! -type d -print -quit)" ] &&
    (cd "$staging" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) > "$ENTRIES/.manifest-$key" &&
    [ ! -e "$staging/.manifest" ] && mv "$ENTRIES/.manifest-$key" "$staging/.manifest" &&
    chmod -R a+rX,go-w "$staging" &&
    mv -T "$staging" "$ENTRIES/$key" 2>/dev/null; then
    return 0
  fi
  rm -rf "$staging" "$ENTRIES/.manifest-$key"
  return 1
}

# Keeps the most recently used entries within MAX_MB.
evict() {
  local total=0 limit=$(( 10#$MAX_MB * 1024 * 1024 )) line size path
  find "$ENTRIES" -mindepth 1 -maxdepth 1 -name '.new-*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  while read -r line; do
    path="${line#* }"
    size="$(du -sb "$path" | cut -f1)" || continue
    total=$((total + size))
    if [ "$total" -gt "$limit" ]; then rm -rf "$path"; rm -f "$USED/${path##*/}"; fi
  done < <(for path in "$ENTRIES"/*; do
    [ -d "$path" ] || continue
    used="$(stat -c %Y "$path")"
    if [ -f "$USED/${path##*/}" ]; then stamp="$(stat -c %Y "$USED/${path##*/}")"; [ "$stamp" -gt "$used" ] && used="$stamp"; fi
    echo "$used $path"
  done | sort -rn)
}

# The outboxes' files are moved into this host user's own directory before anything reads them, so
# the job cannot change them between a check and a read (a FIFO swapped in, say).
# Each claim gets a directory of its own there: what a job swapped in that this user cannot delete
# (a directory of the runners' user) stays behind for run.sh to remove, and blocks no later claim.
TAKEN="$OUTBOXES/.taken"
mkdir -p "$TAKEN" && chmod 0700 "$TAKEN"
take() { [ -f "$1" ] && [ ! -L "$1" ] && mv -T "$1" "$2" 2>/dev/null && [ -f "$2" ] && [ ! -L "$2" ]; }

promoted=0
for name in "$@"; do
  outbox="$OUTBOXES/$name"
  [ -d "$outbox" ] || continue
  for used in "$outbox"/used-*; do
    [ -e "$used" ] || [ -L "$used" ] || continue
    key="${used##*/used-}"
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]] && [ -d "$ENTRIES/$key" ]; then mkdir -p "$USED" && touch "$USED/$key"; fi
    rm -rf "$used" 2>/dev/null || true
  done
  # One claim per outbox per pass (a job builds one commit): each costs GitHub calls on this user's
  # token, which also registers the runners, so the rest are deleted unread.
  judged=0
  for claim in "$outbox"/*.claim; do
    [ -e "$claim" ] || [ -L "$claim" ] || continue
    file="${claim##*/}" key="${file%.claim}" tar="$outbox/${file%.claim}.tar"
    run="" attempt=""
    if [ "$judged" = 1 ]; then
      rm -rf "$claim" "$tar" 2>/dev/null || true
      if [[ "$key" =~ ^[0-9a-f]{64}$ ]]; then mkdir "$outbox/judged-$key" 2>/dev/null || true; fi
      continue
    fi
    judged=1
    work="$(mktemp -d "$TAKEN/XXXXXX")" || continue
    # only plain files, and small claims: a link could make this host user read or keep a file of its own
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]] && take "$tar" "$work/build.tar" && take "$claim" "$work/claim" &&
      [ "$(stat -c %s "$work/claim")" -le 64 ]; then
      read -r run attempt < "$work/claim" || true
    fi
    if [[ "$run" =~ ^[0-9]{1,20}$ && "$attempt" =~ ^[0-9]{1,5}$ ]] && [ ! -e "$ENTRIES/$key" ] &&
      [ "$(stat -c %s "$work/build.tar")" -le $(( 10#$MAX_MB * 1024 * 1024 )) ] && trusted "$name" "$run" "$attempt"; then
      if admit "$work/build.tar" "$key"; then log "cached $key from $name (run $run)"; promoted=1; fi
    fi
    # whatever it is (a directory named like a claim included): it must not stop the other slots
    rm -rf "$claim" "$tar" "$work" 2>/dev/null || true
    # Only now, the entry in place or the build refused: the job that built it may let the others go.
    # A directory, which mkdir never makes through a link the job could have put at that name.
    if [[ "$key" =~ ^[0-9a-f]{64}$ ]]; then mkdir "$outbox/judged-$key" 2>/dev/null || true; fi
  done
done
if [ "$promoted" = 1 ]; then evict; fi
