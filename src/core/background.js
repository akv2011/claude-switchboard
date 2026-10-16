/**
 * Background agents (`claude --bg`) that are blocked on the person.
 *
 * The list and each agent's state come from `claude agents --json`, the
 * interface Claude Code documents. What an agent is waiting for (needs,
 * detail, a suggested reply, when it last moved) is only in its job file,
 * ~/.claude/jobs/<id>/state.json, which is internal and may change shape; the
 * window labels that text as the agent's own summary.
 *
 * A blocked agent shows up nowhere else, so they pile up unseen. `claude
 * agents --json` costs about 0.3 s and 190 MB for that moment, so it runs at
 * most once a minute, and not at all when Claude Code is not installed.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withoutClaudeMarkers, findBin } from './paths.js';
import { runInVscodeTerminal, shq } from './vscode-bridge.js';

const claudeBin = () => findBin('claude');
const jobsDir = () => path.join(os.homedir(), '.claude', 'jobs');
const TTL_MS = 60_000;
export const STALE_DAYS = 7;

/** The CLI on the logged-in account: never an API key, never a nested session. */
function cliEnv() {
  const env = withoutClaudeMarkers();
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Pure: the CLI's list plus each job file, in the shape the window shows. */
export function parseBackground(list, readJob, now = Date.now()) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a.kind === 'background' && a.state === 'blocked')
    .map((a) => {
      const job = readJob(a.id) ?? {};
      const updated = Date.parse(job.updatedAt ?? '') || (typeof a.startedAt === 'number' ? a.startedAt : null);
      return {
        id: a.id,
        name: a.name ?? job.name ?? a.id.slice(0, 8),
        cwd: a.cwd ?? job.cwd ?? null,
        sessionId: a.sessionId ?? job.sessionId ?? null,
        needs: text(job.needs),
        detail: text(job.detail),
        suggestedReply: text(job.suggestedReply),
        updatedAt: updated,
        stale: updated ? now - updated > STALE_DAYS * 86_400_000 : true,
      };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function readJob(id) {
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir(), id, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

let cache = { at: 0, agents: [], error: null };
export function readBackground({ force = false } = {}) {
  if (!force && Date.now() - cache.at < TTL_MS) return cache;
  const claude = claudeBin();
  if (!claude) {
    cache = { at: Date.now(), agents: [], error: 'Claude Code is not installed (no claude on PATH)' };
    return cache;
  }
  try {
    const out = execFileSync(claude, ['agents', '--json'], { encoding: 'utf8', timeout: 10_000, env: cliEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    cache = { at: Date.now(), agents: parseBackground(JSON.parse(out), readJob), error: null };
  } catch (err) {
    cache = { at: Date.now(), agents: cache.agents, error: `claude agents failed: ${err.message.split('\n')[0]}` };
  }
  return cache;
}

const knownAgent = (id) => readBackground().agents.find((a) => a.id === id) ?? null;

/** Open the agent in a VS Code terminal in its folder: `claude attach <id>`. */
export function openAgent(id) {
  const a = knownAgent(id);
  if (!a) return Promise.resolve({ ok: false, error: 'no such blocked agent' });
  const cwd = a.cwd && fs.existsSync(a.cwd) ? a.cwd : os.homedir();
  return runInVscodeTerminal({ cwd, name: a.name, text: `${shq(claudeBin() ?? 'claude')} attach ${shq(a.id)}` });
}

/** Stop an agent. Its conversation is kept and can be attached again later. */
export function stopAgent(id) {
  const a = knownAgent(id);
  if (!a) return Promise.resolve({ ok: false, error: 'no such blocked agent' });
  return new Promise((resolve) => {
    execFile(claudeBin() ?? 'claude', ['stop', a.id], { timeout: 20_000, env: cliEnv() }, (err, stdout, stderr) => {
      cache.at = 0;
      resolve(err ? { ok: false, error: (stderr || err.message).trim().split('\n').pop() } : { ok: true });
    });
  });
}
