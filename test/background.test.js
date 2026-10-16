/**
 * Blocked background agents, from `claude agents --json` plus each job file,
 * in the shapes seen a real store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBackground } from '../src/core/background.js';

const now = Date.parse('2026-10-16T10:00:00Z');
const list = [
  { id: 'aaa111', kind: 'background', state: 'blocked', name: 'Api_sync_new', cwd: '/p', sessionId: 's1', startedAt: now - 42 * 3.6e6 },
  { id: 'bbb222', kind: 'background', state: 'blocked', name: 'Shop_seo', cwd: '/p', startedAt: now - 1049 * 3.6e6 },
  { id: 'ccc333', kind: 'background', state: 'running', name: 'busy one' },
  { id: 'ddd444', kind: 'interactive', status: 'waiting', name: 'a chat' },
];
const jobs = {
  aaa111: { needs: 'reply go to ship the full deploy', detail: 'full re-deploy awaiting go', suggestedReply: 'go ahead', updatedAt: '2026-10-15T21:15:33.754Z' },
  bbb222: { needs: '  ', detail: 'awaiting go', updatedAt: '2026-09-15T10:41:46.887Z' },
};

test('only blocked background agents, newest first, with what they need', () => {
  const a = parseBackground(list, (id) => jobs[id], now);
  assert.deepEqual(a.map((x) => x.id), ['aaa111', 'bbb222']);
  assert.equal(a[0].needs, 'reply go to ship the full deploy');
  assert.equal(a[0].suggestedReply, 'go ahead');
  assert.equal(a[0].stale, false);
  assert.equal(a[1].needs, null, 'blank text is no text');
  assert.equal(a[1].stale, true, 'a month without moving is stale');
});

test('a missing job file still lists the agent, dated by its start', () => {
  const a = parseBackground([list[0]], () => null, now);
  assert.equal(a[0].needs, null);
  assert.equal(a[0].updatedAt, list[0].startedAt);
});
