/**
 * App side of vscode-bridge/: ask VSCode to type a command into a terminal.
 *
 * Writes a request, waits for a window to report it done, and opens the
 * chat's folder in VSCode when no window has claimed it after a few seconds
 * (the bridge in the new window then takes it). The window that acted is
 * brought to the front with `code <folder>`.
 */
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withoutClaudeMarkers, codeBin } from './paths.js';

const ROOT = path.join(os.homedir(), '.claude-restore', 'vscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (args) => new Promise((resolve) => {
  execFile(codeBin(), args, { env: withoutClaudeMarkers() }, (err) => resolve(!err));
});

/** The installed folder name starts with publisher.name from vscode-bridge/package.json. */
export const BRIDGE_ID = 'csr.csr-bridge';

/** Whether the extension in vscode-bridge/ is installed (`npm run bridge`). */
export function bridgeInstalled(dir = path.join(os.homedir(), '.vscode', 'extensions')) {
  try {
    return fs.readdirSync(dir).some((n) => n.startsWith(`${BRIDGE_ID}-`));
  } catch {
    return false;
  }
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Whether a process has children; a shell with none is sitting at its prompt. */
export function hasChildren(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches.
  }
}

/** The pid of the shell a process runs in, or null. */
export function parentPid(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || null;
  } catch {
    return null;
  }
}

/**
 * Type into the VSCode terminal a running chat sits in. Only that terminal:
 * no window is opened and no new terminal is made. `newline: false` sends a
 * key alone (Esc, Shift+Tab). Fails when no window holds the terminal, which
 * is the case for a chat started outside VSCode.
 */
export async function typeIntoTerminal({ shellPid, text, newline = true }, { root = ROOT, giveUpMs = 6000 } = {}) {
  if (!shellPid) return { ok: false, error: 'no terminal known for this chat' };
  const keys = path.join(root, 'keys');
  const done = path.join(root, 'done');
  fs.mkdirSync(keys, { recursive: true });
  fs.mkdirSync(done, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  fs.writeFileSync(path.join(keys, `${id}.tmp`), JSON.stringify({ shellPid, text, newline, at: Date.now() }));
  fs.renameSync(path.join(keys, `${id}.tmp`), path.join(keys, id));
  const started = Date.now();
  while (Date.now() - started < giveUpMs) {
    if (fs.existsSync(path.join(done, id))) {
      fs.rmSync(path.join(done, id), { force: true });
      return { ok: true };
    }
    await sleep(150);
  }
  fs.rmSync(path.join(keys, id), { force: true });
  return { ok: false, error: 'No open VSCode window has this chat\'s terminal. Only chats in VSCode terminals can be steered from here; if it is one, run "Developer: Restart Extension Host" once to load the updated bridge.' };
}

export async function runInVscodeTerminal(
  { shellPid = null, cwd, name, text },
  { root = ROOT, openAfterMs = 4500, giveUpMs = 25_000, open = (dir) => code([dir]) } = {},
) {
  const requests = path.join(root, 'requests');
  const done = path.join(root, 'done');
  fs.mkdirSync(requests, { recursive: true });
  fs.mkdirSync(done, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const tmp = path.join(requests, `${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ shellPid, cwd, name, text, at: Date.now() }));
  fs.renameSync(tmp, path.join(requests, id));

  const started = Date.now();
  let opened = false;
  while (Date.now() - started < giveUpMs) {
    const result = path.join(done, id);
    if (fs.existsSync(result)) {
      const r = JSON.parse(fs.readFileSync(result, 'utf8'));
      fs.rmSync(result, { force: true });
      if (r.folder) await open(r.folder);
      return { ok: true, reused: r.reused, folder: r.folder };
    }
    if (!opened && Date.now() - started > openAfterMs) {
      opened = true;
      await open(cwd);
    }
    await sleep(250);
  }
  fs.rmSync(path.join(requests, id), { force: true });
  return { ok: false, error: `VSCode did not take it. Is the bridge installed? Run this in a terminal: ${text}` };
}
