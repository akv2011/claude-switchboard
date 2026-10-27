# Changelog

## Unreleased

- The remote card no longer reads "No reading" on a remote short of memory. Its status check started a `ps` for every session record in every chat pane, about 900 of them with 19 chats, and took 9 s against an 8 s limit. It now looks each pane's chat up by pid.

- A banner when a chat needs you: `tools/notify/install.sh` adds a Claude Code hook for turn ends, questions, permission prompts, plans to approve and API errors. Background turns ping only when they address you or report a problem or a finished job, at most hourly per kind. On the remote, `--forward-to` sends its banners to your main machine over a key that can only post one.

- `offload move` resumes a chat under its own title. A bare resume sometimes registered a name made from the folder, so the moved chat answered to that.

- With the relay on, the `@` list and ListAgents in a chat offer the other machine's chats as well as this machine's. They read only this machine's session records, so the relay writes a stand-in record for each chat on the other machine.

- The recorder's liveness check asks ps only about pids that exist. macOS ps exits 1 on a pid above its range, and every chat then looked closed.

- `offload claude` and `offload move` run from a terminal attach the way `offload attach` does, so a dropped link reconnects and mouse reporting is turned off afterwards. They ran a bare ssh before, and once the chat restarted the tab printed every mouse move into the shell.

- `offload move <chat> -- --model <model>` passes Claude flags to the moved chat, as `offload claude` does. A chat could not be resumed on the remote with another model or effort.

## 1.1.0

- The second machine may be a Mac as well as a Linux box, and the main machine may run Linux for everything but the window. The remote's probe reads macOS counters through the same parser as this Mac's, with the right page size for swap rates; claude-sync puts the organization rules file where each system keeps it and rewrites the home folder in hook commands; `offload` works with GNU or BSD stat. On Linux the recorder is a systemd user timer, and the load, notifications (notify-send), clipboard (wl-copy or xclip), terminal and VS Code settings paths follow the system.

- `scripts/setup.sh` installs everything from a fresh clone in one step: the VS Code extensions, offload, claude-sync and lazy-mcp, the window and the recorder, offload's config and a claude-sync timer when a remote is configured, and the relay hook when it is on. CLAUDE.md tells Claude Code how to run it and what to ask.

- Chats on the two machines can message each other with Claude Code's own SendMessage, and `@<chat>` in a prompt reaches a chat on the other machine. Off unless `"relay": true` in config.json, and tools/relay/install.sh adds its hook. The recorder mirrors every chat's message socket onto the other machine over one ssh connection; Claude Code otherwise reaches only chats on its own machine, or Remote Control ones on the same account.

- A chat's tab follows the chat's name after /rename or /branch (the switchboard-names extension). Tabs are opened with a fixed name, which VS Code keeps whatever the chat sends. The tab in use is renamed at once; another when it is opened or the window is left, since VS Code renames only the terminal in front.

- A remote chat's tab acts like a local one's (the switchboard-remote extension): closing it closes the chat, and Cmd+V or Ctrl+V with an image copies the image to the remote and types its path. Claude reads a pasted image from the clipboard of the machine it runs on.

- A remote chat that nothing shows is closed once it has been idle for 10 minutes; its history stays for a resume. One still working waits; one running only background jobs is not closed but named in a notification. A tab closed while the extension was not loaded, VS Code quitting or a restart here left such chats running for hours.

- A remote tab holds its tmux session by id, so it keeps its chat through a /rename, and `offload attach` reconnects after a dropped link and turns mouse reporting off afterwards. After a restart here, "Attach N here" on the remote's card reopens the tabs of chats still running there, and a chat reattaches in the tab it last ran in instead of a second one.

- The remote's card shows what holds its memory: each chat and job by its tmux session, files in /tmp when it is a RAM disk, and programs whose parent died. An info button lists the offload commands, with Copy, and opens New chat with the remote picked.

- Close in the chat panel stops a running chat wherever it runs, and Delete is always there: a running chat is closed first. Deleting also moves the chat's copy on the remote to ~/.claude-trash there; copying between the machines never deletes, so it stayed.

