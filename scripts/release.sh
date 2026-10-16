#!/bin/bash
# Build a release into dist/: the app zipped, the VS Code extension, checksums.
# Usage: scripts/release.sh   (version comes from package.json)
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
echo "release $version"

npm test
bun run gui
(cd vscode-bridge && bunx --bun @vscode/vsce@3 package --no-dependencies --skip-license --allow-missing-repository -o "../dist/csr-bridge-$version.vsix")

mkdir -p dist
app="build/stable-macos-arm64/Claude Session Restore.app"
[ -d "$app" ] || { echo "release: no build at $app" >&2; exit 1; }
ditto -c -k --keepParent "$app" "dist/Claude-Session-Restore-$version-macos-arm64.zip"
(cd dist && shasum -a 256 ./*"$version"* > SHA256SUMS && cat SHA256SUMS)
echo "release $version is in dist/"
