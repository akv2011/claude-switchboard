/**
 * Mirroring chats' message sockets between the two machines: the pure plan of which socket
 * answers where, and what each machine is told about the other's chats. Then the stand-in records
 * against the real Claude Code, whose startup sweep must leave them in place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const { relayPlan, mirrorPath } = await import('../src/core/peer-relay.js');

test('a chat is mirrored on the other machine in a folder of its own, whatever the systems', () => {
  assert.equal(mirrorPath('/run/user/1000/cc-socks/1588669.sock', 1000), '/tmp/cc-socks-1001000/1588669.sock', 'a Linux chat');
  assert.equal(mirrorPath('/tmp/cc-socks/95240.sock', 501), '/tmp/cc-socks-1000501/95240.sock', 'a Mac chat: never its own /tmp/cc-socks there');
  assert.equal(mirrorPath('/private/tmp/cc-socks-501/12.sock', 501), '/tmp/cc-socks-1000501/12.sock');
  assert.equal(mirrorPath(null, 501), null);
  assert.equal(mirrorPath('/tmp/cc-socks/1.sock', NaN), null, 'no uid, no mirror');
  assert.equal(mirrorPath("/run/user/1000/cc-socks/1';rm -rf ~;'.sock", 1000), null, 'only plain socket names reach ssh');
});

test('relayPlan forwards every chat both ways and lists each side\'s chats for the other', () => {
  const plan = relayPlan({
    local: [{ name: 'build-bot', messagingSocketPath: '/tmp/cc-socks/4242.sock' }, { name: 'Odd', messagingSocketPath: null }],
    remote: [{ name: 'Web UI', messagingSocketPath: '/run/user/1000/cc-socks/77.sock' }],
    localUid: 501, remoteUid: 1000, remoteLabel: 'Devbox', here: 'the Mac',
  });
  assert.deepEqual(plan.forwards, {
    'L /tmp/cc-socks-1001000/77.sock': ['-L', '/tmp/cc-socks-1001000/77.sock:/run/user/1000/cc-socks/77.sock'],
    'R /tmp/cc-socks-1000501/4242.sock': ['-R', '/tmp/cc-socks-1000501/4242.sock:/tmp/cc-socks/4242.sock'],
  });
  assert.deepEqual(plan.onLocal, [{ name: 'Web UI', to: 'uds:/tmp/cc-socks-1001000/77.sock', addr: 'uds:/run/user/1000/cc-socks/77.sock', machine: 'Devbox' }]);
  assert.deepEqual(plan.onRemote, [{ name: 'build-bot', to: 'uds:/tmp/cc-socks-1000501/4242.sock', addr: 'uds:/tmp/cc-socks/4242.sock', machine: 'the Mac' }],
    'a chat with no socket is left out');
});

test('the relay stays off unless config.relay is set', async () => {
  const { syncRelay } = await import('../src/core/peer-relay.js');
  const remote = { reachable: true, stale: false, uid: 1000, sessions: [] };
  assert.equal(await syncRelay({ remote, mac: [], config: { relay: false, remote: { host: 'devbox', label: 'Devbox' } } }), null);
  assert.equal(await syncRelay({ remote, mac: [], config: { relay: true, remote: null } }), null);
});

test('each machine gets a stand-in record per named chat on the other, at its mirror, that no pid check finds alive', () => {
  const plan = relayPlan({
    local: [{ pid: 4242, name: 'build-bot', cwd: '/p', status: 'idle', statusUpdatedAt: 5, messagingSocketPath: '/tmp/cc-socks/4242.sock' },
      { pid: 7, name: null, cwd: '/p', messagingSocketPath: '/tmp/cc-socks/7.sock' }],
    remote: [{ pid: 3096916, name: 'Web UI', cwd: '/p', startedAt: 9, messagingSocketPath: '/run/user/1000/cc-socks/3096916.sock' }],
    localUid: 501, remoteUid: 1000, remoteLabel: 'Devbox', here: 'the Mac',
  });
  assert.deepEqual(plan.recordsRemote, [{ pid: 900004242, sessionId: 'relay-the Mac-4242', name: 'build-bot', cwd: '/p', kind: 'interactive',
    messagingSocketPath: '/tmp/cc-socks-1000501/4242.sock', pidDomain: 'relay:the Mac', relayMirror: 'the Mac', startedAt: 0,
    status: 'idle', statusUpdatedAt: 5 }], 'an unnamed chat gets no record');
  assert.deepEqual(plan.recordsLocal, [{ pid: 903096916, sessionId: 'relay-Devbox-3096916', name: 'Web UI', cwd: '/p', kind: 'interactive',
    messagingSocketPath: '/tmp/cc-socks-1001000/3096916.sock', pidDomain: 'relay:Devbox', relayMirror: 'Devbox', startedAt: 9 }]);
  for (const r of [...plan.recordsLocal, ...plan.recordsRemote]) {
    assert.ok(r.pid > 4194304 && r.pid < 2 ** 31, 'above Linux pid_max, a valid int');
  }
});

// Holds a pty open for claude until SIGTERM, then lets it exit cleanly (so it removes its own
// socket), reading its output all the while: a child left writing to an unread pty never exits.
const PTY = `import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0: os.execv(sys.argv[1], sys.argv[1:])
stop = []
signal.signal(signal.SIGTERM, lambda *a: stop.append(1))
def drain(sec):
    r, _, _ = select.select([fd], [], [], sec)
    if r:
        try: os.read(fd, 65536)
        except OSError: time.sleep(sec)
while not stop: drain(0.2)
os.kill(pid, signal.SIGTERM); end = time.time() + 5
while time.time() < end and os.waitpid(pid, os.WNOHANG)[0] == 0: drain(0.1)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
`;

test('a new Claude Code tab\'s startup sweep keeps the stand-ins', { timeout: 60_000 }, async (t) => {
  const claude = [spawnSync('sh', ['-lc', 'command -v claude']).stdout?.toString().trim(), path.join(os.homedir(), '.local/bin/claude')]
    .find((p) => p && fs.existsSync(p));
  if (!claude) return t.skip('claude is not installed here');
  // Its own config folder, so the sweep runs on these records and never on this machine's chats.
  // Onboarding done and the folder trusted is enough to reach the prompt and register; no login.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark',
    projects: { [fs.realpathSync(cwd)]: { hasTrustDialogAccepted: true } } }));
  const [standIn] = relayPlan({ local: [], remote: [{ pid: 3096916, name: 'Web UI', cwd: '/p',
    messagingSocketPath: '/run/user/1000/cc-socks/3096916.sock' }], localUid: 501, remoteUid: 1000, remoteLabel: 'Devbox', here: 'the Mac' }).recordsLocal;
  // A stand-in without a sessionId, the shape before this fix: the sweep deleting it proves the sweep ran.
  const { sessionId, ...control } = { ...standIn, pid: standIn.pid + 1 };
  const file = (r) => path.join(dir, 'sessions', `${r.pid}.json`);
  for (const r of [standIn, control]) fs.writeFileSync(file(r), JSON.stringify(r));

  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1', TERM: 'xterm-256color' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.TMUX;
  const child = spawn('python3', ['-c', PTY, claude], { cwd, env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  for (let waited = 0; fs.existsSync(file(control)) && waited < 30_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
  child.kill('SIGTERM');
  await exited;

  assert.equal(fs.existsSync(file(control)), false, 'the sweep ran: it deleted the record with no sessionId');
  assert.equal(fs.existsSync(file(standIn)), true, 'the stand-in survived it, so the @ list still offers the other machine\'s chat');
});
