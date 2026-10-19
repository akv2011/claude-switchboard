# Shared compute: a second machine for Claude Code

How to turn a spare laptop or desktop into a headless box that takes Claude Code chats, builds, tests and long jobs off your main machine, and how the pieces in this repo fit together. This was built for a 24 GB Mac that swapped under ten chats at once, with a 16 GB, 8-core Linux laptop on the same Wi-Fi taking the load. The numbers below are from that setup.

## The pieces

| Piece | Where | Job |
|---|---|---|
| The window | `src/` | Shows both machines' load, every chat on either, moves chats live, attaches them in VS Code tabs. Configured with `remote` in `config.json` (see [CONFIG.md](CONFIG.md)). |
| `offload` | `tools/offload/offload` | A command-line tool: run any command on the remote in the same folder, with the project synced both ways by Mutagen; start or attach Claude Code there in tmux; move a closed chat over. |
| `claude-sync` | `tools/offload/claude-sync` | Copies your Claude Code setup to the remote every few minutes, and the remote's transcripts back. |
| `tmux.conf` | `tools/offload/tmux.conf` | For the remote, so an attached chat looks and scrolls like a local one. |
| `test_offload.sh` | `tools/offload/test_offload.sh` | 38 end-to-end checks against your real remote. |
| `lazy-mcp` | `tools/offload/lazy-mcp` | Starts an MCP server only when a chat first uses it, so a server that runs on the other machine over ssh costs nothing per idle chat. |
| The relay | `src/core/peer-relay.js`, `tools/relay/` | Lets chats on the two machines message each other (section 10). |
| Tab extensions | `vscode-remote/`, `vscode-names/` | A remote chat's tab closes the chat when closed and takes pasted images; every chat's tab follows its name. |

## 1. The machine

Anything with an SSD, 16 GB of RAM and a decent CPU. Measured on 16 GB:

| Idle chats | PSS total | PSS each | RSS each | CPU cores | Memory left |
|---|---|---|---|---|---|
| 10 | 1.78 GB | 182 MB | 330 MB | 0.05 | 11.9 GB |
| 20 | 3.16 GB | 162 MB | 318 MB | 0.10 | 10.6 GB |
| 40 | 6.12 GB | 157 MB | 317 MB | 0.19 | 7.6 GB |

PSS is the real cost; RSS counts the shared Claude Code binary pages again for every chat. Chats in real use cost more: each one also runs its MCP servers, which can double its footprint, so plan on 300 to 500 MB per active chat.

A swapped-out idle chat echoed a keystroke in a median 0.09 s with RAM free, and 0.39 s with RAM full of other work. Memory pressure stays the signal to watch: buy more RAM only if `/proc/pressure/memory` stays high during normal work.

## 2. Operating system

A minimal Linux install with no desktop works best; these notes are from Arch Linux, and the same settings exist on any distribution. [LINUX-SETUP.md](LINUX-SETUP.md) is the full install from a blank disk, with `tools/linux-setup/configure-arch.sh` and `post-install.sh` doing the settings below.

