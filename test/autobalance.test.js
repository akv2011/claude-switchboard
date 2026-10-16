/**
 * Automatic balancing moves at most one unused chat per tick, and only under
 * every condition at once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULTS } from '../src/core/autobalance.js';

const now = Date.parse('2026-10-16T12:00:00Z');
const chat = (name, extra = {}) => ({ name, machine: 'mac', live: true, status: 'idle', needsYou: false, stoppedOn: null, cwd: '/w', modifiedAt: now - 30 * 60_000, rssMb: 400, ...extra });
const base = {
  config: { ...DEFAULTS, enabled: true },
  state: { strained: 2, lastMoveAt: 0 },
  mac: { level: 'strained', reasons: ['swapping in 40 MB/min'] },
  remote: { reachable: true, level: 'ok', availableMb: 12000 },
  sessions: [chat('small', { rssMb: 300 }), chat('big', { rssMb: 900 })],
  now,
};

test('moves the largest unused chat when everything holds', () => {
  const d = decide(base);
  assert.equal(d.move.name, 'big');
  assert.match(d.why, /swapping/);
});

test('waits on any failed condition', () => {
  assert.match(decide({ ...base, config: { ...base.config, enabled: false } }).wait, /off/);
  assert.match(decide({ ...base, mac: { level: 'ok', reasons: [] } }).wait, /not strained/);
  assert.match(decide({ ...base, state: { strained: 1, lastMoveAt: 0 } }).wait, /1 of 2/);
  assert.match(decide({ ...base, state: { strained: 3, lastMoveAt: now - 60_000 } }).wait, /5 minutes/);
  assert.match(decide({ ...base, remote: { reachable: true, level: 'strained', availableMb: 12000 } }).wait, /remote machine/);
});

test('never takes a chat in use, waiting on you, stopped on a limit, or recently active', () => {
  const sessions = [
    chat('busy', { status: 'busy' }), chat('asks', { needsYou: true }), chat('limit', { stoppedOn: { kind: 'limit' } }),
    chat('recent', { modifiedAt: now - 5 * 60_000 }), chat('elsewhere', { machine: 'remote' }),
  ];
  assert.match(decide({ ...base, sessions }).wait, /idle 20 minutes/);
});

test('keeps the remote machine\'s reserve', () => {
  assert.match(decide({ ...base, remote: { reachable: true, level: 'ok', availableMb: 3200 } }).wait, /under 3 GB free/);
});
