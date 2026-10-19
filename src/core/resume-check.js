/**
 * Flag a chat that resumed from an older point than its newest message.
 *
 * A resume continues from one message of the history, and the first entry the new
 * process writes names that message as its parent. When the parent is not the
 * newest message from before the start, the messages after it have dropped out of
 * the conversation (they stay in the file). The causes known so far are guarded
 * where they start: a remote chat opened here from an older copy fetches the
 * remote's first (restoreGroups), and a chat open on one machine is never started
 * on the other (movePreflight, startInTmux). A clock off between the machines
 * also shifts the order; keep both synced. This catches whatever is left, once
 * per start, on either machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readTailEntries } from './jsonl.js';
import { PROJECTS_DIR, stateDir } from './paths.js';

const TAIL_BYTES = 4 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const isMessage = (e) => (e.type === 'user' || e.type === 'assistant');
const when = (e) => Date.parse(e.timestamp ?? '') || 0;

/**
 * Pure. Where a chat started at `startedAt` continued from. Null while it has
 * written nothing since, or when its parent lies before the entries read; else
 * { skipped, from, newest }: the messages between the point it continued from and
 * the newest one before the start (0 when it continued from the newest).
 */
export function resumePoint(entries, startedAt) {
  const chain = entries.filter((e) => e.uuid && !e.isSidechain && e.timestamp);
  const first = chain.find((e) => when(e) >= startedAt);
  if (!first?.parentUuid) return null;
  const before = chain.filter((e) => when(e) < startedAt);
  const at = before.map((e) => e.uuid).lastIndexOf(first.parentUuid);
  if (at < 0) return null;
  const dropped = before.slice(at + 1).filter(isMessage);
  return { skipped: dropped.length, from: before[at].timestamp, newest: dropped.at(-1)?.timestamp ?? null };
}

function transcriptFor(sessionId) {
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const file = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch { /* no projects folder */ }
  return null;
}

const checksFile = () => path.join(stateDir(), 'resume-checks.json');

/**
 * One recorder tick: each running chat (here, or on the remote, whose transcripts copy here)
 * is judged once per start. A start that continued from an older point pings.
 *
 * @param {{sessions: Array<{sessionId:string, name?:string, startedAt?:number, machine?:string}>,
 *          notify?: (msg:string)=>void, say?: (msg:string)=>void, now?: number}} args
 */
export function checkResumes({ sessions, notify = () => {}, say = () => {}, now = Date.now() }) {
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(checksFile(), 'utf8')); } catch { /* first run */ }
  const flagged = [];
  for (const s of sessions) {
    if (!s.sessionId || !s.startedAt) continue;
    const key = `${s.sessionId}:${s.startedAt}`;
    if (seen[key]) continue;
    const file = transcriptFor(s.sessionId);
    if (!file) continue;
    const entries = readTailEntries(file, TAIL_BYTES);
    const point = resumePoint(entries, s.startedAt);
    if (!point) {
      // Nothing written since the start yet: look again next tick. Written, but the start lies
      // further back than the tail read: it ran before this check existed, so it is not judged.
      if (when(entries.find((e) => e.timestamp) ?? {}) >= s.startedAt) seen[key] = { at: now, result: 'unknown' };
      continue;
    }
    seen[key] = { at: now, result: point.skipped ? 'older' : 'newest', ...(point.skipped ? point : {}) };
    if (!point.skipped) continue;
    const name = String(s.name ?? s.sessionId.slice(0, 8)).slice(0, 30);
    say(`resume check: ${name} (${s.sessionId}) on ${s.machine === 'remote' ? 'the remote' : 'this Mac'} continued from ${point.from}, `
      + `skipping ${point.skipped} message(s) up to ${point.newest}; they are still in ${file}`);
    try { notify(`${name} resumed from an older point: ${point.skipped} newer message${point.skipped === 1 ? '' : 's'} left out`); } catch { /* the log has it */ }
    flagged.push({ sessionId: s.sessionId, name, ...point });
  }
  for (const [key, v] of Object.entries(seen)) if (now - (v.at ?? 0) > KEEP_MS) delete seen[key];
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${checksFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, checksFile());
  } catch { /* judged again next tick */ }
  return flagged;
}
