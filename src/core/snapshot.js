/**
 * The durable record of what was open.
 *
 * Claude Code deletes ~/.claude/sessions/<pid>.json when a session ends, so
 * after a shutdown nothing on the machine remembers what had been running. This
 * store is the answer: the recorder keeps rewriting it while work happens, and
 * it is the only thing left to read at boot.
 *
 * Writes are atomic (temp file plus rename) because the failure mode being
 * defended against is literally the machine losing power mid write.
 *
 * Memory is per workspace rather than one global snapshot, so closing one
 * project while others keep running does not lose it.
 *
 * The rule is deliberately simple: while anything is running in a folder there
 * is nothing to restore, and once the folder goes dark the set that was live at
 * the previous poll is what comes back. Earlier attempts held individual chats
 * across partial closes, which meant chats you had moved on from kept being
 * offered for days.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  stateDir, stateFile, PROJECTS_DIR, isInsidePath, canBeWorkspaceRoot,
} from './paths.js';
import { readRunningSessionIds } from './registry.js';
import { cachedRemoteLiveIds } from './remote.js';

const SCHEMA_VERSION = 3;

export function readSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!Array.isArray(raw.sessions)) return null;

    // v1 kept a single global lastNonEmpty, which only helped when everything
    // died at once. Closing one project while others kept running dropped that
    // project's chats entirely. Fold whatever v1 remembered into the per
    // workspace map rather than discarding a user's only restore set.
    if (raw.schemaVersion === 1) {
      const workspaces = {};
      for (const group of groupByWorkspace(raw.lastNonEmpty?.sessions ?? [])) {
        // Remembered because they had gone, so they are the set from before.
        workspaces[group.root] = {
          lastSeen: raw.lastNonEmpty?.capturedAt ?? raw.capturedAt,
          sessions: [],
          lastLiveSet: group.sessions,
          closedAt: raw.lastNonEmpty?.capturedAt ?? raw.capturedAt,
        };
      }
      return { ...raw, schemaVersion: SCHEMA_VERSION, workspaces };
    }
    // v2 had per-workspace memory but overwrote it on every poll, so opening a
    // single chat after closing a window shrank the restore set to that one.
    // Nothing to convert: the first v3 poll captures a restore point on the
    // next alive -> empty transition.
    if (raw.schemaVersion === 2) return { ...raw, schemaVersion: SCHEMA_VERSION };
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (!raw.workspaces || typeof raw.workspaces !== 'object') return null;
    return raw;
  } catch {
    // Missing or corrupt. Callers must treat this as "nothing to restore",
    // never as an error worth blocking on.
    return null;
  }
}

/**
 * Write a poll result.
 *
 * @param {Array<object>} sessions live sessions as seen by the recorder
 */
