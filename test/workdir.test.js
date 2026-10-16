/**
 * Filing a chat started in ~/Desktop/Projects under the project it works on,
 * from the folder names its recent work runs through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWorkDir } from '../src/core/sessions.js';
import { pathTokens } from '../src/core/model.js';

const subs = new Set(['webapp', 'catalog', 'storefront', 'player']);

test('a clear leader among real subfolders wins', () => {
  assert.equal(pickWorkDir([['catalog', 12], ['storefront', 4], ['node_modules', 40]], subs), 'catalog');
});

test('too few mentions, a split vote, or a project folder itself picks nothing', () => {
  assert.equal(pickWorkDir([['webapp', 2]], subs), null, 'needs 3 or more');
  assert.equal(pickWorkDir([['catalog', 12], ['storefront', 10]], subs), 'catalog');
  assert.equal(pickWorkDir([['catalog', 5], ['storefront', 5], ['webapp', 5]], subs), null, 'no majority');
  assert.equal(pickWorkDir([['catalog', 12]], null), null, 'cwd is a project, not a folder of them');
});

test('path tokens come from replies, tool calls and results', () => {
  const entries = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: { file_path: '/home/a/Projects/webapp/app/page.tsx' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'cd webapp/scripts && ls' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Edited `webapp/README.md`.' }] } },
  ];
  const counts = Object.fromEntries(pathTokens(entries));
  assert.equal(counts['webapp'], 3, 'counted even right after another folder name');
  assert.equal(counts['Projects'], 1);
});
