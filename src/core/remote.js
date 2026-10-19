/**
 * The remote machine: an optional second computer, reached over ssh, where
 * chats run inside tmux.
 *
 * Configured in ~/.config/claude-switchboard/config.json (see config.js).
 * With no remote configured, every function here returns "not configured"
 * without starting ssh.
 *
 * The remote is a Linux box with tmux, rsync and Claude Code logged in. Its
 * registry has the same shape as this Mac's, so one ssh round trip answers
 * "what is running there": every ~/.claude/sessions/<pid>.json whose pid is
 * still alive, plus free memory, load, the remote home folder, and the tmux
 * session names a user attaches to.
 *
 * Paths: a project at <localProjectsRoot>/app on this Mac lives at
 * <projectsRoot>/app on the remote, with "~" expanded on each machine. Remote
 * chats are shown under their local path, so they group with the local
 * project; the remote path is kept beside it as remoteCwd.
 *
 * The answer is cached in a small file for CACHE_MS. The recorder and the
 * window both poll, and neither must pay an ssh per tick nor block on a
 * machine that is switched off.
 *
 * Unreachable is not "nothing running". A Wi-Fi blip must not make every
 * remote chat look closed and put them on the restore banner, so callers keep
 * the last set they knew about and show the state as stale instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { swapOutRate } from './load.js';
import { stateDir, encodeCwd } from './paths.js';
import { isTerminalSession, treeRss } from './registry.js';
import { readConfig, expandHome } from './config.js';

const CACHE_MS = 25_000;
const STALE_MS = 2 * 60_000;
const SSH_TIMEOUT_MS = 8_000;

const cacheFile = () => path.join(stateDir(), 'remote-live.json');

export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ServerAliveInterval=5'];

/** POSIX single quotes, safe for bash and zsh on the remote. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The configured remote, or null. */
export const remoteConfig = () => readConfig().remote;

/** What every reader gets when no remote is configured. Nothing was asked of the network. */
const OFF = Object.freeze({
  configured: false, label: null, reachable: false, stale: false, checkedAt: null, lastReachableAt: null,
  sessions: [], memTotalMb: null, memAvailableMb: null, tmux: [], liveCount: 0, home: null,
});

// Each registry file is printed only if its pid still exists. Claude deletes
// them on exit, but a crash leaves one behind pointing at a dead pid.
const PROBE = `
for f in "$HOME"/.claude/sessions/*.json; do
  [ -f "$f" ] || continue
  p=$(basename "$f" .json)
  [ -d "/proc/$p" ] || continue
  echo "RSS:$p:$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null)"
  cat "$f"; echo
done
echo "---MEM---"
echo "HOME:$HOME"
grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree|Zswapped):" /proc/meminfo
echo "PSI:$(awk '/^some/{split($3,a,"=");print a[2]}' /proc/pressure/memory 2>/dev/null)"
echo "PSWPIN:$(awk '/^pswpin /{print $2}' /proc/vmstat)"
echo "LOAD:$(cut -d' ' -f1 /proc/loadavg):$(nproc)"
for h in /sys/class/hwmon/hwmon*; do
  case "$(cat "$h/name" 2>/dev/null)" in k10temp|coretemp) echo "TEMP:$(( $(cat "$h/temp1_input") / 1000 ))"; break ;; esac
done
echo "PSWPOUT:$(awk '/^pswpout /{print $2}' /proc/vmstat)"
# A chat renamed with /rename keeps the tmux session named at launch, and every
# control here and \`offload attach\` find a chat by its name: rename the session
# to match. Only sessions offload started a chat in (claude --name or --resume),
# never an offload -d job. Needs jq on the remote; without it nothing is renamed.
# First, so this reading already carries the new names. An open tab keeps its chat:
# it holds the session by its id, which a rename keeps.
command -v jq >/dev/null && tmux list-panes -a -F '#{pane_pid} #{session_name} #{pane_start_command}' 2>/dev/null | while read -r pane sess cmd; do
  case $cmd in *"claude --name"*|*"claude --resume"*) ;; *) continue ;; esac
  for f in "$HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    p=$(basename "$f" .json)
    # zsh -lc execs claude, so the chat is usually the pane's own process.
    [ "$p" = "$pane" ] || [ "$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" = "$pane" ] || continue
    want=$(jq -j '.name // empty' "$f" 2>/dev/null | tr -c 'A-Za-z0-9_-' '_' | cut -c1-50)
    [ -n "$want" ] && [ "$want" != "$sess" ] && ! tmux has-session -t "=$want" 2>/dev/null &&
      tmux rename-session -t "=$sess" "$want"
  done
done
# What holds the memory: the tmux pane of each process tree, whose processes are ours, and /tmp when it is a RAM disk.
tmux list-panes -a -F 'PANE:#{pane_pid}:#{session_name}' 2>/dev/null
# Terminals attached to each session, from anywhere: a chat nothing shows is closed once idle (remote-tabless.js).
tmux ls -F 'CLIENTS:#{session_attached}:#{session_id}:#{session_name}' 2>/dev/null
echo "UID:$(id -u)"
echo "USYSD:$(pgrep -u "$(id -u)" -x systemd | head -1)"
[ "$(findmnt -n -o FSTYPE /tmp 2>/dev/null)" = tmpfs ] && echo "TMPFS:$(df -k --output=used /tmp | tail -1 | tr -d ' ')"
echo "---TMUX---"
tmux ls -F "#{session_name}" 2>/dev/null
echo "---PS---"
ps -e -o pid=,ppid=,rss=,uid=,comm=
# tmux exits 1 with no server and grep exits 1 with no match. Neither is "down".
exit 0
`;

