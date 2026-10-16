/**
 * Account usage: read from claude-swap's cache, ping once per window, never
 * when the reading is stale. Shapes match the real cache on a real store.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseUsage, alertsDue } from '../src/core/usage.js';
import { usageAlerts } from '../src/recorder/daemon.js';

const now = Date.parse('2026-10-16T10:00:00Z');
const raw = {
  schemaVersion: 1,
  accounts: {
    1: { email: 'a@x', fetchedAt: now / 1000 - 60, lastGood: { five_hour: { pct: 88.4, resets_at: '2026-10-16T11:09:00Z' }, seven_day: { pct: 40, resets_at: '2026-10-20T00:00:00Z' } } },
    2: { email: 'b@x', fetchedAt: now / 1000 - 60, lastGood: { five_hour: { pct: 10, resets_at: 'x' }, seven_day: { pct: 81, resets_at: '2026-10-19T00:00:00Z' } } },
    3: { email: 'c@x', fetchedAt: now / 1000 - 3 * 3600, lastGood: { five_hour: { pct: 99, resets_at: 'y' } } },
    5: { email: 'd@x' },
  },
};

test('parse keeps slots with readings, marks the active one and stale ones, drops emails', () => {
  const a = parseUsage(raw, 2, now);
  assert.deepEqual(a.map((x) => x.slot), [1, 2, 3]);
  assert.equal(a[1].active, true);
  assert.equal(a[2].stale, true);
  assert.equal(a[0].fiveHour.pct, 88);
  assert.ok(!JSON.stringify(a).includes('@'));
});

test('alerts fire over the thresholds, once per window, never on stale data', () => {
  const a = parseUsage(raw, 2, now);
  const due = alertsDue(a, new Set());
  assert.deepEqual(due.map((d) => d.key), ['1:fiveHour:2026-10-16T11:09:00.000Z', '2:sevenDay:2026-10-19T00:00:00.000Z']);
  assert.match(due[0].message, /^Claude account 1 is at 88% of its 5h limit, resets /);
  assert.match(due[1].message, /account 2 \(active\)/);
  assert.equal(alertsDue(a, new Set(due.map((d) => d.key))).length, 0);
});

test('the recorder pings each due alert once and remembers it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-usage-')), 'sent.json');
  const sent = [];
  const accounts = parseUsage(raw, null, now);
  // say: a test must not write into the real recorder log.
  usageAlerts({ accounts, notify: (m) => sent.push(m), file, say: () => {} });
  usageAlerts({ accounts, notify: (m) => sent.push(m), file, say: () => {} });
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.length < 95), 'a banner is one line under 95 characters');
});

test('one window is one ping, whatever microseconds the reset time carries', async () => {
  const { windowKey } = await import('../src/core/usage.js');
  const seen = ['2026-10-16T10:40:00.032108+00:00', '2026-10-16T10:40:00.071173+00:00', '2026-10-16T10:40:00.285607+00:00'];
  assert.equal(new Set(seen.map(windowKey)).size, 1);
  const a = (resets) => [{ slot: 1, active: false, stale: false, fiveHour: { pct: 92, resetsAt: resets }, sevenDay: null }];
  const sent = new Set(alertsDue(a(seen[0]), new Set()).map((d) => d.key));
  assert.equal(alertsDue(a(seen[2]), sent).length, 0);
});
