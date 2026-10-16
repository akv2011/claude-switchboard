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
echo "---TMUX---"
tmux ls -F "#{session_name}" 2>/dev/null
echo "---PS---"
ps -e -o pid=,ppid=,rss=
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
        version: raw.version ?? null,
        kind: raw.kind ?? null,
        startedAt: raw.startedAt ?? null,
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
  // Whole process tree per chat, as on the Mac; VmRSS of claude alone when ps gave nothing.
  const tree = psPart.trim() ? treeRss(psPart, sessions.map((x) => x.pid).filter(Boolean)) : new Map();
  for (const x of sessions) if (tree.has(x.pid)) x.rssMb = tree.get(x.pid);
  const load = memPart.match(/LOAD:([\d.]+):(\d+)/);
  const swapTotalMb = mem('SwapTotal');
  return {
    sessions,
    tmux,
    home,
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
  };
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

/** The shell command that attaches a terminal to a remote chat's tmux session. */
export function attachCommand(host, name) {
  return `ssh -tq ${q(host)} ${q(`tmux -u attach -t ${q(`=${tmuxName(name)}`)}`)}`;
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
  fs.writeFileSync(file, `#!/bin/bash\nexec ${attachCommand(remote.host, name)}\n`, { mode: 0o755 });
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
  const lines = items.map((it, i) => `${i ? `sleep ${staggerSeconds}; ` : ''}mkdir -p ${q(it.cwd)}; `
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
    items.push({ id: s.sessionId, tmux: tmuxName(label), cwd, args: `--name ${q(label)} --resume ${q(s.sessionId)}${extraArgs ? ` ${extraArgs}` : ''}` });
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
    const r = await rsync(`${folder.local}/`, `${remote.host}:${folder.remote}/`);
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
