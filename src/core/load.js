/**
 * How loaded each machine is, in the same shape for the Mac and the remote.
 *
 * "Free memory" alone lied on the Mac: memory_pressure said 48% free while
 * 8.3 GB sat in swap and the compressor held 7.4 GB. Used here is what
 * Activity Monitor calls Memory Used (app + wired + compressed), and the
 * verdict also weighs swap, the rate pages are being swapped out right now,
 * the kernel's pressure level, load per core and CPU temperature.
 */
import { execFileSync } from 'node:child_process';

const MB = 1024 * 1024;
const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

/**
 * @param {string} sysctl  `sysctl -n hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level vm.loadavg hw.ncpu`
 * @param {string} vmStat  `vm_stat`
 */
export function parseMacLoad(sysctl, vmStat) {
  const [memsize, swap = '', pressure, loadavg = '', ncpu] = String(sysctl).trim().split('\n');
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label) => Number(vmStat.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  const swapMb = (key) => Number(swap.match(new RegExp(`${key} = ([\\d.]+)M`))?.[1] ?? NaN);
  const totalMb = Math.round(Number(memsize) / MB);
  const usedPages = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor');
  return {
    totalMb,
    usedMb: Math.round((usedPages * pageSize) / MB),
    swapTotalMb: Math.round(swapMb('total')) || 0,
    swapUsedMb: Math.round(swapMb('used')) || 0,
    pressure: PRESSURE[Number(pressure)] ?? null,
    load1: Number(loadavg.match(/[\d.]+/)?.[0] ?? NaN),
    cores: Number(ncpu) || null,
    tempC: null,
    swapOuts: pages('Swapouts'),
    swapIns: pages('Swapins'),
    compressedMb: Math.round((pages('Pages occupied by compressor') * pageSize) / MB),
    pageSize,
  };
}

/** MB per minute swapped out between two samples, or null without a usable earlier one. */
export function swapOutRate(prev, next, pageSize) {
  if (!prev || !Number.isFinite(prev.swapOuts) || !Number.isFinite(next.swapOuts)) return null;
  if (next.at <= prev.at || next.swapOuts < prev.swapOuts) return null;
  const minutes = (next.at - prev.at) / 60_000;
  return Math.round((((next.swapOuts - prev.swapOuts) * pageSize) / MB / minutes) * 10) / 10;
}

/**
 * Rates over a rolling window, so one quiet 15 s sample inside a bad stretch
 * does not read as "not swapping" (measured: 0 MB/min over 30 s inside a
 * stretch that averaged about 235 MB/min).
 */
export function windowRates(samples, pageSize, windowMs = 5 * 60_000) {
  const last = samples.at(-1);
  const first = samples.find((x) => last.at - x.at <= windowMs);
  if (!first || last.at - first.at < 20_000) return { swapInMbPerMin: null, swapOutMbPerMin: null };
  return {
    swapInMbPerMin: swapOutRate({ at: first.at, swapOuts: first.swapIns }, { at: last.at, swapOuts: last.swapIns }, pageSize),
    swapOutMbPerMin: swapOutRate(first, last, pageSize),
  };
}

const macSamples = [];
/**
 * `samples` carries the swap counters between readings. The window keeps
 * them in memory; the recorder starts a new process every tick, so it passes
 * the ones it saved.
 */
export function macLoad({ samples = macSamples } = {}) {
  try {
    const sysctl = execFileSync('sysctl', ['-n', 'hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level', 'vm.loadavg', 'hw.ncpu'], { encoding: 'utf8', timeout: 5000 });
    const m = parseMacLoad(sysctl, execFileSync('vm_stat', { encoding: 'utf8', timeout: 5000 }));
    samples.push({ at: Date.now(), swapOuts: m.swapOuts, swapIns: m.swapIns });
    // Swap files live on this volume and grow until it fills: its free space is the real ceiling.
    const df = execFileSync('df', ['-k', '/System/Volumes/VM'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop().split(/\s+/);
    m.diskFreeMb = Math.round(Number(df[3]) / 1024) || null;
    m.swapDynamic = true;
    while (samples.length > 2 && Date.now() - samples[1].at > 6 * 60_000) samples.shift();
    return { ...m, ...windowRates(samples, m.pageSize) };
  } catch {
    return { totalMb: null, usedMb: null, swapTotalMb: null, swapUsedMb: null, pressure: null, load1: null, cores: null, tempC: null, swapInMbPerMin: null, swapOutMbPerMin: null };
  }
}

/**
 * One verdict per machine: ok, strained or critical, with the reasons in words.
 * Balance moves chats off a machine that is not ok, and never onto one.
 */
export function health(m) {
  if (!m || !m.totalMb) return { level: 'unknown', reasons: [] };
  const usedPct = (m.usedMb / m.totalMb) * 100;
  const critical = [];
  const strained = [];
  const rate = (label, v, warn, crit) => {
    if (v >= crit) critical.push(`${label} ${Math.round(v)} MB/min`);
    else if (v >= warn) strained.push(`${label} ${Math.round(v)} MB/min`);
  };
  if (m.pressure === 'critical') critical.push('memory pressure critical');
  else if (m.pressure === 'warn') strained.push('memory pressure warning');
  if (usedPct >= 95) critical.push(`${Math.round(usedPct)}% memory used`);
  else if (usedPct >= 85) strained.push(`${Math.round(usedPct)}% memory used`);
  // Swap-in is what a person feels: a page they touch has to come back from disk.
  rate('swapping in', m.swapInMbPerMin, 20, 200);
  rate('swapping out', m.swapOutMbPerMin, 20, 200);
  // Linux pressure stall: share of the last minute some task waited on memory.
  if (m.psiMem60 >= 30) critical.push(`memory stalls ${Math.round(m.psiMem60)}%`);
  else if (m.psiMem60 >= 10) strained.push(`memory stalls ${Math.round(m.psiMem60)}%`);
  if (m.cores && m.load1 > m.cores * 1.5) strained.push(`load ${m.load1.toFixed(1)} on ${m.cores} cores`);
  // Laptop CPUs commonly hold about 92 C under full load; only past 97 C is it news.
  if (m.tempC >= 97) critical.push(`CPU ${m.tempC} C`);
  const level = critical.length ? 'critical' : strained.length ? 'strained' : 'ok';
  return { level, reasons: [...critical, ...strained], usedPct: Math.round(usedPct) };
}
