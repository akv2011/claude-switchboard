import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-resume-'));
process.env.HOME = home;
const { resumePoint, checkResumes } = await import('../src/core/resume-check.js');

const at = (min) => `2026-10-19T03:${String(min).padStart(2, '0')}:00.000Z`;
const e = (uuid, parentUuid, type, min, extra = {}) => ({ uuid, parentUuid, type, timestamp: at(min), ...extra });
const history = [e('u1', null, 'user', 0), e('a1', 'u1', 'assistant', 1), e('u2', 'a1', 'user', 2), e('a2', 'u2', 'assistant', 3), e('s1', 'a2', 'system', 4)];
const start = Date.parse(at(10));

test('a resume that continues from the newest message passes, trailing system lines aside', () => {
  assert.deepEqual(resumePoint([...history, e('u3', 'a2', 'user', 11)], start), { skipped: 0, from: at(3), newest: null });
  assert.equal(resumePoint(history, start), null, 'nothing written since the start yet');
});

test('a resume that continues from an older message is caught, with what it left out', () => {
  assert.deepEqual(resumePoint([...history, e('u3', 'a1', 'user', 11)], start), { skipped: 2, from: at(1), newest: at(3) });
});

test('each start is judged once and pings once', () => {
  const dir = path.join(home, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'abcdef12-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [...history, e('u3', 'a1', 'user', 11)].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const pings = [];
  const run = () => checkResumes({ sessions: [{ sessionId: id, name: 'Shop_SEO', startedAt: start }], notify: (m) => pings.push(m) });
  assert.equal(run().length, 1);
  assert.equal(run().length, 0, 'not again for the same start');
  assert.deepEqual(pings, ['Shop_SEO resumed from an older point: 2 newer messages left out']);
});
