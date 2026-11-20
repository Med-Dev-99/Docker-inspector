#!/bin/sh
# Launcher used by the desktop entry. Builds the UI on first run.
cd "$(dirname "$0")/.." || exit 1
unset ELECTRON_RUN_AS_NODE
[ -f dist/index.html ] || ./node_modules/.bin/vite build >/dev/null 2>&1
exec ./node_modules/.bin/electron . "$@"
