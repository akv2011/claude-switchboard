/**
 * Full-text search keeps matches in what was said, not in tool output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHits, snippet, lineText } from '../src/core/search.js';

const said = JSON.stringify({ type: 'user', message: { content: 'please fix the image uploader before the deploy' } });
const replied = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The image uploader now retries.' }, { type: 'tool_use', input: { command: 'uploader' } }] } });
const toolOut = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'grep uploader: 400 lines' }] } });

test('only text people and Claude wrote counts, one hit per file', () => {
  const out = [`/a/x.jsonl:3:${said}`, `/a/x.jsonl:9:${replied}`, `/a/y.jsonl:2:${toolOut}`, 'garbage'].join('\n');
  const hits = parseHits(out, 'uploader');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, '/a/x.jsonl');
  assert.equal(hits[0].count, 2);
  assert.match(hits[0].snippet, /image uploader/);
});

test('snippets centre on the match and say when they are cut', () => {
  const s = snippet(`${'a '.repeat(100)}needle${' b'.repeat(100)}`, 'NEEDLE', 30);
  assert.match(s, /^….*needle.*…$/);
  assert.equal(lineText({ type: 'system', message: { content: 'x' } }), '');
});
