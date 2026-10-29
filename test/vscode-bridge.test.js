/**
 * The app side of the VS Code bridge: a request a window reports done comes
 * back ok and focuses that window; an unclaimed request opens the chat's
 * folder once, then gives up with the command to run by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runInVscodeTerminal, shq } from '../src/core/vscode-bridge.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-'));

/** Plays one VS Code window: answers the first request it sees. */
function fakeWindow(root, reply) {
  const timer = setInterval(() => {
    const dir = path.join(root, 'requests');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []) {
      const req = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      fs.rmSync(path.join(dir, f));
      fs.writeFileSync(path.join(root, 'done', f), JSON.stringify(reply(req)));
      clearInterval(timer);
    }
  }, 20);
  return timer;
}

test('a claimed request returns ok and focuses the window that took it', async () => {
  const root = tmpRoot();
  const seen = [];
  fakeWindow(root, (req) => ({ reused: req.shellPid === 42, folder: '/w', at: Date.now() }));
  const r = await runInVscodeTerminal(
    { shellPid: 42, cwd: '/w/p', name: 'x', text: 'echo hi' },
    { root, open: async (d) => seen.push(d), openAfterMs: 5000, giveUpMs: 3000 },
  );
  assert.deepEqual(r, { ok: true, reused: true, folder: '/w' });
  assert.deepEqual(seen, ['/w']);
  assert.equal(fs.readdirSync(path.join(root, 'done')).length, 0);
});

test('an unclaimed request opens the folder once, then gives up and cleans up', async () => {
  const root = tmpRoot();
  const seen = [];
  const r = await runInVscodeTerminal(
    { cwd: '/w/p', name: 'x', text: "tmux attach -t '=x'" },
    { root, open: async (d) => seen.push(d), openAfterMs: 100, giveUpMs: 600 },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /tmux attach -t '=x'/);
  assert.deepEqual(seen, ['/w/p']);
  assert.equal(fs.readdirSync(path.join(root, 'requests')).length, 0);
});

test('an unclaimed request opens the chat\'s window, not a window on its subfolder', async () => {
  // Seen live: a chat run from a subfolder got a new window on that subfolder
  // instead of the window it belongs to.
  const root = tmpRoot();
  const window = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-window-'));
  const seen = [];
  await runInVscodeTerminal(
    { cwd: path.join(window, 'api'), window, name: 'x', text: 'echo hi' },
    { root, open: async (d) => seen.push(d), openAfterMs: 100, giveUpMs: 600 },
  );
  assert.deepEqual(seen, [window]);
});

/** What a terminal's shell runs: a real zsh in a pseudo-terminal gets `typed` as keyboard input, then `text` as VS Code's sendText sends it. */
function shellRuns(typed, text) {
  const py = `import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("zsh", ["zsh", "-f", "-i"], {**os.environ, "PS1": "$ ", "EDITOR": "", "VISUAL": ""})
out = b""
def drain(t):
    global out
    end = time.time() + t
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try: out += os.read(fd, 4096)
            except OSError: return
drain(0.5); os.write(fd, sys.argv[1].encode()); drain(0.3)
os.write(fd, sys.argv[2].encode() + b"\\r"); drain(1.0); os.write(fd, b"exit\\r"); drain(0.5)
sys.stdout.write(out.decode("utf-8", "replace"))`;
  return spawnSync('python3', ['-c', py, typed, text], { encoding: 'utf8' }).stdout;
}

test('a command typed into an old tab runs even when its prompt holds leftover input', async () => {
  // Seen live 2026-10-29: after the Dell powered off, VS Code's theme reports sat at 12 tabs' prompts
  // as "997;1n", and the reattach ran as "997;1n~/.local/bin/dell attach ...": command not found.
  const root = tmpRoot();
  let sent = null;
  fakeWindow(root, (req) => { sent = req.text; return { reused: true, folder: '/w', at: Date.now() }; });
  await runInVscodeTerminal(
    { shellPid: 42, cwd: '/w/p', name: 'x', text: 'echo ran-$((6*7))' },
    { root, open: async () => {}, openAfterMs: 5000, giveUpMs: 3000 },
  );
  const out = shellRuns('997;1n', sent);
  assert.match(out, /ran-42/, `the command did not run:\n${out}`);
  assert.doesNotMatch(out, /command not found/);
});

test('shq quotes names for the shell', () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
});
