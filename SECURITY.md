# Security

## What the app can do on your machine

- Read Claude Code's files under `~/.claude`.
- Send SIGTERM to a Claude Code process it lists, when you move or restart that chat.
- Type into VS Code terminals through the bundled extension: only into the terminal a chat runs in, and only text you sent from the window (a reply, Esc, Ctrl+U, or a resume command it builds).
- Run `ssh`, `rsync` and `tmux` against the one remote host you configure.
- Run `cswap` (claude-swap) if installed, for listing and switching accounts.
- Install one launchd job (the recorder).

It does not call any model, read any API key, or contact any server.

## Trust boundaries

- **config.json** reaches ssh, rsync and tmux. The host must look like an ssh alias and never start with `-`; remote paths may contain plain path characters only, because older rsync builds pass remote paths to the remote shell unquoted.
- **Window requests**: model, effort and permission must be in fixed lists; replies are 1 to 4000 characters; account numbers must be ones cswap lists; folders must exist. Everything else is refused before a process is touched.
- **Bridge files** under `~/.claude-restore/vscode` are written by the app and read by the extension. Any process running as you can write there too; the extension types only into a terminal whose shell pid matches a request, and stale requests expire.
- **Transcripts** are rendered as text: the markdown renderer escapes everything first and never creates links.

## Reporting

Please report a vulnerability privately through the repository's security advisory feature rather than in a public issue.
