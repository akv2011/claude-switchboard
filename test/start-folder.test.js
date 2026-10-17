import test from 'node:test';
import assert from 'node:assert/strict';
import { startFolder } from '../src/core/paths.js';

const filed = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

test('a chat whose cd moved it into a subfolder still opens where it was started', () => {
  assert.equal(startFolder(filed('/Users/you/Projects'), ['/Users/you/Projects/site']), '/Users/you/Projects');
});

test('a chat that never moved keeps its own folder', () => {
  assert.equal(startFolder(filed('/Users/you/Work/api'), ['/Users/you/Work/api']), '/Users/you/Work/api');
});

test('a later recorded folder is used when the first never walks up to it', () => {
  assert.equal(startFolder(filed('/Users/you/Lab'), [
    '/Users/you/.claude/projects/-Users-you-Lab/memory', '/Users/you/Lab/harness',
  ]), '/Users/you/Lab');
});

test('none is found when no recorded folder leads to the filed name', () => {
  assert.equal(startFolder(filed('/Users/you/Projects'), ['/private/tmp/scratch', null]), null);
});
