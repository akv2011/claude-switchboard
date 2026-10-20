/**
 * Is a recorded Claude session still actually running?
 *
 * Two checks, both required:
 *
 *   1. Does the PID exist at all?
 *   2. Is it the SAME process? macOS recycles PIDs, so a registry file left
 *      behind by a dead session can point at an unrelated new process.
 *
 * Check 2 compares the registry's `procStart` against the process's real start
 * time, and there is a trap in doing so:
 *
 *   registry procStart : "Sat Aug  8 19:11:23 2026"   <- UTC
 *   ps lstart          : "Sun Aug  9 04:41:23 2026"   <- LOCAL time
 *
 * On a UTC+9:30 machine every live session shows a 9.5 hour delta, so a naive
 * string or Date comparison marks all of them dead and the restorer silently
 * brings nothing back. Both sides are normalised to epoch milliseconds here,
 * and the tests run under TZ=Australia/Adelaide so a regression cannot pass in UTC.
 */

import { execFileSync } from 'node:child_process';

/** Tolerance for start-time comparison. ps truncates to whole seconds. */
const START_TOLERANCE_MS = 5000;

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse the "Sat Aug  8 19:11:23 2026" shape used by both ps and the registry.
 * Note the irregular internal whitespace for single digit days.
 *
 * @param {string} value
 * @param {'utc'|'local'} zone which timezone the string is expressed in
 * @returns {number|null} epoch milliseconds
 */
export function parseProcTime(value, zone) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, mon, day, clock, year] = parts;
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const [hh, mm, ss] = clock.split(':').map(Number);
  const d = Number(day);
  const y = Number(year);
  if ([d, y, hh, mm, ss].some(Number.isNaN)) return null;
  return zone === 'utc'
    ? Date.UTC(y, month, d, hh, mm, ss)
    : new Date(y, month, d, hh, mm, ss).getTime();
}

/** Cheap existence check. Signal 0 tests for the process without signalling it. */
export function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user, which still counts.
    return err.code === 'EPERM';
  }
}

/**
 * Real start times for a set of PIDs, in one ps call rather than one per PID.
 * @param {number[]} pids
 * @returns {Map<number, number>} pid -> epoch milliseconds (local time parsed)
 */
export function processStartTimes(pids) {
  const out = new Map();
  if (pids.length === 0) return out;
  let stdout = '';
  try {
    stdout = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8',
    });
  } catch {
    // ps exits non-zero when none of the PIDs exist. An empty map is correct.
    return out;
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const started = parseProcTime(match[2], 'local');
    if (started !== null) out.set(Number(match[1]), started);
  }
  return out;
}

/**
 * Verify a batch of registry entries.
 *
 * @param {Array<{pid:number, procStart?:string}>} entries
 * @returns {Map<number, {alive:boolean, reason:string, skewMs:number|null}>}
 */
export function verifyLiveness(entries) {
  const result = new Map();
  // Only pids that exist: macOS ps exits 1 on a pid above its range, such as the relay's stand-in
  // records for the other machine's chats, and every chat here then looked closed.
  const pids = entries.map((e) => e.pid).filter((p) => Number.isInteger(p) && p > 0 && pidExists(p));
  const starts = processStartTimes(pids);

  for (const entry of entries) {
    const { pid, procStart } = entry;
    if (!Number.isInteger(pid) || pid <= 0) {
      result.set(pid, { alive: false, reason: 'invalid pid', skewMs: null });
      continue;
    }
    if (!pidExists(pid)) {
      result.set(pid, { alive: false, reason: 'no such process', skewMs: null });
      continue;
    }
    const actual = starts.get(pid);
    if (actual === undefined) {
      // The process vanished between the kill(0) probe and ps, or ps hid it.
      result.set(pid, { alive: false, reason: 'start time unavailable', skewMs: null });
      continue;
    }
    const claimed = parseProcTime(procStart, 'utc');
    if (claimed === null) {
      // Old sessions may predate the procStart field. Existence is all we have.
      result.set(pid, { alive: true, reason: 'pid exists (no procStart to verify)', skewMs: null });
      continue;
    }
    const skewMs = actual - claimed;
    if (Math.abs(skewMs) <= START_TOLERANCE_MS) {
      result.set(pid, { alive: true, reason: 'verified', skewMs });
    } else {
      result.set(pid, { alive: false, reason: 'pid recycled', skewMs });
    }
  }
  return result;
}
