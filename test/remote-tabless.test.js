import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tabless-'));
process.env.HOME = home;
const { tablessPlan, closeTablessRemote, GRACE_MS } = await import('../src/core/remote-tabless.js');

const MIN = 60_000;
const chat = (over) => ({ pid: 7, sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Web_UI', tmux: 'projects-92', status: 'idle', statusUpdatedAt: 0, clients: 0, ...over });
// Readings every 30 s, as the recorder takes them, from `from` to `to` minutes.
const run = (sessions, { tabs = {}, from = 0, to = 11 } = {}) => {
  let state = {};
  let last;
  for (let t = from * MIN; t <= to * MIN; t += 30_000) { last = tablessPlan({ sessions, tabs, state, now: t }); state = last.next; }
  return last;
};

test('an idle chat nothing shows is closed after 10 minutes, not before', () => {
  assert.equal(run([chat()], { to: 9.5 }).close.length, 0);
  assert.deepEqual(run([chat()]).close.map((s) => s.name), ['Web_UI']);
});

test('a chat with a tab here or any attached terminal is left alone', () => {
  assert.equal(run([chat()], { tabs: { 'projects-92': 123 } }).close.length, 0, 'tab found by its real tmux name');
  assert.equal(run([chat({ clients: 1 })]).close.length, 0, 'attached from anywhere');
  assert.deepEqual(run([chat({ clients: null })]).close.length, 1, 'no client count and no tab counts as unseen');
});

test('a chat still working waits until it has been idle for 10 minutes', () => {
  assert.equal(run([chat({ status: 'busy' })]).close.length, 0);
  assert.equal(run([chat({ status: 'waiting' })]).close.length, 0);
  assert.equal(run([chat({ statusUpdatedAt: 5 * MIN })]).close.length, 0, 'idle only since minute 5');
  assert.equal(run([chat({ statusUpdatedAt: 5 * MIN })], { to: 15 }).close.length, 1);
});

test('a chat left with only background jobs is asked about once, never closed', () => {
  let state = {};
  const asks = [];
  for (let t = 0; t <= 30 * MIN; t += 30_000) {
    const r = tablessPlan({ sessions: [chat({ status: 'shell' })], tabs: {}, state, now: t });
    assert.equal(r.close.length, 0);
    asks.push(...r.ask);
    state = r.next;
  }
  assert.equal(asks.length, 1);
});

test('a gap in readings starts the count again', () => {
  const first = tablessPlan({ sessions: [chat()], tabs: {}, now: 0 });
  // This machine slept 30 minutes; the first reading after waking does not close it.
  const after = tablessPlan({ sessions: [chat()], tabs: {}, state: first.next, now: 30 * MIN });
  assert.equal(after.close.length, 0);
  assert.equal(after.next[chat().sessionId].since, 30 * MIN);
});

test('closeTablessRemote closes, logs and notifies once the plan says so; skips an unreachable remote', async () => {
  const file = path.join(home, 'tabless.json');
  const pings = [];
  const asked = [];
  const close = async (list) => { asked.push(...list.map((s) => s.name)); return new Set(list.map((s) => s.sessionId)); };
  const remote = { configured: true, label: 'Devbox', reachable: true, stale: false, sessions: [chat()] };
  assert.deepEqual(await closeTablessRemote({ remote: { ...remote, reachable: false }, tabs: {}, file, close, notify: (m) => pings.push(m), now: 0 }), []);
  assert.deepEqual(await closeTablessRemote({ remote, tabs: {}, file, close, notify: (m) => pings.push(m), now: 0 }), []);
  let names = [];
  for (let t = 30_000; t <= GRACE_MS; t += 30_000) names = await closeTablessRemote({ remote, tabs: {}, file, close, notify: (m) => pings.push(m), now: t });
  assert.deepEqual(names, ['Web_UI']);
  assert.deepEqual(asked, ['Web_UI']);
  assert.equal(pings.at(-1), 'Closed 1 chat on Devbox with no tab, idle 10+ minutes: Web_UI');
});
