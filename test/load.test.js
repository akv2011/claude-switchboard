/**
 * The load model. Fixtures are real sysctl and vm_stat output from
 * a Mac whose memory_pressure said 48% free while 8.3 GB sat in swap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMacLoad, swapOutRate, windowRates, health } from '../src/core/load.js';
import { parseProbe } from '../src/core/remote.js';

const SYSCTL = `25769803776
total = 9216.00M  used = 8304.25M  free = 911.75M  (encrypted)
1
{ 5.68 18.13 22.65 }
12
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   101719.
Anonymous pages:                              569708.
Pages wired down:                             326583.
Pages purgeable:                               25608.
Pages occupied by compressor:                 453487.
Swapouts:                                     897323.
`;

test('Mac used memory counts app, wired and compressed pages, like Activity Monitor', () => {
  const m = parseMacLoad(SYSCTL, VM_STAT);
  assert.equal(m.totalMb, 24576);
  assert.equal(m.usedMb, Math.round(((569708 - 25608 + 326583 + 453487) * 16384) / 1048576));
  assert.equal(m.swapUsedMb, 8304);
  assert.equal(m.swapTotalMb, 9216);
  assert.equal(m.pressure, 'normal');
  assert.equal(m.load1, 5.68);
  assert.equal(m.cores, 12);
});

test('that Mac was 84% used, not the 52% that "48% free" implied', () => {
  // One snapshot carries no swap rate, so strain from swapping needs the window (below).
  assert.equal(health(parseMacLoad(SYSCTL, VM_STAT)).usedPct, 84);
});

test('health levels', () => {
  const base = { totalMb: 16000, usedMb: 4000, swapUsedMb: 0, swapTotalMb: 8000, swapOutMbPerMin: 0, pressure: 'normal', load1: 1, cores: 16, tempC: 50 };
  assert.equal(health(base).level, 'ok');
  assert.equal(health({ ...base, swapOutMbPerMin: 20 }).level, 'strained');
  assert.equal(health({ ...base, swapOutMbPerMin: 250 }).level, 'critical');
  assert.equal(health({ ...base, swapInMbPerMin: 30 }).level, 'strained');
  assert.equal(health({ ...base, psiMem60: 12 }).level, 'strained');
  assert.equal(health({ ...base, psiMem60: 40 }).level, 'critical');
  // macOS keeps swap after pressure passes; a big swap with no traffic is not strain.
  assert.equal(health({ ...base, swapUsedMb: 11000 }).level, 'ok');
  assert.equal(health({ ...base, pressure: 'critical' }).level, 'critical');
  assert.equal(health({ ...base, usedMb: 14000 }).level, 'strained');
  assert.equal(health({ ...base, load1: 30 }).level, 'strained');
  // 92 C is a normal hold point for many laptops under full load.
  assert.equal(health({ ...base, tempC: 92 }).level, 'ok');
  assert.equal(health({ ...base, tempC: 97 }).level, 'critical');
  assert.equal(health(null).level, 'unknown');
});

test('window rates span the whole window, not the last sample pair', () => {
  const samples = [
    { at: 0, swapOuts: 0, swapIns: 0 },
    { at: 60_000, swapOuts: 25_600, swapIns: 0 },
    { at: 120_000, swapOuts: 25_600, swapIns: 0 }, // a quiet last minute inside a bad stretch
  ];
  assert.equal(windowRates(samples, 4096).swapOutMbPerMin, 50);
  assert.equal(windowRates([samples[0]], 4096).swapOutMbPerMin, null);
});

test('swap-out rate needs two usable samples', () => {
  assert.equal(swapOutRate(null, { at: 1, swapOuts: 1 }, 4096), null);
  assert.equal(swapOutRate({ at: 0, swapOuts: undefined }, { at: 60_000, swapOuts: 5 }, 4096), null);
  assert.equal(swapOutRate({ at: 0, swapOuts: 10 }, { at: 60_000, swapOuts: 5 }, 4096), null);
  // 256 pages of 4 KB in one minute is 1 MB/min.
  assert.equal(swapOutRate({ at: 0, swapOuts: 0 }, { at: 60_000, swapOuts: 256 }, 4096), 1);
});

test('the remote probe reports swap, load, temperature and the swap-out counter', () => {
  const p = parseProbe(`---MEM---
MemTotal:       15573956 kB
MemAvailable:   14156188 kB
SwapTotal:      33554428 kB
SwapFree:       33030140 kB
LOAD:0.42:16
TEMP:40
PSWPOUT:1234
---TMUX---
`);
  assert.equal(p.swapTotalMb, 32768);
  assert.equal(p.swapUsedMb, 32768 - 32256);
  assert.equal(p.load1, 0.42);
  assert.equal(p.cores, 16);
  assert.equal(p.tempC, 40);
  assert.equal(p.pswpout, 1234);
});

test('a chat\'s memory includes its whole process tree, counted once', async () => {
  const { treeRss } = await import('../src/core/registry.js');
  const ps = `  1     0   100
  10     1  102400
  11    10   51200
  12    11   10240
  20     1  204800
  21    20   20480
  99     1   1024`;
  const m = treeRss(ps, [10, 20]);
  assert.equal(m.get(10), 160, '100 + 50 + 10 MB');
  assert.equal(m.get(20), 220);
  assert.equal(m.has(99), false);
});

test('a remote chat\'s memory comes from its process tree in the probe', () => {
  const reg = JSON.stringify({ pid: 500, sessionId: '11111111-1111-1111-1111-111111111111', cwd: '/w', kind: 'interactive', name: 'x' });
  const p = parseProbe(`RSS:500:102400\n${reg}\n---MEM---\nMemTotal: 1 kB\n---TMUX---\nx\n---PS---\n  500   1 102400\n  501 500  51200\n`);
  assert.equal(p.sessions[0].rssMb, 150);
  assert.deepEqual(p.tmux, ['x']);
});
