/**
 * The remote probe, run the way the app runs it (readRemoteLive, with ssh stood in at the network edge)
 * against an isolated tmux server: it renames a chat's tmux session to the chat's name, and the
 * processes it starts grow with the chat panes, not with panes times registry files. On 2026-10-28
 * that product (19 chat panes x 48 registry files, about 900 `ps` starts) took 8.7 to 9.8 s on a
 * remote short of memory, past the 8 s limit, and its card read "No reading". Needs tmux and jq.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const hasTools = ['tmux', 'jq'].every((cmd) => spawnSync(cmd, [cmd === 'tmux' ? '-V' : '--version']).status === 0);

test('the probe renames chat sessions with one process lookup per chat pane', { skip: !hasTools && 'needs tmux and jq: run on a Linux box' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-probe-'));
  const bin = path.join(dir, 'bin');
  const sessions = path.join(dir, '.claude', 'sessions');
  fs.mkdirSync(bin);
  fs.mkdirSync(sessions, { recursive: true });
  // Inside a tmux pane $TMUX points every tmux command at the real server: on 2026-10-26 a test run
  // from a Dell chat killed it and every chat on it. TMUX_TMPDIR puts this server under dir.
  const env = { ...process.env, HOME: dir, TMUX_TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;
  const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8' }).trim();
  const real = (cmd) => execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim();
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // ssh runs the command here; ps and pgrep count each start, as the lookups the probe pays for.
  write('ssh', 'while [ $# -gt 0 ]; do case $1 in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec "$@"');
  for (const cmd of ['ps', 'pgrep']) write(cmd, `echo ${cmd} >> "$HOME/lookups"\nexec ${real(cmd)} "$@"`);
  const record = (pid, name) => fs.writeFileSync(path.join(sessions, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`, cwd: dir, name, kind: 'interactive' }));
  let socket = null;
  try {
    tmux('new-session', '-d', '-s', 'projects-1', 'exec sleep 600 # claude --resume one');
    socket = tmux('display', '-p', '#{socket_path}');
    // Abort before anything is killed unless tmux talks to the test server under dir.
    assert.ok(socket.startsWith(dir), `tmux is not the test server: ${socket}`);
    tmux('new-session', '-d', '-s', 'projects-2', 'sleep 600; : claude --name two');
    tmux('new-session', '-d', '-s', 'build', 'exec sleep 600');
    for (let i = 3; i <= 20; i += 1) tmux('new-session', '-d', '-s', `projects-${i}`, `exec sleep 600 # claude --name n${i}`);
    await new Promise((r) => setTimeout(r, 500));
    const panePid = (s) => Number(tmux('display', '-p', '-t', `=${s}:`, '#{pane_pid}'));
    record(panePid('projects-1'), 'Own Name');
    record(Number(execFileSync(real('pgrep'), ['-P', String(panePid('projects-2'))], { encoding: 'utf8' }).trim()), 'Child Name');
    record(panePid('build'), 'Not Me');
    // Closed chats whose files linger: the old loop paid a ps for each, in every pane.
    for (let i = 0; i < 60; i += 1) record(3_990_000 + i, `Gone ${i}`);

    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { readRemoteLive } = await import(${JSON.stringify(path.join(repo, 'src/core/remote.js'))});
       const r = readRemoteLive({ remote: { host: 'devbox', label: 'Devbox' }, force: true }); console.log(JSON.stringify({ reachable: r.reachable, error: r.error ?? null }));`],
    { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), { reachable: true, error: null });

    const names = tmux('ls', '-F', '#{session_name}').split('\n');
    assert.ok(names.includes('Own_Name'), 'a chat that is the pane process names its session');
    assert.ok(names.includes('Child_Name'), 'a chat that is a child of the pane process names its session');
    assert.ok(names.includes('build') && !names.includes('Not_Me'), 'a pane not started as a chat keeps its name');
    const lookups = fs.readFileSync(path.join(dir, 'lookups'), 'utf8').trim().split('\n').length;
    assert.ok(lookups <= 30, `20 chat panes and 63 registry files took ${lookups} ps/pgrep starts`);
  } finally {
    if (socket?.startsWith(dir)) spawnSync('tmux', ['-S', socket, 'kill-server'], { env });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
