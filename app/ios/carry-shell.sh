#!/bin/sh
# The App target's "Carry the shell" phase, after its resources are copied and before the app is signed: puts the shell
# `bun run build:web` packed into app/bundled-shell (app/scripts/bundled-shell.ts: shell/ and shell-policy.json) into the
# app as `bundled-shell`, where ShellHost.swift reads it, in a build that serves the shell itself (OVIS_APP_SHELL
# `bundled`); and takes out one an earlier build of the same folder left, so a build that loads the shell from the
# network carries none. That folder is absent in such a build, which is why the project does not reference it.
# In the app the shell's two documents go by names no host answers as a page (index.shellpage, render.shellpage:
# ShellRoute.pageFile and renderFile): Capacitor answers the app's own host with any file its folder reaches, typed by
# its extension, and render.html under that host would be the render host with no policy.
# check-hosted-origin.sh has already failed a build whose folder is not what OVIS_APP_SHELL says.
# Xcode runs this phase while it indexes too (ACTION `indexbuild`), beside a build that uses the same products folder:
# an index needs no shell, and taking the folder out under a build would fail it now and then, so it does nothing then.
# Usage: carry-shell.sh <OVIS_APP_SHELL> <app/bundled-shell> <the built app's resources folder> <ACTION>
if [ "$4" = "indexbuild" ]; then exit 0; fi
rm -rf "$3/bundled-shell"
if [ "$1" = "bundled" ]; then
  cp -R "$2" "$3/bundled-shell" || { echo "error: could not copy $2 into the app"; exit 1; }
  for page in index render; do
    mv "$3/bundled-shell/shell/$page.html" "$3/bundled-shell/shell/$page.shellpage" || { echo "error: $2/shell holds no $page.html"; exit 1; }
  done
  # no other page of the shell's is left under a name a host would answer as one
  left=$(find "$3/bundled-shell/shell" -name '*.html' ! -path '*/assets/*' | head -1)
  if [ -n "$left" ]; then
    echo "error: the carried shell holds a page the app does not know how to answer ($left): ShellRoute and carry-shell.sh name index.html and render.html alone"
    exit 1
  fi
fi
