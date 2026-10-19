/**
 * The remote machine.
 *
 * Pins the parts that run without one: reading its registry out of one ssh
 * reply, naming tmux sessions, and the recorder keeping remote chats on the
 * books while the machine is unreachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-remote-'));
process.env.HOME = fakeHome;
const root = path.join(fakeHome, 'Projects');
fs.mkdirSync(root, { recursive: true });

const { parseProbe, tmuxName, ramUsers, withoutTabHere, rememberRemoteTabs, remoteTabShell, attachShells, attachCommand } = await import('../src/core/remote.js');
const { pollOnce } = await import('../src/recorder/daemon.js');
const { restorableWorkspaces } = await import('../src/core/snapshot.js');
const { splitByMachine } = await import('../src/core/api.js');

const entry = (over) => JSON.stringify({
  pid: 100, sessionId: '0a9f7eff-6798-4159-86a2-2e0020d9c954', cwd: root,
  name: 'site_crawl', status: 'busy', kind: 'interactive', entrypoint: 'cli', ...over,
});

test('parseProbe keeps terminal chats, drops background workers and junk', () => {
  const out = [
    entry({}),
    entry({ pid: 101, sessionId: '11111111-1111-1111-1111-111111111111', kind: 'bg' }),
    'garbage line',
    entry({ pid: 102, sessionId: '22222222-2222-2222-2222-222222222222', cwd: null }),
    '---MEM---', 'MemTotal:       15573980 kB', 'MemAvailable:   13950000 kB',
    '---TMUX---', 'site_crawl', 'build',
  ].join('\n');
  const parsed = parseProbe(out);
  assert.deepEqual(parsed.sessions.map((s) => s.sessionId), ['0a9f7eff-6798-4159-86a2-2e0020d9c954']);
  assert.equal(parsed.sessions[0].machine, 'remote');
  assert.equal(parsed.memTotalMb, 15209);
  assert.equal(parsed.memAvailableMb, 13623);
  assert.deepEqual(parsed.tmux, ['site_crawl', 'build']);
});

test('parseProbe survives an empty or truncated reply', () => {
  assert.deepEqual(parseProbe('').sessions, []);
  assert.equal(parseProbe('---MEM---\n').memTotalMb, null);
});

test('tmuxName keeps letters, digits, _ and -, and caps the length', () => {
  assert.equal(tmuxName('api_sync (2)'), 'api_sync__2_');
  assert.equal(tmuxName('a.b:c'), 'a_b_c');
  assert.equal(tmuxName('x'.repeat(80)).length, 50);
});

test('a remote chat is recorded with its machine, and kept while the machine is unreachable', () => {
  const chat = { sessionId: '0a9f7eff-6798-4159-86a2-2e0020d9c954', cwd: root, name: 'site_crawl', status: 'busy', machine: 'remote' };
  const up = pollOnce({ remote: { reachable: true, sessions: [chat] } });
  assert.equal(up.length, 1);
  assert.equal(up[0].machine, 'remote');

  const blip = pollOnce({ remote: { reachable: false, sessions: [] } });
  assert.deepEqual(blip.map((s) => s.sessionId), [chat.sessionId], 'a blip does not close it');

  const gone = pollOnce({ remote: { reachable: true, sessions: [] } });
  assert.equal(gone.length, 0);
  const offer = restorableWorkspaces(undefined, undefined, new Set(), new Set([chat.sessionId]));
  assert.equal(offer.length, 1, 'shut down for real, so it is offered');
  assert.equal(offer[0].sessions[0].machine, 'remote');

  const stillRunning = restorableWorkspaces(undefined, undefined, new Set([chat.sessionId]), new Set([chat.sessionId]));
  assert.equal(stillRunning.length, 0, 'not offered while live anywhere');
});

test('with no remote configured, nothing is kept for one', () => {
  const none = pollOnce({ remote: { configured: false, reachable: false, sessions: [] } });
  assert.ok(none.every((s) => s.machine !== 'remote'));
});

test('an offer is split by machine for bring-up', () => {
  const { mac, remote } = splitByMachine([{ machine: 'remote' }, { machine: 'mac' }, {}]);
  assert.equal(remote.length, 1);
  assert.equal(mac.length, 2);
});

test('parseProbe reads each chat\'s tmux session, attached terminals, status time and the remote uid', () => {
  const out = [
    entry({ statusUpdatedAt: 1792395427858, messagingSocketPath: '/run/user/1000/cc-socks/100.sock' }),
    '---MEM---', 'UID:1000', 'PANE:100:projects-92', 'CLIENTS:0:$44:projects-92', 'CLIENTS:2:$3:dev-server',
    '---TMUX---', 'projects-92', 'dev-server',
  ].join('\n');
  const probe = parseProbe(out);
  const [chat] = probe.sessions;
  assert.equal(chat.tmux, 'projects-92', 'the session it really runs in, not its name');
  assert.equal(chat.clients, 0);
  assert.equal(chat.statusUpdatedAt, 1792395427858);
  assert.equal(chat.messagingSocketPath, '/run/user/1000/cc-socks/100.sock');
  assert.deepEqual(probe.tmuxIds, { $44: 'projects-92', $3: 'dev-server' });
  assert.equal(probe.uid, 1000);
});

test('after a restart here, remote chats with no attached tab are the ones to reopen', () => {
  const sessions = [{ sessionId: 'a', name: 'Shop_REA' }, { sessionId: 'b', name: 'Set up' }, { sessionId: 'cafe1234-x', name: null }];
  const ps = [
    "  901   812 /usr/bin/ssh -tq devbox tmux -u attach -t '=Shop_REA'",
    '  812   700 /bin/zsh -l',
    "  902   813 /usr/bin/ssh -tq devbox tmux -u attach -t '=Set_up_other'",
    "  903   814 /bin/zsh -c pkill -f \"tmux -u attach -t '=Set_up'\"",
  ].join('\n');
  assert.deepEqual(withoutTabHere(sessions, ps).map((s) => s.sessionId), ['b', 'cafe1234-x'],
    'a tab on another chat whose name starts the same, or a command that only names one, does not count');
  assert.deepEqual(withoutTabHere(sessions, '').map((s) => s.sessionId), ['a', 'b', 'cafe1234-x'], 'no tabs at all: every one');
});

test('a tab running offload attach maps to its shell through the script that waits on ssh', () => {
  const ps = ['  700     1 /bin/zsh -l', '  800   700 /bin/bash /Users/you/bin/offload attach Shop_REA',
    "  801   800 /usr/bin/ssh -tq devbox tmux -u attach -t '=Shop_REA'"].join('\n');
  assert.deepEqual([...attachShells(ps, {})], [['Shop_REA', 700]], 'the tab shell, not the offload script');
});

// offload attach and attachCommand hold the session by id, which a /rename keeps.
const idAttach = (pid, ppid, id) => `  ${pid} ${ppid} /usr/bin/ssh -tq devbox [ "$(tmux display -p -t '${id}' '#{session_created}' 2>/dev/null)" = 1792395855 ] && exec tmux -u attach -t '${id}'; echo 'offload: that chat is no longer on the remote' >&2; exit 1`;

test('a tab attached by tmux id is named from the last reading, so it follows a /rename', () => {
  const ps = ['  700     1 /bin/zsh -l', '  800   700 /bin/bash /Users/you/bin/offload attach projects-ef', idAttach(801, 800, '$44')].join('\n');
  assert.deepEqual([...attachShells(ps, { $44: 'Web_UI' })], [['Web_UI', 700]], 'the name now, not the one it was opened under');
  assert.deepEqual([...attachShells(ps, {})], [], 'an id the reading has not seen yet is left out');
  assert.equal(attachCommand('devbox', 'Web UI', '$44'), `ssh -tq 'devbox' 'tmux -u attach -t '\\''$44'\\'''`);
  assert.equal(attachCommand('devbox', 'Web UI', 'nonsense'), `ssh -tq 'devbox' 'tmux -u attach -t '\\''=Web_UI'\\'''`, 'by name without a real id');
});

test('a tab is remembered while its shell lives, and under its chat\'s new name after a rename', () => {
  const byName = (pid, name, shell) => `  ${pid} ${shell} /usr/bin/ssh -tq devbox tmux -u attach -t '=${name}'`;
  rememberRemoteTabs(`${byName(901, 'Shop_REA', process.pid)}\n${byName(902, 'Gone', 999999)}`, {});
  rememberRemoteTabs('', {});
  assert.equal(remoteTabShell('Shop_REA'), process.pid, 'kept after the link dropped: its shell is still open');
  assert.equal(remoteTabShell('Gone'), null, 'a closed tab is forgotten');
  const ps = idAttach(911, process.pid, '$44');
  rememberRemoteTabs(ps, { $44: 'projects-ef' });
  rememberRemoteTabs(ps, { $44: 'Web_UI' });
  assert.equal(remoteTabShell('Web_UI'), process.pid, 'closing the tab now closes Web_UI');
  assert.equal(remoteTabShell('projects-ef'), null, 'the old name is dropped');
});

test('ramUsers names what holds the remote\'s memory and flags programs whose parent died', () => {
  const ps = [
    '1 0 9000 0 systemd',
    '900 1 12000 1000 systemd',
    '100 1 4000 1000 tmux: server',
    '200 100 3000 1000 zsh',
    '210 200 600000 1000 claude',
    '211 210 300000 1000 node',
    '300 100 3000 1000 zsh',
    '310 300 700000 1000 node',
    '400 900 170000 1000 terraform-provi',
    '401 900 170000 1000 terraform-provi',
    '500 1 50000 0 dockerd',
    '600 650 400000 1000 mutagen-agent',
    '650 640 8000 1000 sshd-session',
  ].join('\n');
  const uses = ramUsers({
    psText: ps, panes: [[200, 'site_crawl'], [300, 'video-render']], uid: 1000, userSystemd: 900, tmpfsKb: 1_500_000,
    sessions: [{ pid: 210, name: 'site_crawl', sessionId: '0a9f7eff' }],
  });
  const by = Object.fromEntries(uses.map((u) => [u.label, u]));
  assert.equal(by['Chat site_crawl'].mb, 882, 'a chat counts its whole tmux pane, MCP servers included');
  assert.equal(by['Job video-render'].mb, 687);
  assert.deepEqual([by['terraform-provi'].count, by['terraform-provi'].leftover, by['terraform-provi'].mb], [2, true, 332]);
  assert.equal(by['Folder sync (Mutagen)'].leftover, false);
  assert.equal(by['Files in /tmp'].mb, 1465);
  assert.equal(by.dockerd, undefined, "another user's daemon is the system's baseline, not shown");
  assert.equal(uses[0].label, 'Files in /tmp', 'biggest first');
});

test('parseProbe reads a Mac remote through the Mac load parser, with its own page size', () => {
  const vmStat = ['Mach Virtual Memory Statistics: (page size of 16384 bytes)', 'Pages free:                               20000.',
    'Pages active:                            300000.', 'Pages inactive:                          290000.', 'Pages wired down:                        100000.',
    'Pages purgeable:                          10000.', 'Anonymous pages:                         400000.', 'Pages occupied by compressor:             50000.',
    'Swapins:                                  12345.', 'Swapouts:                                 23456.'].join('\n');
  const out = [
    entry({ messagingSocketPath: '/tmp/cc-socks/100.sock' }),
    '---MEM---', 'HOME:/Users/you', 'OS:darwin', '---MACSYSCTL---', '17179869184',
    'total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)', '2', '{ 2.50 2.10 1.90 }', '10',
    '---VMSTAT---', vmStat, '---ENDMAC---', 'UID:501', 'PANE:100:site_crawl',
    '---TMUX---', 'site_crawl',
    '---PS---', '100 1 400000 501 /Users/you/.local/bin/claude', '1 0 9000 0 /sbin/launchd', '300 1 300000 501 /Applications/Some Agent.app/Contents/MacOS/agent',
  ].join('\n');
  const p = parseProbe(out);
  assert.equal(p.os, 'darwin');
  assert.equal(p.memTotalMb, 16384);
  assert.equal(p.memAvailableMb, 16384 - Math.round(((400000 - 10000 + 100000 + 50000) * 16384) / 1048576));
  assert.deepEqual([p.swapTotalMb, p.swapUsedMb, p.pressure, p.load1, p.cores, p.pageSize, p.pswpout, p.uid], [2048, 512, 'warn', 2.5, 10, 16384, 23456, 501]);
  assert.equal(p.sessions[0].tmux, 'site_crawl');
  assert.ok(!p.uses.some((u) => u.leftover), "a Mac's launchd agents are never flagged as left behind");
  assert.ok(p.uses.some((u) => u.label === 'agent'), 'a program by its name, not its path');
});
