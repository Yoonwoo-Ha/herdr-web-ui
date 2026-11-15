#!/bin/sh
# Puts the pinned hc-tui source in ./upstream with ./patches applied, so that cargo can build this
# crate against it (Cargo.toml names upstream/crates/hc-tui and upstream/crates/hc-proto by path).
#
#   crates/ovis-tui/prepare.sh
#
# It fetches one commit (hc-tui.pin names it) and that commit's Ghostty submodule, checks both commit
# ids, applies every patch and commits them there, so a clean `git status` in ./upstream means the
# tree is exactly "the pin plus our patches". A tree that is already that is left alone. A tree with
# work of its own (see work_in: edits, untracked or kept ignored files, branches, a stash, another
# worktree, commits, in it or in its Ghostty submodule) is never deleted: the script stops and says so. A new tree is made beside the old one and replaces it only once whole,
# so a failed fetch leaves the old tree as it was.
#
# HC_TUI_REPO_OVERRIDE names another place to fetch the same commit from (a local clone, a mirror).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -n "$here" ] && [ -f "$here/hc-tui.pin" ] || { echo "prepare.sh: hc-tui.pin is missing beside the script" >&2; exit 1; }
# shellcheck disable=SC1091
. "$here/hc-tui.pin"
dest="$here/upstream"
stamp="$dest/.ovis-prepared"