/** `p` moved from under `fromRoot` to under `toRoot`, or null when it is not inside fromRoot. */
export function mapPath(p, fromRoot, toRoot) {
  if (typeof p !== 'string' || !fromRoot || !toRoot) return null;
  if (p === fromRoot) return toRoot;
  return p.startsWith(`${fromRoot}/`) ? `${toRoot}${p.slice(fromRoot.length)}` : null;
}

/** The remote projects root as an absolute path, or null while the remote home is unknown. */
export function remoteRoot(remote, home) {
  const root = remote?.projectsRoot;
  if (!root) return null;
  if (root.startsWith('/')) return root;
  return home ? expandHome(root, home) : null;
}

/** Where a local folder lives on the remote, or null when it is outside the local projects root. */
export function toRemotePath(localPath, remote, home) {
  return mapPath(localPath, remote?.localProjectsRoot, remoteRoot(remote, home));
}

/** Where a remote folder lives on this Mac, or null when it is outside the remote projects root. */
export function toLocalPath(remotePath, remote, home) {
  return mapPath(remotePath, remoteRoot(remote, home), remote?.localProjectsRoot);
}

/**
 * The project folder a chat's files live in: the first folder under the
 * projects root. Null for the root itself, which holds every project and is
 * never synced whole.
 */
export function projectFolder(cwd, root) {
  if (typeof cwd !== 'string' || !root || !cwd.startsWith(`${root}/`)) return null;
  const [first] = cwd.slice(root.length + 1).split('/');
  return first && !first.startsWith('.') ? path.join(root, first) : null;
}

/**
 * Parse the probe's stdout. Pure, so it is testable without a remote.
 *
 * @param {object} [remote] the remote config, for mapping cwds to local paths
 * @returns {{sessions:Array<object>, memTotalMb:number|null, memAvailableMb:number|null, tmux:string[], home:string|null}}
 */
export function parseProbe(stdout, remote = null) {
  const [registryPart = '', rest = ''] = String(stdout).split('---MEM---');
  const [memPart = '', tail = ''] = rest.split('---TMUX---');
  const [tmuxPart = '', psPart = ''] = tail.split('---PS---');
  const home = memPart.match(/^HOME:(\/\S*)$/m)?.[1] ?? null;

  const sessions = [];
  const rssKb = new Map();
  for (const line of registryPart.split('\n')) {
    const trimmed = line.trim();
    const rss = trimmed.match(/^RSS:(\d+):(\d*)$/);
    if (rss) { if (rss[2]) rssKb.set(Number(rss[1]), Number(rss[2])); continue; }
    if (!trimmed.startsWith('{')) continue;
    try {
      const raw = JSON.parse(trimmed);
      if (!isTerminalSession(raw)) continue;
      if (!raw.sessionId || !raw.cwd) continue;
      sessions.push({
        rssMb: rssKb.has(raw.pid) ? Math.round(rssKb.get(raw.pid) / 1024) : null,
        pid: raw.pid ?? null,
        sessionId: raw.sessionId,
        // Shown under the local path so it groups with its project here. A
        // folder outside the projects root has no local twin and keeps its own.
        cwd: toLocalPath(raw.cwd, remote, home) ?? raw.cwd,
        remoteCwd: raw.cwd,
        name: raw.name ?? null,
        nameSource: raw.nameSource ?? null,
        status: raw.status ?? null,
        statusUpdatedAt: raw.statusUpdatedAt ?? null,
        version: raw.version ?? null,
        kind: raw.kind ?? null,
        startedAt: raw.startedAt ?? null,
        messagingSocketPath: raw.messagingSocketPath ?? null,
        machine: 'remote',
      });
    } catch {
      // A half-written registry file. Skip it.
    }
  }

  const mem = (key) => {
    const kb = memPart.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1];
    return kb ? Math.round(Number(kb) / 1024) : null;
  };

  const tmux = tmuxPart.split('\n').map((s) => s.trim()).filter(Boolean);
  const panes = [...memPart.matchAll(/^PANE:(\d+):(.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]);
  // The tmux session each chat really runs in. It can differ from the chat's name (a chat
  // started unnamed and renamed later), and an attach by the name then finds nothing.
  const pane = new Map(panes);
  const parent = new Map([...psPart.matchAll(/^\s*(\d+)\s+(\d+)\s/gm)].map((m) => [Number(m[1]), Number(m[2])]));
  for (const x of sessions) {
    for (let p = x.pid, hops = 0; p > 1 && hops < 64; p = parent.get(p) ?? 0, hops += 1) if (pane.has(p)) { x.tmux = pane.get(p); break; }
  }
  const clientLines = [...memPart.matchAll(/^CLIENTS:(\d+):(?:(\$\d+):)?(.+)$/gm)];
  const clients = new Map(clientLines.map((m) => [m[3].trim(), Number(m[1])]));
  for (const x of sessions) x.clients = clients.get(x.tmux) ?? null;
  // tmux session id to its name now: a tab attached by id follows its chat through a rename.
  const tmuxIds = Object.fromEntries(clientLines.filter((m) => m[2]).map((m) => [m[2], m[3].trim()]));
  // Whole process tree per chat, as on the Mac; VmRSS of claude alone when ps gave nothing.
  const tree = psPart.trim() ? treeRss(psPart, sessions.map((x) => x.pid).filter(Boolean)) : new Map();
  for (const x of sessions) if (tree.has(x.pid)) x.rssMb = tree.get(x.pid);
  const load = memPart.match(/LOAD:([\d.]+):(\d+)/);
  const swapTotalMb = mem('SwapTotal');
  return {
    sessions,
    tmux,
    tmuxIds,
    home,
    // The remote user's uid: the relay names the folder a remote chat's mirror goes in after it.
    uid: Number(memPart.match(/^UID:(\d+)/m)?.[1] ?? NaN),
    memTotalMb: mem('MemTotal'),
    memAvailableMb: mem('MemAvailable'),
    swapTotalMb,
    // zswap keeps compressed pages in RAM; only the rest is on disk.
    swapUsedMb: swapTotalMb === null ? null : Math.max(0, swapTotalMb - (mem('SwapFree') ?? swapTotalMb) - (mem('Zswapped') ?? 0)),
    psiMem60: Number(memPart.match(/PSI:([\d.]+)/)?.[1] ?? NaN),
    pswpin: Number(memPart.match(/PSWPIN:(\d+)/)?.[1] ?? NaN),
    load1: load ? Number(load[1]) : null,
    cores: load ? Number(load[2]) : null,
    tempC: Number(memPart.match(/TEMP:(\d+)/)?.[1] ?? NaN) || null,
    pswpout: Number(memPart.match(/PSWPOUT:(\d+)/)?.[1] ?? NaN),
    uses: ramUsers({
      psText: psPart,
      panes,
      sessions,
      uid: Number(memPart.match(/^UID:(\d+)/m)?.[1] ?? NaN),
      userSystemd: Number(memPart.match(/^USYSD:(\d+)/m)?.[1] ?? 0),
      tmpfsKb: Number(memPart.match(/^TMPFS:(\d+)/m)?.[1] ?? 0),
    }),
  };
}