- The Accounts page shows the remote's account and can put the remote on one by hand ("Use on" the remote), for an account spent there or with no login there; it then stays until "Follow this Mac".

- A chat runs in one place: Bring back, Open and the remote's restore skip a chat already running on either machine, under any tmux name. A chat that last ran on the remote fetches its transcript first when it reopens here, and waits while the remote is unreachable instead of opening from an older copy. A resume check flags a chat that resumed from an older point than its newest message.

- Moves: a chat the remote never lists within 60 s (stuck at a question nobody sees) is stopped there and reopened here, so it is never on neither machine. A move refuses a chat whose background tasks it would stop. One picked by hand goes even after it used what only this Mac has, and the message names it. A project's first copy may take up to 30 minutes.

- Several tabs opened at once (Bring back, Attach N here) open together, in order and beside the tab in use, without taking the keyboard.

- Layout: the page scrolls as one, with the list header and selection bar staying on top; the sidebar and the chat panel are resizable by drag or arrow keys and remember their width; the panel floats over the list only below 720 px. The list filters by machine (All, Mac, the remote) on top of the current view. A family's `<name>_old` copies sit in its own Old row and stay out of whole-family actions. The restore banner says when the oldest chat closed as well as the newest.

- tools/offload/lazy-mcp starts an MCP server only when a chat first uses it. Every chat starts its own copy of every configured server: a dozen browser-profile servers per chat held 18 GB on one 24 GB Mac.

- Auto-balance reads chats' transcripts only on a tick that could move one.

- A background chat (claude --bg) shows as running. Only interactive sessions counted, to keep the daemon's spare workers out; a spare has no conversation, so a bg session with a transcript now counts.

- Installing waits for the old recorder job to stop before loading the new one. A load right after an unload could fail with launchctl status 5 and stop the install before it copied the app.

- The restore offer names a chat the way the list does. It used the name saved while the chat ran, which for an unnamed chat is one Claude Code made from the folder, and the terminal tab Bring back opened carried it too.

- A chat reopens in the folder it was started in, not where its own cd's left it. Claude records its current folder on every line, so a chat started in its window's folder could reopen in a subfolder, in a new window; `offload move` had the same fault.

- Bring back puts a chat in the window it belongs to, never a new window on its subfolder, and terminals in the editor area open as tabs in one group instead of a new split pane each (VS Code locks terminal-only groups). The detail panel follows its chat when it starts, stops or moves.

- One move per chat across the window and auto-balance. The guard was per process, so pressing Move on a chat auto-balance was moving could close it twice and attach two terminals; the claim is now a lock file both processes see.

- Every selection-bar button counts every ticked chat. A ticked chat that was also on the restore offer went only to Bring back, so four ticked read as Bring back 1 and Open 3; Bring back now takes them all, each on the machine it last ran on.

- Auto-balance leaves a chat on this Mac when it committed or pushed lately, since .git never syncs to the remote. Sidebar names are white; grey is kept for counts, parent paths and state words.

- The sidebar has a Folders | Groups switch under Views, Folders by default and remembered. Inside a folder, chats with no name prefix sit under a "No group" line, last, instead of reading as part of the group above them.

- Balance and auto-balance leave a chat that lately used what the remote cannot serve: this Mac's browser through Claude in Chrome or the Playwright and Chrome DevTools plugins, a drive under `/Volumes/`, `osascript`, `screencapture` or `open -a`. Add MCP servers of your own that only this Mac has to `localOnlyMcp` in config.json. A chat moved with that work would stop on the remote.
- With claude-swap on both machines, the recorder keeps the remote on this Mac's active account, or one of the same organization, and leaves it alone when it has neither. A chat moved there ran on whatever account the remote last had, another organization's limits included. An account counts only when its email matches.

- A chat that compaction carries into a new transcript, or that /clear restarts, is no longer offered as closed. Restore keyed chats by id, and Bring back would have reopened the old copy beside the live one.

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
