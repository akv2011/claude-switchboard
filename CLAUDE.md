# Setting up Claude Switchboard

For Claude Code, when someone asks to set this repository up.

1. Run `scripts/setup.sh --check`. Install what it lists as missing with the system's package manager (Homebrew on macOS), then run `scripts/setup.sh`. It runs the tests, installs the three VS Code extensions (`npm run bridge`), puts `offload`, `claude-sync` and `lazy-mcp` in `~/.local/bin`, and installs the window and the recorder. Run it again after any change; it replaces what it installed.
2. Ask whether there is a second machine. If not, stop: the app works on one machine with no config file.
3. With one, ask its ssh host alias, a short label, and where projects live on each machine, then write `~/.config/claude-switchboard/config.json` (docs/CONFIG.md):
   `{ "remote": { "host": "<alias>", "label": "<label>", "projectsRoot": "~/Projects", "localProjectsRoot": "~/Projects" } }`
   Check `ssh -o BatchMode=yes <alias> true` works. If it asks for a password, key login is not set up yet: docs/SHARED-COMPUTE.md, section 4. Never copy credentials between machines; the person logs in to Claude Code on the remote themselves.
4. The remote may run Linux or macOS. It needs tmux, rsync, jq and Claude Code logged in; a Mac also needs Remote Login on and Homebrew's bin folder on PATH for non-login shells (`export PATH=/opt/homebrew/bin:$PATH` in `~/.zshenv`). Then run `scripts/setup.sh` again: it writes offload's config and runs claude-sync every 5 minutes.
5. Ask whether chats on the two machines should message each other. If yes, add `"relay": true` to the config and run `scripts/setup.sh` again; it installs the relay hook.
6. Check: `offload ls` lists the remote's tmux sessions, and the window shows both machines. `tools/offload/test_offload.sh` runs 38 end-to-end checks against the remote.

Do not change anything on the remote beyond what the person asks for. Restart VS Code's extensions only if a tab feature does not show up: a new extension loads into open windows at once, an update needs Developer: Restart Extension Host.
