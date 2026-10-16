#!/bin/bash
# Install the built app and the recorder snapshot it relies on.
# Run after `bun run gui`. The recorder runs from ~/.claude-restore/recorder,
# a copy of src/ taken here, never from the source tree.
set -euo pipefail
cd "$(dirname "$0")/.."
app="build/stable-macos-arm64/Claude Session Restore.app"
[ -d "$app" ] || { echo "install: build first (bun run gui)" >&2; exit 1; }

node=$(command -v node) || { echo "install: Node.js 20 or later is needed for the recorder" >&2; exit 1; }
snap="$HOME/.claude-restore/recorder"
mkdir -p "$snap"
rsync -a --delete src/ "$snap/src/"
cp package.json "$snap/package.json"   # "type": "module" for node
"$node" -e "import('$snap/src/recorder/launchd.js').then((l) => { l.install(); console.log('recorder runs', l.SNAPSHOT_ENTRY); })"

# The launcher ignores SIGTERM.
pkill -9 -f "Claude Session Restore.app" || true
rm -rf "/Applications/Claude Session Restore.app"
cp -R "$app" /Applications/
open -a "Claude Session Restore"
echo "installed /Applications/Claude Session Restore.app"
