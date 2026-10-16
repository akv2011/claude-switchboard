/**
 * Delete a chat properly, the way the CLI never offers to.
 *
 * Deleting the transcript alone is what every existing tool does, and it leaves
 * four other stores behind. Checked on a real store, all of these are keyed by
 * session id:
 *
 *   projects/<dir>/<sid>.jsonl        the transcript
 *   projects/<dir>/<sid>/subagents/   subagent transcripts
 *   session-env/<sid>/                per session env
 *   file-history/<sid>/               edit history
 *   tasks/<sid>/                      task state
 *   history.jsonl                     prompt lines, tens per session
 *
 * shell-snapshots is NOT session keyed (no file name matched an id) and is left alone.
 *
 * Two safety rules that are not negotiable:
 *   - nothing is ever rm'd, only moved to ~/.Trash, so a misclick is recoverable
 *   - a session with a live PID cannot be deleted at all
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PROJECTS_DIR, SESSION_ENV_DIR, CLAUDE_DIR, HISTORY_FILE,
  isInsideClaudeDir, isSessionId,
} from './paths.js';
import { liveSessionIds } from './registry.js';
import { forgetSession } from './snapshot.js';

const TRASH_DIR = path.join(os.homedir(), '.Trash');

function statSizeOf(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      } catch { /* vanished mid-scan */ }
    }
  };
  walk(target);
  return total;
}

/**
 * Everything on disk belonging to a session, with sizes. Nothing is touched.
 *
 * @param {{sessionId:string, projectDir:string|null}} session
 * @returns {{targets:Array<{path:string, kind:string, bytes:number}>,
 *            historyLines:number, totalBytes:number}}
 */
export function planDelete(session) {
  const { sessionId, projectDir } = session;
  if (!isSessionId(sessionId)) throw new Error(`refusing: not a session id: ${sessionId}`);

  const candidates = [];
  if (projectDir) {
    candidates.push({ path: path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`), kind: 'transcript' });
    candidates.push({ path: path.join(PROJECTS_DIR, projectDir, sessionId), kind: 'subagent transcripts' });
  }
  candidates.push({ path: path.join(SESSION_ENV_DIR, sessionId), kind: 'session env' });
  candidates.push({ path: path.join(CLAUDE_DIR, 'file-history', sessionId), kind: 'file history' });
  candidates.push({ path: path.join(CLAUDE_DIR, 'tasks', sessionId), kind: 'task state' });

  const targets = [];
  for (const candidate of candidates) {
    if (!isInsideClaudeDir(candidate.path)) continue; // guards against a crafted id
    const bytes = statSizeOf(candidate.path);
    if (bytes === null) continue; // does not exist
    targets.push({ ...candidate, bytes });
  }

  return {
    sessionId,
    targets,
    historyLines: countHistoryLines(sessionId),
    totalBytes: targets.reduce((sum, t) => sum + t.bytes, 0),
  };
}

/** How many prompt-history lines mention this session. */
export function countHistoryLines(sessionId) {
  let content;
  try {
    content = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).sessionId === sessionId) count += 1;
    } catch { /* skip malformed */ }
  }
  return count;
}

/** Move a path into ~/.Trash, uniquifying the name on collision. */
function moveToTrash(target) {
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const base = path.basename(target);
  let destination = path.join(TRASH_DIR, base);
  let counter = 1;
  while (fs.existsSync(destination)) {
    destination = path.join(TRASH_DIR, `${base} ${counter}`);
    counter += 1;
  }
  try {
    fs.renameSync(target, destination);
  } catch (err) {
    // Trash may be on a different volume. Copy then remove.
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(target, destination, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
  return destination;
}

/** Rewrite history.jsonl without this session's lines, atomically. */
function pruneHistory(sessionId) {
  let content;
  try {
    content = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return 0;
  }
  const kept = [];
  let removed = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch { /* keep unparseable lines rather than silently dropping data */ }
    if (parsed && parsed.sessionId === sessionId) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return 0;
  const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
  fs.renameSync(tmp, HISTORY_FILE);
  return removed;
}

/**
 * Execute a delete. Always call planDelete first and show the user the plan.
 *
 * @param {{sessionId:string, projectDir:string|null}} session
 * @param {{force?:boolean}} [options] force skips only the live-session check,
 *   and exists for tests. The GUI never sets it.
 */
export function deleteSession(session, options = {}) {
  const { sessionId } = session;
  if (!isSessionId(sessionId)) throw new Error(`refusing: not a session id: ${sessionId}`);

  if (!options.force && liveSessionIds().has(sessionId)) {
    throw new Error('refusing: that chat is running right now. Close it first.');
  }

  const plan = planDelete(session);
  const moved = [];
  for (const target of plan.targets) {
    moved.push({ ...target, trashedTo: moveToTrash(target.path) });
  }
  const historyRemoved = pruneHistory(sessionId);
  forgetSession(sessionId);

  return { sessionId, moved, historyRemoved, bytesReclaimed: plan.totalBytes };
}
