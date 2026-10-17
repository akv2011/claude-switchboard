/**
 * Automatic balancing moves at most one unused chat per tick, and only under
 * every condition at once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, localOnlyUse, DEFAULTS } from '../src/core/autobalance.js';
import { parseConfig } from '../src/core/config.js';

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

const use = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('a chat that lately used what only this Mac has stays here', () => {
  const d = decide({ ...base, sessions: [chat('small', { rssMb: 300 }), chat('big', { rssMb: 900, localOnly: 'claude-in-chrome' })] });
  assert.equal(d.move.name, 'small', 'the larger chat drives this Mac\'s browser');
  const none = decide({ ...base, sessions: [chat('big', { localOnly: 'claude-in-chrome' })] });
  assert.match(none.wait, /only this Mac has \(big: claude-in-chrome\)/);
});

test('local-only use is read from tool calls, not from talk about them', () => {
  assert.equal(localOnlyUse([use('mcp__claude-in-chrome__navigate')]), 'claude-in-chrome');
  assert.equal(localOnlyUse([use('mcp__plugin_playwright_playwright__browser_navigate')]), 'plugin_playwright_playwright');
  assert.equal(localOnlyUse([use('mcp__plugin_chrome-devtools-mcp_chrome-devtools__click')]), 'plugin_chrome-devtools-mcp_chrome-devtools');
  assert.equal(localOnlyUse([use('Bash', { command: 'ls "/Volumes/Backup Disk/archive"' })]), '/Volumes/');
  assert.equal(localOnlyUse([use('Bash', { command: 'osascript -e "beep"' })]), 'osascript');
  assert.equal(localOnlyUse([use('Bash', { command: 'open -a Safari x.html' })]), 'open -a');
  assert.equal(localOnlyUse([use('Bash', { command: 'git add a.js && git commit -m "x"' })]), 'git');
  assert.equal(localOnlyUse([use('Bash', { command: 'git -C ~/Projects/site push origin main' })]), 'git');
  assert.equal(localOnlyUse([use('Bash', { command: 'git status && git log --oneline -3 && git diff' })]), null);
  assert.equal(localOnlyUse([use('Bash', { command: 'npm test' }), use('mcp__context7__query-docs')]), null);
  assert.equal(localOnlyUse([{ type: 'user', message: { content: 'drive mcp__claude-in-chrome and /Volumes/ later' } }]), null);
});

test('MCP servers of your own count only when config.json names them', () => {
  const browse = [use('mcp__browser-work__browser_click')];
  assert.equal(localOnlyUse(browse), null);
  assert.equal(localOnlyUse(browse, ['browser-']), 'browser-work');
  assert.deepEqual(parseConfig({}).localOnlyMcp, []);
  assert.deepEqual(parseConfig({ localOnlyMcp: ['browser-', 'disasm'] }).localOnlyMcp, ['browser-', 'disasm']);
  const bad = parseConfig({ localOnlyMcp: ['', 'a b'] });
  assert.deepEqual(bad.localOnlyMcp, [], 'an empty start would match every MCP server');
  assert.match(bad.errors[0], /localOnlyMcp/);
});
