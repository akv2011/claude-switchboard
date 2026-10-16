/**
 * Delete safety, against a fake ~/.claude tree.
 *
 * HOME is redirected before the modules load, because paths.js resolves the
 * Claude directory once at import time. Real user data is never touched here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const PROJECT_DIR = '-Users-test-Desktop-Projects';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-home-'));
process.env.HOME = fakeHome;

const claude = path.join(fakeHome, '.claude');
const projectPath = path.join(claude, 'projects', PROJECT_DIR);

function seed() {
  fs.rmSync(claude, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectPath, SID, 'subagents'), { recursive: true });

  fs.writeFileSync(path.join(projectPath, `${SID}.jsonl`), 'x'.repeat(1000));
  fs.writeFileSync(path.join(projectPath, SID, 'subagents', 'agent-a.jsonl'), 'y'.repeat(500));
  fs.writeFileSync(path.join(projectPath, `${OTHER}.jsonl`), 'z'.repeat(100));

  for (const store of ['session-env', 'file-history', 'tasks']) {
    fs.mkdirSync(path.join(claude, store, SID), { recursive: true });
    fs.writeFileSync(path.join(claude, store, SID, 'data'), 'q'.repeat(50));
  }
  // shell-snapshots is NOT session keyed and must survive untouched.
  fs.mkdirSync(path.join(claude, 'shell-snapshots'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'shell-snapshots', 'snapshot-zsh-123.sh'), 'echo hi');

  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(claude, 'history.jsonl'),
    [
      JSON.stringify({ display: 'a', sessionId: SID }),
      JSON.stringify({ display: 'keep me', sessionId: OTHER }),
      JSON.stringify({ display: 'b', sessionId: SID }),
    ].join('\n') + '\n',
  );
}

const { planDelete, deleteSession, countHistoryLines } = await import('../src/core/deleter.js');

test('the plan finds every store keyed by session id, not just the transcript', () => {
  seed();
  const plan = planDelete({ sessionId: SID, projectDir: PROJECT_DIR });
  const kinds = plan.targets.map((t) => t.kind).sort();
  assert.deepEqual(kinds, [
    'file history', 'session env', 'subagent transcripts', 'task state', 'transcript',
  ]);
  assert.equal(plan.historyLines, 2);
  assert.equal(plan.totalBytes, 1000 + 500 + 50 * 3);
});

test('a session with no side data still plans cleanly', () => {
  seed();
  const plan = planDelete({ sessionId: OTHER, projectDir: PROJECT_DIR });
  assert.deepEqual(plan.targets.map((t) => t.kind), ['transcript']);
  assert.equal(plan.historyLines, 1);
});

test('deleting sweeps all stores and prunes history', () => {
  seed();
  const result = deleteSession({ sessionId: SID, projectDir: PROJECT_DIR }, { force: true });

  assert.equal(fs.existsSync(path.join(projectPath, `${SID}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(projectPath, SID)), false);
  for (const store of ['session-env', 'file-history', 'tasks']) {
    assert.equal(fs.existsSync(path.join(claude, store, SID)), false, `${store} not swept`);
  }
  assert.equal(result.historyRemoved, 2);
  assert.equal(countHistoryLines(SID), 0);
});

test('an unrelated session is left completely alone', () => {
  seed();
  deleteSession({ sessionId: SID, projectDir: PROJECT_DIR }, { force: true });

  assert.ok(fs.existsSync(path.join(projectPath, `${OTHER}.jsonl`)), 'other transcript deleted');
  assert.equal(countHistoryLines(OTHER), 1, 'other history lines pruned');
  assert.ok(
    fs.existsSync(path.join(claude, 'shell-snapshots', 'snapshot-zsh-123.sh')),
    'shell-snapshots is not session keyed and must not be touched',
  );
});

test('nothing is rm-ed: everything lands in Trash and is recoverable', () => {
  seed();
  const result = deleteSession({ sessionId: SID, projectDir: PROJECT_DIR }, { force: true });
  for (const moved of result.moved) {
    assert.ok(moved.trashedTo.includes('.Trash'), `${moved.kind} did not go to Trash`);
    assert.ok(fs.existsSync(moved.trashedTo), `${moved.kind} is not recoverable`);
  }
});

test('a name that is not a session id is refused outright', () => {
  seed();
  assert.throws(
    () => planDelete({ sessionId: '../../../etc', projectDir: PROJECT_DIR }),
    /not a session id/,
  );
  assert.throws(
    () => deleteSession({ sessionId: 'nice-try', projectDir: PROJECT_DIR }, { force: true }),
    /not a session id/,
  );
});

test('a live chat cannot be deleted', async () => {
  seed();
  // Present ourselves as a running session, the way claude does.
  const { execFileSync } = await import('node:child_process');
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
  const { parseProcTime } = await import('../src/core/liveness.js');
  const d = new Date(parseProcTime(lstart, 'local'));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const procStart = `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;

  fs.writeFileSync(
    path.join(claude, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SID, cwd: '/tmp', procStart, name: 'Live' }),
  );

  assert.throws(
    () => deleteSession({ sessionId: SID, projectDir: PROJECT_DIR }),
    /running right now/,
  );
  assert.ok(fs.existsSync(path.join(projectPath, `${SID}.jsonl`)), 'live transcript was deleted');
});

test('deleting a chat also removes it from the restore offer', async () => {
  // Delete swept five stores and left the sixth alone, so a chat you deleted was
  // still offered on the banner and restoring it would have opened nothing.
  seed();
  const snap = await import('../src/core/snapshot.js');
  const { deleteSession } = await import('../src/core/deleter.js');

  const root = path.join(fakeHome, 'proj');
  fs.mkdirSync(root, { recursive: true });
  snap.writeSnapshot([
    { sessionId: SID, cwd: root, name: 'Doomed', startedAt: 1 },
    { sessionId: OTHER, cwd: root, name: 'Keeper', startedAt: 2 },
  ]);
  snap.writeSnapshot([]);   // both go dark, both on offer

  deleteSession({ sessionId: SID, projectDir: PROJECT_DIR });

  const offered = snap.restorableWorkspaces(snap.readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.deepEqual((offered?.sessions ?? []).map((s) => s.name), ['Keeper']);
});
