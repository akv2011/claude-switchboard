/**
 * Remembered results of reading a transcript.
 *
 * Resolving a name and reading a cwd both open the file, and on a store of
 * 9,179 chats that took 6.9 s and 3.0 s per scan. Every other part of the scan was noise
 * by comparison (statSync 35ms, subagent dirs 98ms), so this caches exactly
 * those two and nothing else.
 *
 * The same applies to the model and effort a chat is running on, which are read
 * from the transcript's tail.
 *
 * The key is size plus mtime. Every cached value is a pure function of the
 * file's contents, so a file that has not changed cannot have a different
 * answer.
 * VERSION exists for the other way it can go stale: a change to how names are
 * resolved, which no file mtime would reflect.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';

const VERSION = 10;   // 2 model+effort; 3 dropped <synthetic>; 4 entrypoint; 5 parent link; 6 last line; 7 context+permission; 8 path tokens; 9 stopped on; 10 path tokens count every folder
const cacheFile = () => path.join(stateDir(), 'scan-cache.json');

export function readScanCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (raw.version !== VERSION || typeof raw.entries !== 'object') return new Map();
    return new Map(Object.entries(raw.entries));
  } catch {
    // Missing or corrupt is not an error: it just means every file is a miss.
    return new Map();
  }
}

export function writeScanCache(entries) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.scan-cache.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({
      version: VERSION,
      entries: Object.fromEntries(entries),
    }), 'utf8');
    fs.renameSync(tmp, cacheFile());
    return true;
  } catch {
    // A cache that cannot be written must never fail a scan.
    return false;
  }
}

/** The cached answer for this file, or null if it is absent or stale. */
export function cacheHit(cache, sessionId, stat) {
  const entry = cache.get(sessionId);
  if (!entry) return null;
  if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) return null;
  return entry;
}
