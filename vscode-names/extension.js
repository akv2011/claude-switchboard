/**
 * Keeps a chat's VS Code tab named after the chat.
 *
 * The window opens a chat's terminal with a fixed name, and VS Code then ignores any title the
 * program inside sends, so /rename and /branch never reached the tab: a branched chat's tab kept
 * the name of the chat it came from. This renames the tab to the chat's name, for chats here
 * (the registry's name of the claude under the tab's shell) and remote ones (the recorder's
 * remote-tabs.json and its last reading of the remote).
 *
 * VS Code renames only the terminal in front. The one in use is renamed at once; another waits
 * until the person opens it or leaves the window, so a rename never moves the view under their
 * hands. Its own extension, because VS Code loads a new one into open windows at once.
 */
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');
const STATE = path.join(os.homedir(), '.claude-switchboard');
const TICK_MS = 5000;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A name Claude made up from the folder is no better than the tab's.
const named = (s) => typeof s?.name === 'string' && s.name && s.nameSource !== 'derived';

function parents() {
  return new Promise((resolve) => execFile('ps', ['-eo', 'pid=,ppid='], (err, out) => resolve(new Map(
    String(out ?? '').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([a, b]) => a && b),
  ))));
}

/** The chat name each tab should carry, by the tab's shell pid. */
async function wantedNames(shells) {
  const want = new Map();
  const ppid = await parents();
  let files = [];
  try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of files) {
    const s = readJson(path.join(SESSIONS, f));
    if (!named(s) || !s.pid || !alive(s.pid)) continue;
    // claude runs under the tab's shell, sometimes through a wrapper or two.
    for (let p = ppid.get(s.pid), hops = 0; p > 1 && hops < 4; p = ppid.get(p), hops += 1) {
      if (shells.has(p)) { want.set(p, s.name); break; }
    }
  }
  const tabs = readJson(path.join(STATE, 'remote-tabs.json')) ?? {};
  for (const s of readJson(path.join(STATE, 'remote-live.json'))?.sessions ?? []) {
    const shell = s.tmux ? tabs[s.tmux] : undefined;
    if (shell && named(s)) want.set(shell, s.name);
  }
  return want;
}

const applied = new WeakMap();
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const terms = [];
    for (const t of vscode.window.terminals) if (!t.exitStatus) terms.push([await t.processId, t]);
    const want = await wantedNames(new Set(terms.map(([pid]) => pid)));
    const active = vscode.window.activeTerminal;
    for (const [pid, t] of terms) {
      const name = want.get(pid);
      if (!name || t.name === name || applied.get(t) === name) continue;
      if (t !== active && vscode.window.state.focused) continue;
      if (t !== active) t.show(true);
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      applied.set(t, name);
      if (t !== active && active) active.show(true);
    }
  } catch {
    // Tried again on the next tick.
  } finally {
    busy = false;
  }
}

function activate(context) {
  const timer = setInterval(tick, TICK_MS);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidChangeActiveTerminal(() => tick()),
    vscode.window.onDidChangeWindowState((s) => { if (!s.focused) tick(); }),
  );
  tick();
}

module.exports = { activate, deactivate() {} };
