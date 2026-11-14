#!/usr/bin/env bash
# Builds the zip a web portal hosts (g2-7): a clean production build of this
# client, without source maps and without privacy.html, zipped with index.html
# at its root. Run from anywhere; usage:
#
#   tools/package-portal.sh <crazygames|itch> [--allow-dirty]
#
# Writes outputs/<portal>/plunderbots-<portal>-<shortsha>.zip (untracked) and
# prints its file count and bytes. Fails over CrazyGames' limits
# (docs.crazygames.com/requirements/technical, read 2026-11-14): initial
# download <= 50 MB and <= 1500 files; warns over 20 MB (their mobile
# homepage). The whole package counts as the initial download, an upper bound.
#
# The package is the same build for every portal: the client tells where it
# runs from its page's host (src/net/portal.ts). The portal name only names the
# zip. privacy.html is left out because only our Worker serves it (/privacy);
# inside a portal the client links to our site's absolute address
# (privacyUrl in src/net/portal.ts).
#
# SERVER_URL defaults to production; set it to build against another server.
# Starts no server and opens no port. Docs: docs/dev-and-ops.md, "Portal builds".
set -euo pipefail

PROD_SERVER_URL='https://server-production-e1da2.up.railway.app'
MAX_BYTES=$((50 * 1000 * 1000))
MOBILE_BYTES=$((20 * 1000 * 1000))
MAX_FILES=1500

usage () { echo "usage: $0 <crazygames|itch> [--allow-dirty]" >&2; exit 2; }

portal=''
allow_dirty=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=1 ;;
    crazygames|itch) [ -z "$portal" ] || usage; portal="$arg" ;;
    *) usage ;;
  esac
done
[ -n "$portal" ] || usage

client="$(cd "$(dirname "$0")/.." && pwd)"
cd "$client"

# The build reads only this package, so only its tree has to be clean. A dirty
# build is not the commit it is named after: its zip and release get -dirty.
sha="$(git rev-parse HEAD)"
short="$(git rev-parse --short=7 HEAD)"
if [ -n "$(git status --porcelain -- .)" ]; then
  if [ "$allow_dirty" = 1 ]; then
    echo "warning: uncommitted changes in plunder-land-client; packaging them as $short-dirty" >&2
    sha="$sha-dirty"
    short="$short-dirty"
  else
    git status --short -- . >&2
    echo "error: plunder-land-client has uncommitted changes; commit them or pass --allow-dirty" >&2
    exit 1
  fi
fi

[ -d node_modules ] || { echo "error: no node_modules; run npm ci in plunder-land-client first" >&2; exit 1; }

server_url="${SERVER_URL:-$PROD_SERVER_URL}"
echo "building $short for $portal against $server_url"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/stage"
build_log="$work/build.log"
mkdir "$stage"

# webpack's output.clean empties dist first. WORKERS_CI_COMMIT_SHA is Sentry's
# release (webpack.config.js, __RELEASE__); unset, the release is empty.
# Quiet on success; on failure the build's own output (webpack prints its
# errors on stdout), its last BUILD_LOG_LINES lines, so the cause is visible.
BUILD_LOG_LINES=80
if ! SERVER_URL="$server_url" WORKERS_CI_COMMIT_SHA="$sha" npm run --silent build >"$build_log" 2>&1; then
  lines=$(wc -l < "$build_log" | tr -d ' ')
  if [ "$lines" -gt "$BUILD_LOG_LINES" ]; then
    echo "... ($((lines - BUILD_LOG_LINES)) earlier lines of build output not shown)" >&2
  fi
  tail -n "$BUILD_LOG_LINES" "$build_log" >&2
  echo "error: the build failed (output above)" >&2
  exit 1
fi

cp -R dist/. "$stage/"
find "$stage" -name '*.map' -type f -delete
rm -f "$stage/privacy.html"
[ -f "$stage/index.html" ] || { echo "error: the build wrote no index.html" >&2; exit 1; }

# CrazyGames: relative paths only. A root-relative or protocol-relative
# src/href in index.html would load from their host's root, not the game's.
# The built index.html is minified, so its attributes may be unquoted.
if grep -Eq "(src|href)=[\"']?/" "$stage/index.html"; then
  grep -Eo "(src|href)=[\"']?/[^ >]*" "$stage/index.html" >&2
  echo "error: index.html references an absolute path" >&2
  exit 1
fi

files=$(find "$stage" -type f | wc -l | tr -d ' ')
bytes=$(find "$stage" -type f -exec cat {} + | wc -c | tr -d ' ')
main_js=$(cd "$stage" && ls main.*.js)
main_bytes=$(wc -c < "$stage/$main_js" | tr -d ' ')
main_gz=$(gzip -9 -c "$stage/$main_js" | wc -c | tr -d ' ')

out_dir="$client/outputs/$portal"
zip_path="$out_dir/plunderbots-$portal-$short.zip"
mkdir -p "$out_dir"
# zip adds to an existing archive, so a stale file would survive in it.
rm -f "$zip_path"
(cd "$stage" && zip -q -r -X "$zip_path" .)
zip_bytes=$(wc -c < "$zip_path" | tr -d ' ')

echo "zip:      $zip_path"
echo "files:    $files"
echo "bytes:    $bytes (unzipped), $zip_bytes zipped"
echo "main js:  $main_js $main_bytes bytes, $main_gz gzipped (gzip -9)"
echo "release:  $sha"

status=0
if [ "$files" -gt "$MAX_FILES" ]; then
  echo "error: $files files, over CrazyGames' $MAX_FILES" >&2; status=1
fi
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "error: $bytes bytes, over CrazyGames' 50 MB initial download" >&2; status=1
elif [ "$bytes" -gt "$MOBILE_BYTES" ]; then
  echo "warning: $bytes bytes, over CrazyGames' 20 MB for the mobile homepage" >&2
fi
if [ "$status" != 0 ]; then rm -f "$zip_path"; exit "$status"; fi
