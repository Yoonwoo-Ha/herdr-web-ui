#!/bin/sh
# Fails the App target's build ("Check the hosted origin" phase) when the pages copied into it by `bun x cap sync ios`
# name another hosted origin than OVIS_APP_ORIGIN, the one the native code trusts (OvisAppOrigin): `bun run build:web`
# for the other platform's build rewrites hosted-origin.generated.xcconfig without copying pages here.
# Usage: check-hosted-origin.sh <the copied shell.js> <OVIS_APP_ORIGIN>
pages=$(sed -n 's/^export const APP_ORIGIN = "\([^"]*\)";$/\1/p' "$1" 2>/dev/null)
if [ "$pages" != "$2" ]; then
  echo "error: $1 names ${pages:-no hosted origin} and OVIS_APP_ORIGIN is ${2:-empty}: run bun run build:web with the OVIS_APP_URL this build is for, then bun x cap sync ios"
  exit 1
fi
