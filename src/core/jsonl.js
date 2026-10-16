/**
 * Partial readers for transcript files.
 *
 * Transcripts get large: one can pass 100 MB, and a store holds hundreds, so
 * reading whole files to pull out a name would make the sidebar take minutes
 * to load. Everything needed lives at one end or the other:
 *
 *   cwd, first prompt  -> near the head
 *   ai-title, custom-title -> written repeatedly, so the last one is near the tail
 *
 * These helpers read a bounded window from either end instead of the whole file.
 */

import fs from 'node:fs';

/** Read up to `bytes` from the start of a file. */
export function readHead(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read up to `bytes` from the end of a file. */
export function readTail(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Parsed entries from the end of a file.
 *
 * Wraps the pairing of readTail and parseLines because the torn-line rule is
 * easy to get wrong: a tail chunk is cut mid-line at the START, so its first
 * line is dropped, but when the file is smaller than the window the chunk is
 * the whole file and that first line is real. Parsing a complete chunk as a
 * head chunk drops only the empty string after the trailing newline.
 */
export function readTailEntries(file, bytes = 256 * 1024) {
  let complete;
  try {
    complete = fs.statSync(file).size <= bytes;
  } catch {
    return [];
  }
  return parseLines(readTail(file, bytes), complete ? 'head' : 'tail');
}

/**
 * Split a chunk into parsed JSON objects, dropping the partial line at whichever
 * end the chunk was torn. Unparseable lines are skipped rather than thrown.
 *
 * @param {string} chunk
 * @param {'head'|'tail'} origin which end the chunk came from
 */
export function parseLines(chunk, origin) {
  if (!chunk) return [];
  const lines = chunk.split('\n');
  // A head chunk may be cut mid-line at the end; a tail chunk at the start.
  if (origin === 'head') lines.pop();
  else lines.shift();

  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Truncated or corrupt line. Skipping is always safe here.
    }
  }
  return out;
}
