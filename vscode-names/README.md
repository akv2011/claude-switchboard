# switchboard-names

Keeps a Claude chat's VS Code terminal tab named after the chat, so `/rename` and `/branch`
reach the tab. Works for chats here and on the remote opened by Claude Switchboard.

The tab in use is renamed within 5 seconds. Another tab is renamed when you open it or leave
the VS Code window, because VS Code can only rename the terminal in front.

Install: `bun run bridge` in the repository root (packages and installs every extension).
