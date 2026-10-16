/**
 * "Needs you" on real last lines from a real store, when 5 of 10 live chats were
 * flagged and about 3 of them were wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { needsYou } from '../src/core/sessions.js';

const real = [
  ["If one comes through that's noise, or one you expected never shows up, send me a screenshot. I'll add a case for it to the test file", false],
  ['The phone is still on the old build, so the alert will fire about an hour after the check\'s first run, unless you install the new one', false],
  ['Nothing changes on your side. Run the pinned command from my last message at 20:00Z, then tell me it has started so I can update the dashboard.', true],
  ['If you want it in git, I can add it with Git LFS, or remove the recordings line from .gitignore', true],
  ['Want me to push it?', true],
  ['Done: 23 reviews posted.', false],
];

for (const [line, expected] of real) {
  test(`${expected ? 'asks' : 'does not ask'}: ${line.slice(0, 50)}`, () => {
    assert.equal(needsYou(true, 'idle', line), expected);
  });
}

test('a working chat never needs you, whatever its last line asked', () => {
  assert.equal(needsYou(true, 'shell', 'Want me to push it?'), false);
  assert.equal(needsYou(true, 'busy', 'Should I deploy?'), false);
});

test('the registry saying waiting is enough; a stopped chat never needs you', () => {
  assert.equal(needsYou(true, 'waiting', 'Reading files.'), true);
  assert.equal(needsYou(false, null, 'Want me to push it?'), false);
});

test('a chat whose last word is a usage limit, with no prompt since, is marked stopped on it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readTailFacts } = await import('../src/core/model.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csr-limit-')), 't.jsonl');
  const limit = { type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: '2026-10-16T10:00:00Z',
    message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 1:40am (UTC)" }] } };
  const before = { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Working on it.' }] } };
  // Every real entry ends in a newline; the tail reader drops a final line without one.
  fs.writeFileSync(file, `${[before, limit].map((e) => JSON.stringify(e)).join('\n')}\n`);
  const f = readTailFacts(file);
  assert.equal(f.stoppedOn.kind, 'limit');
  assert.match(f.stoppedOn.text, /resets 1:40am/);
  assert.equal(f.model, 'claude-opus-5-5', 'the synthetic entry does not become the model');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'continue' } })}\n`);
  assert.equal(readTailFacts(file).stoppedOn, null, 'a prompt after it means it was picked up');
});
