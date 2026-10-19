#!/bin/bash
# Install the relay's Claude Code hook on this machine: copy switchboard_relay.py into
# ~/.claude/hooks and add it to ~/.claude/settings.json for UserPromptSubmit and for
# SendMessage. Run it again any time; it adds each entry once. claude-sync copies both
# to the remote. Then set "relay": true in ~/.config/claude-switchboard/config.json.
set -euo pipefail
command -v jq >/dev/null || { echo "install: needs jq" >&2; exit 2; }
command -v python3 >/dev/null || { echo "install: needs python3" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
hooks=$HOME/.claude/hooks
settings=$HOME/.claude/settings.json
mkdir -p "$hooks"
install -m 755 "$here/switchboard_relay.py" "$hooks/switchboard_relay.py"
python3 "$hooks/switchboard_relay.py" --selftest
cmd="python3 $hooks/switchboard_relay.py"
[ -f "$settings" ] || echo '{}' > "$settings"
tmp=$(mktemp "$settings.XXXXXX")
jq --arg cmd "$cmd" '
  def add(event; entry): .hooks[event] = ((.hooks[event] // []) | if any(.[]; (.hooks // []) | any(.command == $cmd)) then . else . + [entry] end);
  add("UserPromptSubmit"; {hooks: [{type: "command", command: $cmd, timeout: 5}]})
  | add("PreToolUse"; {matcher: "SendMessage", hooks: [{type: "command", command: $cmd, timeout: 5}]})' "$settings" > "$tmp"
jq -e . "$tmp" >/dev/null && mv "$tmp" "$settings"
echo "relay hook installed in $settings"
