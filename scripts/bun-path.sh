#!/bin/sh
with_bun_add() {
  case "$1" in
    *:*) return 0 ;;
    /*) ;;
    *) return 0 ;;
  esac
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
  esac
  if [ -d "$1" ]; then PATH="${PATH:+$PATH:}$1"; fi
  return 0
}
if [ -n "${WITH_BUN_EXTRA_DIRS:-}" ]; then
  with_bun_rest=$WITH_BUN_EXTRA_DIRS
  while [ -n "$with_bun_rest" ]; do
    case "$with_bun_rest" in
      *:*) with_bun_add "${with_bun_rest%%:*}"; with_bun_rest=${with_bun_rest#*:} ;;
      *) with_bun_add "$with_bun_rest"; with_bun_rest= ;;
    esac
  done
else
  if [ -n "${BUN_INSTALL:-}" ]; then with_bun_add "$BUN_INSTALL/bin"; fi
  if [ -n "${HOME:-}" ]; then
    with_bun_add "$HOME/.bun/bin"
    with_bun_add "$HOME/.local/bin"
    with_bun_add "$HOME/.local/share/mise/shims"
  fi
  with_bun_add /opt/homebrew/bin
  with_bun_add /usr/local/bin
fi
export PATH
