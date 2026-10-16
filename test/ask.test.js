/**
 * A read that timed out while the page was frozen is asked again; an action
 * never is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { askAgainOnTimeout } from '../src/core/ask.js';

// Electrobun's own text (node_modules/electrobun/dist/api/shared/rpc.ts).
const TIMEOUT = 'RPC request timed out.';

const asker = (...results) => {
  const calls = { n: 0 };
  const ask = () => {
    const r = results[Math.min(calls.n++, results.length - 1)];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return { ask, calls };
};

test('a read that timed out is asked again and its answer used', async () => {
  const { ask, calls } = asker(new Error(TIMEOUT), { projects: [] });
  assert.deepEqual(await askAgainOnTimeout('overview', ask), { projects: [] });
  assert.equal(calls.n, 2);
});

test('an action that timed out is not asked again', async () => {
  const { ask, calls } = asker(new Error(TIMEOUT), { ok: true });
  await assert.rejects(askAgainOnTimeout('moveLive', ask), { message: TIMEOUT });
  assert.equal(calls.n, 1);
});

test('a read that failed for another reason is not asked again', async () => {
  const { ask, calls } = asker(new Error('no such session'), { ok: true });
  await assert.rejects(askAgainOnTimeout('overview', ask), { message: 'no such session' });
  assert.equal(calls.n, 1);
});

test('a read that times out twice reports it', async () => {
  const { ask, calls } = asker(new Error(TIMEOUT));
  await assert.rejects(askAgainOnTimeout('lastMessage', ask), { message: TIMEOUT });
  assert.equal(calls.n, 2);
});
