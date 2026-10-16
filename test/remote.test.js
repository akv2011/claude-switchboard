/**
 * The remote machine.
 *
 * Pins the parts that run without one: reading its registry out of one ssh
 * reply, naming tmux sessions, and the recorder keeping remote chats on the
 * books while the machine is unreachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-remote-'));
process.env.HOME = fakeHome;
const root = path.join(fakeHome, 'Projects');
fs.mkdirSync(root, { recursive: true });

const { parseProbe, tmuxName } = await import('../src/core/remote.js');
const { pollOnce } = await import('../src/recorder/daemon.js');
const { restorableWorkspaces } = await import('../src/core/snapshot.js');
const { splitByMachine } = await import('../src/core/api.js');

const entry = (over) => JSON.stringify({
  pid: 100, sessionId: '0a9f7eff-6798-4159-86a2-2e0020d9c954', cwd: root,
  name: 'site_crawl', status: 'busy', kind: 'interactive', entrypoint: 'cli', ...over,
});

test('parseProbe keeps terminal chats, drops background workers and junk', () => {
  const out = [
    entry({}),
    entry({ pid: 101, sessionId: '11111111-1111-1111-1111-111111111111', kind: 'bg' }),
    'garbage line',
    entry({ pid: 102, sessionId: '22222222-2222-2222-2222-222222222222', cwd: null }),
    '---MEM---', 'MemTotal:       15573980 kB', 'MemAvailable:   13950000 kB',
    '---TMUX---', 'site_crawl', 'build',
  ].join('\n');
  const parsed = parseProbe(out);
  assert.deepEqual(parsed.sessions.map((s) => s.sessionId), ['0a9f7eff-6798-4159-86a2-2e0020d9c954']);
  assert.equal(parsed.sessions[0].machine, 'remote');
  assert.equal(parsed.memTotalMb, 15209);
  assert.equal(parsed.memAvailableMb, 13623);
  assert.deepEqual(parsed.tmux, ['site_crawl', 'build']);
});

test('parseProbe survives an empty or truncated reply', () => {
  assert.deepEqual(parseProbe('').sessions, []);
  assert.equal(parseProbe('---MEM---\n').memTotalMb, null);
});

test('tmuxName keeps letters, digits, _ and -, and caps the length', () => {
  assert.equal(tmuxName('api_sync (2)'), 'api_sync__2_');
  assert.equal(tmuxName('a.b:c'), 'a_b_c');
  assert.equal(tmuxName('x'.repeat(80)).length, 50);
});

test('a remote chat is recorded with its machine, and kept while the machine is unreachable', () => {
  const chat = { sessionId: '0a9f7eff-6798-4159-86a2-2e0020d9c954', cwd: root, name: 'site_crawl', status: 'busy', machine: 'remote' };
  const up = pollOnce({ remote: { reachable: true, sessions: [chat] } });
  assert.equal(up.length, 1);
  assert.equal(up[0].machine, 'remote');

  const blip = pollOnce({ remote: { reachable: false, sessions: [] } });
  assert.deepEqual(blip.map((s) => s.sessionId), [chat.sessionId], 'a blip does not close it');

  const gone = pollOnce({ remote: { reachable: true, sessions: [] } });
  assert.equal(gone.length, 0);
  const offer = restorableWorkspaces(undefined, undefined, new Set(), new Set([chat.sessionId]));
  assert.equal(offer.length, 1, 'shut down for real, so it is offered');
  assert.equal(offer[0].sessions[0].machine, 'remote');

  const stillRunning = restorableWorkspaces(undefined, undefined, new Set([chat.sessionId]), new Set([chat.sessionId]));
  assert.equal(stillRunning.length, 0, 'not offered while live anywhere');
});

test('with no remote configured, nothing is kept for one', () => {
  const none = pollOnce({ remote: { configured: false, reachable: false, sessions: [] } });
  assert.ok(none.every((s) => s.machine !== 'remote'));
});

test('an offer is split by machine for bring-up', () => {
  const { mac, remote } = splitByMachine([{ machine: 'remote' }, { machine: 'mac' }, {}]);
  assert.equal(remote.length, 1);
  assert.equal(mac.length, 2);
});
