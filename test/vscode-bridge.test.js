/**
 * The app side of the VS Code bridge: a request a window reports done comes
 * back ok and focuses that window; an unclaimed request opens the chat's
 * folder once, then gives up with the command to run by hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('shq quotes names for the shell', () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
});
