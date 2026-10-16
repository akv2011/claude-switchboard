/**
 * Read the live session registry that Claude Code maintains.
 *
 * Every running `claude` process writes ~/.claude/sessions/<pid>.json. The
 * filename is the PID. Contents look like:
 *
 *   { pid, sessionId, cwd, name, status, procStart, version, kind, entrypoint }
 *
 * Claude removes these files on exit, so this is a snapshot of NOW and nothing
 * else. That is precisely why the recorder exists: after a shutdown there is no
 * trace here of what had been open.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './paths.js';
import { execFileSync } from 'node:child_process';
import { verifyLiveness } from './liveness.js';

/**
 * @returns {Array<object>} raw registry entries, unverified
 */
export function readRegistry() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const pidFromName = Number(path.basename(file, '.json'));
    if (!Number.isInteger(pidFromName) || pidFromName <= 0) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      // Trust the filename over the body: the filename is what the OS keyed it by.
      entries.push({ ...raw, pid: pidFromName });
    } catch {
      // Half-written or corrupt registry file. Skip it.
    }
  }
  return entries;
}

/**
 * Is this a terminal chat, as opposed to something else that registers itself
 * identically? Three kinds share the registry and only one is restorable:
 *
 *   kind "interactive", entrypoint "cli"           a terminal a human used
 *   kind "bg"                                      pre-warmed background worker
 *   kind "interactive", entrypoint "claude-vscode" the VSCode extension panel
 *
 * The last two have no terminal to restore into, and `claude --resume` on them
 * is meaningless, so counting either inflates the running total and would
 * poison a restore. A missing entrypoint is treated as cli, because older
 * versions did not record one and those sessions are real.
 */
export function isTerminalSession(entry) {
  if (entry?.kind !== 'interactive') return false;
  return entry.entrypoint === undefined || entry.entrypoint === null || entry.entrypoint === 'cli';
}

/**
 * Registry entries that are genuinely running, PID-recycle checked.
 *
 * @param {{interactiveOnly?:boolean}} [options] pass false when you need every
 *   live session regardless of kind, e.g. to protect one from deletion.
 */
export function readLiveSessions(options = {}) {
  const { interactiveOnly = true } = options;
  const raw = readRegistry();
  const liveness = verifyLiveness(raw);

  const live = [];
  for (const entry of raw) {
    const verdict = liveness.get(entry.pid);
    if (!verdict?.alive) continue;
    if (interactiveOnly && !isTerminalSession(entry)) continue;
    live.push({
      pid: entry.pid,
      sessionId: entry.sessionId ?? null,
      cwd: entry.cwd ?? null,
      name: entry.name ?? null,
      nameSource: entry.nameSource ?? null,
      status: entry.status ?? null,
      version: entry.version ?? null,
      kind: entry.kind ?? null,
      startedAt: entry.startedAt ?? null,
      verifiedReason: verdict.reason,
    });
  }
  return live;
}

/**
 * Session ids that must not be deleted because something is using them.
 * Deliberately includes background agents: a bg session is not a chat, but its
 * data is still in use and must not be pulled out from under it.
 */
export function liveSessionIds() {
  return new Set(
    readLiveSessions({ interactiveOnly: false }).map((s) => s.sessionId).filter(Boolean),
  );
}

/**
 * Resident memory in MB for a set of pids, one ps call.
 * @returns {Map<number, number>}
 */
export function readResidentMemory(pids) {
  if (!pids.length) return new Map();
  try {
    return treeRss(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }), pids);
  } catch {
    return new Map();
  }
}

/**
 * Memory a chat holds, in MB: its own process and every descendant. Each chat
 * starts about 20 MCP servers, so the claude process alone under-counted by
 * half (measured: 492 MB own, 915 MB with its tree). Pure: `ps -A -o pid=,ppid=,rss=` text in.
 */
export function treeRss(psText, pids) {
  const parent = new Map();
  const rss = new Map();
  for (const line of String(psText).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) { parent.set(Number(m[1]), Number(m[2])); rss.set(Number(m[1]), Number(m[3])); }
  }
  const roots = new Set(pids.map(Number));
  const kb = new Map([...roots].filter((p) => rss.has(p)).map((p) => [p, 0]));
  for (const pid of rss.keys()) {
    // Walk up to the nearest chat; a process under two chats counts for the inner one.
    for (let x = pid, hops = 0; x > 1 && hops < 64; x = parent.get(x) ?? 0, hops += 1) {
      if (kb.has(x)) { kb.set(x, kb.get(x) + rss.get(pid)); break; }
    }
  }
  return new Map([...kb].map(([p, v]) => [p, Math.round(v / 1024)]));
}

/**
 * Session ids that are provably running, read from process arguments.
 *
 * The registry is not always complete. A session was observed running with no
 * ~/.claude/sessions/<pid>.json at all, which made it invisible here and, worse,
 * made restore offer a chat that was already open. A resumed session carries its
 * id in argv, so this is a second, independent source of truth.
 *
 * It only sees sessions started with an explicit id: a bare `claude` or a
 * `--resume` with no argument cannot be attributed, so this supplements the
 * registry rather than replacing it.
 */
export function readRunningSessionIds() {
  let stdout = '';
  try {
    stdout = execFileSync('ps', ['-eo', 'command='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return new Set();
  }

  const ids = new Set();
  const pattern = /claude\b[^\n]*?--resume[= ]+'?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'?/gi;
  for (const line of stdout.split('\n')) {
    for (const match of line.matchAll(pattern)) ids.add(match[1].toLowerCase());
  }
  return ids;
}