// Programs that are meant to run with no parent of their own.
const SERVICES = new Set(['systemd', '(sd-pam)', 'sshd-session', 'tmux: server', 'mutagen-agent', 'dbus-daemon', 'dbus-broker',
  'pipewire', 'wireplumber', 'ollama', 'gpg-agent', 'ssh-agent']);
const LABELS = { 'mutagen-agent': 'Folder sync (Mutagen)' };

/**
 * What holds the remote's memory, biggest first: each chat and offload job by its tmux session,
 * the files in /tmp (when it is a RAM disk, which also holds deleted files a process still has
 * open), and the rest of the user's processes by program. A program whose parent died is
 * flagged: a tool's child processes left behind when their folder was deleted can hold gigabytes
 * for days with nothing in view. Pure: the probe's ps text (pid ppid rss uid comm) and tmux panes in.
 */
export function ramUsers({ psText, panes = [], sessions = [], uid, userSystemd = 0, tmpfsKb = 0, top = 6 }) {
  const procs = new Map();
  for (const line of String(psText ?? '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), kb: Number(m[3]), uid: Number(m[4]), comm: m[5].trim() });
  }
  if (!procs.size || !Number.isFinite(uid)) return [];
  const pane = new Map(panes);
  const paneOf = (pid) => {
    for (let x = pid, hops = 0; x > 1 && hops < 64; x = procs.get(x)?.ppid ?? 0, hops += 1) if (pane.has(x)) return x;
    return null;
  };
  const chatPane = new Map(sessions.filter((s) => s.pid).map((s) => [paneOf(s.pid), s.name ?? s.sessionId?.slice(0, 8)]));
  const groups = new Map();
  const add = (key, label, kb, leftover = false) => {
    const g = groups.get(key) ?? groups.set(key, { label, kb: 0, count: 0, leftover }).get(key);
    g.kb += kb; g.count += 1;
  };
  for (const [pid, p] of procs) {
    if (p.uid !== uid || !p.kb) continue;
    const at = paneOf(pid);
    if (at) { add(`tmux:${pane.get(at)}`, chatPane.has(at) ? `Chat ${chatPane.get(at)}` : `Job ${pane.get(at)}`, p.kb); continue; }
    const orphan = (p.ppid === 1 || p.ppid === userSystemd) && !SERVICES.has(p.comm);
    add(`${orphan ? 'left' : 'prog'}:${p.comm}`, LABELS[p.comm] ?? p.comm, p.kb, orphan);
  }
  if (tmpfsKb) add('tmpfs', 'Files in /tmp', tmpfsKb);
  return [...groups.values()]
    .map((g) => ({ label: g.label, mb: Math.round(g.kb / 1024), count: g.count, leftover: g.leftover }))
    .filter((g) => g.mb >= 20)
    .sort((a, b) => b.mb - a.mb)
    .slice(0, top);
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = path.join(stateDir(), `.remote-live.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, cacheFile());
  } catch {
    // A cache that cannot be written only costs the next caller an ssh.
  }
}

function decorate(entry, now, remote) {
  const lastReachableAt = entry.lastReachableAt ?? (entry.reachable ? entry.checkedAt : null);
  return {
    ...entry,
    configured: true,
    label: remote.label,
    lastReachableAt,
    // Known-good data older than this is a guess, and the window says so.
    stale: !entry.reachable || now - (lastReachableAt ?? 0) > STALE_MS,
    liveCount: entry.sessions.length,
  };
}

/**
 * What is running on the remote right now, from the cache when it is fresh.
 *
 * @param {{force?:boolean, remote?:object|null}} [options] `remote` overrides
 *   the configured one; null means none.
 * @returns {{configured:boolean, label:string|null, reachable:boolean, stale:boolean,
 *            checkedAt:number|null, lastReachableAt:number|null, sessions:Array<object>,
 *            memTotalMb:number|null, memAvailableMb:number|null, tmux:string[],
 *            home:string|null, liveCount:number, error?:string}}
 */
export function readRemoteLive(options = {}) {
  const remote = options.remote === undefined ? remoteConfig() : options.remote;
  if (!remote) return { ...OFF, sessions: [], tmux: [] };
  const now = Date.now();
  // A cache from another host says nothing about this one.
  const stored = readCache();
  const cached = stored?.host === remote.host ? stored : null;
  if (cached && !options.force && now - cached.checkedAt < CACHE_MS) return decorate(cached, now, remote);

  let entry;
  try {
    const stdout = execFileSync('ssh', [...SSH_OPTS, remote.host, 'bash', '-s'], {
      input: PROBE,
      encoding: 'utf8',
      timeout: SSH_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    entry = { host: remote.host, checkedAt: now, lastReachableAt: now, reachable: true, ...parseProbe(stdout, remote) };
    // Linux counts pswpout in 4 KB pages since boot; the cached probe is the earlier sample.
    entry.swapOutMbPerMin = cached?.reachable
      ? swapOutRate({ at: cached.checkedAt, swapOuts: cached.pswpout }, { at: now, swapOuts: entry.pswpout }, 4096)
      : null;
    entry.swapInMbPerMin = cached?.reachable
      ? swapOutRate({ at: cached.checkedAt, swapOuts: cached.pswpin }, { at: now, swapOuts: entry.pswpin }, 4096)
      : null;
  } catch (err) {
    // Keep the last set we saw, so a blip does not read as "everything closed".
    entry = {
      host: remote.host,
      checkedAt: now,
      lastReachableAt: cached?.lastReachableAt ?? null,
      reachable: false,
      sessions: cached?.sessions ?? [],
      memTotalMb: cached?.memTotalMb ?? null,
      memAvailableMb: null,
      tmux: cached?.tmux ?? [],
      home: cached?.home ?? null,
      tmuxIds: cached?.tmuxIds ?? {},
      uid: cached?.uid ?? null,
      error: err?.code === 'ETIMEDOUT' ? 'timed out' : 'unreachable',
    };
  }
  writeCache(entry);
  return decorate(entry, now, remote);
}

/** Session ids live on the remote as of the cache, without touching the network. */
export function cachedRemoteLiveIds() {
  const cached = readCache();
  return new Set((cached?.sessions ?? []).map((s) => String(s.sessionId).toLowerCase()));
}

/** tmux session names cannot hold : or ., and chat names often have spaces or brackets. */
export function tmuxName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50);
}

/** Run a bash script on the remote over stdin. Resolves to {ok, stdout, error}. */
export function sshScript(host, script, timeout = 30_000) {
  // On stdin, never as an argument: ssh joins its arguments with spaces, so a
  // script passed to `bash -c` arrives as `bash -c tmux ...`, and a bare tmux
  // tries to start a server ("open terminal failed: not a terminal").
  return new Promise((resolve) => {
    execFile('ssh', [...SSH_OPTS, host, 'bash', '-s'], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err
        ? { ok: false, stdout: stdout ?? '', error: (stderr ?? '').trim().split('\n').pop() || err.message }
        : { ok: true, stdout: stdout ?? '' });
    }).stdin.end(`${script}\n`);
  });
}

/**
 * The shell command that attaches a terminal to a remote chat's tmux session. With the
 * session's id from the last reading it holds the session by id, which a /rename keeps:
 * the probe renames a renamed chat's session, and the tab then still knows its chat.
 */
export function attachCommand(host, name, id = null) {
  const target = /^\$\d+$/.test(String(id ?? '')) ? id : `=${tmuxName(name)}`;
  return `ssh -tq ${q(host)} ${q(`tmux -u attach -t ${q(target)}`)}`;
}

/** The tmux session id a chat runs in, from the last reading, or null. */
export function cachedTmuxId(name) {
  const t = tmuxName(name);
  return Object.entries(readCache()?.tmuxIds ?? {}).find(([, n]) => n === t)?.[0] ?? null;
}

/** This machine's processes as `pid ppid command` lines, or '' when ps fails. */
export function localProcesses() {
  try { return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch { return ''; }
}

/** tmux session ids on the remote to their names, as of the last reading; never touches the network. */
function cachedTmuxIds() {
  return readCache()?.tmuxIds ?? {};
}

/**
 * The shell each remote chat's tab runs in, by tmux name. A tab runs attachCommand
 * (`ssh -tq host tmux -u attach -t '$<id>'`, or `'=<name>'`), directly or under
 * `offload attach`, so the ssh's parent, or the parent of that, is the tab's shell. An
 * id is named from the last reading: the session's name now, after any /rename. One the
 * reading has not seen yet is left out until it has.
 */
export function attachShells(psText, ids = cachedTmuxIds()) {
  const procs = new Map();
  for (const line of psText.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  const shells = new Map();
  for (const p of procs.values()) {
    const target = /^\S*ssh\s/.test(p.command) ? p.command.match(/tmux(?: -u)? attach -t '?(=[A-Za-z0-9_-]+|\$\d+)/)?.[1] : null;
    const name = target?.startsWith('=') ? target.slice(1) : ids[target];
    if (!name) continue;
    let shell = p.ppid;
    if (/\/offload attach /.test(procs.get(shell)?.command ?? '')) shell = procs.get(shell).ppid;
    shells.set(name, shell);
  }
  return shells;
}

/**
 * Remote chats no terminal here is attached to. A restart of this machine closes every
 * remote tab while the chats run on, and restore offers only closed chats, so these are
 * the tabs it would not bring back.
 */
export function withoutTabHere(sessions, psText = localProcesses()) {
  const attached = attachShells(psText);
  return sessions.filter((s) => !attached.has(s.tmux ?? tmuxName(s.name ?? String(s.sessionId).slice(0, 8))));
}

const tabsFile = () => path.join(stateDir(), 'remote-tabs.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Remember the tab shell of every attached remote chat, kept while that shell lives. When
 * the link drops (a remote restart, a long sleep), the tab falls back to its prompt with the
 * chat's name on it, and reattaching in a new tab left two tabs of that name.
 */
export function rememberRemoteTabs(psText = localProcesses(), ids = cachedTmuxIds()) {
  let known = {};
  try { known = JSON.parse(fs.readFileSync(tabsFile(), 'utf8')); } catch { /* none yet */ }
  const next = Object.fromEntries(Object.entries(known).filter(([, pid]) => alive(pid)));
  for (const [name, pid] of attachShells(psText, ids)) {
    // One tab shows one chat: a tab whose chat was renamed drops the old name.
    for (const [old, shell] of Object.entries(next)) if (shell === pid && old !== name) delete next[old];
    next[name] = pid;
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${tabsFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, tabsFile());
  } catch { /* the next tick tries again */ }
  return next;
}

/** The shell of the tab a remote chat last ran in, while that shell is still open. */
export function remoteTabShell(name) {
  try {
    const pid = JSON.parse(fs.readFileSync(tabsFile(), 'utf8'))[tmuxName(name)];
    return pid && alive(pid) ? pid : null;
  } catch { return null; }
}

/**
 * Open a Terminal window attached to a chat running on the remote.
 *
 * A GUI cannot hand its user a live tty, so this launches Terminal.app on a
 * .command file. `open` on a file we wrote ourselves needs no Automation
 * permission, which an osascript "tell Terminal" would.
 */
export function attachInTerminal(name, remote = remoteConfig()) {
  if (!remote) return Promise.resolve({ ok: false, error: 'no remote machine is configured' });
  const dir = path.join(stateDir(), 'attach');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tmuxName(name)}.command`);
  fs.writeFileSync(file, `#!/bin/bash\nexec ${attachCommand(remote.host, name, cachedTmuxId(name))}\n`, { mode: 0o755 });
  return new Promise((resolve) => {
    execFile('open', [file], (err) => resolve(err ? { ok: false, error: err.message } : { ok: true, file }));
  });
}

/**
 * Folders that are never copied between the machines: dependencies, build
 * output and caches, which each machine makes for itself, and .git, so the
 * two copies never fight over one repository's history. A project can add its
 * own rules in a .rsync-filter file (rsync -F).
 */
export const SYNC_EXCLUDES = ['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache', 'dist', 'build', 'target', '.pytest_cache', 'coverage', '.DS_Store', '.git'];

/**
 * Older rsync builds (macOS ships one) pass remote paths through the remote
 * shell unquoted. A path of plain characters means the same thing to every
 * build; anything else is refused before a byte is copied.
 */
export const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/+@=,-]*$/;

