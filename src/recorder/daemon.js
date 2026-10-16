/**
 * The recorder.
 *
 * This exists because ~/.claude/sessions/<pid>.json is wiped when a session
 * ends. After a shutdown there is nothing left on the machine describing what
 * had been open, so the only way to restore anything is to have been watching
 * while the work was happening.
 *
 * It is deliberately dull: poll, verify, write, repeat. Any failure is logged
 * and swallowed, because a recorder that crashes is a recorder that silently
 * stops protecting you.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readUsage, alertsDue } from '../core/usage.js';
import { readLiveSessions } from '../core/registry.js';
import { readRemoteLive } from '../core/remote.js';
import { readConfig } from '../core/config.js';
import { writeSnapshot, readSnapshot } from '../core/snapshot.js';
import { clearRestoreTasks } from '../restore/tasks.js';
import { trimErrorLog } from './launchd.js';
import { stateDir, logFile, toolPath } from '../core/paths.js';

const POLL_INTERVAL_MS = 5000;
const MAX_LOG_BYTES = 512 * 1024;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    // Cheap rotation so an always-on daemon cannot fill the disk.
    try {
      if (fs.statSync(logFile()).size > MAX_LOG_BYTES) {
        fs.renameSync(logFile(), `${logFile()}.1`);
      }
    } catch { /* no log yet */ }
    fs.appendFileSync(logFile(), line);
  } catch { /* logging must never be fatal */ }
}

/**
 * One poll. Exported so the CLI and tests can run it without the loop.
 *
 * Covers both machines. Each chat carries `machine`, so when the remote is
 * shut down its chats vanish from the live set and go on the restore offer
 * like any other, and restore knows to bring them back over there.
 *
 * @param {{remote?:object|null}} [options] a remote reading to use instead of
 *   taking one, for tests and for callers that already hold one.
 */
export function pollOnce(options = {}) {
  const now = Date.now();
  const record = (session) => ({
    sessionId: session.sessionId,
    cwd: session.cwd,
    name: session.name,
    status: session.status,
    version: session.version,
    pid: session.pid,
    machine: session.machine ?? 'mac',
    ...(session.remoteCwd ? { remoteCwd: session.remoteCwd } : {}),
    startedAt: session.startedAt ?? null,
    lastSeen: now,
  });
  const mac = readLiveSessions()
    .filter((session) => session.sessionId && session.cwd)
    .map(record);

  // Unreachable is not "closed". Keep what was last known so a network blip
  // never turns into a restore banner, and never into a lost offer either.
  // With no remote configured there is nothing to keep.
  const remote = options.remote === undefined ? readRemoteLive() : options.remote;
  const remoteSessions = remote?.reachable
    ? remote.sessions.filter((s) => s.sessionId && s.cwd).map(record)
    : remote?.configured === false ? []
      : (readSnapshot()?.sessions ?? []).filter((s) => s.machine === 'remote');

  const ordered = sortByOpenOrder([...mac, ...remoteSessions]);
  writeSnapshot(ordered);
  sweepFinishedRestores();
  return ordered;
}

/**
 * Oldest first, so chats come back in the order you opened them rather than in
 * whatever order readdir happened to return the registry files. VSCode does not
 * expose tab order, and opening order is the closest honest proxy for it. Ties
 * and missing timestamps fall back to the name so the result is never arbitrary.
 */
