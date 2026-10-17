import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-movelock-'));
process.env.HOME = home;
const { claimMove, releaseMove } = await import('../src/core/api.js');
const lock = (key) => path.join(home, '.claude-switchboard', 'moving', `${key}.lock`);

test('one claim per chat; released, it can be claimed again', () => {
  assert.equal(claimMove('chat-a'), true);
  assert.equal(claimMove('chat-a'), false, 'a second mover is turned away');
  assert.equal(claimMove('chat-b'), true, 'another chat is not blocked');
  releaseMove('chat-a');
  assert.equal(claimMove('chat-a'), true);
  releaseMove('chat-a'); releaseMove('chat-b');
});

test('the claim holds across processes, as between the window and the recorder', () => {
  assert.equal(claimMove('chat-c'), true);
  const other = spawnSync(process.execPath, ['--input-type=module', '-e',
    `process.env.HOME = ${JSON.stringify(home)}; const { claimMove } = await import(${JSON.stringify(path.resolve('src/core/api.js'))}); process.stdout.write(String(claimMove('chat-c')));`],
    { encoding: 'utf8' });
  assert.equal(other.stdout, 'false', other.stderr);
  releaseMove('chat-c');
});

test('a claim left by a process that died is taken over', () => {
  const dead = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  fs.mkdirSync(path.dirname(lock('chat-d')), { recursive: true });
  fs.writeFileSync(lock('chat-d'), JSON.stringify({ pid: dead, at: Date.now() }));
  assert.equal(claimMove('chat-d'), true);
  releaseMove('chat-d');
});
