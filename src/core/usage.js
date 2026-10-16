/**
 * Claude account usage, read from claude-swap's own cache. No network, and
 * never a switch: the app tells you when an account fills and leaves the
 * choice to you. (claude-swap has its own `cswap auto`; this app never uses it.)
 *
 * The cache (~/.claude-swap-backup/cache/usage.json) holds each account's
 * last good 5-hour and 7-day windows as { pct, resets_at }. Emails in it are
 * never passed on; accounts are named by slot number.
 *
 * Without claude-swap installed there is nothing to read, and nothing is run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin } from './paths.js';

export const usageFile = () => path.join(os.homedir(), '.claude-swap-backup', 'cache', 'usage.json');
export const THRESHOLDS = { fiveHour: 85, sevenDay: 80 };

const win = (w) => (w && Number.isFinite(Number(w.pct)) ? { pct: Math.round(Number(w.pct)), resetsAt: w.resets_at ?? null } : null);

/** @param {object} raw the parsed cache; @param {number|null} active the active slot */
export function parseUsage(raw, active = null, now = Date.now()) {
  return Object.entries(raw?.accounts ?? {})
    .map(([slot, a]) => ({
      slot: Number(slot),
      active: Number(slot) === active,
      fiveHour: win(a.lastGood?.five_hour),
      sevenDay: win(a.lastGood?.seven_day),
      // Older than 30 minutes is shown as such, never as current.
      stale: !a.fetchedAt || now - a.fetchedAt * 1000 > 30 * 60_000,
      failing: Boolean(a.lastError) || (a.consecutiveFailures ?? 0) > 0,
    }))
    .filter((a) => a.fiveHour || a.sevenDay)
    .sort((a, b) => a.slot - b.slot);
}

let activeCache = { at: 0, slot: null };
function activeSlot(cswap) {
  if (Date.now() - activeCache.at < 60_000) return activeCache.slot;
  try {
    const out = JSON.parse(execFileSync(cswap, ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    activeCache = { at: Date.now(), slot: out?.active?.number ?? null };
  } catch {
    activeCache = { at: Date.now(), slot: null };
  }
  return activeCache.slot;
}

export function readUsage(file = usageFile()) {
  const cswap = findBin('cswap');
  if (!cswap) return [];
  try {
    return parseUsage(JSON.parse(fs.readFileSync(file, 'utf8')), activeSlot(cswap));
  } catch {
    return [];
  }
}

const clock = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'later';
};

/** A reset time to the minute, so one window always gives one key. */
export function windowKey(resetsAt) {
  const t = Date.parse(resetsAt ?? '');
  return Number.isNaN(t) ? String(resetsAt) : new Date(Math.round(t / 60_000) * 60_000).toISOString();
}

/**
 * Pings that are due: once per account per window, keyed by when the window
 * resets, so a window that stays full is reported once and the next one fresh.
 * Stale readings never ping. Pure: `sent` is the set of keys already used.
 */
export function alertsDue(accounts, sent, thresholds = THRESHOLDS) {
  const due = [];
  for (const a of accounts) {
    if (a.stale) continue;
    for (const [kind, label] of [['fiveHour', '5h'], ['sevenDay', 'week']]) {
      const w = a[kind];
      if (!w || w.pct < thresholds[kind]) continue;
      // cswap's reset time carries fresh microseconds on every fetch; keyed raw,
      // one full window was reported six times in 45 minutes.
      const key = `${a.slot}:${kind}:${windowKey(w.resetsAt)}`;
      if (sent.has(key)) continue;
      const full = w.pct >= 100;
      due.push({
        key,
        message: `Claude account ${a.slot}${a.active ? ' (active)' : ''} ${full ? 'hit its' : `is at ${w.pct}% of its`} ${label} limit, resets ${clock(w.resetsAt)}`,
      });
    }
  }
  return due;
}
