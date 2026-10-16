/**
 * Lets Claude Switchboard type a command into a VSCode terminal.
 *
 * The app drops a request file; every VSCode window watches the folder. The
 * window that owns the terminal whose shell pid matches takes it and types into
 * that terminal, so a chat moved to the remote machine comes back in the terminal it ran
 * in. Without a matching terminal (or when it has closed), the window opened on
 * the chat's folder takes it after a grace period and opens a new terminal
 * there. Claiming is an atomic rename, so two windows never both act.
 *
 * Commands such as remote-control's sendSequence type into the active
 * terminal, which can be a different live chat; this matches by pid instead.
 */
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(os.homedir(), '.claude-switchboard', 'vscode');
const REQUESTS = path.join(ROOT, 'requests');
const DONE = path.join(ROOT, 'done');
// Keystrokes for a chat that is running: only ever its own terminal, never a
// new one, and no Enter unless asked. Kept apart from requests/ so a bridge
// from before this existed ignores them instead of opening a terminal.
const KEYS = path.join(ROOT, 'keys');
const KEYS_STALE_MS = 30_000;
const EXACT_GRACE_MS = 1500;
const PARENT_GRACE_MS = 3000;
const STALE_MS = 60_000;

function folders() {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

async function terminalByShellPid(pid) {
  for (const t of vscode.window.terminals) {
    if ((await t.processId) === pid) return t;
  }
  return null;
}

function claim(file) {
  try {
    fs.renameSync(file, `${file}.${process.pid}.claimed`);
    return `${file}.${process.pid}.claimed`;
  } catch {
    return null;
  }
}

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    for (const entry of fs.readdirSync(REQUESTS).filter((n) => n.endsWith('.json'))) {
      const file = path.join(REQUESTS, entry);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const age = Date.now() - req.at;
      if (age > STALE_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const own = req.shellPid ? await terminalByShellPid(req.shellPid) : null;
      const mine = folders();
      const exact = mine.includes(req.cwd);
      const parent = mine.some((f) => req.cwd.startsWith(f + path.sep));
      const take = own || (exact && age > EXACT_GRACE_MS) || (parent && age > PARENT_GRACE_MS);
      if (!take) continue;
      const claimed = claim(file);
      if (!claimed) continue;

      const reuse = own && own.exitStatus === undefined;
      if (own && !reuse) own.dispose();
      const term = reuse ? own : vscode.window.createTerminal({ name: req.name, cwd: req.cwd });
      term.show(false);
      term.sendText(req.text, true);
      fs.writeFileSync(path.join(DONE, entry), JSON.stringify({ reused: Boolean(reuse), folder: mine[0] ?? null, at: Date.now() }));
      fs.rmSync(claimed, { force: true });
    }
  } catch {
    // A missing folder or a raced file is retried on the next tick.
  } finally {
    scanning = false;
  }
}

let keying = false;
async function scanKeys() {
  if (keying) return;
  keying = true;
  try {
    for (const entry of fs.readdirSync(KEYS).filter((n) => n.endsWith('.json'))) {
      const file = path.join(KEYS, entry);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (Date.now() - req.at > KEYS_STALE_MS) { fs.rmSync(file, { force: true }); continue; }
      const own = req.shellPid ? await terminalByShellPid(req.shellPid) : null;
      // Not ours, or the terminal has closed: another window may hold it.
      if (!own || own.exitStatus !== undefined) continue;
      const claimed = claim(file);
      if (!claimed) continue;
      own.sendText(String(req.text), req.newline !== false);
      fs.writeFileSync(path.join(DONE, entry), JSON.stringify({ reused: true, folder: folders()[0] ?? null, at: Date.now() }));
      fs.rmSync(claimed, { force: true });
    }
  } catch {
    // Retried on the next tick.
  } finally {
    keying = false;
  }
}

function activate(context) {
  for (const dir of [REQUESTS, DONE, KEYS]) fs.mkdirSync(dir, { recursive: true });
  const watcher = fs.watch(REQUESTS, () => scan());
  const keyWatcher = fs.watch(KEYS, () => scanKeys());
  // The grace periods are time based, so a quiet folder still needs a tick.
  const timer = setInterval(() => { scan(); scanKeys(); }, 1000);
  context.subscriptions.push({ dispose: () => { watcher.close(); keyWatcher.close(); clearInterval(timer); } });
  scan();
  scanKeys();
}

module.exports = { activate, deactivate() {} };
