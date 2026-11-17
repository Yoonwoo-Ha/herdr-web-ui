#!/bin/bash
# Attaches a built Rust PTY host set (scripts/pty-sidecar.ts build + manifest) to a published release:
# .github/workflows/pty-sidecar-attach.yml runs it, and scripts/pty-sidecar.test.ts runs it with a fake gh.
#   pty-sidecar-attach.sh <vX.Y.Z> <dir holding the set>   (GH_TOKEN and GH_REPO as gh reads them)
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
if printf '%s\n' "$assets" | grep -qx ovis-pty-sidecar.json; then
  echo "::error::$tag already has the Rust PTY host." >&2
  exit 1
fi
gh release upload "$tag" "$dir"/ovis-pty-sidecar-* "$dir/SHA256SUMS" --clobber
gh release upload "$tag" "$dir/ovis-pty-sidecar.json"
