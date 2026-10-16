# Changelog

## 1.0.0

First public release.

- Every Claude Code chat in one list: state, model, effort, context, permission mode, memory (process tree), last line; grouped by project, with families and same-name folding.
- Needs-you detection; chats stopped on a usage limit or an API error, with Continue; quiet busy chats; blocked background agents.
- Restore after a shutdown into one VS Code terminal tab per chat, from a launchd recorder.
- Reply and Esc into a chat's own VS Code terminal; change model, effort or permission mode by a session-only restart; new-chat launcher.
- Optional remote machine over ssh and tmux: live moves both ways with preflight and rollback, live screen, Balance, opt-in auto-balance, honest load readings for both machines.
- Optional claude-swap integration: account usage, switching, notifications at 85% of 5 hours or 80% of a week.
- Full-text search across chats; rendered replies in the detail panel; keyboard navigation (j, k, Enter, r, a, m, Esc, Cmd+F, Cmd+R).
