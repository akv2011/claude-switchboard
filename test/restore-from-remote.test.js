import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A remote that cannot be reached: the .invalid name never resolves.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fromremote-'));
process.env.HOME = home;
const projects = path.join(home, 'Projects');
const cwd = path.join(projects, 'shop');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(home, '.config', 'claude-switchboard'), { recursive: true });
fs.writeFileSync(path.join(home, '.config', 'claude-switchboard', 'config.json'),
  JSON.stringify({ remote: { host: 'devbox.invalid', label: 'Devbox', projectsRoot: '~/Projects', localProjectsRoot: projects } }));
const { restoreGroups } = await import('../src/core/api.js');

test('a chat that last ran on the remote waits instead of opening here from an older copy', async () => {
  const fromRemote = { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'From_remote', cwd, machine: 'mac', lastMachine: 'remote' };
  const here = { sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Local_chat', cwd, machine: 'mac', lastMachine: 'mac' };
  const written = await restoreGroups([{ cwd, sessions: [fromRemote, here] }], { launch: false });
  assert.match(written.find((w) => w.error)?.error ?? '', /From_remote last ran on Devbox, which is unreachable/);
  const tasks = fs.readFileSync(path.join(cwd, '.vscode', 'tasks.json'), 'utf8');
  assert.ok(tasks.includes(here.sessionId), 'the local chat still opens');
  assert.ok(!tasks.includes(fromRemote.sessionId), 'the remote one does not');
});
