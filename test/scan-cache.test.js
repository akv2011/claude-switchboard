/**
 * The scan cache, against a fake ~/.claude tree.
 *
 * HOME is redirected before the modules load, because paths.js resolves the
 * Claude directory once at import time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-cache-'));
process.env.HOME = fakeHome;

const SID = '77777777-2222-3333-4444-555555555555';
const projectDir = '-Users-you-Projects';
const dir = path.join(fakeHome, '.claude', 'projects', projectDir);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${SID}.jsonl`);

const line = (text) => JSON.stringify({
  type: 'user', cwd: '/Users/you/Projects', message: { content: text },
});

const { scanSessions } = await import('../src/core/sessions.js');
const nameOf = () => scanSessions().sessions.find((s) => s.sessionId === SID)?.name;

test('a cached name is reused rather than read again', () => {
  fs.writeFileSync(file, `${line('first prompt here')}\n`);
  assert.equal(nameOf(), 'first prompt here');

  // Same size, same mtime, different bytes. Only a cache hit can still answer
  // with the old name, so this proves the file is not being re-read.
  //
  // The mtime is restored from the cache's own record rather than from a stat
  // taken here: utimesSync cannot reproduce the sub-millisecond precision that
  // APFS records, so a naive round trip misses the key by a fraction of a ms.
  const cachePath = path.join(fakeHome, '.claude-restore', 'scan-cache.json');
  const { mtimeMs, size } = JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries[SID];

  const swapped = `${line('XXXXX prompt here')}\n`;
  assert.equal(Buffer.byteLength(swapped), size, 'test setup: byte length must match');
  fs.writeFileSync(file, swapped);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  assert.equal(fs.statSync(file).mtimeMs, mtimeMs, 'test setup: mtime must match exactly');

  assert.equal(nameOf(), 'first prompt here', 'unchanged size and mtime must hit the cache');
});

test('a real edit invalidates the cached name', () => {
  fs.writeFileSync(file, `${line('a completely different first prompt')}\n`);
  assert.equal(nameOf(), 'a completely different first prompt');
});

test('a cache written by an older version is ignored, not trusted', async () => {
  const { readScanCache } = await import('../src/core/scan-cache.js');
  const cachePath = path.join(fakeHome, '.claude-restore', 'scan-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 0,
    entries: { [SID]: { size: 1, mtimeMs: 1, name: 'from an old version', cwd: null } },
  }));
  assert.equal(readScanCache().size, 0, 'a version bump must invalidate every entry');
});

test('an unreadable cache never fails a scan', () => {
  fs.writeFileSync(path.join(fakeHome, '.claude-restore', 'scan-cache.json'), 'not json{{');
  assert.doesNotThrow(() => scanSessions());
  assert.equal(nameOf(), 'a completely different first prompt');
});
