/**
 * The remote follows this Mac's claude-swap account: the same slot when its
 * email matches, else one of the same organization, else nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRemoteAccount } from '../src/core/remote-account.js';

const a = (number, email, org, active = false) => ({ number, email, org, active });
const local = (activeSlot) => [
  a(1, 'a@x', 'Org A', activeSlot === 1),
  a(2, 'b@x', 'Org A', activeSlot === 2),
  a(5, 'e@y', 'Org E', activeSlot === 5),
  a(6, 'f@z', 'Org F', activeSlot === 6),
];
const remote = [a(2, 'b@x', ''), a(6, 'f@z', 'Org F', true)];

test('the remote takes this Mac\'s account when it has it', () => {
  assert.equal(pickRemoteAccount(local(2), remote), 2);
});

test('else an account of the same organization, so work stays on its own organization', () => {
  assert.equal(pickRemoteAccount(local(1), remote), 2);
});

test('else the remote is left as it is', () => {
  assert.equal(pickRemoteAccount(local(5), remote), null);
});

test('nothing to do when the remote is already on it', () => {
  assert.equal(pickRemoteAccount(local(6), remote), null);
});

test('a slot whose email differs from this Mac\'s is never picked', () => {
  assert.equal(pickRemoteAccount(local(2), [a(2, 'c@x', ''), a(6, 'f@z', 'Org F', true)]), null);
});
