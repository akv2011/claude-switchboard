#!/bin/bash
# One step from a fresh clone: check what is needed, build, and install every piece this machine
# can run. Safe to run again: each step replaces what an earlier run installed.
#
#   scripts/setup.sh           check, test, build and install
#   scripts/setup.sh --check   only say what is missing
#
# It installs: the VS Code extensions (bridge, remote tabs, tab names), offload, claude-sync and
# lazy-mcp in ~/.local/bin, the window (macOS) and the recorder (launchd on macOS, a systemd user
# timer on Linux). With a remote in ~/.config/claude-switchboard/config.json it also writes
# offload's config and runs claude-sync every 5 minutes; with "relay": true it installs the
# relay's Claude Code hook. Nothing on the remote is touched; see docs/SHARED-COMPUTE.md for that.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)
os=$(uname -s)
bin=$HOME/.local/bin

missing=()
need() { command -v "$1" >/dev/null 2>&1 || missing+=("$1: $2"); }
need node "Node.js 20 or later (the recorder and the tools run on it)"
need bun "Bun, to build the window (https://bun.sh)"
need code "VS Code's code command (in VS Code: Shell Command: Install 'code' command in PATH)"
need rsync "rsync"
need jq "jq"
need python3 "Python 3 (the relay hook)"
need ssh "the OpenSSH client"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  missing+=("node: version 20 or later is needed, found $(node -v)")
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "setup: missing:"; printf '  %s\n' "${missing[@]}"
fi
if [ "${1:-}" = --check ]; then
  [ ${#missing[@]} -eq 0 ] && echo "setup: everything needed is installed"
  exit $((${#missing[@]} > 0))
fi
for hard in node bun; do command -v "$hard" >/dev/null || { echo "setup: $hard is required; install it and run this again" >&2; exit 1; }; done

step() { printf '\n== %s\n' "$1"; }

step "dependencies and tests"
bun install
npm test 2>&1 | tail -4

step "command-line tools in $bin"
# A copy, not a link: launchd cannot read ~/Desktop or ~/Documents on macOS, where checkouts often live.
mkdir -p "$bin"
install -m 755 tools/offload/offload tools/offload/claude-sync tools/offload/lazy-mcp "$bin/"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH to run offload and lazy-mcp by name" ;; esac

step "VS Code extensions"
if command -v code >/dev/null; then
  npm run bridge
  echo "installed; windows already open load them without a restart"
else
  echo "skipped: no code command. Install it from VS Code, then run: npm run bridge"
fi

step "the window and the recorder"
if [ "$os" = Darwin ]; then
  bun run gui
  scripts/install.sh
else
  # The window is built and run on macOS only so far; the recorder and the tools run here.
  scripts/install.sh --recorder-only
fi

# What config.json says, read by the app's own parser.
read -r host label root relay < <(node --input-type=module -e "
import { readConfig } from '$repo/src/core/config.js';
const c = readConfig();
for (const e of c.errors) console.error('config: ' + e);
console.log([c.remote?.host ?? '-', (c.remote?.label ?? '-').replace(/\s+/g, '_'), c.remote?.localProjectsRoot ?? '-', c.relay ? 1 : 0].join(' '));
")

if [ "$host" != - ]; then
  step "the remote: $label ($host)"
  conf=${XDG_CONFIG_HOME:-$HOME/.config}/offload/config
  if [ ! -f "$conf" ]; then
    mkdir -p "$(dirname "$conf")"
    printf 'host=%s\nprojects=%s\n' "$host" "$root" > "$conf"
    echo "wrote $conf"
  else
    echo "kept $conf as it is"
  fi
  if [ "$os" = Darwin ]; then
    plist=$HOME/Library/LaunchAgents/io.github.claude-switchboard.claude-sync.plist
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.claude-switchboard.claude-sync</string>
  <key>ProgramArguments</key><array><string>$bin/claude-sync</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/io.github.claude-switchboard.claude-sync" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
    mkdir -p "$units"
    printf '[Unit]\nDescription=Copy the Claude Code setup to %s and its transcripts back\n\n[Service]\nType=oneshot\nExecStart=%s/claude-sync\n' "$host" "$bin" > "$units/claude-switchboard-sync.service"
    printf '[Unit]\nDescription=claude-sync every 5 minutes\n\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=300\n\n[Install]\nWantedBy=timers.target\n' > "$units/claude-switchboard-sync.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now claude-switchboard-sync.timer
  fi
  echo "claude-sync runs every 5 minutes"
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" true 2>/dev/null; then
    echo "ssh $host works without a prompt"
  else
    echo "ssh $host does not log in without a prompt yet; see docs/SHARED-COMPUTE.md, section 4"
  fi
fi

if [ "$relay" = 1 ]; then
  step "the relay hook"
  tools/relay/install.sh
fi

step "done"
echo "Open Claude Switchboard; config: ~/.config/claude-switchboard/config.json (docs/CONFIG.md)."
echo "For a banner whenever a chat needs you: tools/notify/install.sh (docs/SHARED-COMPUTE.md, section 8)."
