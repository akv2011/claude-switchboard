/**
 * The restore mechanism: generating .vscode/tasks.json.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildTasks, mergeTasks, writeRestoreTasks, clearRestoreTasks, shellQuote,
} from '../src/restore/tasks.js';

const sessions = [
  { sessionId: '1deb9f98-6412-45d6-a61e-96c3a18626a1', name: 'desktop_app' },
  { sessionId: 'db451332-53b4-4c28-9f9c-2b8f83fd6483', name: 'Shop_clone_ui' },
];

test('each session becomes a folderOpen task with its own terminal', () => {
  const tasks = buildTasks(sessions);
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    assert.equal(task.runOptions.runOn, 'folderOpen');
    assert.equal(task.presentation.panel, 'dedicated');
  }
  assert.match(tasks[0].command, /claude --resume '1deb9f98-6412-45d6-a61e-96c3a18626a1'/);
  assert.equal(tasks[0].label, 'claude: desktop_app');
});

test('starts are staggered so nine terminals do not launch at once', () => {
  const tasks = buildTasks(sessions, { staggerSeconds: 3 });
  assert.ok(!tasks[0].command.startsWith('sleep'), 'first should start immediately');
  assert.match(tasks[1].command, /^sleep 3; env /);
  assert.match(tasks[1].command, /claude --resume/);
});

test('the restored chat does not inherit the parent session markers', () => {
  // Inheriting CLAUDE_CODE_CHILD_SESSION makes claude treat the chat as a child
  // session: transcript saving off, no registry entry, invisible to the app and
  // to `claude agents`. The conversation is then never written to disk at all.
  const [task] = buildTasks(sessions);
  assert.match(task.command, /^env (-u \S+ )+claude --resume/);
  for (const marker of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) {
    assert.match(task.command, new RegExp(`-u ${marker}\\b`), `${marker} must be stripped`);
  }
});

test('quoting survives a real shell, so a hostile id cannot inject a command', () => {
  // Proven by execution rather than by pattern matching the string: a real sh
  // must hand the whole thing back as one literal argument.
  const hostile = "x'; touch /tmp/csr-pwned; echo '";
  const marker = '/tmp/csr-pwned';
  fs.rmSync(marker, { force: true });

  const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(hostile)}`], { encoding: 'utf8' });
  assert.equal(out, hostile, 'quoted value must round-trip through the shell unchanged');
  assert.equal(fs.existsSync(marker), false, 'injected command executed');
});

test('the generated command embeds the id as a single quoted argument', () => {
  const tasks = buildTasks([{ sessionId: "a'b", name: 'weird' }]);
  const [, arg] = execFileSync(
    'sh',
    ['-c', `set -- ${tasks[0].command.replace(/^.*--resume/, 'x --resume')}; echo $#; echo $3`],
    { encoding: 'utf8' },
  ).trim().split('\n');
  assert.equal(arg, "a'b", 'id must arrive as one intact argument');
});

test('merging preserves the user own tasks and replaces only ours', () => {
  const existing = {
    version: '2.0.0',
    tasks: [
      { label: 'build', type: 'shell', command: 'npm run build' },
      { label: 'claude: OldChat', type: 'shell', command: 'claude --resume old' },
    ],
  };
  const merged = mergeTasks(existing, buildTasks(sessions));
  const labels = merged.tasks.map((t) => t.label);
  assert.ok(labels.includes('build'), 'user task must survive');
  assert.ok(!labels.includes('claude: OldChat'), 'stale generated task must go');
  assert.equal(merged.tasks.filter((t) => t.label.startsWith('claude: ')).length, 2);
});

test('repeated restores do not accumulate duplicate tasks', () => {
  let state = mergeTasks(null, buildTasks(sessions));
  state = mergeTasks(state, buildTasks(sessions));
  state = mergeTasks(state, buildTasks(sessions));
  assert.equal(state.tasks.length, 2);
});

test('writing produces a real tasks.json', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));
  const { tasksFile } = writeRestoreTasks(cwd, sessions);

  const written = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.equal(written.tasks.length, 2);
  assert.equal(written.version, '2.0.0');
});

test('it does NOT write task.allowAutomaticTasks into the workspace', () => {
  // That setting is application-scoped (VSCode schema: scope 1), so a workspace
  // copy is read by nobody. Writing it produced a file that looked like it had
  // enabled something and had not, which is how restore came to do nothing.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));
  writeRestoreTasks(cwd, sessions);
  const settingsFile = path.join(cwd, '.vscode', 'settings.json');
  assert.equal(fs.existsSync(settingsFile), false, 'inert workspace setting must not be written');
});

test('the result reports whether VSCode will actually run the tasks', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));
  const result = writeRestoreTasks(cwd, sessions);
  assert.ok(result.autoTasks, 'callers need to know the tasks may never fire');
  assert.equal(typeof result.autoTasks.enabled, 'boolean');
});

test('a tasks.json containing comments is still parsed rather than overwritten', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));
  fs.mkdirSync(path.join(cwd, '.vscode'));
  fs.writeFileSync(
    path.join(cwd, '.vscode', 'tasks.json'),
    '{\n  // my build task\n  "version": "2.0.0",\n  "tasks": [{"label":"build"}]\n}',
  );
  writeRestoreTasks(cwd, sessions);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.vscode', 'tasks.json'), 'utf8'));
  assert.ok(written.tasks.some((t) => t.label === 'build'), 'commented user task must survive');
});

test('clearing removes only generated tasks', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));
  fs.mkdirSync(path.join(cwd, '.vscode'));
  fs.writeFileSync(
    path.join(cwd, '.vscode', 'tasks.json'),
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build' }] }),
  );
  writeRestoreTasks(cwd, sessions);
  const { removed } = clearRestoreTasks(cwd);
  assert.equal(removed, 2);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.vscode', 'tasks.json'), 'utf8'));
  assert.deepEqual(written.tasks.map((t) => t.label), ['build']);
});

test('tasks share a group, because that is the only way they all run', () => {
  // Measured with four tasks in fresh folders: a shared group ran 4 of 4, no
  // group ran 2 of 4. VSCode shows grouped tasks as split panes, which is a
  // real cost, but restoring two chats out of four is a worse one.
  for (const task of buildTasks(sessions)) {
    assert.equal(task.presentation.group, 'claude');
    assert.equal(task.runOptions.runOn, 'folderOpen', 'each task opens on its own');
  }
});

test('separate tabs can be opted into, at the cost of chats not restoring', () => {
  for (const task of buildTasks(sessions, { separateTabs: true })) {
    assert.equal(task.presentation.group, undefined);
  }
});

test('no dependsOn parent is emitted', () => {
  // A dependsOn parent combined with grouping measured 0 of 4.
  const tasks = buildTasks(sessions);
  assert.equal(tasks.length, sessions.length, 'one task per chat, no orchestrator');
  assert.ok(tasks.every((t) => !t.dependsOn));
});

test('finished restore tasks are swept, so opening the folder later resurrects nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-sweep-'));
  process.env.HOME = home;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-proj-'));

  const snap = await import('../src/core/snapshot.js');
  const { sweepFinishedRestores } = await import('../src/recorder/daemon.js');

  const live = [{ sessionId: 'sw1', cwd, name: 'A' }];
  snap.writeSnapshot(live);
  fs.mkdirSync(path.join(cwd, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.vscode', 'tasks.json'),
    JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build' }, ...buildTasks(live)] }),
  );

  // Still running, nothing pending: the restore is finished, so sweep them.
  sweepFinishedRestores();
  const after = JSON.parse(fs.readFileSync(path.join(cwd, '.vscode', 'tasks.json'), 'utf8'));
  assert.deepEqual(after.tasks.map((t) => t.label), ['build'], 'user task must survive the sweep');

  // While a restore is still pending the tasks must stay put.
  snap.writeSnapshot([]);                       // chats gone, restore point held
  fs.writeFileSync(
    path.join(cwd, '.vscode', 'tasks.json'),
    JSON.stringify({ version: '2.0.0', tasks: buildTasks(live) }),
  );
  sweepFinishedRestores();
  const pending = JSON.parse(fs.readFileSync(path.join(cwd, '.vscode', 'tasks.json'), 'utf8'));
  assert.equal(pending.tasks.length, 1, 'tasks for a pending restore must not be swept');
});
