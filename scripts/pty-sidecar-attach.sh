#!/bin/bash
# Attaches a built Rust PTY host set, with the ACP keeper built beside it (scripts/pty-sidecar.ts build + manifest), to a published release:
# .github/workflows/pty-sidecar-attach.yml runs it, and scripts/pty-sidecar.test.ts runs it with a fake gh.
#   pty-sidecar-attach.sh <vX.Y.Z> <dir holding the set>   (GH_TOKEN and GH_REPO as gh reads them)
# Nothing is uploaded unless the release's asset list was read: a lookup that fails (an HTTP 502, a
# rate limit) must not be taken for "no host yet", or the binaries of a complete set would be replaced
# while its manifest stayed.
set -euo pipefail
tag=$1 dir=$2
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::'$tag' is not a release tag (vX.Y.Z)." >&2
  exit 1
fi
version=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$dir/ovis-pty-sidecar.json")
if [ "v$version" != "$tag" ]; then
  echo "::error::$tag's package.json says $version." >&2
  exit 1
fi
if ! assets=$(gh release view "$tag" --json assets --jq '.assets[].name'); then
  echo "::error::could not read $tag's assets, so nothing was uploaded; run this again." >&2
  exit 1
fi
# a complete set already attached stays: replacing it would let installs see a mix of two builds
if printf '%s\n' "$assets" | grep -qx ovis-pty-sidecar.json; then
  echo "::error::$tag already has the Rust PTY host." >&2
  exit 1
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/set" "$scratch/docs"
setdir="$scratch/set"
hosts=(ovis-pty-sidecar-{linux-x64,linux-arm64,darwin-universal})
keepers=(ovis-acp-keeper-{linux-x64,linux-arm64,darwin-universal})
for file in "${hosts[@]}" ovis-pty-sidecar.json; do cp "$dir/$file" "$setdir/$file"; done
if grep -qx ovis-acp-keeper-server.json <<<"$assets"; then
  for file in ovis-server.json ovis-server.json.sig ovis-acp-keeper-server.json ovis-acp-keeper-server.json.sig; do
    gh release download "$tag" --pattern "$file" --output "$scratch/docs/$file"
  done
  for file in "${keepers[@]}" ovis-acp-keeper.json SHA256SUMS; do cp "$dir/$file" "$setdir/$file"; done
  bun "$(dirname "$0")/verify-repair.ts" "$setdir" "$scratch/docs" "$version"
  gh release upload "$tag" "${hosts[@]/#/$setdir/}" "${keepers[@]/#/$setdir/}" "$setdir/SHA256SUMS" --clobber
  gh release upload "$tag" "$setdir/ovis-acp-keeper.json" --clobber
else
  if grep -q '^ovis-acp-keeper' <<<"$assets"; then echo "Cannot repair an existing keeper without its signed companion" >&2; exit 1; fi
  # Legacy host-only releases have no signed keeper identity. Never attach a keeper to them.
  (cd "$setdir" && bun -e 'for (const f of process.argv.slice(1)) console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(f).bytes()).digest("hex") + "  " + f)' "${hosts[@]}" >SHA256SUMS)
  gh release upload "$tag" "${hosts[@]/#/$setdir/}" "$setdir/SHA256SUMS" --clobber
fi
gh release upload "$tag" "$setdir/ovis-pty-sidecar.json"