export function writeSnapshot(sessions) {
  const previous = readSnapshot();
  const now = Date.now();

  const liveByRoot = new Map(groupByWorkspace(sessions).map((g) => [g.root, g.sessions]));
  const workspaces = { ...(previous?.workspaces ?? {}) };
  const roots = new Set([...Object.keys(workspaces), ...liveByRoot.keys()]);

  for (const root of roots) {
    const prior = workspaces[root];
    const live = liveByRoot.get(root) ?? [];
    const liveIds = new Set(live.map((session) => session.sessionId));

    const vanished = (prior?.sessions ?? []).filter((s) => !liveIds.has(s.sessionId));
    const outstanding = (prior?.lastLiveSet ?? []).some((s) => !liveIds.has(s.sessionId));

    // The offer is the live set from the poll before chats went away: taken on
    // the poll where something vanishes, held while any of it is still missing,
    // replaced by the current set once it is all back.
    //
    // A teardown is not atomic. A restart kills chats over more than one poll,
    // and replacing the offer each time dropped whichever died first, so a
    // machine that took two polls to go down came back offering the stragglers
    // only. While chats are still missing the offer accumulates instead.
    // Working in a folder again answers the question restore was asking. Whatever
    // is live becomes the baseline on the very next poll, so an offer never
    // outlives the session it belonged to.
    //
    // The deliberate cost: chats waiting to be restored are dropped if you start
    // something new in that folder first. Restore before you start, or Dismiss.
    //
    // The vanished branch wins, because a teardown also passes through polls
    // where something is still live and must accumulate rather than reset.
    let lastLiveSet;
    if (vanished.length) {
      lastLiveSet = mergeByOpenOrder(outstanding ? prior.lastLiveSet : [], prior?.sessions ?? live);
    } else if (live.length) lastLiveSet = live;
    else if (outstanding) lastLiveSet = prior.lastLiveSet;
    else lastLiveSet = live;

    workspaces[root] = {
      lastSeen: live.length ? now : (prior?.lastSeen ?? now),
      sessions: live,
      lastLiveSet,
      ...(vanished.length ? { closedAt: now } : prior?.closedAt ? { closedAt: prior.closedAt } : {}),
    };
  }

  for (const [root, entry] of Object.entries(workspaces)) {
    if (entry.sessions.length) continue;
    // A folder that has been deleted cannot be restored into: clicking it threw
    // "that folder no longer exists". Test fixtures under /var/folders were
    // sitting in the offer this way. A remote chat's folder may exist only on
    // the remote, so its absence here proves nothing.
    const holdsRemote = (entry.lastLiveSet ?? []).some((s) => s.machine === 'remote');
    if (now - (entry.lastSeen ?? 0) > RETAIN_MS || (!fs.existsSync(root) && !holdsRemote)) delete workspaces[root];
  }

  return persist({ schemaVersion: SCHEMA_VERSION, capturedAt: now, sessions, workspaces });
}

/** Temp file plus rename, because the failure being defended against is power loss. */
function persist(payload) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, stateFile());
  return payload;
}

/**
 * Drop a session from the store entirely.
 *
 * Called after a delete. Without it the chat stayed on the restore banner with
 * its transcript already in the Trash, and restoring it would open nothing.
 */
export function forgetSession(sessionId) {
  const snapshot = readSnapshot();
  if (!snapshot) return false;
  const without = (list) => (list ?? []).filter((s) => s.sessionId !== sessionId);

  const workspaces = {};
  for (const [root, entry] of Object.entries(snapshot.workspaces ?? {})) {
    workspaces[root] = { ...entry, sessions: without(entry.sessions), lastLiveSet: without(entry.lastLiveSet) };
  }
  persist({ ...snapshot, sessions: without(snapshot.sessions), workspaces });
  return true;
}

/**
 * Session ids that still have a transcript on disk.
 *
 * Returns null when the projects directory cannot be read at all, which means
 * "unknown": callers must then offer everything rather than hide chats merely
 * because the lookup failed.
 */
function transcriptIds() {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const ids = new Set();
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(PROJECTS_DIR, dir));
    } catch { continue; }
    for (const file of entries) {
      if (file.endsWith('.jsonl')) ids.add(file.slice(0, -6).toLowerCase());
    }
  }
  return ids;
}

/**
 * Two sets of chats as one, newest record of each id winning, back in the order
 * they were opened. Used to grow an offer while a teardown is still in progress.
 */
