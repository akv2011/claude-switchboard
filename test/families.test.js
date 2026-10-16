/**
 * Families and same names, on the real shapes of a real store: code-prefixed
 * names form families, free-text titles do not, and a reused name gets one
 * role per copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { markFamilies, markSameNames, baseName } from '../src/core/families.js';

const chat = (name, extra = {}) => ({ sessionId: `${name}-${Math.random()}`, name, modifiedAt: 0, live: false, ...extra });

test('code prefixes form families; free text, unnamed and one-name groups do not', () => {
  const s = [
    chat('WEB_crawl'), chat('WEB_seo'), chat('web_ui'),
    chat('Octa_SSf'), chat('Octa'),
    chat('Paper_numbers'), chat('Paper_numbers'),
    chat('Image check'), chat('Image tools'),
    chat('(unnamed cee07c85)'), chat('(unnamed a92ed2c8)'),
    chat('DOC_sync_series (2)'), chat('DOC_UI'),
  ];
  markFamilies(s);
  const fam = Object.fromEntries(s.map((x) => [x.name, x.family ?? null]));
  assert.equal(fam['WEB_crawl'], 'WEB');
  assert.equal(fam['web_ui'], 'WEB', 'the most common casing labels the family');
  assert.equal(fam.Octa, 'Octa', 'a bare prefix joins its family');
  assert.equal(fam.Paper_numbers, null, 'one name used twice is a duplicate, not a family');
  assert.equal(fam['Image check'], null);
  assert.equal(fam['(unnamed cee07c85)'], null);
  assert.equal(fam['DOC_sync_series (2)'], 'DOC');
});

test('baseName drops the (n) suffix', () => {
  assert.equal(baseName('DOC_sync_series (2)'), 'DOC_sync_series');
});

test('same-name roles: running first, then latest; parts, branches and older copies', () => {
  const parent = chat('Other');
  const s = [
    chat('WEB_crawl', { modifiedAt: 5 }),
    chat('WEB_crawl', { modifiedAt: 1, live: true }),
    chat('WEB_crawl', { modifiedAt: 3, chainSize: 2, chainPart: 1 }),
    chat('WEB_crawl', { modifiedAt: 2, parentSessionId: parent.sessionId }),
    parent,
  ];
  markSameNames(s);
  const [newer, live, part, branch] = s;
  assert.equal(live.sameNameRank, 0);
  assert.equal(live.sameNameRole, 'running');
  assert.equal(newer.sameNameRole, 'older');
  assert.equal(part.sameNameRole, 'part');
  assert.equal(branch.sameNameRole, 'branch');
  assert.ok(s.slice(0, 4).every((x) => x.sameNameCount === 4 && x.sameNamePrimaryId === live.sessionId));
  assert.equal(parent.sameNameCount, undefined);
});

test('two live copies of a name are flagged', () => {
  const s = [chat('A_x', { live: true, modifiedAt: 2 }), chat('A_x', { live: true, modifiedAt: 1 })];
  markSameNames(s);
  assert.equal(s[1].sameNameRole, 'also-running');
});

test('with nothing live the newest copy is the latest', () => {
  const s = [chat('B_x', { modifiedAt: 1 }), chat('B_x', { modifiedAt: 9 })];
  markSameNames(s);
  assert.equal(s[1].sameNameRole, 'latest');
  assert.equal(s[0].sameNameRole, 'older');
});