/**
 * Copy with rsync over ssh. Never deletes anything on the receiver, and never
 * overwrites a file that is newer there (--update), so a copy that moved on
 * at the other end is not rolled back.
 *
 * @param {string} from a local path, or host:path
 * @param {string} to   a local path, or host:path
 */
export function rsync(from, to, { excludes = SYNC_EXCLUDES, timeout = 600_000 } = {}) {
  const args = ['-a', '-u', '-F', ...excludes.flatMap((e) => ['--exclude', e]), '-e', `ssh ${SSH_OPTS.join(' ')}`, '--', from, to];
  return new Promise((resolve) => {
    execFile('rsync', args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr ?? '').trim().split('\n').pop() || err.message } : { ok: true });
    });
  });
}

/** Where a session's transcript lives for a given cwd, under a given home. */
export function transcriptFor(home, cwd, sessionId) {
  return path.join(home, '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Start chats in detached tmux sessions on the remote, one per chat. A session
 * that already exists under that name is left alone. Starts are staggered so
 * a dozen claude processes do not launch in the same instant, and two seconds
 * after the last one every session is checked: a claude that exits at once
 * (not installed, not logged in) takes its tmux session with it.
 *
 * The command runs under the remote user's login shell, so PATH includes
 * wherever Claude Code is installed there.
 *
 * @param {Array<{id:string, tmux:string, cwd:string, args:string}>} items
 *   cwd is the remote folder; args are already shell-quoted claude arguments.
 */
export async function startInTmux(host, items, { staggerSeconds = 2 } = {}) {
  // A chat runs once: a resume is skipped when a live registry entry already holds its id, under any tmux name.
  const running = (id) => `for f in $(grep -l ${q(`"sessionId":"${id}"`)} ~/.claude/sessions/*.json 2>/dev/null); do kill -0 "$(basename "$f" .json)" 2>/dev/null && exit 0; done; exit 1`;
  const lines = items.map((it, i) => `${i ? `sleep ${staggerSeconds}; ` : ''}mkdir -p ${q(it.cwd)}; `
    + (it.sessionId ? `if ( ${running(it.sessionId)} ); then echo ${q(`skip ${it.id}`)}; el` : '')
    + `if tmux has-session -t ${q(`=${it.tmux}`)} 2>/dev/null; then echo ${q(`skip ${it.id}`)}; `
    // -u: a non-login ssh has no LANG, and tmux then draws every non-ASCII glyph as "_".
    + `else tmux -u new-session -d -s ${q(it.tmux)} -c ${q(it.cwd)} "\${SHELL:-/bin/sh}" -lc ${q(`claude ${it.args}`)} && echo ${q(`started ${it.id}`)}; fi`);
  const verify = items.map((it) => `tmux has-session -t ${q(`=${it.tmux}`)} 2>/dev/null || echo ${q(`died ${it.id}`)}`);
  const script = [...lines, 'sleep 2', ...verify].join('\n');
  const r = await sshScript(host, script, 60_000 + items.length * staggerSeconds * 1000);
  const count = (word) => r.stdout.split('\n').filter((l) => l.startsWith(`${word} `)).length;
  const died = count('died');
  const result = { ok: r.ok && died === 0, started: count('started') - died, skipped: count('skip'), died };
  if (!r.ok) result.error = r.error;
  else if (died) result.error = `claude exited at once on the remote for ${died} chat${died === 1 ? '' : 's'}; is Claude Code installed and logged in there?`;
  return result;
}

/**
 * Bring chats back up on the remote after it was shut down, or after a
 * restart with new flags. Their transcripts are on the remote's own disk, so
 * nothing is copied: each one is resumed in a tmux session named after the
 * chat.
 *
 * @param {Array<{sessionId:string, name?:string, cwd:string, remoteCwd?:string}>} sessions
 */
export async function resumeOnRemote(sessions, { staggerSeconds = 2, extraArgs = '', remote = remoteConfig(), home } = {}) {
  if (!remote) return { ok: false, error: 'no remote machine is configured', started: 0, skipped: 0 };
  const remoteHome = home ?? readRemoteLive({ remote }).home;
  const items = [];
  for (const s of sessions) {
    const cwd = s.remoteCwd ?? toRemotePath(s.cwd, remote, remoteHome);
    if (!cwd) return { ok: false, error: `${s.name ?? s.sessionId} has no folder on the remote`, started: 0, skipped: 0 };
    const label = s.name ?? s.sessionId.slice(0, 8);
    items.push({ id: s.sessionId, sessionId: s.sessionId, tmux: tmuxName(label), cwd, args: `--name ${q(label)} --resume ${q(s.sessionId)}${extraArgs ? ` ${extraArgs}` : ''}` });
  }
  return startInTmux(remote.host, items, { staggerSeconds });
}

/**
 * Copy a project folder and a chat's transcript from this Mac to the remote.
 * The caller has closed the chat here first. Nothing on the remote is deleted
 * and nothing newer there is overwritten.
 *
 * @param {{sessionId:string, cwd:string, file?:string|null, workDir?:string|null}} session
 * @returns {Promise<{ok:boolean, error?:string, remoteCwd?:string}>}
 */
export async function pushToRemote(session, { remote, home }) {
  const remoteCwd = toRemotePath(session.cwd, remote, home);
  if (!remoteCwd) return { ok: false, error: `its folder is not inside ${remote.localProjectsRoot}, the folder that maps to the remote` };
  // The project the chat works in. A chat started in the projects root itself
  // syncs the project its work goes through, when one clearly leads.
  const local = projectFolder(session.cwd, remote.localProjectsRoot)
    ?? projectFolder(session.workDir, remote.localProjectsRoot);
  const folder = local ? { local, remote: toRemotePath(local, remote, home) } : null;
  const transcript = session.file && fs.existsSync(session.file)
    ? { local: session.file, remote: transcriptFor(home, remoteCwd, session.sessionId) } : null;
  const remotePaths = [remoteCwd, folder?.remote, transcript?.remote].filter(Boolean);
  const unsafe = remotePaths.find((p) => !SAFE_REMOTE_PATH.test(p));
  if (unsafe) return { ok: false, error: `${unsafe} has characters rsync cannot pass safely; rename the folder to letters, digits and . _ - only` };

  const dirs = [remoteCwd, folder?.remote, transcript && path.dirname(transcript.remote)].filter(Boolean);
  const made = await sshScript(remote.host, `mkdir -p ${dirs.map(q).join(' ')}`);
  if (!made.ok) return { ok: false, error: `could not make its folders on the remote: ${made.error}` };
  if (folder) {
    // A project's first copy runs inside the move, and a large one (gigabytes of data) outlasts 10 minutes.
    const r = await rsync(`${folder.local}/`, `${remote.host}:${folder.remote}/`, { timeout: 30 * 60_000 });
    if (!r.ok) return { ok: false, error: `could not copy ${path.basename(folder.local)} to the remote: ${r.error}` };
  }
  if (transcript) {
    const r = await rsync(transcript.local, `${remote.host}:${path.dirname(transcript.remote)}/`, { excludes: [] });
    if (!r.ok) return { ok: false, error: `could not copy its transcript: ${r.error}` };
    // Subagent transcripts sit in a folder named after the session.
    const sub = transcript.local.replace(/\.jsonl$/, '');
    if (fs.existsSync(sub)) await rsync(`${sub}/`, `${remote.host}:${transcript.remote.replace(/\.jsonl$/, '')}/`, { excludes: [] });
  }
  return { ok: true, remoteCwd };
}

/**
 * Move a closed chat to the remote, history and all: copy its project folder
 * and transcript, then resume it in tmux there. Refused while it is still
 * open here, since a chat open on two machines forks its transcript.
 */
export async function moveToRemote(session, { remote = remoteConfig(), home } = {}) {
  if (!remote) return { ok: false, error: 'no remote machine is configured' };
  const remoteHome = home ?? readRemoteLive({ remote, force: true }).home;
  if (!remoteHome) return { ok: false, error: `${remote.label} is unreachable` };
  const pushed = await pushToRemote(session, { remote, home: remoteHome });
  if (!pushed.ok) return pushed;
  const r = await resumeOnRemote([{ ...session, remoteCwd: pushed.remoteCwd }], { staggerSeconds: 0, remote, home: remoteHome });
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.started) return { ok: false, error: `a chat named ${tmuxName(session.name ?? session.sessionId.slice(0, 8))} is already running on ${remote.label}; rename one first` };
  return { ok: true, remoteCwd: pushed.remoteCwd };
}

/**
 * Start a new chat on the remote: copy its project folder there, then start
 * claude with a name and session-only flags in a tmux session.
 *
 * @param {string} flags already validated launch flags (restart.js launchFlags)
 */
export async function startOnRemote({ cwd, name, flags = '' }, { remote = remoteConfig(), home } = {}) {
  if (!remote) return { ok: false, error: 'no remote machine is configured' };
  const remoteHome = home ?? readRemoteLive({ remote, force: true }).home;
  if (!remoteHome) return { ok: false, error: `${remote.label} is unreachable` };
  const pushed = await pushToRemote({ sessionId: '', cwd, file: null }, { remote, home: remoteHome });
  if (!pushed.ok) return pushed;
  const r = await startInTmux(remote.host, [{ id: name, tmux: tmuxName(name), cwd: pushed.remoteCwd, args: `--name ${q(name)}${flags ? ` ${flags}` : ''}` }]);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.started) return { ok: false, error: `a chat named ${tmuxName(name)} is already running on ${remote.label}; pick another name` };
  return { ok: true };
}

