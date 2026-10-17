import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBackgroundChat } from '../src/core/registry.js';

const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bgchat-'));
const cwd = '/Users/you/Projects';
const id = '0000aaaa-0000-4000-8000-000000000001';
fs.mkdirSync(path.join(projects, '-Users-you-Projects'));
fs.writeFileSync(path.join(projects, '-Users-you-Projects', `${id}.jsonl`), '{}\n');

test('a background session with a transcript is a chat, as one open in a terminal is', () => {
  assert.equal(isBackgroundChat({ kind: 'bg', entrypoint: 'cli', sessionId: id, cwd }, projects), true);
});

test('a spare background worker, with no conversation yet, is not', () => {
  assert.equal(isBackgroundChat({ kind: 'bg', entrypoint: 'cli', sessionId: '0000bbbb-0000-4000-8000-000000000009', cwd }, projects), false);
  assert.equal(isBackgroundChat({ kind: 'bg', name: 'spare', status: 'idle' }, projects), false);
});

test('a run a program started, or a non-background session, is not counted here', () => {
  assert.equal(isBackgroundChat({ kind: 'bg', entrypoint: 'sdk-cli', sessionId: id, cwd }, projects), false);
  assert.equal(isBackgroundChat({ kind: 'interactive', entrypoint: 'cli', sessionId: id, cwd }, projects), false);
});
