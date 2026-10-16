/**
 * The timezone landmine, pinned down.
 *
 * `npm test` pins a non-UTC zone with a half-hour offset, because the bug being
 * guarded against is invisible in UTC: registry procStart is UTC while ps lstart
 * is local, so a naive comparison shows a whole-hours skew and marks every live
 * session dead. The offset is derived at runtime, so any non-UTC zone works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseProcTime, pidExists, verifyLiveness } from '../src/core/liveness.js';

test('parseProcTime reads the ps/registry format including padded single digits', () => {
  const utc = parseProcTime('Sat Aug  8 19:11:23 2026', 'utc');
  assert.equal(new Date(utc).toISOString(), '2026-08-08T19:11:23.000Z');
});

test('the same wall-clock string means different instants in UTC vs local', () => {
  const value = 'Sat Aug  8 19:11:23 2026';
  const asUtc = parseProcTime(value, 'utc');
  const asLocal = parseProcTime(value, 'local');
  // If this is ever zero the suite is running in UTC and has stopped testing the
  // thing it exists to test. npm test pins a non-UTC, half-hour-offset zone.
  assert.notEqual(asUtc - asLocal, 0, 'suite must not run in UTC');

  // getTimezoneOffset is minutes WEST of UTC, so it negates to the east offset.
  const expected = -new Date(asLocal).getTimezoneOffset() * 60 * 1000;
  assert.equal(asUtc - asLocal, expected, 'skew must equal the local UTC offset');
});

test('parseProcTime rejects junk instead of returning a bogus date', () => {
  assert.equal(parseProcTime('not a time', 'utc'), null);
  assert.equal(parseProcTime('', 'utc'), null);
  assert.equal(parseProcTime(undefined, 'utc'), null);
  assert.equal(parseProcTime('Sat Xyz  8 19:11:23 2026', 'utc'), null);
});

test('pidExists is true for us and false for an impossible pid', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(0x7ffffff), false);
});

/** Our own start time, as the registry would have written it (UTC). */
function ownProcStartUtc() {
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
  }).trim();
  const epoch = parseProcTime(lstart, 'local');
  const d = new Date(epoch);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

test('a real running process with a UTC procStart verifies as alive', () => {
  const entry = { pid: process.pid, procStart: ownProcStartUtc() };
  const verdict = verifyLiveness([entry]).get(process.pid);
  assert.equal(verdict.alive, true, `expected alive, got: ${verdict.reason}`);
  assert.equal(verdict.reason, 'verified');
  assert.ok(Math.abs(verdict.skewMs) <= 5000);
});

test('a recycled pid is caught: right pid, wrong start time', () => {
  const real = ownProcStartUtc();
  const shifted = real.replace(/ (\d{2}):/, (m, hh) => ` ${String((Number(hh) + 1) % 24).padStart(2, '0')}:`);
  const verdict = verifyLiveness([{ pid: process.pid, procStart: shifted }]).get(process.pid);
  assert.equal(verdict.alive, false);
  assert.equal(verdict.reason, 'pid recycled');
});

test('the naive comparison this module exists to prevent would fail here', () => {
  // Feeding ps local time where UTC is expected is exactly the original bug.
  const lstartLocal = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
  }).trim();
  const verdict = verifyLiveness([{ pid: process.pid, procStart: lstartLocal }]).get(process.pid);
  assert.equal(verdict.alive, false, 'local-as-UTC must be rejected, proving the check is real');
});

test('a dead pid is reported dead, not crashed on', () => {
  const verdict = verifyLiveness([{ pid: 0x7ffffff, procStart: 'Sat Aug  8 19:11:23 2026' }]).get(0x7ffffff);
  assert.equal(verdict.alive, false);
  assert.equal(verdict.reason, 'no such process');
});

test('a session with no procStart falls back to existence rather than dying', () => {
  const verdict = verifyLiveness([{ pid: process.pid }]).get(process.pid);
  assert.equal(verdict.alive, true);
  assert.match(verdict.reason, /no procStart/);
});
