/**
 * Scanning and the project tree, against a fake ~/.claude tree.
 *
 * HOME is redirected before the modules load, because paths.js resolves the
 * Claude directory once at import time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-scan-'));
process.env.HOME = fakeHome;

const projects = path.join(fakeHome, '.claude', 'projects');

let n = 0;
const uuid = () => `${String(n += 1).padStart(8, '0')}-1111-2222-3333-444444444444`;

function seedProject(dirName, cwd, count = 1) {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const body = { type: 'user', message: { content: `chat ${i}` }, ...(cwd ? { cwd } : {}) };
    fs.writeFileSync(path.join(dir, `${uuid()}.jsonl`), `${JSON.stringify(body)}\n`);
  }
}

const sessionsModule = await import('../src/core/sessions.js');
const { scanSessions } = sessionsModule;
const requireSessions = () => sessionsModule;

test('a project whose transcripts carry no cwd does not hang the scan', () => {
  // Seen live: a scratchpad directory belonging to another Claude session held
  // three transcripts with no cwd anywhere in the head. That project became a
  // root with cwd null, and the tree walk matched children by `child.parent ===
  // project.cwd`, so every root with a null parent counted as its own child.
  // The scan died with "Maximum call stack size exceeded" and the window showed
  // nothing but "could not load".
  seedProject('-Users-you-Projects', '/Users/you/Projects', 2);
  seedProject('-Users-you-Projects-reader', '/Users/you/Projects/reader', 1);
  seedProject('-Users-you-Other', '/Users/you/Other', 1);
  seedProject('-private-tmp-scratchpad', null, 3);

  let result;
  assert.doesNotThrow(() => { result = scanSessions(); }, 'the scan must survive a cwd-less project');

  assert.equal(result.projects.length, 4);
  const labels = result.projects.map((p) => p.label);
  assert.equal(new Set(labels).size, labels.length, 'every project appears exactly once');
});

test('a parent still comes before its children', () => {
  const ordered = scanSessions().projects.map((p) => p.label);
  const parent = ordered.indexOf('/Users/you/Projects');
  const child = ordered.indexOf('/Users/you/Projects/reader');
  assert.ok(parent >= 0 && child >= 0, 'both must be listed');
  assert.ok(parent < child, 'a child must follow its parent');
});

test('subfolder chats are counted in the parent, and the parent is not a child', () => {
  const byLabel = new Map(scanSessions().projects.map((p) => [p.label, p]));
  assert.equal(byLabel.get('/Users/you/Projects').allSessions.length, 3, '2 of its own plus 1 nested');
  assert.equal(byLabel.get('/Users/you/Projects').parent, null);
  assert.equal(byLabel.get('/Users/you/Projects/reader').parent, '/Users/you/Projects');
});

test('an SDK run is not a chat you had', () => {
  // Measured on this machine: 10,776 of 10,845 transcripts carried
  // entrypoint "sdk-cli" from one experiment harness that ran the same prompt
  // over and over. Listing those as chats made the header read 10,845 and
  // buried 59 real ones. registry.js already applies this rule to live
  // sessions; the scan simply never read the field.
  const dir = path.join(projects, '-Users-you-Experiment');
  fs.mkdirSync(dir, { recursive: true });
  const write = (entrypoint) => {
    const body = {
      type: 'user', cwd: '/Users/you/Experiment', entrypoint,
      message: { content: 'go' },
    };
    fs.writeFileSync(path.join(dir, `${uuid()}.jsonl`), `${JSON.stringify(body)}\n`);
  };
  write('sdk-cli');
  write('sdk-cli');
  write('cli');

  const result = scanSessions();
  const mine = result.sessions.filter((s) => s.cwd === '/Users/you/Experiment');
  assert.equal(mine.length, 1, 'only the terminal chat counts');
  assert.equal(result.sdkHidden, 2, 'the hidden ones are still reported, not silently dropped');
});

test('a transcript with no entrypoint is kept, not assumed to be an SDK run', () => {
  // Older transcripts predate the field. Dropping them would erase history.
  const dir = path.join(projects, '-Users-you-Old');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${uuid()}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: '/Users/you/Old', message: { content: 'hi' } })}\n`,
  );
  assert.equal(scanSessions().sessions.filter((s) => s.cwd === '/Users/you/Old').length, 1);
});

test('a name Claude Code derived from the folder loses to the title you set', () => {
  // The registry carries nameSource: "derived" when Claude Code invents a name
  // from the directory, such as "projects-d8" or "armorio-40". Three live
  // sessions showed those instead of Shop_ci, SDK_Sync and AWS_Deployment,
  // which were sitting in their transcripts as custom titles the whole time.
  const { preferredLiveName } = requireSessions();
  assert.equal(
    preferredLiveName({ name: 'projects-d8', nameSource: 'derived' }, 'Shop_ci'),
    null,
    'a derived name must not win over a real title',
  );
  assert.equal(
    preferredLiveName({ name: 'Blog_seo', nameSource: 'user' }, 'Old_title'),
    'Blog_seo',
    'a name you set is fresher than the transcript',
  );
  assert.equal(
    preferredLiveName({ name: 'projects-d8', nameSource: 'derived' }, null),
    'projects-d8',
    'with nothing better, the derived name is still better than nothing',
  );
  // Older registries wrote no nameSource at all; those must keep working.
  assert.equal(preferredLiveName({ name: 'Legacy' }, 'Other'), 'Legacy');
});

test('transcripts of one conversation are numbered as parts of a chain', () => {
  // A chat that runs out of context continues in a new transcript. The carried
  // entries keep their original session_id, which is the link. Measured live:
  // Api_seo was 8ef488ea -> 26a2c126 -> ed856ea6, three files, one chat.
  const { markContinuationChains } = requireSessions();
  const s = (id, parent, at) => ({ sessionId: id, parentSessionId: parent, name: 'Chat', modifiedAt: at });
  const a = s('aaa', null, 1); const b = s('bbb', 'aaa', 2); const c = s('ccc', 'bbb', 3);
  const lone = { sessionId: 'zzz', parentSessionId: null, name: 'Other', modifiedAt: 9 };
  markContinuationChains([a, b, c, lone]);

  assert.deepEqual([a.chainPart, a.chainSize], [1, 3]);
  assert.deepEqual([c.chainPart, c.chainSize], [3, 3]);
  assert.equal(lone.chainPart, undefined, 'a chat that never rolled over is not numbered');
});

test('two chats sharing a title are not chained together', () => {
  // Both Shop_ui chats open with a continuation summary and carry the same title,
  // but neither continues the other. Grouping on title or timestamps would have
  // merged them; the parent link does not.
  const { markContinuationChains } = requireSessions();
  const one = { sessionId: 'b45', parentSessionId: '72b', name: 'Shop_ui', modifiedAt: 2 };
  const two = { sessionId: 'b16', parentSessionId: null, name: 'Shop_ui', modifiedAt: 1 };
  markContinuationChains([one, two]);
  assert.equal(one.chainSize, undefined);
  assert.equal(two.chainSize, undefined);
});

test('a parent that no longer exists does not break the walk', () => {
  const { markContinuationChains } = requireSessions();
  const orphan = { sessionId: 'kid', parentSessionId: 'deleted-long-ago', name: 'Kid', modifiedAt: 1 };
  assert.doesNotThrow(() => markContinuationChains([orphan]));
  assert.equal(orphan.chainSize, undefined);
});

test('a rename ends the chain, because lineage is not a rollover', () => {
  // Following the parent link alone merged six titles into one seven-part
  // chain: renaming or branching also carries the parent's entries. A genuine
  // rollover keeps the title.
  const { markContinuationChains } = requireSessions();
  const older = { sessionId: 'old', parentSessionId: null, name: 'Shop_ui', modifiedAt: 1 };
  const renamed = { sessionId: 'new', parentSessionId: 'old', name: 'Shop_sync_new', modifiedAt: 2 };
  markContinuationChains([older, renamed]);
  assert.equal(older.chainSize, undefined);
  assert.equal(renamed.chainSize, undefined);
});
