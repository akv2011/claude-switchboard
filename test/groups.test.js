/**
 * Groups: a picked group beats the name prefix, which beats the folder; the
 * tree root follows the window, then the projects roots, then home; and
 * groups.json survives bad input.
 *
 * HOME is redirected before the module loads, so nothing touches the real
 * ~/.claude-switchboard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-groups-'));
process.env.HOME = fakeHome;
const file = path.join(fakeHome, '.claude-switchboard', 'groups.json');

const { applyGroups, readGroups, assignGroup, createGroup, deleteGroup, cleanGroupName, rootOf } = await import('../src/core/groups.js');

const chat = (name, extra = {}) => ({ name, cwd: '/Users/you/Desktop/Projects', ...extra });

test('picked beats the name prefix beats the folder; copies of a name move together', () => {
  const s = [
    chat('3D_UI'), chat('3D_Crawl'), chat('3d_SEO'),
    chat('WEB_Sync_new_series (2)'),
    chat('WEB_Sync_new_series'),
    chat('Octa_build'),
    chat('Image check and more'),
    chat('Tools', { cwd: '/Users/you/Documents/Clients' }),
    chat('(unnamed cee07c85)', { cwd: '/Users/you/Music/Audio_Lab' }),
    chat('Loose', { cwd: null }),
  ];
  applyGroups(s, { groups: [], assign: { 'web_sync_new_series': 'Sync' } });
  const by = Object.fromEntries(s.map((x) => [x.name, [x.group, x.autoGroup]]));
  assert.deepEqual(by['3d_SEO'], ['3D', '3D'], 'a prefix in any casing, labelled with the common one');
  assert.deepEqual(by['WEB_Sync_new_series (2)'], ['Sync', 'WEB'], 'the (n) copy shares the pick');
  assert.deepEqual(by.WEB_Sync_new_series, ['Sync', 'WEB']);
  assert.deepEqual(by.Octa_build, ['Octa', 'Octa'], 'a prefix one chat uses is still a group');
  assert.deepEqual(by['Image check and more'], ['Projects', 'Projects'], 'no prefix: the folder, "Projects" at the root');
  assert.deepEqual(by.Tools, ['Clients', 'Clients']);
  assert.deepEqual(by['(unnamed cee07c85)'], ['Audio_Lab', 'Audio_Lab']);
  assert.deepEqual(by.Loose, ['No folder', 'No folder']);
});

test('the tree root: the known window folder, else two levels below home', () => {
  const home = '/Users/you';
  assert.equal(rootOf('/Users/you/Desktop/Projects/storefront/src', home), '/Users/you/Desktop/Projects');
  assert.equal(rootOf('/Users/you/Desktop/Projects', home), '/Users/you/Desktop/Projects');
  assert.equal(rootOf('/Users/you/Desktop', home), '/Users/you/Desktop', 'one level down is its own root');
  assert.equal(rootOf('/Users/you', home), '/Users/you');
  assert.equal(rootOf('/Volumes/Backup/archive', home), '/Volumes/Backup/archive', 'outside home is its own root');
  assert.equal(rootOf(null, home), '');
  const [inWindow, unknown, loose] = applyGroups([
    chat('3D_UI', { cwd: '/Users/you/Desktop/Projects/storefront', workspaceRoot: '/Users/you/Desktop/Projects/storefront' }),
    chat('3D_SEO', { cwd: '/Users/you/Desktop/Projects/api-gateway' }),
    chat('Image check', { cwd: '/Users/you/Desktop/Scratch' }),
  ], { groups: [], assign: {} }, { home });
  assert.equal(inWindow.root, '/Users/you/Desktop/Projects/storefront', 'the window it ran in wins');
  assert.equal(unknown.root, '/Users/you/Desktop/Projects');
  assert.deepEqual([inWindow.groupFrom, loose.groupFrom], ['prefix', 'folder']);
});

test('a projects root from config.json holds everything below it, the deepest when they nest', () => {
  const home = '/Users/you';
  const roots = ['/Users/you/Projects', '/Users/you/Projects/clients'];
  assert.equal(rootOf('/Users/you/Projects/storefront/src', home), '/Users/you/Projects/storefront', 'without it, two levels below home');
  assert.equal(rootOf('/Users/you/Projects/storefront/src', home, roots), '/Users/you/Projects');
  assert.equal(rootOf('/Users/you/Projects', home, roots), '/Users/you/Projects');
  assert.equal(rootOf('/Users/you/Projects/clients/acme', home, roots), '/Users/you/Projects/clients');
  assert.equal(rootOf('/Users/you/Projects-old/x', home, roots), '/Users/you/Projects-old/x', 'a sibling with the same start is not inside');
  const [s] = applyGroups([chat('Notes', { cwd: '/Users/you/Projects/storefront' })], { groups: [], assign: {} }, { home, projectsRoots: roots });
  assert.equal(s.root, '/Users/you/Projects');
});

test('a renamed chat leaves its pick behind and its new prefix files it', () => {
  const config = { groups: ['Misc'], assign: { octa_build: 'Misc' } };
  const before = applyGroups([chat('Octa_build'), chat('3D_UI')], config);
  assert.equal(before[0].group, 'Misc', 'a pick wins for its name');
  assert.equal(before[0].groupFrom, 'pick');
  const after = applyGroups([chat('3D_Octa_build'), chat('3D_UI')], config);
  assert.equal(after[0].group, '3D', 'renamed, nothing else to do');
});

test('group names: trimmed, 1 to 40 characters, no control characters, no slash', () => {
  assert.equal(cleanGroupName('  Billing '), 'Billing');
  for (const bad of ['', '   ', 'a'.repeat(41), 'a/b', 'tab\there', 'new\nline', 42, null, undefined]) {
    assert.equal(cleanGroupName(bad), null, JSON.stringify(bad));
  }
  assert.equal(cleanGroupName('a'.repeat(40)).length, 40);
});

test('create, assign, unassign and delete round-trip through groups.json', () => {
  assert.deepEqual(readGroups(), { groups: [], assign: {} }, 'no file reads as empty');
  assert.equal(createGroup('Billing').name, 'Billing');
  assert.equal(createGroup(' billing ').name, 'Billing', 'creating it again in another casing is a no-op');
  assert.deepEqual(readGroups().groups, ['Billing']);

  assert.ok(assignGroup({ names: ['Octa_build', 'Mail_suite (2)'], group: 'Billing' }).ok);
  assert.deepEqual(readGroups().assign, { octa_build: 'Billing', mail_suite: 'Billing' });
  assert.ok(assignGroup({ names: ['Mail_suite'], group: null }).ok, 'null goes back to automatic');
  assert.deepEqual(readGroups().assign, { octa_build: 'Billing' });

  assert.ok(deleteGroup('Billing').ok);
  assert.deepEqual(readGroups(), { groups: [], assign: {} }, 'deleting a group drops its assignments');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
});

test('bad input is refused and nothing is written', () => {
  fs.rmSync(file, { force: true });
  assert.equal(assignGroup({ names: ['x'], group: 'a/b' }).ok, false);
  assert.equal(assignGroup({ names: [], group: 'A' }).ok, false);
  assert.equal(assignGroup({ names: [''], group: 'A' }).ok, false);
  assert.equal(createGroup('').ok, false);
  assert.equal(fs.existsSync(file), false);
});

test('a corrupt or hand-edited file reads as what is valid in it', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readGroups(), { groups: [], assign: {} });
  fs.writeFileSync(file, JSON.stringify({ groups: ['Ok', 'bad/one', 'Ok', 7], assign: { a: 'Ok', b: '', c: 'x/y' } }));
  assert.deepEqual(readGroups(), { groups: ['Ok'], assign: { a: 'Ok' } });
});

test('a chat renamed <name>_old stays in its family, marked old, so the family can list it apart', () => {
  const s = [{ name: 'Shop_SEO_old', live: true }, { name: 'Shop_SEO' }, { name: 'Paper_numbers_old_2' }, { name: 'Bold_ui_older' }];
  applyGroups(s, { groups: [], assign: {} }, '/Users/you');
  assert.deepEqual(s.map((x) => [x.group, x.isOld]), [['Shop', true], ['Shop', false], ['Paper', true], ['Bold', false]],
    'running or not; "_old" only as the suffix');
});
