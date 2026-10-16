/**
 * Search the text of every listed chat: what the person wrote and what Claude
 * replied, not tool output. ripgrep finds the candidate lines across the
 * transcripts, then each line is parsed and kept only if its text blocks hold
 * the words, so a match inside a file dump or a command's output does not
 * count. Lines over 200 KB (pasted files, big tool results) are skipped.
 */
import { execFile } from 'node:child_process';
import { findBin } from './paths.js';

/** The searchable text of one transcript line, or '' for anything else. */
export function lineText(entry) {
  if (entry?.type !== 'user' && entry?.type !== 'assistant') return '';
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
}

export function snippet(text, query, width = 90) {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - Math.floor((width - query.length) / 2));
  const flat = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${flat}${start + width < text.length ? '…' : ''}`;
}

/** Pure: ripgrep's "path:line:json" output into one hit per file, most matches first. */
export function parseHits(stdout, query) {
  const byFile = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^(.+?\.jsonl):(\d+):(.*)$/);
    if (!m) continue;
    let entry;
    try { entry = JSON.parse(m[3]); } catch { continue; }
    const text = lineText(entry);
    const snip = text ? snippet(text, query) : null;
    if (!snip) continue;
    const hit = byFile.get(m[1]) ?? { file: m[1], count: 0, snippet: snip, at: entry.timestamp ?? null, role: entry.type };
    hit.count += 1;
    byFile.set(m[1], hit);
  }
  return [...byFile.values()].sort((a, b) => b.count - a.count);
}

export function searchTranscripts(query, files) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 3) return Promise.resolve({ ok: false, error: 'type at least 3 characters' });
  if (!files.length) return Promise.resolve({ ok: true, hits: [] });
  // ponytail: every file goes on one command line, so a store of many thousand listed chats can pass ARG_MAX (1 MB on macOS); feed rg the list in batches if that happens.
  const rg = findBin('rg');
  if (!rg) return Promise.resolve({ ok: false, error: 'search inside chats needs ripgrep: brew install ripgrep' });
  return new Promise((resolve) => {
    execFile(rg, ['-F', '-i', '-n', '-H', '--no-heading', '-M', '200000', '--max-count', '50', '--', q, ...files],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        // ripgrep exits 1 when nothing matched; that is an empty result, not a failure.
        if (err && err.code !== 1) return resolve({ ok: false, error: `search failed: ${err.message.split('\n')[0]}` });
        resolve({ ok: true, hits: parseHits(stdout, q) });
      });
  });
}