/**
 * Copy a project folder and a chat's transcript back from the remote. The
 * caller has closed the chat there first. Newer copies win on each side.
 */
export async function pullFromRemote({ sessionId, cwd, remoteCwd, localFile }, { remote, home }) {
  const fromCwd = remoteCwd ?? toRemotePath(cwd, remote, home);
  const remoteFile = transcriptFor(home, fromCwd, sessionId);
  const local = projectFolder(cwd, remote.localProjectsRoot);
  const folder = local ? { local, remote: toRemotePath(local, remote, home) } : null;
  const unsafe = [remoteFile, folder?.remote].filter(Boolean).find((p) => !SAFE_REMOTE_PATH.test(p));
  if (unsafe) return { ok: false, error: `${unsafe} has characters rsync cannot pass safely` };
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  const t = await rsync(`${remote.host}:${remoteFile}`, localFile, { excludes: [] });
  if (!t.ok) return { ok: false, error: `could not copy its transcript back: ${t.error}` };
  await rsync(`${remote.host}:${remoteFile.replace(/\.jsonl$/, '')}/`, `${localFile.replace(/\.jsonl$/, '')}/`, { excludes: [] });
  if (folder) {
    const r = await rsync(`${remote.host}:${folder.remote}/`, `${folder.local}/`);
    if (!r.ok) return { ok: false, error: `could not copy ${path.basename(folder.local)} back: ${r.error}` };
  }
  return { ok: true };
}

