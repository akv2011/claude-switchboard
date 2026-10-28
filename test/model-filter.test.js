/**
 * The model filter beside All / Mac / Remote, on the built view in Chromium. The app's window is
 * WebKit, but Playwright's WebKit needs Ubuntu's libraries, which an Arch remote lacks. The overview
 * is the real one, read by getOverview from a fake ~/.claude with three running chats and one
 * stopped; only ssh is stood in, so the remote reads as unreachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { parseProcTime } from '../src/core/liveness.js';

const repo = path.resolve(import.meta.dirname, '..');

/** ps gives local time and the registry records UTC, as Claude Code writes it. */
function procStartUtc(pid) {
  const d = new Date(parseProcTime(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 'local'));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

test('the model buttons show only the chats on that model, and Any model shows them all again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-filter-'));
  const cwd = path.join(dir, 'work');
  const transcripts = path.join(dir, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const registry = path.join(dir, '.claude', 'sessions');
  const bin = path.join(dir, 'bin');
  const config = path.join(dir, '.config', 'claude-switchboard');
  for (const d of [cwd, transcripts, registry, bin, config]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 255\n', { mode: 0o755 });
  // The overview lists tmux sessions; TMUX_TMPDIR keeps it off the real server.
  const env = { ...process.env, HOME: dir, TMUX_TMPDIR: dir, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;

  const chats = [
    { id: '00000000-0000-4000-8000-000000000001', name: 'Opus_One', model: 'claude-opus-5-5', live: true },
    { id: '00000000-0000-4000-8000-000000000002', name: 'Opus_Two', model: 'claude-opus-5-5', live: true },
    // Resumed: the resume's attachments fill the last 256 KB, as in 8 running chats on 2026-10-29.
    { id: '00000000-0000-4000-8000-000000000003', name: 'Sonnet_One', model: 'claude-sonnet-5-5', live: true, resumed: true },
    { id: '00000000-0000-4000-8000-000000000004', name: 'Haiku_Stopped', model: 'claude-haiku-5-5', live: false },
  ];
  const sleepers = [];
  let browser = null;
  try {
    for (const c of chats) {
      const lines = [
        { type: 'user', message: { role: 'user', content: `start ${c.name}` }, cwd, sessionId: c.id, entrypoint: 'cli' },
        { type: 'assistant', effort: 'xhigh', message: { role: 'assistant', model: c.model, content: [{ type: 'text', text: `${c.name} is working.` }] }, cwd, sessionId: c.id },
        ...Array.from({ length: c.resumed ? 15 : 0 }, (_, i) => ({ type: 'attachment', attachment: { type: 'skill_listing', content: `${i}`.padEnd(20_000, '.') }, cwd, sessionId: c.id })),
      ];
      fs.writeFileSync(path.join(transcripts, `${c.id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      if (!c.live) continue;
      const p = spawn('sleep', ['600'], { stdio: 'ignore' });
      sleepers.push(p);
      fs.writeFileSync(path.join(registry, `${p.pid}.json`), JSON.stringify({
        pid: p.pid, sessionId: c.id, cwd, procStart: procStartUtc(p.pid), name: c.name, kind: 'interactive', entrypoint: 'cli',
      }));
    }

    const page = path.join(dir, 'view');
    execFileSync('bun', ['build', path.join(repo, 'src/mainview/index.ts'), '--outdir', page], { stdio: 'pipe' });
    fs.copyFileSync(path.join(repo, 'src/mainview/styles.css'), path.join(page, 'styles.css'));
    const shell = fs.readFileSync(path.join(repo, 'src/mainview/index.html'), 'utf8');
    const script = '<script src="index.js"></script>';
    assert.ok(shell.includes(script), 'the page loads index.js');

    browser = await chromium.launch();
    const tab = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    const rows = () => tab.$$eval('#rows .row[data-id]', (els) => els.map((e) => e.dataset.id).sort());
    /** The window as the app would draw it from this machine's overview now. */
    const open = async () => {
      const overview = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const { getOverview } = await import(${JSON.stringify(path.join(repo, 'src/core/api.js'))});
         process.stdout.write(JSON.stringify(getOverview({ poll: false })));`],
      // stderr is the Mac load reader failing on Linux; it shows only if the overview fails.
      { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      fs.writeFileSync(path.join(page, 'index.html'),
        shell.replace(script, `<script>window.__csrMock = ${overview.replace(/</g, '\\u003c')};</script>${script}`));
      await tab.goto(`file://${path.join(page, 'index.html')}`);
      await tab.waitForSelector('#rows .row[data-id]');
    };

    // With no remote set up, the machine buttons have nothing to pick between.
    await open();
    assert.equal(await tab.isVisible('#on-remote'), false, 'All / Mac / Remote shows with no remote set up');

    fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ remote: { host: 'devbox', label: 'Devbox' } }));
    await open();
    assert.deepEqual(await rows(), chats.map((c) => c.id), 'every chat is listed before a model is picked');

    const models = await tab.$$eval('#models button', (els) => els.map((e) => [e.getAttribute('aria-label') ?? e.textContent, e.getAttribute('aria-pressed')]));
    assert.deepEqual(models, [['Any model', 'true'], ['opus 5.5, 2 running', 'false'], ['sonnet 5.5, 1 running', 'false']],
      'one button per model the running chats use, most used first; the stopped chat\'s model has none');

    await tab.click('#models button[data-model="sonnet 5.5"]');
    assert.deepEqual(await rows(), [chats[2].id], 'sonnet 5.5 shows only the chat on it');
    assert.match(await tab.textContent(`#rows .row[data-id="${chats[2].id}"]`), /Sonnet_One is working\./, 'a resumed chat keeps its last line');
    assert.match(await tab.textContent('#title'), /sonnet 5\.5/);
    assert.equal(await tab.getAttribute('#models button[data-model="sonnet 5.5"]', 'aria-pressed'), 'true');

    await tab.click('#models button[data-model="opus 5.5"]');
    assert.deepEqual(await rows(), [chats[0].id, chats[1].id], 'opus 5.5 shows the two on it');

    await tab.click('#on-remote');
    assert.match(await tab.textContent('#rows'), /Nothing on opus 5\.5 here/, 'the model filter stacks on the machine filter');
    await tab.click('#on-all');

    await tab.click('#models button[data-model=""]');
    assert.deepEqual(await rows(), chats.map((c) => c.id), 'Any model lists every chat again');
    assert.deepEqual(errors, [], 'the page threw');
  } finally {
    await browser?.close();
    for (const p of sleepers) p.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
