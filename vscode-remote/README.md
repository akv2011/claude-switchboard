# switchboard-remote

Makes a remote chat's VS Code tab act like a local one:

- Closing the tab closes the chat on the remote (SIGTERM, a clean exit for Claude Code). Quitting VS Code or a dropped link does not; the recorder closes a chat left with no tab once it has been idle for 10 minutes.
- Cmd+V or Ctrl+V with an image on the clipboard copies the image to `~/.claude-switchboard/pasted` on the remote and types its path, since Claude reads a pasted image from the clipboard of the machine it runs on. On Linux this needs `wl-paste` or `xclip`.

Install: `bun run bridge` in the repository root packages and installs every extension.
