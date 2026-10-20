/**
 * Mirroring chats' message sockets between the two machines: the pure plan of which socket
 * answers where, and what each machine is told about the other's chats.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.deepEqual(plan.recordsRemote, [{ pid: 900004242, name: 'build-bot', cwd: '/p', kind: 'interactive',
    messagingSocketPath: '/tmp/cc-socks-1000501/4242.sock', pidDomain: 'relay:the Mac', relayMirror: 'the Mac', startedAt: 0,
    status: 'idle', statusUpdatedAt: 5 }], 'an unnamed chat gets no record');
  assert.deepEqual(plan.recordsLocal, [{ pid: 903096916, name: 'Web UI', cwd: '/p', kind: 'interactive',
    messagingSocketPath: '/tmp/cc-socks-1001000/3096916.sock', pidDomain: 'relay:Devbox', relayMirror: 'Devbox', startedAt: 9 }]);
  for (const r of [...plan.recordsLocal, ...plan.recordsRemote]) {
    assert.equal(r.sessionId, undefined, 'never read as this machine holding the chat');
    assert.ok(r.pid > 4194304 && r.pid < 2 ** 31, 'above Linux pid_max, a valid int');
  }
});