export function sortByOpenOrder(sessions) {
  return [...sessions].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/**
 * Remove generated tasks once their restore has completed.
 *
 * The tasks are written to a project's .vscode/tasks.json and stay there, so
 * simply opening that folder weeks later resurrects whatever was open at the
 * time. Once a workspace has nothing left to restore, the tasks have done their
 * job and are litter. Only labels we generated are touched.
 */
export function sweepFinishedRestores() {
  const snapshot = readSnapshot();
  if (!snapshot) return [];

  const cleared = [];
  for (const [root, entry] of Object.entries(snapshot.workspaces ?? {})) {
    // An outstanding offer means those tasks may yet be needed.
    const liveIds = new Set((entry.sessions ?? []).map((s) => s.sessionId));
    const outstanding = (entry.lastLiveSet ?? []).some((s) => !liveIds.has(s.sessionId));
    if (outstanding) continue;
    try {
      const { removed } = clearRestoreTasks(root);
      if (removed > 0) {
        cleared.push({ root, removed });
        log(`cleared ${removed} finished restore task(s) in ${root}`);
      }
    } catch {
      // A folder that has moved or is unwritable is not worth failing a poll for.
    }
  }
  return cleared;
}

/**
 * Tell the person when a Claude account is filling up; never switch it.
 * One notification per account per usage window, remembered in
 * usage-alerts.json. Without claude-swap there is no usage to read.
 */
export function usageAlerts({ accounts = readUsage(), notify = defaultNotify, file = path.join(stateDir(), 'usage-alerts.json'), say = log } = {}) {
  let sent = [];
  try { sent = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const due = alertsDue(accounts, new Set(sent));
  for (const alert of due) {
    try {
      notify(alert.message);
      sent.push(alert.key);
      say(`usage alert: ${alert.message}`);
    } catch (err) {
      say(`usage alert not sent: ${err.message}`);
    }
  }
  if (due.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sent.slice(-200)));
  }
  return due;
}

/**
 * A macOS notification, or the command set as notify.command in config.json.
 * The message is passed as an argument, never spliced into a script, so it
 * cannot be read as AppleScript or shell.
 */
export function notifyArgs(message, command = readConfig().notify.command) {
  if (command) return [command[0], [...command.slice(1), message]];
  return ['/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "Claude Session Restore"', '-e', 'end run', message]];
}

const defaultNotify = (message) => {
  const [cmd, args] = notifyArgs(message);
  execFileSync(cmd, args, { timeout: 15_000, stdio: 'ignore' });
};

export function run() {
  log(`recorder started (pid ${process.pid}, interval ${POLL_INTERVAL_MS}ms)`);

  let lastCount = -1;
  const tick = () => {
    try {
      const sessions = pollOnce();
      try { usageAlerts(); } catch (err) { log(`usage check failed: ${err.message}`); }
      if (sessions.length !== lastCount) {
        log(`tracking ${sessions.length} session(s): ${sessions.map((s) => s.name).join(', ')}`);
        lastCount = sessions.length;
      }
    } catch (err) {
      log(`poll failed: ${err.message}`);
    }
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  const stop = (signal) => {
    log(`recorder stopping (${signal})`);
    clearInterval(timer);
    process.exit(0);
  };
  // On shutdown, do NOT poll again: the claude processes may already be gone and
  // a final poll would overwrite a good snapshot with an empty one. Just leave.
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // launchd starts the recorder with /usr/bin:/bin only; cswap and the
  // notifier may live elsewhere.
  process.env.PATH = toolPath();
  // --once exists for launchd StartInterval mode, where launchd owns the timer
  // and nothing stays resident between ticks.
  if (process.argv.includes('--once')) {
    try {
      trimErrorLog();
      const sessions = pollOnce();
      try { usageAlerts(); } catch (err) { log(`usage check failed: ${err.message}`); }
      log(`tick: captured ${sessions.length} session(s)`);
    } catch (err) {
      log(`tick failed: ${err.message}`);
      process.exit(1);
    }
    // Off unless switched on in the window. Loaded only then: it pulls in the
    // move code, and api.js already imports this module.
    let enabled = false;
    try { enabled = JSON.parse(fs.readFileSync(path.join(stateDir(), 'auto-balance.json'), 'utf8')).enabled === true; } catch { /* never switched on */ }
    if (enabled) {
      import('../core/api.js')
        .then((api) => api.autoBalanceTick({ notify: defaultNotify, say: log }))
        .catch((err) => log(`auto-balance failed: ${err.message}`));
    }
  } else {
    run();
  }
}
