# Contributing

## Setup

```sh
bun install
npm test          # node --test test/*.test.js
bun run gui       # build the app
```

`src/core` is plain Node ESM with no dependencies; keep it that way, so the CLI, the recorder and the window share it. The window is vanilla TypeScript.

## Checking UI changes without the app

The window runs in a plain browser when `window.__csrMock` holds an overview, and `__csrMock.__rpc` can hold canned replies for other requests. Build, take `views/mainview/index.js` and `styles.css` from the built bundle, inject the mock into `src/mainview/index.html`, and open it.

`node scripts/demo-overview.mjs > demo.json` prints an invented overview with canned replies, the one the README screenshots use. Take shared screenshots from it, never from your own chats, and set the browser's time zone to UTC, since the window shows clock times in local time.

## Guidelines

- Every value that reaches a shell, ssh, rsync or tmux is validated at the boundary. Add a test for any new one.
- A change to what the scan reads from a transcript bumps `VERSION` in `scan-cache.js`.
- Nothing calls a model or reads an API key.
- Prefer measured reasons in comments: what was observed, and why the code does what it does.
- Commit messages say why, not what.

## Tests

Pure functions carry the logic and have tests: the load verdict, the auto-balance decision, needs-you, families, path-token picking, markdown, the bridge's app side. Code that touches processes, ssh or VS Code is kept thin around them.
