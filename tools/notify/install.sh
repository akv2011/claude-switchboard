#!/bin/bash
# Install the notifier's Claude Code hooks on this machine: copy switchboard_notifier.py into
# ~/.claude/hooks and add it to ~/.claude/settings.json for Notification, Stop, StopFailure, and
# PreToolUse on AskUserQuestion and ExitPlanMode. Run it again any time; it adds each entry once.
# claude-sync copies the hook and the settings to the remote.
#
#   tools/notify/install.sh                      this machine shows its own banners
#   tools/notify/install.sh --forward-to you@main.local [you@100.64.0.1] [--key ~/.ssh/notify_key]
#       run on the remote: write ~/.config/claude-switchboard/notify.json, so its banners go to
#       the main machine instead (docs/SHARED-COMPUTE.md, section 8)
set -euo pipefail
command -v python3 >/dev/null || { echo "install: needs python3" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
hooks=$HOME/.claude/hooks
settings=$HOME/.claude/settings.json

if [ "${1:-}" = --forward-to ]; then
  shift; to=(); key="~/.ssh/notify_key"
  while [ $# -gt 0 ]; do
    case $1 in --key) key=$2; shift 2 ;; -*) echo "install: unknown option $1" >&2; exit 2 ;; *) to+=("$1"); shift ;; esac
  done
  [ ${#to[@]} -gt 0 ] || { echo "install: --forward-to needs at least one user@host" >&2; exit 2; }
  conf=${XDG_CONFIG_HOME:-$HOME/.config}/claude-switchboard/notify.json
  mkdir -p "$(dirname "$conf")"
  python3 - "$conf" "$key" "${to[@]}" <<'PY'
import json, socket, sys
conf, key, to = sys.argv[1], sys.argv[2], sys.argv[3:]
json.dump({"forward": {"to": to, "key": key, "label": socket.gethostname().split(".")[0]}}, open(conf, "w"), indent=2)
PY
  echo "banners from this machine go to ${to[*]} (edit $conf to change)"
  exit 0
fi

command -v jq >/dev/null || { echo "install: needs jq" >&2; exit 2; }
mkdir -p "$hooks"
install -m 755 "$here/switchboard_notifier.py" "$hooks/switchboard_notifier.py"
python3 "$here/test_notifier.py" >/dev/null
cmd="python3 $hooks/switchboard_notifier.py"
[ -f "$settings" ] || echo '{}' > "$settings"
tmp=$(mktemp "$settings.XXXXXX")
# async: a banner never holds up the chat.
jq --arg cmd "$cmd" '
  def hook: {type: "command", command: $cmd, timeout: 15, async: true};
  def add(event; entry): .hooks[event] = ((.hooks[event] // []) | if any(.[]; (.hooks // []) | any(.command == $cmd)) then . else . + [entry] end);
  add("Notification"; {hooks: [hook]})
  | add("Stop"; {hooks: [hook]})
  | add("StopFailure"; {hooks: [hook]})
  | add("PreToolUse"; {matcher: "AskUserQuestion|ExitPlanMode", hooks: [hook]})' "$settings" > "$tmp"
jq -e . "$tmp" >/dev/null && mv "$tmp" "$settings"
echo "notifier hooks installed in $settings"
echo "a chat can ping you on purpose: $cmd \"Done: <job>, <result>\""