/**
 * Drive a chat running in tmux on the remote by typing into it.
 *
 * This is the only way to steer a running Claude Code from outside, and it is
 * exactly what a person at the keyboard would do: a reply, or Esc to
 * interrupt. Model, effort and permission go through restart.js instead.
 */
export const CONTROLS = {
  reply: (value) => [['-l', value], ['Enter']],
  interrupt: () => [['Escape']],
};
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function controlSession(name, action, value = '', remote = remoteConfig()) {
  if (!remote) return Promise.resolve({ ok: false, error: 'no remote machine is configured' });
  const build = CONTROLS[action];
  if (!build) return Promise.resolve({ ok: false, error: `unknown action ${action}` });
  // "=name:" is the session matched exactly, then its current window and pane.
  // A bare "=name" is a session target, which send-keys rejects as "no pane".
  const target = q(`=${tmuxName(name)}:`);
  const script = build(value)
    .map((keys) => `tmux send-keys -t ${target} ${keys.map(q).join(' ')}`)
    .join(' && ');
  return sshScript(remote.host, script, 15_000).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }));
}

/** The last 60 lines of a remote chat's screen, read-only. */
export function peekScreen(name, remote = remoteConfig()) {
  if (!remote) return Promise.resolve({ ok: false, error: 'no remote machine is configured' });
  return sshScript(remote.host, `tmux capture-pane -p -J -S -60 -t ${q(`=${tmuxName(name)}:`)}`, 10_000)
    .then((r) => (r.ok ? { ok: true, text: r.stdout } : { ok: false, error: r.error }));
}

