#!/usr/bin/env bash
# Rebuilds shared/ghostty/ghostty-vt.wasm: libghostty-vt from ghostty (MIT) at a pinned commit, with
# kitty-on-wasm.patch, which turns the Kitty graphics protocol on for wasm32-freestanding (upstream
# leaves it off there: no file medium and no PNG decoder). The patch refuses the file, temporary
# file and shared memory media, which have no meaning in a browser, and links ghostty's bundled
# wuffs PNG decoder, so a PNG a program sends is decoded inside the module.
# screen-generation.patch exposes the selection lifetime at the native switch/reset sites.
#
#   ZIG=/path/to/zig-0.17.1/zig scripts/ghostty-vt/build.sh
#
# Expected output sha256 (zig 0.17.1, x86_64-linux):
#   20e40e3cdbb33b7206c0b8bc9606fcfb412f01605d3302f1e85975ea832a6c3a
set -euo pipefail
GHOSTTY_COMMIT=e95bed63330cc921f3cf2fe3d14e024396b09d43
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
zig="${ZIG:-zig}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q ghostty
git -C "$work/ghostty" fetch -q --depth 1 https://github.com/ghostty-org/ghostty "$GHOSTTY_COMMIT"
git -C "$work/ghostty" checkout -q FETCH_HEAD
git -C "$work/ghostty" apply "$here/kitty-on-wasm.patch"
git -C "$work/ghostty" apply "$here/screen-generation.patch"
(cd "$work/ghostty" && "$zig" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall --prefix "$work/out")
cp "$work/out/bin/ghostty-vt.wasm" "$repo/shared/ghostty/ghostty-vt.wasm"
sha256sum "$repo/shared/ghostty/ghostty-vt.wasm"