# what the tree must be made from: the pin and the bytes of every patch, in order
if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum; }
elif command -v shasum >/dev/null 2>&1; then hash() { shasum -a 256; }
else echo "prepare.sh: needs sha256sum or shasum" >&2; exit 1
fi
want=$( { printf '%s %s\n' "$HC_TUI_COMMIT" "$GHOSTTY_COMMIT"; for patch in "$here"/patches/*.patch; do [ -f "$patch" ] && cat "$patch"; done; } | hash | cut -d' ' -f1)
[ -n "$want" ] || { echo "prepare.sh: could not hash the pin and the patches" >&2; exit 1; }

# Prints, one per line, what in the tree at $1 is someone's work; prints nothing for a tree this
# script made and nobody changed since. Build caches are not work: target/ in upstream/, and
# zig-pkg/, zig-out/ and the Zig caches in vendor/ghostty.
work_in() {
  d=$1
  [ -n "$(ls -A "$d" 2>/dev/null)" ] || return 0
  if [ ! -d "$d/.git" ]; then
    echo "it is not a checkout this script made"
    return 0
  fi
  made=$(sed -n 2p "$d/.ovis-prepared" 2>/dev/null || true)
  head=$(git -C "$d" rev-parse HEAD 2>/dev/null || true)
  [ "$head" = "$made" ] || [ "$head" = "$HC_TUI_COMMIT" ] || echo "HEAD is $head, with commits not exported to patches/"
  # the flags override a status.showUntrackedFiles=no in that checkout's config
  git -C "$d" status --porcelain --untracked-files=normal --ignore-submodules=all | grep -v -x '?? .ovis-prepared' | sed 's/^/changed: /'
  git -C "$d" status --porcelain --untracked-files=normal --ignored=matching --ignore-submodules=all | sed -n 's/^!! //p' | grep -v -E '^target/' | sed 's/^/ignored file kept: /'
  # the script makes no branch, tag, stash or other worktree: any is someone's
  git -C "$d" for-each-ref --format='%(refname)' refs/heads refs/tags refs/stash | sed 's/^/ref: /'
  [ "$(git -C "$d" worktree list --porcelain | grep -c '^worktree ')" -le 1 ] || echo "another worktree of it"
  # a commit only the reflog still holds (made, then reset away): the script's own are the pin and its commit
  git -C "$d" rev-list --reflog --not "$HC_TUI_COMMIT" ${made:+"$made"} -- 2>/dev/null | head -1 | sed 's/^/commit only its reflog holds: /'
  # a file flagged skip-worktree or assume-unchanged hides its edits from status
  git -C "$d" ls-files -v | grep -E '^(S|[a-z]) ' | sed 's/^[^ ]* /file whose edits git hides: /'
  s="$d/vendor/ghostty"
  [ -e "$s/.git" ] || return 0
  # compared with the commit this tree itself records, which differs from the new pin once the pin moves
  recorded=$(git -C "$d" ls-tree HEAD vendor/ghostty | awk '{print $3}')
  sub=$(git -C "$s" rev-parse HEAD 2>/dev/null || true)
  [ "$sub" = "$recorded" ] || echo "vendor/ghostty: HEAD is $sub, not the commit this tree records ($recorded)"
  git -C "$s" status --porcelain --untracked-files=normal | sed 's|^|vendor/ghostty changed: |'
  git -C "$s" status --porcelain --untracked-files=normal --ignored=matching | sed -n 's/^!! //p' | grep -v -E '^(zig-pkg|zig-out|\.zig-cache|zig-cache)/' | sed 's|^|vendor/ghostty ignored file kept: |'
  git -C "$s" for-each-ref --format='%(refname)' refs/stash | sed 's|^|vendor/ghostty: |'
  # its clone makes a branch at the remote's head and may follow its tags: only commits no remote
  # has (on a branch, a tag, or held by the reflog alone) are work
  git -C "$s" rev-list --branches --tags --reflog --not --remotes ${recorded:+"$recorded"} -- 2>/dev/null | head -1 | sed 's|^|vendor/ghostty: unpushed commit |'
  [ "$(git -C "$s" worktree list --porcelain | grep -c '^worktree ')" -le 1 ] || echo "vendor/ghostty: another worktree of it"
  git -C "$s" ls-files -v | grep -E '^(S|[a-z]) ' | sed 's|^[^ ]* |vendor/ghostty: file whose edits git hides: |'
}

refuse() {
  echo "prepare.sh: $dest has work of its own$1. Export it (git -C upstream format-patch), or move the folder away, then run this again:" >&2
  printf '%s\n' "$2" | head -10 | sed 's/^/  /' >&2
  exit 1
}

if [ -e "$dest" ]; then
  work=$(work_in "$dest")
  [ -z "$work" ] || refuse "" "$work"
  # reused only when it is the very commit made for these patches: the bare pin is made again
  if [ -d "$dest/.git" ] && [ "$(git -C "$dest" rev-parse HEAD)" = "$(sed -n 2p "$stamp" 2>/dev/null || true)" ] && [ "$(sed -n 1p "$stamp" 2>/dev/null || true)" = "$want" ]; then
    exit 0
  fi
fi

# made beside the old tree, which it replaces only once whole
new="$here/.upstream.new.$$"
trap 'rm -rf "$new"' EXIT
rm -rf "$new"
mkdir -p "$new"
git -C "$new" init --quiet
git -C "$new" fetch --quiet --depth 1 "${HC_TUI_REPO_OVERRIDE:-$HC_TUI_REPO}" "$HC_TUI_COMMIT"
git -C "$new" checkout --quiet --detach FETCH_HEAD
got=$(git -C "$new" rev-parse HEAD)
[ "$got" = "$HC_TUI_COMMIT" ] || { echo "prepare.sh: fetched $got, not the pinned $HC_TUI_COMMIT" >&2; exit 1; }
git -C "$new" submodule --quiet update --init --depth 1
got=$(git -C "$new/vendor/ghostty" rev-parse HEAD)
[ "$got" = "$GHOSTTY_COMMIT" ] || { echo "prepare.sh: vendor/ghostty is $got, not the pinned $GHOSTTY_COMMIT" >&2; exit 1; }

applied=0
for patch in "$here"/patches/*.patch; do
  [ -f "$patch" ] || continue
  git -C "$new" apply --index "$patch" || { echo "prepare.sh: $patch does not apply to $HC_TUI_COMMIT" >&2; exit 1; }
  applied=$((applied + 1))
done
if [ "$applied" -gt 0 ]; then
  git -C "$new" -c user.name=ovis-tui -c user.email=ovis-tui@users.noreply.github.com commit --quiet -m "Ovis patches on hc-tui $HC_TUI_TAG ($applied)"
fi
printf '%s\n%s\n' "$want" "$(git -C "$new" rev-parse HEAD)" > "$new/.ovis-prepared"
# looked at again just before it goes: work may have been done in it while this one was made
if [ -e "$dest" ]; then
  work=$(work_in "$dest")
  [ -z "$work" ] || refuse " (made while this ran; nothing was replaced)" "$work"
fi
rm -rf "$dest"
mv "$new" "$dest"
trap - EXIT
echo "prepare.sh: hc-tui $HC_TUI_TAG ($HC_TUI_COMMIT) with $applied patch(es) is in $dest"