/** Stop a remote chat's claude process and wait up to 15 s for it to exit. */
export function stopOnRemote(pid, remote = remoteConfig()) {
  const n = Number(pid);
  if (!remote || !Number.isInteger(n) || n <= 1) return Promise.resolve(false);
  return sshScript(remote.host, `kill -TERM ${n}; for i in $(seq 1 30); do kill -0 ${n} 2>/dev/null || exit 0; sleep 0.5; done; exit 1`)
    .then((r) => r.ok);
}

/**
 * A deleted chat's copy on the remote, moved to ~/.claude-trash/<time>-<id> there, and its
 * prompt-history lines dropped. Copies between the machines never delete, so a chat deleted
 * here kept its transcript and checkpoints there. Refuses a chat still running on the remote.
 * Resolves { ok, moved, to } or { ok: false, error }.
 */
export async function trashOnRemote({ sessionId, projectDir = null }, remote = remoteConfig()) {
  if (!remote) return { ok: false, error: 'no remote machine is configured' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(sessionId))
    || (projectDir && !/^[A-Za-z0-9._-]+$/.test(projectDir))) return { ok: false, error: 'not a chat id' };
  const rels = [projectDir && `projects/${projectDir}/${sessionId}.jsonl`, projectDir && `projects/${projectDir}/${sessionId}`,
    `session-env/${sessionId}`, `file-history/${sessionId}`, `tasks/${sessionId}`].filter(Boolean);
  const script = `set -u
for f in $(grep -l '"sessionId":"${sessionId}"' ~/.claude/sessions/*.json 2>/dev/null); do kill -0 "$(basename "$f" .json)" 2>/dev/null && { echo running; exit 3; }; done
dest=~/.claude-trash/$(date +%Y%m%d-%H%M%S)-${sessionId.slice(0, 8)}
moved=0
for r in ${rels.join(' ')}; do
  [ -e ~/.claude/"$r" ] || continue
  mkdir -p "$dest/$(dirname "$r")" && mv ~/.claude/"$r" "$dest/$r" && moved=$((moved + 1))
done
h=~/.claude/history.jsonl
if [ -f "$h" ] && grep -q '"sessionId":"${sessionId}"' "$h"; then
  grep -v '"sessionId":"${sessionId}"' "$h" > "$h.tmp-trash" && mv "$h.tmp-trash" "$h"
fi
echo "moved $moved to $dest"`;
  const r = await sshScript(remote.host, script, 60_000);
  const out = r.stdout.trim();
  if (out === 'running') return { ok: false, error: `it is still running on ${remote.label}; close it there first` };
  if (!r.ok) return { ok: false, error: `${remote.label} did not answer (${r.error})` };
  return { ok: true, moved: Number(out.match(/^moved (\d+)/)?.[1] ?? 0), to: out.split(' to ')[1] ?? null };
}

/** End a remote chat's tmux session. Resolves true when it is gone. */
export function stopRemoteTmux(name, remote = remoteConfig()) {
  if (!remote) return Promise.resolve(false);
  const t = q(`=${tmuxName(name)}`);
  return sshScript(remote.host, `tmux kill-session -t ${t} 2>/dev/null; ! tmux has-session -t ${t} 2>/dev/null`, 10_000).then((r) => r.ok);
}
