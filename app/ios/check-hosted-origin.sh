#!/bin/sh
# Fails the App target's build ("Check the hosted origin" phase) when the pages copied into it by `bun x cap sync ios`
# name another hosted origin than OVIS_APP_ORIGIN, the one the native code trusts (OvisAppOrigin), or were built for
# another first screen than OVIS_APP_HOME, the one it opens (OvisAppHome): `bun run build:web` for the other platform's
# build rewrites hosted-origin.generated.xcconfig without copying pages here.
# It also fails a build whose shell is not where OVIS_APP_SHELL (OvisAppShell) says: `bundled` needs the shell that run
# packed into app/bundled-shell (which the "Carry the shell" phase copies into the app, carry-shell.sh), whole: the
# shell's own page with every file it starts with, the render host's file, and both policies, the render host's with
# a `sandbox` that does not hand the origin back; `hosted` none there. And an archive of the store app (Product > Archive, what an App Store upload is
# made from) that would load the shell from the network, which only a test build does, or whose shell is not a
# release's verified one (shell-provenance.json, as Gradle asks of the Android store app).
# Usage: check-hosted-origin.sh <the copied shell.js> <OVIS_APP_ORIGIN> <OVIS_APP_HOME> <OVIS_APP_SHELL>
#   <app/bundled-shell> <ACTION> <PRODUCT_BUNDLE_IDENTIFIER>
pages=$(sed -n 's/^export const APP_ORIGIN = "\([^"]*\)";$/\1/p' "$1" 2>/dev/null)
if [ "$pages" != "$2" ]; then
  echo "error: $1 names ${pages:-no hosted origin} and OVIS_APP_ORIGIN is ${2:-empty}: run bun run build:web with the OVIS_APP_URL this build is for, then bun x cap sync ios"
  exit 1
fi
home=$(sed -n 's/^export const APP_HOME = "\([^"]*\)";$/\1/p' "$1" 2>/dev/null)
if [ "$home" != "$3" ]; then
  echo "error: $1 was built for ${home:+the }${home:-no} first screen and OVIS_APP_HOME is ${3:-empty}: run bun run build:web with the OVIS_APP_HOME this build is for, then bun x cap sync ios"
  exit 1
fi
case "$4" in
  bundled)
    for file in shell/index.html shell/render.html shell-policy.json; do
      if [ ! -f "$5/$file" ]; then
        echo "error: OVIS_APP_SHELL is bundled and $5 holds no $file: run bun run build:web (OVIS_APP_SHELL_DIR names the dist-shell to carry, else it builds one from this checkout). OVIS_APP_SHELL=hosted loads the shell from the network instead, never in a store build"
        exit 1
      fi
    done
    # the page is the shell's, and every file it starts with is there: a partial copy would open blank
    if ! grep -q '<meta name="ovis-shell"' "$5/shell/index.html"; then
      echo "error: $5/shell/index.html is not the shell's (it lacks <meta name=\"ovis-shell\">): run bun run build:web"
      exit 1
    fi
    for asset in $(grep -o '\(src\|href\)="/assets/[^"?#]*' "$5/shell/index.html" | sed 's/^[a-z]*="\///' | sort -u); do
      if [ ! -f "$5/shell/$asset" ]; then
        echo "error: the carried shell lacks $asset, which its index.html starts with, so the app would open blank: run bun run build:web"
        exit 1
      fi
    done
    # both policies, as packShell writes them (one line, `page` then `render`), and the render host's takes a page's
    # origin away: the app sends them as they are, and serves no shell without them (ShellRoute.policies)
    policy=$(sed -n 's/^{"page":"\([^"\\]\{1,\}\)","render":"\([^"\\]\{1,\}\)"}$/\2/p' "$5/shell-policy.json")
    lower=$(printf '%s' "$policy" | tr 'A-Z' 'a-z')
    case "; $lower;" in
      *"; sandbox;"*|*"; sandbox "*) ;;
      *)
        echo "error: $5/shell-policy.json does not hold the shell's two policies, or its render policy has no sandbox: run bun run build:web"
        exit 1;;
    esac
    # a sandbox that gives the origin back takes nothing away: a page drawn by the render host would be the shell's
    # origin (ShellRoute.sandboxed refuses it when the app starts, too)
    if printf '%s' "$lower" | tr ';' '\n' | grep -E '^[[:space:]]*sandbox([[:space:]]|$)' | grep -q 'allow-same-origin'; then
      echo "error: $5/shell-policy.json's render policy has allow-same-origin in its sandbox, which leaves a rendered page the shell's origin: carry a shell whose _headers gives the render host \`sandbox allow-scripts\`"
      exit 1
    fi
    # the store app carries a release's verified shell (the tag's dist-shell.tar.gz, its SHA-256 checked before it was unpacked)
    if [ "$6" = "install" ] && [ "$7" = "sh.ovis.app" ]; then
      proof="$5/shell-provenance.json"
      if ! grep -q '"source":"release"' "$proof" 2>/dev/null || ! grep -Eq '"tag":"v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"' "$proof" || ! grep -Eq '"sha256":"[0-9a-f]{64}"' "$proof"; then
        echo "error: this archive of sh.ovis.app carries a shell that is no release's ($proof): run bun run build:web with OVIS_APP_SHELL_ARCHIVE=<the tag's dist-shell.tar.gz>, OVIS_APP_SHELL_SHA256=<its SHA-256> and OVIS_APP_SHELL_TAG=<the tag>, then bun x cap sync ios"
        exit 1
      fi
    fi
    # the shell is served at the hosted origin's host on the app's own scheme, where localhost is the app's own pages
    case "$2" in
      https://localhost|https://localhost:*)
        echo "error: OVIS_APP_SHELL is bundled and OVIS_APP_ORIGIN is $2: the app's own pages are at that host, so the shell cannot be served there. Build this origin with OVIS_APP_SHELL=hosted"
        exit 1;;
    esac;;
  hosted)
    if [ -e "$5" ]; then
      echo "error: OVIS_APP_SHELL is hosted and $5 still holds a shell from another run: run bun run build:web with the OVIS_APP_SHELL this build is for"
      exit 1
    fi
    if [ "$6" = "install" ] && [ "$7" = "sh.ovis.app" ]; then
      echo "error: this archive of sh.ovis.app would load the shell from the network (OVIS_APP_SHELL=hosted, the default with OVIS_APP_URL), which the store app never does. Run bun run build:web with OVIS_APP_SHELL_ARCHIVE=<the tag's dist-shell.tar.gz>, OVIS_APP_SHELL_SHA256=<its SHA-256> and OVIS_APP_SHELL_TAG=<the tag>, then bun x cap sync ios; a test build with another bundle ID may stay hosted"
      exit 1
    fi;;
  *)
    echo "error: OVIS_APP_SHELL is ${4:-empty}: it is bundled or hosted (app/ios/hosted-origin.xcconfig)"
    exit 1;;
esac
