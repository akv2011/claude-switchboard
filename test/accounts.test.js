/**
 * Accounts from `cswap list --json`, in the shape claude-swap returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccounts, mostRoom } from '../src/core/accounts.js';

const raw = {
  schemaVersion: 1,
  activeAccountNumber: 6,
  accounts: [
    { number: 1, email: 'a@x', organizationName: 'Org A', active: false, usageStatus: 'ok',
      usage: { fiveHour: { pct: 92.2, resetsAt: '2026-10-16T10:40:00Z' }, sevenDay: { pct: 46, resetsAt: 'w' }, scoped: [{ name: 'Fable', pct: 32 }] },
      loginExpiresAt: '2026-11-02T00:00:00Z', usageAgeSeconds: 135.4 },
    { number: 4, email: 'd@x', organizationName: 'Org D', active: false, usageStatus: 'ok',
      usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 3 }, scoped: [] } },
    { number: 6, email: 'f@x', organizationName: 'Org F', active: true, usageStatus: 'ok',
      usage: { fiveHour: { pct: 12 }, sevenDay: { pct: 17 }, scoped: [] } },
    { number: 7, email: 'g@x', active: false, usageStatus: 'error', usage: {} },
  ],
};

test('parse keeps every account with its windows, models and login expiry', () => {
  const a = parseAccounts(raw);
  assert.equal(a.length, 4);
  assert.deepEqual(a[0].fiveHour, { pct: 92, resetsAt: '2026-10-16T10:40:00Z' });
  assert.deepEqual(a[0].models, [{ name: 'Fable', pct: 32, resetsAt: null }]);
  assert.equal(a[0].ageSeconds, 135);
  assert.equal(a[2].active, true);
  assert.equal(a[3].fiveHour, null);
});

test('most room is the account whose busier window is lowest, among working ones', () => {
  assert.equal(mostRoom(parseAccounts(raw)), 4);
});
