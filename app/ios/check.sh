#!/bin/sh
# The iOS app's own checks, which no CI job runs: on a Mac with Xcode, before an upload (app/store/ios.md) and after a
# change under app/ios. The decisions the app only carries out are in three Swift packages (`swift test`): which screen
# opens and what a page may ask (OvisHomeCore: the routes and policies of the shell inside the app, the bridge's gate),
# SSH (OvisSshCore) and push (OvisPushCore); two files of the App target have checks of their own.
# Each step is a command of its own whose failure ends the script: one after `&&`, or in front of a pipe, would not
# (`set -e` looks past both), and the last line would say all passed.
# Usage: sh app/ios/check.sh
set -e
ios=$(cd "$(dirname "$0")" && pwd)
# runs "$@", and on failure prints the end of what it said and ends the script; `said` holds what it said
run() {
  what=$1; shift
  if ! said=$("$@" 2>&1); then
    printf '%s\n' "$said" | tail -40
    echo "error: $what failed"
    exit 1
  fi
}
for package in OvisHomeCore OvisSshCore OvisPushCore; do
  echo "== swift test: $package"
  run "$package's tests" swift test --package-path "$ios/$package"
  # XCTest's own count: the line after it is Swift Testing's, which finds none here
  printf '%s\n' "$said" | grep -E 'Executed [0-9]+ tests' | tail -1
done
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
echo "== ScopePath"
run "compiling the ScopePath check" swiftc "$ios/App/App/ScopePath.swift" "$ios/ScopePathCheck/main.swift" -o "$out/scope"
run "the ScopePath check" "$out/scope"
printf '%s\n' "$said" | tail -1
echo "== OpeningWatch"
run "compiling the OpeningWatch check" swiftc "$ios/App/App/OpeningWatch.swift" "$ios/OpeningWatchCheck/main.swift" -o "$out/watch"
run "the OpeningWatch check" "$out/watch"
printf '%s\n' "$said" | tail -1
echo "the iOS app's checks passed"
