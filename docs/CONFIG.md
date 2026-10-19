# Configuration

One optional file: `~/.config/claude-switchboard/config.json`. It is read on every refresh, so an edit takes effect within 15 seconds. A missing file means the defaults. A broken file is reported in the window and the defaults are used.

```json
{
  "remote": {
    "host": "devbox",
    "label": "Devbox",
    "projectsRoot": "~/Projects",
    "localProjectsRoot": "~/Projects"
  },
  "projectsRoots": ["~/Projects", "~/Desktop/Projects", "~/code"],
  "localOnlyMcp": ["browser-"],
  "notify": { "command": ["/opt/homebrew/bin/terminal-notifier", "-message"] }
}
```

## remote

The optional second machine. Leave it out and every remote feature is hidden.

| Key | Default | Meaning |
|---|---|---|
| `host` | required | An ssh host or alias from `~/.ssh/config`. Key login must work without a prompt; the app runs ssh with `BatchMode=yes`. Letters, digits and `. _ - @`, not starting with `-`. |
| `label` | `Remote` | What the window calls it. Up to 24 characters. |
| `projectsRoot` | `~/Projects` | Where projects live on the remote. `~`, `~/folder` or `/absolute/folder`, plain path characters only. |
| `localProjectsRoot` | same as `projectsRoot` | Where the same projects live on this Mac. A project at `<localProjectsRoot>/app` here is synced to `<projectsRoot>/app` there. Only projects inside it can move. |

What the remote needs:
- Linux with `bash`, `tmux` 3.2 or later, `rsync`, and Claude Code installed and logged in.
- Ideally the same Claude Code settings and plugins as the Mac, so a moved chat behaves the same.
- Optionally claude-swap, with each account registered from a setup token (`cswap add-token`) under the same number it has on the Mac. The recorder then keeps the remote on the Mac's active account, or one of the same organization. An account counts only when its email matches the Mac's. A copied login would be logged out on the Mac the first time the remote renews it.

Recommended `~/.tmux.conf` on the remote, so a chat attached from a VS Code tab looks and scrolls like a local one:

```
set -g status off
set -g mouse on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB"
set -g window-size latest
setw -g aggressive-resize on
```

The app runs every tmux command with `tmux -u`. Without it, a non-login ssh session has no `LANG`, and tmux draws Claude Code's bullets and prompt as `_`.

## projectsRoots

Folders that hold many projects. A chat started in one of these folders, rather than in a project, is filed under the subfolder its recent work touches. The app counts the folder names in the chat's replies, tool calls and results, and the leader must have at least 3 mentions and half of them. Expanded from `~`. Default: `~/Projects`, `~/Desktop/Projects`, `~/code`.

## localOnlyMcp

MCP servers that only this Mac can serve, such as a browser driver signed in to your own profiles. Each entry matches server names that start with it. Balance and auto-balance leave a chat that called one of them lately, as they do for Claude in Chrome, the Playwright and Chrome DevTools plugins, `/Volumes/`, `osascript`, `screencapture` and `open -a`. Letters, digits, `_` and `-`. Default: none.

## relay

`true` lets chats on the two machines message each other: the recorder mirrors every chat's message socket onto the other machine over one ssh connection, and `@<chat>` in a prompt or SendMessage to a chat's name reaches a chat there. Off by default, since it opens every chat's socket to the other machine. Also run `tools/relay/install.sh` once, for the hook that tells Claude where a chat on the other machine is; claude-sync copies it to the remote. Needs a remote.

```json
{ "remote": { "host": "devbox" }, "relay": true }
```

## notify

How the recorder tells you about usage limits and automatic moves. Default: a macOS notification through `osascript`. Set `command` to a program and its arguments; the message is added as the last argument.

## Files the app keeps

All under `~/.claude-switchboard/`:

| File | What |
|---|---|
| `scan-cache.json` | Per-transcript facts, so a refresh reads only files that changed. |
| `snapshot.json` | What was open, for restore. Written by the recorder. |
| `remote-live.json` | The remote machine's last reading, cached 25 s. |
| `recorder/` | The copy of `src/` the recorder runs from, refreshed by `scripts/install.sh`. |
| `vscode/requests`, `vscode/done` | Request files for the VS Code bridge. |
| `auto-balance.json`, `auto-balance-state.json` | The auto-balance switch, and what it last decided. |
| `usage-alerts.json` | Which usage windows were already notified. |
| `remote-account.json` | The Mac account the remote was last matched to, so the remote is asked again only on a switch or every 5 minutes. |
| `recorder.log` | The recorder's log. |
