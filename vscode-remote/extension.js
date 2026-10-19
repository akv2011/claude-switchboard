/**
 * Makes a remote chat's tab act like a local chat's: closing it closes the chat, and an image
 * pastes into it.
 *
 * Its own extension, apart from the bridge: VS Code starts a newly installed extension in
 * windows that are already open, while an update to an installed one waits for an extension
 * host restart, so a feature shipped as a bridge update can sit unloaded for hours.
 */
const vscode = require('vscode');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE = path.join(os.homedir(), '.claude-switchboard');
const HOST_RE = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The configured remote's ssh host, or null. */
function remoteHost() {
  const conf = readJson(path.join(os.homedir(), '.config', 'claude-switchboard', 'config.json'));
  const host = conf?.remote?.host;
  return typeof host === 'string' && HOST_RE.test(host) ? host : null;
}

// Remote chats' tabs by their shell pid, as the recorder writes them: { tmuxName: shellPid }.
function remoteTabOf(pid) {
  const tabs = readJson(path.join(STATE, 'remote-tabs.json')) ?? {};
  return Object.entries(tabs).find(([, shell]) => shell === pid)?.[0] ?? null;
}
const run = (cmd, args, input) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout: 30_000 }, (err) => resolve(!err));
  if (input) child.stdin.end(input);
});
const ssh = (host, script) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'bash', '-s'], script);

/**
 * Closing a remote chat's tab closes the chat, as it does a local chat; the tab is only a
 * view, and the chat ran on. Only when the person closes it: quitting VS Code, a restart,
 * sleep or a dropped link leave the chat to the recorder, which closes it once idle with no
 * tab for 10 minutes (src/core/remote-tabless.js).
 */
async function closedTab(term) {
  if (term.exitStatus?.reason !== vscode.TerminalExitReason.User) return;
  const host = remoteHost();
  const name = host && remoteTabOf(await term.processId);
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return;
  // SIGTERM to the claude in that tmux session: Claude Code exits cleanly on it.
  await ssh(host, `for p in $(tmux list-panes -t '=${name}' -F '#{pane_pid}' 2>/dev/null); do
  if [ "$(ps -o comm= -p $p)" = claude ]; then kill -TERM $p; else kill -TERM $(pgrep -P $p -x claude) 2>/dev/null; fi
done\n`);
}

/** The clipboard's image saved as a PNG at `file`, or false when it holds none. */
function saveClipboardImage(file) {
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'set png to (the clipboard as «class PNGf»)',
      '-e', `set f to open for access (POSIX file "${file}") with write permission`, '-e', 'write png to f', '-e', 'close access f']);
  }
  // Wayland first, then X11.
  const tryOne = ([cmd, ...args]) => new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = fs.createWriteStream(file);
    child.stdout.pipe(out);
    child.on('error', () => resolve(false));
    child.on('close', (code) => out.close(() => resolve(code === 0)));
  });
  return tryOne(['wl-paste', '--no-newline', '--type', 'image/png'])
    .then((ok) => ok || tryOne(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o']));
}

/**
 * Cmd+V or Ctrl+V with an image on the clipboard, in a remote chat's tab. Claude reads a pasted
 * image from the clipboard of the machine it runs on, and the remote has none of this one. The
 * image is copied to ~/.claude-switchboard/pasted on the remote and its path typed in, for
 * Claude to open there. Anything else pastes as usual.
 */
async function paste(key) {
  const term = vscode.window.activeTerminal;
  const plain = () => (key === 'ctrl'
    ? vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\u0016' })
    : vscode.commands.executeCommand('workbench.action.terminal.paste'));
  const host = remoteHost();
  if (!term || !host || !remoteTabOf(await term.processId)) return plain();
  const name = `paste-${Date.now()}.png`;
  const file = path.join(STATE, 'pasted', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved = await saveClipboardImage(file);
  if (!saved || !fs.existsSync(file) || !fs.statSync(file).size) { fs.rmSync(file, { force: true }); return plain(); }
  const copied = await ssh(host, 'mkdir -p ~/.claude-switchboard/pasted\n')
    && await run('scp', ['-q', file, `${host}:.claude-switchboard/pasted/${name}`]);
  if (!copied) { vscode.window.showWarningMessage(`Could not copy the image to ${host}; it is saved here at ${file}`); return; }
  // The remote's home from the last reading, so the path is absolute there.
  const home = readJson(path.join(STATE, 'remote-live.json'))?.home;
  term.sendText(`${home ? `${home}/.claude-switchboard/pasted/${name}` : `~/.claude-switchboard/pasted/${name}`} `, false);
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => { closedTab(t); }),
    vscode.commands.registerCommand('switchboard.paste', () => paste('cmd')),
    vscode.commands.registerCommand('switchboard.pasteCtrl', () => paste('ctrl')),
  );
}

module.exports = { activate, deactivate() {} };
