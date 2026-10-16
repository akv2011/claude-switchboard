/**
 * Reading the model and effort a chat is running on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readModelAndEffort, shortModel } from '../src/core/model.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-model-'));
let n = 0;
function transcript(entries) {
  const file = path.join(dir, `t${n += 1}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}
const reply = (model, effort) => ({ type: 'assistant', effort, message: { model } });

test('the last assistant reply is what the chat is running on', () => {
  const file = transcript([
    { type: 'user', message: { content: 'hi' } },
    reply('claude-sonnet-5', 'medium'),
    reply('claude-opus-5', 'high'),
  ]);
  assert.deepEqual(readModelAndEffort(file), { model: 'claude-opus-5', effort: 'high' });
});

test('a synthetic entry is skipped, not reported as the model', () => {
  // Claude Code writes its own errors in as an assistant entry with a
  // bracketed placeholder. A third of the transcripts on this machine end on
  // one, so taking it literally would fill the column with "<synthetic>".
  const file = transcript([
    reply('claude-opus-5', 'high'),
    { type: 'assistant', message: { model: '<synthetic>', content: 'model unavailable' } },
  ]);
  assert.deepEqual(readModelAndEffort(file), { model: 'claude-opus-5', effort: 'high' });
});

test('a chat with no reply yet reports nothing rather than guessing', () => {
  const file = transcript([{ type: 'user', message: { content: 'first prompt' } }]);
  assert.deepEqual(readModelAndEffort(file), { model: null, effort: null });
});

test('a missing file is not an error', () => {
  assert.deepEqual(readModelAndEffort('/nope/missing.jsonl'), { model: null, effort: null });
});

test('an effort-less reply still reports its model', () => {
  const file = transcript([reply('claude-haiku-4-5-20251001', undefined)]);
  assert.deepEqual(readModelAndEffort(file), { model: 'claude-haiku-4-5-20251001', effort: null });
});

test('model ids shorten to something that fits a column', () => {
  assert.equal(shortModel('claude-opus-5'), 'opus 5');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku 4.5');
  assert.equal(shortModel('claude-opus-5[1m]'), 'opus 5 1m');
  assert.equal(shortModel('claude-fable-5-1'), 'fable 5.1');
  assert.equal(shortModel(null), null);
  // An id that does not match the pattern is passed through rather than lost.
  assert.equal(shortModel('some-other-model'), 'some-other-model');
});
