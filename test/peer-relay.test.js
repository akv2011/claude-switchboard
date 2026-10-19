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
