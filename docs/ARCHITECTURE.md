# Architecture

Three processes and one extension:

```
 Claude Code chats ── write ──▶ ~/.claude/projects/*.jsonl, ~/.claude/sessions/<pid>.json
                                        ▲                     ▲
                                        │ read                │ read
 ┌───────────────────────────┐   ┌──────┴──────────┐   ┌──────┴─────────────┐
 │ App window (Electrobun)    │   │ Main process     │   │ Recorder (launchd) │
 │ src/mainview, vanilla TS   │◀─▶│ src/bun/index.ts │   │ src/recorder       │
 └───────────────────────────┘RPC└──────┬──────────┘   └──────┬─────────────┘
                                        │ both call src/core  │ every 30 s
                                        ▼                     ▼
                          ~/.claude-switchboard (cache, snapshot, bridge requests)
                                        │
                                        ▼
                   VS Code bridge extension (vscode-bridge/), one per window
```

- **src/core**: all logic, plain Node-compatible ESM with no dependencies, so the window, the CLI (`bin/switchboard.js`) and the recorder share one implementation.
- **src/bun/index.ts**: the main process. It is thin: each RPC forwards to `src/core/api.js`.
- **src/mainview**: the window. Vanilla TypeScript, one stylesheet, bundled Geist fonts. Rows are keyed and updated in place, so a 15-second refresh never re-animates the list.
- **src/recorder**: a launchd job (`--once` every 30 s) that snapshots what is open, sends usage notifications, and runs auto-balance when it is switched on.

## Modules in src/core

| Module | Job |
|---|---|
| `sessions.js` | Scan every transcript into chats and projects: names, cwd, chains, families, same-name groups, the project a chat works on, "needs you". |
| `scan-cache.js` | Per-file facts keyed by size and mtime; versioned, so a change in what is read invalidates it. |
| `model.js` | Facts from a transcript's tail: model, effort, last line, context tokens, permission mode, an API-error stop, folder names mentioned. |
| `registry.js` | The live registry (`~/.claude/sessions`), plus chats found only through `ps`, and per-chat memory as a process-tree sum. |
| `families.js` | Prefix families and same-name roles. |
| `load.js` | Machine load: memory used as Activity Monitor counts it, swap, swap-in and swap-out rates over 5 minutes, pressure level, load, temperature; one verdict per machine. |
| `remote.js` | The optional second machine: probe, sync (rsync), start, attach, resume and stop in tmux, live screen. |
| `config.js` | Read and validate `config.json`. |
| `restart.js` | Change model, effort or permission mode by restarting an idle chat with session-only flags. |
| `autobalance.js` | The pure auto-balance decision, and its switch and state files. |
| `background.js` | Background agents blocked on you, from `claude agents --json` plus each job's state file. |
| `accounts.js`, `usage.js` | claude-swap integration: accounts, switching, usage, notifications. |
| `search.js` | Full-text search with ripgrep over the listed chats, text blocks only. |
| `markdown.js` | Safe rendering of a reply for the detail panel. |
| `snapshot.js` | What to offer for restore. |
| `vscode-bridge.js` | The app side of the bridge protocol. |
| `deleter.js` | Move a chat's files to the Trash, after a preview. |
| `api.js` | Everything the window calls, composed from the above. |

## RPC surface

Requests the window makes to the main process (`src/bun/index.ts`):

`overview`, `lastMessage`, `peek`, `searchAll`, `previewDelete`, `confirmDelete`, `restore`, `clearTasks`, `enableAutoTasks`, `disablePersistence`, `openProject`, `attach`, `control` (reply or interrupt), `restartWith` (model, effort, permission), `newChat`, `moveLive`, `moveToRemote`, `moveToLocal`, `balance`, `setAutoBalance`, `accounts`, `switchAccount`, `newChatAs`, `openAgent`, `stopAgent`, `copyText`, `recorderInstall`, `recorderUninstall`.

Every value from the window is checked at the boundary in `api.js`, `restart.js` or `accounts.js` before it reaches a shell, ssh or tmux.

## The VS Code bridge

VS Code has no command-line way to type into a terminal, so the app and the extension talk through files under `~/.claude-switchboard/vscode/`:

- `requests/<id>.json`: `{ shellPid?, cwd, name, text, at }`. The window holding the terminal whose shell pid matches takes it and types `text` there. With no such terminal (or a closed one), the window opened on `cwd` takes it after 1.5 s, or a parent folder's window after 3 s, and opens a new terminal. The app opens the folder in VS Code after 4.5 s if nobody took it.
- `keys/<id>.json`: `{ shellPid, text, newline, at }`. Keystrokes for a running chat: only the terminal with that shell pid, never a new one, with or without Enter (Esc and Ctrl+U go alone). Expires after 30 s.
- `done/<id>.json`: written by the window that acted.

Claiming is an atomic rename, so two windows never both act. The app types into an existing terminal only while its shell has no children (it is at a prompt), so text never lands in a program that started there since.

## Moves

A live move from the Mac to the remote:
1. Preflight: the remote is reachable; the chat is registered with a pid; the folder is inside `localProjectsRoot`; no remote tmux session already has the name; the chat is idle.
2. SIGTERM the chat. Claude Code exits cleanly and drops its registry file within a second.
3. Sync the project and copy the transcript. A newer remote copy is never overwritten.
4. Resume in tmux on the remote with the same name.
5. Confirm the remote registry lists it, then attach it in the VS Code tab it was in.

If a step after the close fails, the chat is resumed in its terminal on the Mac, so it is never left on neither machine. Moves are locked per chat, and a chat mid-move is kept off the restore offer.

## Why settings changes restart the chat

Typing `/model <name>` or `/effort <level>` into a chat also saves it as the default for every new session. A change meant for one chat therefore goes through a restart with `--model`, `--effort` and `--permission-mode`, which apply to that session only.