function mergeByOpenOrder(...sets) {
  const byId = new Map();
  for (const set of sets) for (const session of set ?? []) byId.set(session.sessionId, session);
  return [...byId.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/** How long a closed workspace stays offered for restore. */
const RETAIN_MS = 48 * 60 * 60 * 1000;



/**
 * What restore should offer, per workspace.
 *
 * A workspace whose chats are running is reported as 'current'. One whose chats
 * have gone is reported as 'closed' and stays on offer until RETAIN_MS passes,
 * which is what lets you reopen a project you shut a couple of hours ago.
 *
 * @returns {Array<{root:string, cwd:string, sessions:Array<object>,
 *                  lastSeen:number|null, source:'closed'}>} only workspaces with
 *   something to bring back are returned.
 */
/**
 * @param {object} [snapshot]
 * @param {unknown} [_reserved] unused; kept so callers can inject ids positionally
 * @param {Set<string>} [runningIds] injected by tests, scanned otherwise
 * @param {Set<string>|null} [resumable] transcript ids on disk; a caller that has
 *   just scanned the store passes them in rather than sweeping it again
 */
export function restorableWorkspaces(snapshot = readSnapshot(), _reserved, runningIds, resumable) {
  if (!snapshot) return [];
  // A chat running on the remote is not something to bring back either.
  const running = runningIds ?? new Set([...readRunningSessionIds(), ...cachedRemoteLiveIds()]);
  // A registry entry is not proof a chat can come back: one was recorded live
  // and left no transcript at all, and it sat on the banner as "projects-f4"
  // with nothing for --resume to open. Deleted chats look the same.
  if (resumable === undefined) resumable = transcriptIds();

  return Object.entries(snapshot.workspaces ?? {})
    .map(([root, entry]) => {
      const liveIds = new Set((entry.sessions ?? []).map((s) => s.sessionId));
      const offer = (entry.lastLiveSet ?? []).filter((s) => !liveIds.has(s.sessionId)
        && !running.has(String(s.sessionId).toLowerCase())
        && (resumable === null || resumable.has(String(s.sessionId).toLowerCase())));
      return {
        root,
        cwd: root,
        sessions: offer,
        lastSeen: entry.closedAt ?? entry.lastSeen ?? null,
        source: entry.sessions?.length ? 'partial' : 'closed',
      };
    })
    .filter((w) => w.sessions.length)
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/**
 * Flattened view, kept because callers that just want "what would come back"
 * should not have to care how it is remembered.
 */
export function restorableSessions(snapshot = readSnapshot(), retainMs = RETAIN_MS) {
  const workspaces = restorableWorkspaces(snapshot, retainMs);
  const sessions = workspaces.flatMap((w) => w.sessions);
  const capturedAt = workspaces.length
    ? Math.max(...workspaces.map((w) => w.lastSeen ?? 0))
    : (snapshot?.capturedAt ?? null);
  const source = workspaces.length === 0
    ? 'none'
    : (workspaces.every((w) => w.source === 'current') ? 'current' : 'mixed');
  return { sessions, capturedAt, source };
}

/**
 * Sessions grouped by cwd, which is the unit a VS Code window restores.
 * @returns {Array<{cwd:string, sessions:Array<object>}>}
 */
export function groupByCwd(sessions) {
  const byCwd = new Map();
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (!byCwd.has(session.cwd)) byCwd.set(session.cwd, []);
    byCwd.get(session.cwd).push(session);
  }
  return [...byCwd.entries()].map(([cwd, group]) => ({ cwd, sessions: group }));
}

/**
 * Group sessions by the folder you would actually open in VS Code.
 *
 * Grouping by exact cwd looks right in a list but restores badly: a chat started
 * in Projects/reader would open its own VS Code window, separate from the
 * Projects window you work in. Nested cwds are therefore folded into the
 * shallowest cwd that also has sessions, and each task carries its own cwd so
 * the terminals still start in the right subfolder.
 *
 * @returns {Array<{root:string, sessions:Array<object>}>}
 */
export function groupByWorkspace(sessions) {
  const roots = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))]
    .sort((a, b) => a.length - b.length);

  const rootFor = new Map();
  for (const cwd of roots) {
    rootFor.set(cwd, roots.find(
      (candidate) => canBeWorkspaceRoot(candidate) && isInsidePath(cwd, candidate),
    ) ?? cwd);
  }

  const grouped = new Map();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const root = rootFor.get(session.cwd) ?? session.cwd;
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(session);
  }
  // `cwd` is kept as an alias so callers that group by folder need no change.
  return [...grouped.entries()].map(([root, group]) => ({ root, cwd: root, sessions: group }));
}

/** How recently a transcript must have changed to count as an active chat. */
const ACTIVE_WRITE_MS = 90 * 1000;

/**
 * Is this session's transcript being written right now?
 *
 * A chat started from the resume picker carries no id in its arguments and is
 * sometimes missing from the registry, leaving nothing to identify it by. It is
 * still writing to its transcript, which is enough to know not to offer it.
 */
function isBeingWritten(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return false;
  }
  for (const dir of dirs) {
    try {
      const stat = fs.statSync(path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`));
      return now - stat.mtimeMs < ACTIVE_WRITE_MS;
    } catch { /* not in this project directory */ }
  }
  return false;
}
