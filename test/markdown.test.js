/**
 * The detail panel's markdown: Claude's usual shapes render, and nothing in
 * the text can inject markup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { md } from '../src/core/markdown.js';

test('bold, code, lists and headings render', () => {
  const html = md('## Result\n\n1. **His agent fetch is not cheap.**\n   - `resolve` walks twice\n- one\n- two');
  assert.match(html, /<h4>Result<\/h4>/);
  assert.match(html, /<ol><li><strong>His agent fetch is not cheap.<\/strong><ul><li><code>resolve<\/code> walks twice<\/li><\/ul><\/li><\/ol>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test('tables and fenced code', () => {
  const html = md('| a | b |\n|---|---|\n| 1 | **2** |\n\n```\nnpm test\n```');
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td><strong>2<\/strong><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
});

test('markup in the text stays text, links do not become links', () => {
  const html = md('<img src=x onerror=alert(1)> see [the doc](javascript:alert(1))');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href'));
  assert.match(html, /&lt;img/);
  assert.match(html, /<u>the doc<\/u>/);
});
