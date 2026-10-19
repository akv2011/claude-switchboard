/**
 * Automatic balancing, off until switched on. Each recorder tick may move at
 * most one chat from a strained Mac to a healthy remote machine, and only a
 * chat that nobody is using: idle, not waiting on the person, not stopped on
 * a limit, quiet for 20 minutes, and not lately using what only this Mac has.
 * The Mac must have been strained for two ticks in a row (a minute), the
 * remote must keep 3 GB free after the move, and moves are at least 5 minutes
 * apart. The recorder runs it each tick while it is switched on (api.js
 * autoBalanceTick); the chat reopens in its own VS Code tab, and a notice says
 * what moved and why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';

export const DEFAULTS = { enabled: false, idleMin: 20, cooldownMin: 5, strainedTicks: 2, remoteReserveMb: 3072 };
const configFile = () => path.join(stateDir(), 'auto-balance.json');
const stateFile = () => path.join(stateDir(), 'auto-balance-state.json');

const readJson = (file, fallback) => { try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...fallback }; } };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
};

export const readConfig = () => readJson(configFile(), DEFAULTS);
export function setEnabled(enabled) {
  const c = { ...readConfig(), enabled: Boolean(enabled) };
  writeJson(configFile(), c);
  return c;
}
export const readState = () => readJson(stateFile(), { strained: 0, lastMoveAt: 0, samples: [], last: null });
export const writeState = (s) => writeJson(stateFile(), s);

// What a chat cannot do on the remote: drive this Mac's browser through the
// Chrome extension or the browser plugins, reach a mounted drive, or script
// Mac apps. A chat that did one of these lately would hit a wall after a move.
// config.json's localOnlyMcp adds MCP servers that only this Mac can serve.
const LOCAL_ONLY_MCP = ['claude-in-chrome__', 'plugin_playwright_', 'plugin_chrome-devtools-mcp_'];
const LOCAL_ONLY_INPUT = /\/Volumes\/|\bosascript\b|\bscreencapture\b|\bopen -a\b/;
// .git never syncs to the remote, so a chat that commits or pushes would stop at its next commit.
const LOCAL_ONLY_GIT = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|push)\b/;

// A background shell or agent still running dies with its chat when a move closes it, and a chat
// can be idle while one runs. Each start names an id that the task's completion notice repeats
// (12 of 12 agents and 14 of 15 shells in one chat; the 15th was still running). Monitors expire
// without a notice, so they are left out. A start is a tool result that opens with the marker: the
// marker quoted anywhere else (a chat writing this check and its test did) starts nothing.
const TASK_START = /^(?:Command running in background with ID: (\w+)|Async agent launched successfully\.[\s\S]*?agentId: (\w+))/;
const TASK_DONE = /<task-id>(\w+)<\/task-id>/g;
const resultText = (c) => (typeof c?.content === 'string' ? c.content
  : Array.isArray(c?.content) ? c.content.map((x) => x?.text ?? '').join('') : '');

/**
 * Pure: how many background tasks started in this transcript text since `since` (ms, the chat
 * process's start: a restart kills its tasks without a notice) have not reported back.
 */
export function openBackgroundTasks(text, since = 0) {
  const open = new Set();
  const done = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.includes('Command running in background with ID: ') && !line.includes('agentId: ') && !line.includes('<task-id>')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'assistant') continue;
    for (const m of line.matchAll(TASK_DONE)) done.add(m[1]);
    if (e?.type !== 'user' || !(Date.parse(e.timestamp ?? '') >= since) || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      const m = c?.type === 'tool_result' ? resultText(c).match(TASK_START) : null;
      if (m) open.add(m[1] ?? m[2]);
    }
  }
  for (const id of done) open.delete(id);
  return open.size;
}

/** Pure: the first local-only tool or path in these transcript entries, or null. */
export function localOnlyUse(entries, mcpPrefixes = []) {
  const prefixes = [...LOCAL_ONLY_MCP, ...mcpPrefixes].map((p) => `mcp__${p}`);
  for (const e of entries) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type !== 'tool_use') continue;
      const name = String(c.name ?? '');
      if (prefixes.some((p) => name.startsWith(p))) return name.slice('mcp__'.length).split('__')[0];
      const input = JSON.stringify(c.input ?? {});
      if (LOCAL_ONLY_GIT.test(input)) return 'git';
      const hit = input.match(LOCAL_ONLY_INPUT);
      if (hit) return hit[0].trim();
    }
  }
  return null;
}

/**
 * Pure: what this tick should do. Returns { move } with the chat to move, or
 * { wait } with the reason it does not.
 */
export function decide({ config, state, mac, remote, sessions, now = Date.now() }) {
  if (!config.enabled) return { wait: 'auto-balance is off' };
  if (mac.level === 'ok' || mac.level === 'unknown') return { wait: 'the Mac is not strained' };
  if (state.strained < config.strainedTicks) return { wait: `the Mac has been strained for ${state.strained} of ${config.strainedTicks} ticks` };
  if (now - (state.lastMoveAt ?? 0) < config.cooldownMin * 60_000) return { wait: 'a chat moved less than 5 minutes ago' };
  if (!remote.reachable || remote.level !== 'ok') return { wait: 'the remote machine is not healthy' };
  const idleFor = config.idleMin * 60_000;
  const idle = sessions
    .filter((s) => s.machine === 'mac' && s.live && s.status === 'idle' && !s.needsYou && !s.stoppedOn && s.cwd && now - s.modifiedAt >= idleFor);
  const unused = idle.filter((s) => !s.localOnly);
  if (!unused.length) {
    return { wait: idle.length ? `the idle chats use what only this Mac has (${idle[0].name}: ${idle[0].localOnly})` : `no chat has been idle ${config.idleMin} minutes` };
  }
  const fits = unused
    .filter((s) => (remote.availableMb ?? 0) - (s.rssMb ?? 500) >= config.remoteReserveMb)
    .sort((a, b) => (b.rssMb ?? 0) - (a.rssMb ?? 0));
  return fits.length ? { move: fits[0], why: mac.reasons.join(', ') } : { wait: `the remote machine would drop under ${Math.round(config.remoteReserveMb / 1024)} GB free` };
}
