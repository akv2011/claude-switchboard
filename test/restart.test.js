/**
 * Launch flags for a session-only change, checked against the CLI's lists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchFlags } from '../src/core/restart.js';

test('known values become session flags', () => {
  assert.equal(launchFlags({ model: 'sonnet', effort: 'high', permission: 'plan' }), '--model sonnet --effort high --permission-mode plan');
  assert.equal(launchFlags({ effort: 'low' }), '--effort low');
});

test('anything else is refused before a chat is touched', () => {
  assert.throws(() => launchFlags({ model: 'gpt-5' }), /model must be one of/);
  assert.throws(() => launchFlags({ effort: 'ultra; rm -rf ~' }), /effort must be one of/);
  assert.throws(() => launchFlags({ permission: 'yolo' }), /permission must be one of/);
  assert.throws(() => launchFlags({}), /nothing to change/);
});

test('a new chat goes to the remote machine only when the Mac is strained and the folder can sync', async () => {
  const { chooseMachine } = await import('../src/core/api.js');
  const remote = { host: 'devbox', label: 'Devbox', projectsRoot: '~/Projects', localProjectsRoot: '/home/u/Projects' };
  const base = { macLevel: 'strained', remoteLevel: 'ok', remoteReachable: true, cwd: '/home/u/Projects/web', remote };
  assert.equal(chooseMachine('auto', base).machine, 'remote');
  assert.equal(chooseMachine('auto', { ...base, macLevel: 'ok' }).machine, 'mac');
  assert.equal(chooseMachine('auto', { ...base, cwd: '/home/u/Projects' }).machine, 'mac', 'the projects root itself does not sync');
  assert.equal(chooseMachine('auto', { ...base, remoteLevel: 'strained' }).machine, 'mac');
  assert.match(chooseMachine('remote', { ...base, remoteReachable: false }).error, /unreachable/);
  assert.equal(chooseMachine('mac', base).machine, 'mac');
});

test('with no remote configured every new chat runs here', async () => {
  const { chooseMachine } = await import('../src/core/api.js');
  assert.equal(chooseMachine('auto', { macLevel: 'critical', remoteLevel: 'ok', remoteReachable: true, cwd: '/x', remote: null }).machine, 'mac');
  assert.match(chooseMachine('remote', { macLevel: 'ok', remoteLevel: 'ok', remoteReachable: true, cwd: '/x', remote: null }).error, /no remote machine/);
});
