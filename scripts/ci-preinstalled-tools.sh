#!/usr/bin/env bash
# Self-hosted jobs use the immutable runner image, never a download fallback.
set -euo pipefail

fail() {
  echo "::error::$* Rebuild scripts/self-hosted-runner/Dockerfile before retrying." >&2
  exit 1
}

[[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]] ||
  fail "The prepared CI image requires Linux x64."
: "${EXPECTED_BUN_VERSION:?EXPECTED_BUN_VERSION is required}"

[[ "$(bun --version)" == "$EXPECTED_BUN_VERSION" ]] ||
  fail "The runner image must provide Bun $EXPECTED_BUN_VERSION."

if [[ "${NEED_NODE:-false}" == true ]]; then
  [[ "$(node --version)" == v22.* ]] ||
    fail "The runner image must provide Node 22."
fi

if [[ "${NEED_HERDR:-false}" == true ]]; then
  herdr_path="$(command -v herdr)" || fail "The runner image must provide herdr 0.9.3."
  echo "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7  $herdr_path" |
    sha256sum --check --status || fail "The runner image must provide the checksum-pinned herdr 0.9.3."
fi

echo "Using verified tools from the self-hosted runner image"
