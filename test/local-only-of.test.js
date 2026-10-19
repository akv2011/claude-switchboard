import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-localonly-'));
process.env.HOME = home;
const { localOnlyOf } = await import('../src/core/api.js');

test("a closed chat's background tasks closed with it, so they never keep it here", () => {
  const dir = path.join(home, '.claude', 'projects', '-p');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'f1d70e3b-0000-4000-8000-000000000002';
  const shell = { type: 'user', timestamp: '2026-10-17T19:00:00.000Z',
    message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: bnzxxc02n. Output is being written to x' }] } };
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify(shell)}\n`);
  const s = { sessionId: id, projectDir: '-p' };
  assert.equal(localOnlyOf({ ...s, live: true }), '1 background task still running');
  assert.equal(localOnlyOf({ ...s, live: false }), null);
});