- **Headless and always on.** Boot to `multi-user.target`. Ignore the lid switch (`HandleLidSwitch=ignore` in `logind.conf`) and mask the sleep targets (`systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`). Blank the console (`consoleblank=60` on the kernel line).
- **Memory: zswap over a disk swapfile, not zram.** zram cannot hand cold pages to disk in LRU order, and zram plus disk swap inverts the LRU. Settings used: zswap with zstd, `max_pool_percent=35`, `shrinker_enabled=1`; a swapfile twice the RAM; `vm.swappiness=150`; MGLRU on; `systemd-oomd` running. Under an 11 GB balloon on top of 40 chats, zswap held 3.9 GB of chat memory in 0.77 GB (5.1x), nothing was killed, and pressure fell back to 2% when the balloon stopped.
- **Thrashing guard.** Set `/sys/kernel/mm/lru_gen/min_ttl_ms` to `1000` (through `/etc/tmpfiles.d/`): the kernel keeps the last second's working set and kills instead of thrashing. Leave `vm.page-cluster` at 3; it beat 0 in both wake tests.
- **Wi-Fi.** Turn Wi-Fi power saving off (a udev rule or your network manager's setting): it cut average ping from 36 ms to 19 ms. Set the regulatory domain for your country, or the card may sit on 2.4 GHz at a fraction of the speed. Measured over 5 GHz through a home router: about 245 Mbit/s each way over ssh, 1 GB in 33 to 39 s.
- **A name.** avahi (mDNS) gives the box a `.local` name that survives a DHCP change.
- **Battery laptops.** If the BIOS has a charge limit or an "AC use" battery mode, turn it on; a laptop kept plugged in all year wears its battery otherwise.
- **Heat.** A laptop under full load with the lid closed held about 92 C, which was the vendor's hold point, not throttling; chats alone sat near 50 C. Avoid "performance" power profiles that only raise the power limit.

## 3. Same paths on both machines

Give the remote the same username and home path as your main machine. Then every absolute path, Claude Code's per-project folders (named after the path) and memory folders match on both sides, and a chat moved over finds everything where it expects it. `offload` requires this; the window can map different roots (`remote.projectsRoot` and `remote.localProjectsRoot`), but identical paths avoid a whole class of surprises.

## 4. ssh

- Key login only, no passwords (`PasswordAuthentication no`, no root login). Pin the host key in `~/.ssh/known_hosts`.
- An alias in `~/.ssh/config` with connection sharing, so every check is fast:

  ```
  Host devbox
    HostName devbox.local
    User you
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 30m
    ServerAliveInterval 15
  ```

- The tools use `BatchMode=yes`: if ssh would prompt, they fail fast instead of hanging.

## 5. Claude Code on the remote

- Install Claude Code there and log in **on the remote itself** (`claude auth login`, or `claude setup-token` for a long-lived token). Do not copy credential files from your main machine: each machine gets its own login.
- Run `tools/offload/claude-sync` from your main machine every 5 minutes with launchd, so the remote has your `CLAUDE.md`, skills, plugins, hooks and keybindings. It builds the remote's `settings.json` from yours, turning off plugins the remote cannot run (`disable_plugins=` in the config, for example browser automation plugins on a machine with no browser) and dropping SessionStart hooks that only make sense locally (`drop_hooks=`).
- Transcripts come back with `rsync --update` and never `--delete`, so the remote's own transcript cleanup can never remove your local copies. That is what lets the window show a remote chat's history and search it.
- Install `~/.tmux.conf` from `tools/offload/tmux.conf`: status bar off (the VS Code tab already names the chat), mouse on (otherwise the scroll wheel walks Claude Code's prompt history instead of scrolling), a 50,000-line history, 24-bit color.
- Always start tmux as `tmux -u`. A non-login ssh session has no `LANG`, and tmux then draws Claude Code's bullets and prompt as `_`. Both tools and the window do this.

A launchd job for the sync, saved as `~/Library/LaunchAgents/local.offload-claude-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.offload-claude-sync</string>
  <key>ProgramArguments</key><array><string>/path/to/tools/offload/claude-sync</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

Keep the script somewhere launchd can read. macOS privacy controls block launchd jobs from `~/Desktop` and `~/Documents`, so copy it to `~/.local/bin` if your checkout lives there.

## 6. Moving work over

With `offload` (configure `host=` and `projects=` in `~/.config/offload/config`):

```sh
offload npm run build                 # runs on the remote in this folder; files sync both ways
offload sh -c 'npm ci && npm test'    # pipes and && need sh -c: arguments arrive as argv
offload -d crawl python crawl.py      # a detached job in tmux; offload logs crawl
offload -p 3000                       # the remote's localhost:3000 answers here
offload claude api_sync -- --model sonnet --effort high
offload attach api_sync
offload move api_sync                 # a closed local chat continues on the remote
offload status                        # every sync session, its state and conflicts
```

Projects sync with Mutagen in `two-way-safe` mode, so a file changed on both sides is a conflict that `offload` reports and never silently overwrites. `node_modules`, virtual environments, build output and `.git` stay on their own machine; add more patterns to `.offloadignore` in the project. A project over 5 GB after ignores is refused unless you set `OFFLOAD_FORCE=1`.

With the window, everything is one click or a drag: a chat closes here cleanly, its project and transcript go over, it resumes in tmux with its name, and it comes back attached in the same VS Code tab. **Balance** moves idle chats off a strained Mac; **Auto** does it one chat at a time with checks. **Move to Mac** brings one back, for work that needs something only the main machine has, such as a logged-in browser or an external drive.

## 7. Telling a strained machine from a busy one

The window's machine cards read what each kernel reports, not "free memory":

- **Mac:** memory used as Activity Monitor counts it (app, wired and compressed pages), swap used against free disk (macOS grows swap files on demand, so its "total" is no ceiling), swap-in and swap-out rates over 5 minutes, the kernel's pressure level, load per core.
- **Linux:** MemAvailable, swap on disk (zswap's compressed pages are RAM), swap rates, `/proc/pressure/memory`, load per core, CPU temperature.

A big swap with no traffic is not strain: macOS keeps swapped pages after pressure passes. Strain is pages moving now, the pressure level, or memory nearly full. Auto-balance acts only on strain.

## 8. Notifications back to your main machine

Claude Code hooks on the remote can tell you when a chat needs you, but a banner on a headless box helps nobody. Send it back over ssh with a key that can do nothing else: in your main machine's `~/.ssh/authorized_keys`,

```
restrict,command="/path/to/your-notifier --from-stdin",from="192.0.2.0/24" ssh-ed25519 AAAA... remote-notify
```

`restrict` turns off forwarding, ptys and agent access; `command=` means the key can only run your notifier; `from=` limits it to your LAN. The remote's hook pipes a one-line message into `ssh -i ~/.ssh/notify_key you@main-machine`.

## 9. Rules that keep it safe

- **One machine per chat.** A chat open on both machines forks its transcript. The window closes a chat before moving it, and `offload move` refuses a chat still open here.
- **The newer transcript wins.** Neither tool copies an older transcript over a newer one.
- **Unreachable is not closed.** When the remote drops off the network (a router restart, a power cut), its chats stay listed as last seen, and nothing is offered for restore until it is truly gone.
- **Check it end to end.** `tools/offload/test_offload.sh` runs 38 checks against your real remote: sync both ways, conflicts, ignores, the size guard, quoting of awkward arguments, exit codes, ttys, jobs, port forwards. It cleans up after itself on both machines.

## 10. Chats that talk across machines

Claude Code's SendMessage reaches chats on its own machine only (or Remote Control ones on the same account). With `"relay": true` in config.json and `tools/relay/install.sh` run once, the recorder mirrors every chat's message socket onto the other machine over one ssh connection, and a hook tells Claude where a chat on the other machine is:

- `@build-bot run the tests` in a prompt on either machine reaches build-bot wherever it runs.
- SendMessage to a chat's name, or a reply to a message from the other machine, goes to that chat's mirror.
- Messages arrive as real cross-session messages, marked as from another Claude session, and the receiving chat's permission mode applies as usual.

A mirror lives in `/tmp/cc-socks-<1000000 + uid>` on the other machine, a folder no chat binds its own socket in, so a Mac and a Linux box, or two Macs, never mix them up. New chats are reachable within about a minute. It rests on Claude Code accepting a message passed through ssh, which it does today.

## 11. MCP servers that start when used

Every chat starts its own copy of every configured MCP server when it opens. A dozen browser-profile servers per chat held 18 GB on a 24 GB Mac with 35 chats. `tools/offload/lazy-mcp` answers a chat's handshake and tool list from the server's last answer and starts the real server on the first tool call, so an idle chat costs nothing:

```sh
claude mcp add-json --scope user browser '{"command":"lazy-mcp","args":["browser","--","npx","@playwright/mcp@0.0.82"]}'
```

The same wrapper lets the remote use a server that only this machine can run, such as a signed-in browser profile, with no cost per idle chat there:

```sh
# on the remote
claude mcp add-json --scope user browser '{"command":"lazy-mcp","args":["browser","--","ssh","-T","mac","exec playwright-mcp --extension"]}'
```

That needs the remote to log in to this machine over ssh, the other way round from section 4.

