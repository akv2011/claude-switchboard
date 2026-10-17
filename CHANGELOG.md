# Changelog

## Unreleased

- A chat renamed with /rename on the remote keeps working from the window: its tmux session is renamed to match, so Reply, the screen preview and `offload attach` find it.

- A chat that stops while others keep running in its folder stays on the restore offer. It was offered for one 30-second poll, then dropped.
- The sidebar groups chats by name: a group picked by hand (drag a chat onto it, or choose one in the detail panel), else the prefix before the first "_", else the folder. Groups made by hand are kept in `~/.claude-switchboard/groups.json`. Grouping by the folders a chat's work touched split one body of work across several folders.
- A Folders tree files each chat under the VS Code window it runs in, else the projects root (`projectsRoots`) that holds it. Projects roots come first and start open.
- Tick boxes on rows, groups and folders, with a bar that brings back, moves, opens or regroups the ticked chats. Shift ticks a range; Space ticks the focused row; Esc clears.
- The restore offer has a tick per chat, so a few can be left out; the rest come back in the order they were open.
- An application menu. Without one, macOS never sent Cmd+= to the window, and copy and paste did nothing in the search box. View has Zoom In, Zoom Out and Actual Size (Cmd+=, Cmd+-, Cmd+0); the level is remembered.
- Bigger sidebar and list text, list columns that fit from 800 px, row buttons that no longer cover the size column, and a delete that keeps the list where it was and focus on the next row.

## 1.0.1

- A window left hidden for a while no longer says it could not load the chats when shown again. WebKit freezes a hidden window's page; a request in flight then timed out on waking although the app had answered. Reads are now asked once more; actions are not.
- Screenshots in the README, taken from an invented demo overview (`scripts/demo-overview.mjs`).
- A remote chat waiting on you no longer cuts off "Needs you" next to a longer machine name.
- The New chat form has side padding, and its note is set in the body font.
- "VS Code" is spelled as Microsoft spells it.

## 1.0.0

First public release, as Claude Switchboard.

- Every Claude Code chat in one list: state, model, effort, context, permission mode, memory (process tree), last line; grouped by project, with families and same-name folding.
- Needs-you detection; chats stopped on a usage limit or an API error, with Continue; quiet busy chats; blocked background agents.
- Restore after a shutdown into one VS Code terminal tab per chat, from a launchd recorder.
- Reply and Esc into a chat's own VS Code terminal; change model, effort or permission mode by a session-only restart; new-chat launcher.
- Optional remote machine over ssh and tmux: live moves both ways with preflight and rollback, live screen, Balance, opt-in auto-balance, honest load readings for both machines.
- Optional claude-swap integration: account usage, switching, notifications at 85% of 5 hours or 80% of a week.
- Full-text search across chats; rendered replies in the detail panel; keyboard navigation (j, k, Enter, r, a, m, Esc, Cmd+F, Cmd+R).
- Shared compute: `tools/offload` (run commands and Claude Code chats on a second machine with the project synced both ways, detached jobs, port forwards, moves), `claude-sync` (setup there, transcripts back), `tmux.conf`, a 38-check end-to-end test, and docs/SHARED-COMPUTE.md.
- Linux setup: docs/LINUX-SETUP.md (a headless compute box from a blank disk: btrfs subvolumes and snapshots, packages, zswap, key-only ssh), `tools/linux-setup/configure-arch.sh` and `post-install.sh` (idempotent, with a read-only `--check`).
