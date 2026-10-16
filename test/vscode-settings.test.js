/**
 * The gate that made restore a no-op.
 *
 * task.allowAutomaticTasks is application-scoped, so it only counts in USER
 * settings. These tests cover reading it out of real-world JSONC (comments,
 * trailing commas, URLs containing "//") and patching it without destroying the
 * file, because that file is hand-maintained.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-vs-'));
process.env.HOME = fakeHome;

const {
  readAutoTaskSetting, enableAutoTasks, userSettingsPath,
  readPersistentSessions, setPersistentSessions,
} = await import('../src/restore/vscode-settings.js');

function writeSettings(content) {
  const file = userSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('a missing settings.json reads as disabled, not as an error', () => {
  fs.rmSync(path.join(fakeHome, 'Library'), { recursive: true, force: true });
  const s = readAutoTaskSetting();
  assert.equal(s.enabled, false);
  assert.equal(s.readable, false);
});

test('reads the setting out of plain JSON', () => {
  writeSettings('{ "task.allowAutomaticTasks": "on" }');
  assert.equal(readAutoTaskSetting().enabled, true);
});

test('"off" is reported as disabled but present', () => {
  writeSettings('{ "task.allowAutomaticTasks": "off" }');
  const s = readAutoTaskSetting();
  assert.equal(s.enabled, false);
  assert.equal(s.present, true);
});

test('a commented-out setting does not count as enabled', () => {
  writeSettings('{\n  // "task.allowAutomaticTasks": "on",\n  "editor.fontSize": 13\n}');
  assert.equal(readAutoTaskSetting().present, false);
});

test('a URL containing // does not break comment stripping', () => {
  writeSettings(`{
  "http.proxy": "https://example.com//weird//path",
  "task.allowAutomaticTasks": "on"
}`);
  assert.equal(readAutoTaskSetting().enabled, true, 'string contents must not be treated as comments');
});

test('block comments are handled', () => {
  writeSettings('{\n  /* "task.allowAutomaticTasks": "on" */\n  "a": 1\n}');
  assert.equal(readAutoTaskSetting().present, false);
});

test('enabling inserts the key and keeps every other setting and comment', () => {
  writeSettings(`{
  // my editor prefs
  "editor.fontSize": 13,
  "files.autoSave": "afterDelay",
}`);
  const result = enableAutoTasks();
  assert.equal(result.changed, true);

  const after = fs.readFileSync(userSettingsPath(), 'utf8');
  assert.match(after, /"task\.allowAutomaticTasks":\s*"on"/);
  assert.match(after, /\/\/ my editor prefs/, 'comments must survive');
  assert.match(after, /"editor\.fontSize": 13/, 'other settings must survive');
  assert.match(after, /"files\.autoSave"/);
  assert.equal(readAutoTaskSetting().enabled, true);
});

test('enabling flips an existing "off" in place', () => {
  writeSettings('{\n  "task.allowAutomaticTasks": "off",\n  "editor.fontSize": 13\n}');
  enableAutoTasks();
  const after = fs.readFileSync(userSettingsPath(), 'utf8');
  assert.match(after, /"task\.allowAutomaticTasks":\s*"on"/);
  assert.ok(!after.includes('"off"'), 'the old value must be gone, not duplicated');
  assert.match(after, /"editor\.fontSize": 13/);
});

test('a backup is written before any change', () => {
  const file = writeSettings('{\n  "editor.fontSize": 13\n}');
  const result = enableAutoTasks();
  assert.ok(fs.existsSync(`${file}.csr-backup`), 'no backup written');
  assert.match(fs.readFileSync(result.backup, 'utf8'), /"editor\.fontSize": 13/);
  assert.ok(!fs.readFileSync(result.backup, 'utf8').includes('allowAutomaticTasks'));
});

test('enabling twice is a no-op the second time', () => {
  writeSettings('{\n  "editor.fontSize": 13\n}');
  assert.equal(enableAutoTasks().changed, true);
  assert.equal(enableAutoTasks().changed, false);
});

test('a missing settings.json is created rather than erroring', () => {
  fs.rmSync(path.join(fakeHome, 'Library'), { recursive: true, force: true });
  const result = enableAutoTasks();
  assert.equal(result.changed, true);
  assert.equal(readAutoTaskSetting().enabled, true);
});

test('an unset persistence flag reads as on, because VSCode defaults to on', () => {
  writeSettings('{ "editor.fontSize": 13 }');
  const p = readPersistentSessions();
  assert.equal(p.present, false);
  assert.equal(p.value, null);
  assert.equal(p.effective, true, 'absent must not be mistaken for off');
});

test('turning persistence off writes a real boolean, not a string', () => {
  writeSettings('{\n  // keep me\n  "editor.fontSize": 13\n}');
  const result = setPersistentSessions(false);
  assert.equal(result.changed, true);

  const raw = fs.readFileSync(userSettingsPath(), 'utf8');
  assert.match(raw, /"terminal\.integrated\.enablePersistentSessions":\s*false/);
  assert.ok(!/enablePersistentSessions":\s*"false"/.test(raw), 'must not be quoted');
  assert.match(raw, /\/\/ keep me/, 'comments must survive');
  assert.equal(readPersistentSessions().effective, false);
});

test('flipping persistence back on replaces rather than duplicates the key', () => {
  writeSettings('{\n  "terminal.integrated.enablePersistentSessions": false\n}');
  setPersistentSessions(true);
  const raw = fs.readFileSync(userSettingsPath(), 'utf8');
  assert.equal((raw.match(/enablePersistentSessions/g) ?? []).length, 1, 'key duplicated');
  assert.equal(readPersistentSessions().value, true);
});
