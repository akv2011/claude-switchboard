#!/bin/bash
# Install the built app and the recorder snapshot it relies on. scripts/setup.sh runs this.
# Run after `bun run gui` on macOS. The recorder runs from ~/.claude-switchboard/recorder,
# a copy of src/ taken here, never from the source tree: launchd on macOS, a systemd user
# timer on Linux.
#
#   scripts/install.sh                  the window and the recorder (macOS)
#   scripts/install.sh --recorder-only  the recorder alone (Linux, or a Mac without the window)
set -euo pipefail
cd "$(dirname "$0")/.."
recorder_only=0; [ "${1:-}" = --recorder-only ] && recorder_only=1
[ "$(uname -s)" = Darwin ] || recorder_only=1
app="build/stable-macos-arm64/Claude Switchboard.app"
if [ "$recorder_only" = 0 ] && [ ! -d "$app" ]; then echo "install: build first (bun run gui)" >&2; exit 1; fi

node=$(command -v node) || { echo "install: Node.js 20 or later is needed for the recorder" >&2; exit 1; }
snap="$HOME/.claude-switchboard/recorder"
mkdir -p "$snap"
rsync -a --delete src/ "$snap/src/"
cp package.json "$snap/package.json"   # "type": "module" for node
"$node" -e "import('$snap/src/recorder/launchd.js').then((l) => { l.install(); console.log('recorder runs', l.snapshotEntry()); })"
[ "$recorder_only" = 1 ] && exit 0

# The launcher ignores SIGTERM.
pkill -9 -f "Claude Switchboard.app" || true
rm -rf "/Applications/Claude Switchboard.app"
cp -R "$app" /Applications/
open -a "Claude Switchboard"
echo "installed /Applications/Claude Switchboard.app"
