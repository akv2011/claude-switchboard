/**
 * The single surface both the CLI and the GUI call.
 *
 * Keeping this here rather than in the GUI is what makes the window swappable:
 * nothing below this line knows whether it is being driven by Electrobun,
 * Electron, or a terminal.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withoutClaudeMarkers, PROJECTS_DIR, encodeCwd, codeBin, stateDir } from './paths.js';
import { readConfig } from './config.js';
import { scanSessions } from './sessions.js';
import { readLiveSessions, readRegistry } from './registry.js';
import { pidExists } from './liveness.js';
import { readTail, readTailEntries } from './jsonl.js';
import { runInVscodeTerminal, typeIntoTerminal, parentPid, hasChildren, shq, bridgeInstalled } from './vscode-bridge.js';
import { macLoad, health } from './load.js';
import { decide, localOnlyUse, openBackgroundTasks, readConfig as readAutoConfig, readState as readAutoState, writeState as writeAutoState, setEnabled as setAutoBalance } from './autobalance.js';
import { readUsage } from './usage.js';
import { cswapPath } from './accounts.js';
import { launchFlags } from './restart.js';
import { readBackground } from './background.js';
import { searchTranscripts } from './search.js';
import { planDelete, deleteSession } from './deleter.js';
import { readSnapshot, restorableWorkspaces } from './snapshot.js';
import { readGroups, applyGroups } from './groups.js';
import {
  readRemoteLive, remoteConfig, attachInTerminal, attachCommand, moveToRemote, pullFromRemote, resumeOnRemote, startOnRemote,
  stopOnRemote, stopRemoteTmux, controlSession, peekScreen, sshScript, rsync, tmuxName, toRemotePath, transcriptFor, CONTROLS,
  withoutTabHere, localProcesses, attachShells, rememberRemoteTabs, remoteTabShell, trashOnRemote, cachedTmuxId,
} from './remote.js';
import { writeRestoreTasks, clearRestoreTasks, resumeCommand, cleanEnv } from '../restore/tasks.js';
import {
  readAutoTaskSetting, enableAutoTasks,
  readPersistentSessions, setPersistentSessions,
} from '../restore/vscode-settings.js';
import * as launchd from '../recorder/launchd.js';
import { pollOnce } from '../recorder/daemon.js';

/**
 * Everything the sidebar needs, in one call.
 *
 * Takes a reading first. Otherwise the newest a caller can see is the last
 * recorder tick, so closing a chat and looking straight away showed nothing for
 * up to 30 seconds and the window looked broken. A poll is cheap and
 * idempotent: it reads a handful of small files and rewrites one.
 *
 * @param {{poll?:boolean}} [options] pass false to read the stored state as-is.
 */
export function getOverview(options = {}) {
  const config = readConfig();
  // One remote reading serves the poll, the scan and the totals. It is cached
  // for 25 s, so this never costs more than one ssh per window refresh and
  // usually none. With no remote configured it costs nothing at all.
  const remote = readRemoteLive({ remote: config.remote });
  const ps = config.remote ? localProcesses() : '';
  if (config.remote) rememberRemoteTabs(ps);
  if (options.poll !== false) {
    try {
      pollOnce({ remote });
    } catch {
      // A failed poll must not stop the window rendering what it already knows.
    }
  }
  const { projects, sessions, skipped, sdkHidden, transcriptIds } = scanSessions({ remoteLive: remote });
  const snapshot = readSnapshot();

  // Where a closed chat last ran, so the row can say "was on the remote" and
  // a move or a bring-up knows which machine holds its transcript. And the
  // folder of the window it ran in, as restore reopens it, which files it in
  // the tree.
  const lastMachine = new Map();
  const windowOf = new Map();
  for (const [root, entry] of Object.entries(snapshot?.workspaces ?? {})) {
    for (const s of [...(entry.lastLiveSet ?? []), ...(entry.sessions ?? [])]) {
      if (s.machine) lastMachine.set(String(s.sessionId).toLowerCase(), s.machine);
      windowOf.set(String(s.sessionId).toLowerCase(), root);
    }
  }
  for (const session of sessions) {
    session.lastMachine = session.machine ?? lastMachine.get(String(session.sessionId).toLowerCase()) ?? null;
    session.workspaceRoot = windowOf.get(String(session.sessionId).toLowerCase()) ?? null;
  }
  const groupConfig = readGroups();
  applyGroups(sessions, groupConfig, { projectsRoots: config.projectsRoots });

  // Computed once. This used to be derived four times per refresh, each with
  // its own sweep of every project directory and its own `ps`.
  const running = new Set(sessions.filter((s) => s.live).map((s) => String(s.sessionId).toLowerCase()));
  // A chat mid-move is on neither machine for a few seconds. Offering it for
  // "Bring back" then would start a second copy and fork the transcript.
  for (const id of inFlight()) running.add(id);
  const groups = restorableWorkspaces(snapshot, undefined, running, transcriptIds);
  const offered = groups.flatMap((g) => g.sessions);
  // The snapshot keeps the name a chat had while it ran, which for an unnamed one is
  // what Claude Code made from the folder; the list shows its title. Use the list's,
  // for the banner and the terminal tab both.
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  for (const s of offered) if (byId.get(s.sessionId)?.name) s.name = byId.get(s.sessionId).name;
  const accountsAvailable = Boolean(cswapPath());

  return {
    home: os.homedir(),
    projects: projects.map((project) => ({
      label: project.label,
      cwd: project.cwd,
      projectDir: project.projectDir,
      bytes: project.bytes,
      liveCount: project.liveCount,
      sessionCount: project.sessions.length,
      sessions: project.sessions,
      // Inclusive of subfolders, which is the unit a VS Code window restores.
      depth: project.depth,
      parent: project.parent,
      allSessions: project.allSessions,
      allBytes: project.allBytes,
      allLiveCount: project.allLiveCount,
    })),
    // The ones the person created; the sidebar shows them even while empty.
    groups: groupConfig.groups,
    // The folder tree lists these first and opens them by default.
    projectsRoots: config.projectsRoots,
    totals: {
      projects: projects.length,
      sessions: sessions.length,
      bytes: sessions.reduce((sum, s) => sum + s.bytes + s.subagentBytes, 0),
      live: running.size,
      liveMac: sessions.filter((s) => s.machine === 'mac').length,
      liveRemote: sessions.filter((s) => s.machine === 'remote').length,
      needsYou: sessions.filter((s) => s.needsYou).length,
      skipped,
      sdkHidden,
    },
    restore: {
      // Exactly what the recorder saw live at the poll before those chats went.
      // No transcript sweep: a window over recently-used files offered chats
      // across folders that were never open together.
      groups,
      count: offered.length,
      capturedAt: groups.length ? Math.max(...groups.map((g) => g.lastSeen ?? 0)) : (snapshot?.capturedAt ?? null),
      source: groups.length === 0 ? 'none' : 'mixed',
      remoteCount: offered.filter((s) => s.machine === 'remote').length,
    },
    mac: (() => { const m = macLoad(); return { ...m, health: health(m) }; })(),
    autoBalance: (() => { const c = readAutoConfig(); return { enabled: c.enabled, idleMin: c.idleMin, last: readAutoState().last }; })(),
    accounts: { available: accountsAvailable },
    usage: accountsAvailable ? readUsage() : [],
    background: readBackground().agents,
    remote: {
      configured: Boolean(config.remote),
      label: config.remote?.label ?? null,
      localProjectsRoot: config.remote?.localProjectsRoot ?? null,
      relay: Boolean(config.remote && config.relay),
      reachable: remote.reachable,
      stale: remote.stale,
      checkedAt: remote.checkedAt,
      lastReachableAt: remote.lastReachableAt,
      memTotalMb: remote.memTotalMb,
      memAvailableMb: remote.memAvailableMb,
      liveCount: remote.liveCount,
      error: remote.error ?? null,
      load: remoteLoad(remote),
      health: health(remoteLoad(remote)),
      uses: remote.reachable ? remote.uses ?? [] : [],
      withoutTab: remote.reachable ? withoutTabHere(remote.sessions, ps).map((s) => ({ sessionId: s.sessionId, name: s.name, cwd: s.cwd })) : [],
    },
    configErrors: config.errors,
    recorder: launchd.status(),
    autoTasks: readAutoTaskSetting(),
    persistence: readPersistentSessions(),
  };
}

/** Split an offer by the machine each chat ran on. */
export function splitByMachine(sessions) {
  const remote = sessions.filter((s) => s.machine === 'remote');
  const mac = sessions.filter((s) => s.machine !== 'remote');
  return { mac, remote };
}

/**
 * One named VS Code terminal per chat, in the window on its folder (opened if
 * none is). Unlike folderOpen tasks this works on a window that is already
 * open and gives tabs, not split panes. Sequential, which also staggers the
 * starts: each request takes 1.5 to 5 s.
 * ponytail: sequential, so 30+ chats in one restore approach the 120 s RPC limit; batch the requests if that ever happens.
 */
async function reopenInVscode(root, sessions) {
  if (!fs.existsSync(root)) return { started: 0, error: `that folder no longer exists: ${root}` };
  let started = 0;
  let error = null;
  // Several at once keep the keyboard where it is, and go in reverse: VS Code puts each new tab
  // right of the active one, so they land together in order instead of scattered among others.
  const many = sessions.length > 1;
  for (const s of many ? [...sessions].reverse() : sessions) {
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : root;
    const r = await runInVscodeTerminal({ cwd, window: root, name: s.name ?? s.sessionId.slice(0, 8), text: resumeCommand(s.sessionId), focus: !many });
    if (r.ok) started += 1;
    else error ??= r.error;
  }
  return { started, ...(error ? { error } : {}) };
}

async function attachEach(root, sessions) {
  let attached = 0;
  const many = sessions.length > 1;
  for (const s of many ? [...sessions].reverse() : sessions) {
    const r = await attachSession({ name: s.name ?? s.sessionId.slice(0, 8), cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : root, window: root, sessionId: s.sessionId, focus: !many });
    if (r.ok) attached += 1;
  }
  return attached;
}

/**
 * Bring an offer back, each chat on the machine it ran on.
 *
 * Mac chats go through the VS Code bridge, or VS Code tasks without it. Remote
 * chats are resumed in tmux over there; their transcripts are on the remote's
 * disk, so nothing is copied.
 */
/** Session id to where it runs now ('the Mac' or the remote's label), for every running chat. */
function runningSomewhere(config) {
  const where = new Map(readLiveSessions({ interactiveOnly: false }).map((s) => [s.sessionId, 'the Mac']));
  if (config) for (const s of readRemoteLive({ remote: config, force: true }).sessions) where.set(s.sessionId, config.label);
  return where;
}

/**
 * A chat that last ran on the remote reopens here from the remote's copy, fetched first: the
 * copy here lags by up to claude-sync's interval. False when the remote cannot be asked.
 */
async function fetchTranscript(s, config, remote) {
  const remoteCwd = s.remoteCwd ?? toRemotePath(s.cwd, config, remote.home);
  if (!remote.reachable || !remote.home || !remoteCwd) return false;
  const localFile = s.file ?? path.join(PROJECTS_DIR, encodeCwd(s.cwd), `${s.sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  return (await rsync(`${config.host}:${transcriptFor(remote.home, remoteCwd, s.sessionId)}`, localFile, { excludes: [] })).ok;
}

export async function restoreGroups(groups, options = {}) {
  const written = [];
  const config = remoteConfig();
  for (const group of groups) {
    // A chat runs in one place: opened twice, its transcript forks.
    const running = runningSomewhere(config);
    const already = group.sessions.filter((s) => running.has(s.sessionId));
    if (already.length) written.push({ cwd: group.cwd, machine: 'mac', started: 0,
      error: `${already.map((s) => `${s.name ?? s.sessionId.slice(0, 8)} is already running on ${running.get(s.sessionId)}`).join('; ')}` });
    let { mac, remote } = splitByMachine(group.sessions.filter((s) => !running.has(s.sessionId)));
    // A chat that last ran on the remote waits while the remote is unreachable, as Move here
    // does, rather than fork from an older copy.
    const fromRemote = config ? mac.filter((s) => s.lastMachine === 'remote') : [];
    if (fromRemote.length) {
      const reading = readRemoteLive({ remote: config });
      const stale = [];
      for (const s of fromRemote) if (!(await fetchTranscript(s, config, reading))) stale.push(s);
      if (stale.length) {
        mac = mac.filter((s) => !stale.includes(s));
        written.push({ cwd: group.cwd, machine: 'mac', started: 0,
          error: `${stale.map((s) => s.name ?? s.sessionId.slice(0, 8)).join(', ')} last ran on ${config.label}, which is unreachable; opened here now, ${stale.length === 1 ? 'it' : 'they'} would miss its last lines` });
      }
    }
    if (mac.length && options.launch !== false && bridgeInstalled()) {
      written.push({ cwd: group.cwd, machine: 'mac', via: 'vscode', ...(await reopenInVscode(group.cwd, mac)) });
    } else if (mac.length) {
      try {
        written.push({ cwd: group.cwd, machine: 'mac', ...restoreProject(group.cwd, mac, options) });
      } catch (err) {
        written.push({ cwd: group.cwd, machine: 'mac', error: err.message });
      }
    }
    if (remote.length) {
      const result = await resumeOnRemote(remote);
      // Watch them where the person works: one VS Code terminal per remote chat.
      const attached = result.ok && options.launch !== false && bridgeInstalled()
        ? await attachEach(group.cwd, remote)
        : 0;
      written.push({ cwd: group.cwd, machine: 'remote', taskCount: remote.length, ...result, attached,
        ...(result.ok ? {} : { error: result.error }) });
    }
  }
  return written;
}

/**
 * Open a remote chat in a VS Code terminal in its project folder, or in the
 * terminal it last ran in when `shellPid` names one. Terminal.app only when
 * the chat has no folder on this Mac to open.
 */
export function attachSession({ name, cwd, shellPid = null, window = null, sessionId = null, focus = true }) {
  if (typeof name !== 'string' || !name) return Promise.resolve({ ok: false, error: 'no session named' });
  const remote = remoteConfig();
  if (!remote) return Promise.resolve({ ok: false, error: 'no remote machine is configured' });
  // By id, the tmux session it really runs in: a chat started unnamed and renamed later runs
  // under another session name, and an attach by its name found nothing.
  const running = sessionId ? readRemoteLive({ remote }).sessions.find((s) => s.sessionId === sessionId)?.tmux : null;
  if (running) name = running;
  if (!cwd || !fs.existsSync(cwd)) return attachInTerminal(name, remote);
  // The tab it ran in last, when none is named: after a dropped link that tab sits at its prompt
  // under the chat's name, and a new tab beside it made two of them.
  const shell = shellPid ?? remoteTabShell(name);
  // Type into the old terminal only while its shell sits at a prompt. If
  // something runs there now (the person started claude again), that program
  // would get the text as input; open a new terminal instead.
  const reuse = shell && !hasChildren(shell) ? shell : null;
  return runInVscodeTerminal({ shellPid: reuse, cwd, window, name, text: attachCommand(remote.host, name, cachedTmuxId(name)), focus });
}

/** Full-text search over the chats the window lists. */
export async function searchAll(query) {
  const { sessions } = scanSessions({ remoteLive: readRemoteLive() });
  const byFile = new Map(sessions.filter((s) => s.file).map((s) => [s.file, s.sessionId]));
  const r = await searchTranscripts(query, [...byFile.keys()]);
  return r.ok ? { ok: true, hits: r.hits.map((h) => ({ sessionId: byFile.get(h.file), count: h.count, snippet: h.snippet, role: h.role })) } : r;
}

/** Put text on the clipboard, for a suggested reply to paste into an agent. */
export function copyText(text) {
  if (typeof text !== 'string' || !text || text.length > 4000) return Promise.resolve({ ok: false, error: 'nothing to copy' });
  // macOS pbcopy; on Linux wl-copy (Wayland), else xclip (X11).
  const tools = process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  const tryOne = ([cmd, args]) => new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(!err)).stdin.end(text);
  });
  return (async () => {
    for (const t of tools) if (await tryOne(t)) return { ok: true };
    return { ok: false, error: process.platform === 'darwin' ? 'pbcopy failed' : 'no clipboard tool: install wl-clipboard or xclip' };
  })();
}

export function peekRemoteScreen(name) {
  return peekScreen(name);
}

/** The full text of a chat's last reply, for the detail panel. */
export function readLastMessage({ sessionId, projectDir }) {
  if (!projectDir || !sessionId) return { text: '', at: null };
  const file = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  const entries = readTailEntries(file, 512 * 1024);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.type !== 'assistant') continue;
    const text = (e.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return { text, at: e.timestamp ?? null };
  }
  return { text: '', at: null };
}

/** The remote's probe in the same shape as macLoad(). */
export function remoteLoad(remote) {
  if (!remote?.reachable || !remote.memTotalMb) return null;
  return {
    totalMb: remote.memTotalMb,
    usedMb: remote.memTotalMb - (remote.memAvailableMb ?? remote.memTotalMb),
    swapTotalMb: remote.swapTotalMb ?? null,
    swapUsedMb: remote.swapUsedMb ?? null,
    swapOutMbPerMin: remote.swapOutMbPerMin ?? null,
    swapInMbPerMin: remote.swapInMbPerMin ?? null,
    psiMem60: Number.isFinite(remote.psiMem60) ? remote.psiMem60 : null,
    pressure: remote.pressure ?? null,
    load1: remote.load1 ?? null,
    cores: remote.cores ?? null,
    tempC: remote.tempC ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chats this process moved in the last minute, lower-cased. */
const moving = new Map();

// The window and the recorder (auto-balance) are separate processes and both move chats,
// so the claim on a chat is a file either can see: created exclusively, removed
// when the move ends, and taken over when the process holding it has died.
const moveLock = (key) => path.join(stateDir(), 'moving', `${key}.lock`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function claimMove(key) {
  const file = moveLock(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written: treat as held */ return false; }
      if (held?.pid && alive(held.pid)) return false;
      try { fs.unlinkSync(file); } catch { /* the other side removed it first */ }
    }
  }
  return false;
}

export function releaseMove(key) {
  try { fs.unlinkSync(moveLock(key)); } catch { /* already released */ }
}

/** Chats being moved now, by any process, or moved by this one in the last minute. */
const inFlight = () => {
  let now = [];
  try { now = fs.readdirSync(path.join(stateDir(), 'moving')).filter((f) => f.endsWith('.lock')).map((f) => f.slice(0, -5)); } catch { /* none */ }
  return [...new Set([...now, ...[...moving].filter(([, at]) => Date.now() - at < 60_000).map(([id]) => id)])];
};

/**
 * Why moving this chat would fail, checked before anything is closed.
 * Pure: the caller passes what it read. Null means go.
 *
 * @param {{live?:object, scanned?:object, remote:object, config:object|null}} args
 *   remote is the live reading, config the remote's settings.
 */
export function movePreflight({ live, scanned, remote, config, tasks = null }) {
  if (!config) return 'no remote machine is configured';
  if (!remote.reachable) return `${config.label} is unreachable`;
  const id = String(scanned?.sessionId ?? live?.sessionId ?? '').toLowerCase();
  if (remote.sessions.some((s) => String(s.sessionId).toLowerCase() === id)) return `it is already running on ${config.label}`;
  // Found through ps but without a registry file: no pid to close safely.
  if (scanned?.live && scanned.machine === 'mac' && !live) return 'it is open on the Mac but not registered yet; close it there (/exit), then move it';
  const cwd = live?.cwd ?? scanned?.cwd;
  if (!cwd) return 'its folder is not known';
  if (!toRemotePath(cwd, config, remote.home)) return `its folder is not inside ${config.localProjectsRoot}, the folder that maps to ${config.label}`;
  const name = tmuxName(scanned?.name ?? live?.name ?? id.slice(0, 8));
  if ((remote.tmux ?? []).includes(name)) return `a chat named ${name} is already running on ${config.label}; rename one first`;
  if (tasks) return `it has ${tasks}, and moving it would stop them`;
  return null;
}

/**
 * Move a chat to the remote. One that is open on the Mac is closed first.
 *
 * Everything that can be checked is checked before the chat is closed. An idle
 * chat is closed with SIGTERM, which Claude Code treats as a clean exit
 * (process and registry file gone within a second). A working one, or one at
 * a permission prompt, is not touched unless `force` says so. If the move
 * still fails after the close, the chat is resumed in the terminal it was in,
 * so it is never left on neither machine. Success means the remote's
 * registry lists it.
 */
export async function moveLiveSession({ sessionId, force = false, reopen = true }) {
  const key = String(sessionId).toLowerCase();
  const config = remoteConfig();
  const remote = readRemoteLive({ remote: config, force: true });
  const live = readLiveSessions({ interactiveOnly: false }).find((s) => s.sessionId === sessionId);
  const scanned = scanSessions({ remoteLive: remote }).sessions.find((s) => s.sessionId === sessionId);
  const blocked = movePreflight({ live, scanned, remote, config, tasks: force || !scanned ? null : runningTasksOf(scanned) });
  if (blocked) return { ok: false, error: blocked };
  // A chat picked by hand goes even when it lately used what only the Mac has; the toast names
  // it, and Move here brings it back.
  const needsLocal = scanned ? lateLocalUse(scanned, readConfig().localOnlyMcp) : null;
  if (live && ['busy', 'shell', 'waiting'].includes(live.status) && !force) {
    return { ok: false, busy: true, error: `${live.name ?? 'the chat'} is ${live.status === 'waiting' ? 'waiting at a prompt' : 'working'}` };
  }

  if (!claimMove(key)) return { ok: false, error: 'it is already being moved' };
  moving.set(key, Date.now());
  try {
    let shellPid = null;
    if (live) {
      shellPid = parentPid(live.pid);
      try {
        process.kill(live.pid, 'SIGTERM');
      } catch (err) {
        return { ok: false, error: `could not close it: ${err.message}` };
      }
      for (let i = 0; i < 30 && pidExists(live.pid); i += 1) await sleep(500);
      if (pidExists(live.pid)) return { ok: false, error: 'the chat did not exit after 15 s; close it by hand' };
    }
    const cwd = live?.cwd ?? scanned?.cwd;
    const name = scanned?.name ?? live?.name ?? sessionId.slice(0, 8);
    const moved = await moveToRemote({ sessionId, cwd, name, file: scanned?.file ?? null, workDir: scanned?.workDir ?? null },
      { remote: config, home: remote.home });
    if (!moved.ok) {
      if (!live) return moved;
      const back = await runInVscodeTerminal({ shellPid, cwd, name, text: resumeCommand(sessionId) });
      return { ok: false, rolledBack: back.ok, error: `${moved.error}. ${back.ok ? 'It is running on the Mac again, in its terminal.' : `Reopen it by hand: claude --resume ${sessionId}`}` };
    }
    for (let i = 0; i < 20; i += 1) {
      const after = readRemoteLive({ remote: config, force: true });
      const entry = after.sessions.find((s) => String(s.sessionId).toLowerCase() === key);
      if (entry) {
        // Bring it back where it was: the same VS Code terminal when it ran in one.
        const reopened = live && reopen && cwd ? await attachSession({ name: entry.tmux ?? entry.name ?? name, cwd, shellPid }) : null;
        return { ok: true, verified: true, closedOnMac: Boolean(live), reopened, needsLocal, tmux: entry.tmux ?? null };
      }
      await sleep(3000);
    }
    // Claude on the remote never got as far as listing itself (stuck at a question nobody sees,
    // such as trusting the folder), so the chat would be closed here and stuck there. Stop the
    // remote copy and reopen it here, so it is never on neither machine.
    const screen = await peekScreen(name, config);
    const said = screen.ok ? screen.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' / ') : '';
    const why = `${config.label} did not start it within 60 s${said ? ` (its screen: ${said.slice(0, 160)})` : ''}`;
    if (!(await stopRemoteTmux(name, config))) return { ok: false, error: `${why}, and it could not be stopped there; check its tmux session ${tmuxName(name)}` };
    if (!live) return { ok: false, error: why };
    const back = await runInVscodeTerminal({ shellPid, cwd, name, text: resumeCommand(sessionId) });
    return { ok: false, rolledBack: back.ok, error: `${why}. ${back.ok ? 'It is running on the Mac again, in its terminal.' : `Reopen it by hand: claude --resume ${sessionId}`}` };
  } finally {
    releaseMove(key);
    moving.set(key, Date.now());
  }
}

/**
 * Close a chat where it runs, the way a move does (SIGTERM, which Claude Code
 * treats as a clean exit), so it can be deleted. Every copy of it, on either
 * machine. A working chat is left alone: interrupt it first.
 */
export async function closeChat({ sessionId, force = false }) {
  const config = remoteConfig();
  const mac = readLiveSessions({ interactiveOnly: false }).filter((s) => s.sessionId === sessionId);
  const there = config ? readRemoteLive({ remote: config, force: true }).sessions.filter((s) => s.sessionId === sessionId) : [];
  const busy = [...mac, ...there].find((s) => ['busy', 'shell', 'waiting'].includes(s.status));
  if (busy && !force) return { ok: false, busy: true, error: `${busy.name ?? 'the chat'} is working; interrupt it or let it finish first` };
  for (const s of mac) {
    try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 30 && pidExists(s.pid); i += 1) await sleep(500);
    if (pidExists(s.pid)) return { ok: false, error: `${s.name} did not close on the Mac after 15 s` };
  }
  for (const s of there) {
    if (!(await stopOnRemote(s.pid, config))) return { ok: false, error: `it did not close on ${config.label} after 15 s` };
  }
  return { ok: true, closed: mac.length + there.length };
}

/**
 * Bring a chat from the remote back to this Mac, for work that needs the Mac
 * (local apps, attached drives). Checked first: the transcript exists on the
 * remote and the folder on the Mac. Then the idle chat is closed there, its
 * transcript and project folder are copied back (newer copy wins), and it
 * resumes in the VS Code terminal that was attached to it.
 */
export async function moveToLocal({ sessionId }) {
  const key = String(sessionId).toLowerCase();
  const config = remoteConfig();
  if (!config) return { ok: false, error: 'no remote machine is configured' };
  const remote = readRemoteLive({ remote: config, force: true });
  if (!remote.reachable || !remote.home) return { ok: false, error: `${config.label} is unreachable` };
  const entry = remote.sessions.find((s) => String(s.sessionId).toLowerCase() === key);
  const scanned = scanSessions({ remoteLive: remote }).sessions.find((s) => s.sessionId === sessionId);
  const cwd = entry?.cwd ?? scanned?.cwd;
  const name = entry?.name ?? scanned?.name ?? sessionId.slice(0, 8);
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'its folder is not on this Mac' };
  if (entry && ['busy', 'shell', 'waiting'].includes(entry.status)) return { ok: false, busy: true, error: `${name} is working on ${config.label}; move it when it is idle` };
  if (readLiveSessions({ interactiveOnly: false }).some((s) => s.sessionId === sessionId)) return { ok: false, error: 'it is already open on this Mac' };
  const remoteCwd = entry?.remoteCwd ?? toRemotePath(cwd, config, remote.home);
  if (!remoteCwd) return { ok: false, error: `its folder is not inside ${config.localProjectsRoot}` };
  const localFile = scanned?.file ?? path.join(PROJECTS_DIR, encodeCwd(cwd), `${sessionId}.jsonl`);
  const remoteFile = transcriptFor(remote.home, remoteCwd, sessionId);
  if (!(await sshScript(config.host, `test -f ${shq(remoteFile)}`)).ok) return { ok: false, error: `its transcript is not on ${config.label}` };

  if (!claimMove(key)) return { ok: false, error: 'it is already being moved' };
  moving.set(key, Date.now());
  try {
    // The VS Code terminal attached to it over ssh, so it comes back in the same tab.
    const shellPid = attachShells(localProcesses()).get(entry?.tmux ?? tmuxName(name)) ?? null;
    if (entry && !(await stopOnRemote(entry.pid, config))) return { ok: false, error: `it did not exit on ${config.label} after 15 s` };
    const pulled = await pullFromRemote({ sessionId, cwd, remoteCwd, localFile }, { remote: config, home: remote.home });
    if (!pulled.ok) {
      const back = entry ? await resumeOnRemote([{ sessionId, name, cwd, remoteCwd }], { staggerSeconds: 0, remote: config, home: remote.home }) : { ok: true };
      return { ok: false, error: `${pulled.error}${entry ? `; ${back.ok ? `it is running on ${config.label} again` : 'restart it there by hand'}` : ''}.` };
    }
    for (let i = 0; i < 6 && shellPid && hasChildren(shellPid); i += 1) await sleep(500);
    const r = await runInVscodeTerminal({ shellPid: shellPid && !hasChildren(shellPid) ? shellPid : null, cwd, name, text: resumeCommand(sessionId) });
    if (!r.ok) return { ok: false, error: `Closed on ${config.label}, but could not reopen here: ${r.error}` };
    for (let i = 0; i < 40; i += 1) {
      await sleep(500);
      if (readLiveSessions({ interactiveOnly: false }).some((s) => s.sessionId === sessionId)) return { ok: true, verified: true, reused: r.reused };
    }
    return { ok: true, verified: false, error: 'reopened, but it has not registered yet' };
  } finally {
    releaseMove(key);
    moving.set(key, Date.now());
  }
}

const transcriptOf = (s) => (s.projectDir && s.sessionId ? path.join(PROJECTS_DIR, s.projectDir, `${s.sessionId}.jsonl`) : null);

/** Background tasks a live chat still runs: a move closes the chat, and they stop with it. */
function runningTasksOf(s) {
  // A closed chat's tasks closed with it.
  if (!s.live || !transcriptOf(s)) return null;
  // ponytail: a task started more than 8 MB back is not seen; read the whole file if one ever is.
  const startedAt = readRegistry().find((e) => e.pid === s.pid)?.startedAt ?? 0;
  const tasks = openBackgroundTasks(readTail(transcriptOf(s), 8 * 1024 * 1024), startedAt);
  return tasks ? `${tasks} background task${tasks === 1 ? '' : 's'} still running` : null;
}

/** What a chat here used lately that the remote cannot serve, from its last 1 MB. */
function lateLocalUse(s, mcpPrefixes) {
  return transcriptOf(s) ? localOnlyUse(readTailEntries(transcriptOf(s), 1024 * 1024), mcpPrefixes) : null;
}

/** Auto and Balance pick chats themselves, so they skip any chat that needs this Mac. */
export function localOnlyOf(s, mcpPrefixes = []) {
  return runningTasksOf(s) ?? lateLocalUse(s, mcpPrefixes);
}

/**
 * Move idle Mac chats to the remote, largest first, while the Mac is strained
 * (pressure, swapping, memory used; see load.js) and the remote has room.
 * Never touches a chat that is working or waiting on the person, and never
 * pushes the remote itself out of "ok". Each moved chat reopens in its own
 * VS Code terminal.
 */
/**
 * One recorder tick of automatic balancing (see autobalance.js). Saves the
 * swap samples and the strained-tick count between ticks, because the
 * recorder is a fresh process each time. At most one move, then a notice.
 */
export async function autoBalanceTick({ notify, say = () => {} } = {}) {
  const config = readAutoConfig();
  const state = readAutoState();
  const { remote: remoteConfig, localOnlyMcp } = readConfig();
  if (!config.enabled || !remoteConfig) { state.strained = 0; writeAutoState(state); return { wait: 'off' }; }
  const mac = health(macLoad({ samples: state.samples }));
  state.strained = mac.level === 'ok' || mac.level === 'unknown' ? 0 : state.strained + 1;
  const remoteLive = readRemoteLive({ remote: remoteConfig });
  const remote = { reachable: remoteLive.reachable, level: health(remoteLoad(remoteLive)).level, availableMb: remoteLive.memAvailableMb };
  const { sessions } = scanSessions({ remoteLive });
  // Read only when this tick could move a chat: up to 9 MB per idle chat on a Mac that is swapping.
  if (state.strained >= config.strainedTicks) {
    for (const s of sessions) if (s.machine === 'mac' && s.live && s.status === 'idle') s.localOnly = localOnlyOf(s, localOnlyMcp);
  }
  const d = decide({ config, state, mac, remote, sessions });
  state.last = { at: Date.now(), wait: d.wait ?? null, moving: d.move?.name ?? null };
  writeAutoState(state);
  if (!d.move) return d;
  say(`auto-balance: moving ${d.move.name} (${d.why})`);
  const r = await moveLiveSession({ sessionId: d.move.sessionId });
  const after = readAutoState();
  after.lastMoveAt = Date.now();
  after.last = { at: Date.now(), moved: r.ok ? d.move.name : null, error: r.ok ? null : r.error };
  writeAutoState(after);
  const line = r.ok ? `Moved ${d.move.name} to ${remoteConfig.label}: the Mac is ${d.why}` : `Auto-balance could not move ${d.move.name}: ${r.error}`;
  notify?.(line.length > 120 ? `${line.slice(0, 117)}...` : line);
  return { moved: r.ok ? d.move.name : null, error: r.ok ? null : r.error };
}

export { setAutoBalance };

export async function balanceToRemote({ max = 5, remoteReserveMb = 3072 } = {}) {
  const moved = [];
  const skipped = [];
  const { remote: config, localOnlyMcp } = readConfig();
  if (!config) return { ok: false, error: 'no remote machine is configured', moved, skipped };
  let remote = readRemoteLive({ remote: config, force: true });
  if (!remote.reachable) return { ok: false, error: `${config.label} is unreachable`, moved, skipped };
  const before = health(macLoad());
  if (before.level === 'ok') return { ok: true, moved, skipped, mac: before, note: 'the Mac is not under strain' };
  const { sessions } = scanSessions({ remoteLive: remote });
  const candidates = sessions
    .filter((s) => s.machine === 'mac' && s.status === 'idle' && !s.needsYou && s.cwd)
    .sort((a, b) => (b.rssMb ?? 0) - (a.rssMb ?? 0));
  for (const s of candidates) {
    if (moved.length >= max) break;
    const localOnly = localOnlyOf(s, localOnlyMcp);
    if (localOnly) { skipped.push({ name: s.name, error: `it uses ${localOnly}, which only this Mac has` }); continue; }
    if (health(macLoad()).level === 'ok') break;
    const room = (remote.memAvailableMb ?? 0) - (s.rssMb ?? 400);
    if (room < remoteReserveMb || health(remoteLoad(remote)).level !== 'ok') {
      skipped.push({ name: s.name, error: `${config.label} is out of room` });
      break;
    }
    const r = await moveLiveSession({ sessionId: s.sessionId });
    if (r.ok) moved.push({ name: s.name, rssMb: s.rssMb, verified: r.verified, reopened: r.reopened?.ok ?? false });
    else skipped.push({ name: s.name, error: r.error });
    remote = readRemoteLive({ remote: config, force: true });
  }
  return { ok: true, moved, skipped, mac: health(macLoad()), idleCandidates: candidates.length };
}

/**
 * What can be typed into a running chat. Model, effort and permission are not
 * here: typed as /model or /effort they also save a new default for every
 * session, so they go through restart.js with session-only launch flags.
 */
export const MAC_KEYS = {
  reply: (v) => ({ text: v, newline: true }),
  interrupt: () => ({ text: '\u001b', newline: false }),
};

/** Checked at the boundary: an unknown action or an oversized reply is refused, never typed. */
export function checkControl(action, value) {
  if (!(action in MAC_KEYS) || !(action in CONTROLS)) return `unknown action ${action}`;
  if (action === 'reply' && (typeof value !== 'string' || !value.trim() || value.length > 4000)) return 'a reply is 1 to 4000 characters';
  return null;
}

/**
 * Type into a chat open on this Mac, in its VS Code terminal. A reply waits for
 * the chat to be idle or waiting on you, so it never lands in the middle of
 * your own typing or its work; Esc is the exception, it is for that.
 */
export async function controlMacSession({ sessionId, action, value = '' }) {
  const bad = checkControl(action, value);
  if (bad) return { ok: false, error: bad };
  const live = readLiveSessions({ interactiveOnly: false }).find((s) => s.sessionId === sessionId);
  if (!live) return { ok: false, error: 'it is not open on this Mac' };
  if (action !== 'interrupt' && (live.status === 'busy' || live.status === 'shell')) {
    return { ok: false, error: `${live.name ?? 'the chat'} is working; wait for it, or interrupt it first` };
  }
  const { text, newline } = MAC_KEYS[action](value);
  // Esc puts the interrupted request back in the input box, so a reply sent
  // next was glued onto it. Right after an interrupt from here, clear the
  // line first; at any other time the box may hold a draft the person
  // typed, and that is left alone.
  const recent = Date.now() - (interruptedAt.get(sessionId) ?? 0) < 10 * 60_000;
  const clear = action === 'reply' && recent ? '\u0015' : '';
  const r = await typeIntoTerminal({ shellPid: parentPid(live.pid), text: clear + text, newline });
  if (r.ok && action === 'interrupt') interruptedAt.set(sessionId, Date.now());
  if (r.ok && action === 'reply') interruptedAt.delete(sessionId);
  return r;
}
const interruptedAt = new Map();

/**
 * A folder the remote can take a new chat in: a project inside the local
 * projects root, not the root itself and nothing hidden.
 */
export function isRemoteProject(cwd, root) {
  return typeof root === 'string' && typeof cwd === 'string' && cwd.startsWith(`${root}/`) && !cwd.includes('/.');
}

/**
 * Where a new chat should run. "auto" puts it on the remote only when the Mac
 * is strained, the remote is healthy, and the folder is a project the remote
 * can take (see isRemoteProject).
 */
export function chooseMachine(choice, { macLevel, remoteLevel, remoteReachable, cwd, remote }) {
  const remoteCan = Boolean(remote) && remoteReachable && isRemoteProject(cwd, remote.localProjectsRoot);
  if (choice === 'mac' || (!remote && choice !== 'remote')) return { machine: 'mac' };
  if (choice === 'remote') {
    if (!remote) return { error: 'no remote machine is configured' };
    if (remoteCan) return { machine: 'remote' };
    return { error: remoteReachable ? `${remote.label} takes chats in a project inside ${remote.localProjectsRoot}, not that folder` : `${remote.label} is unreachable` };
  }
  if (remoteCan && macLevel !== 'ok' && remoteLevel === 'ok') return { machine: 'remote', why: 'the Mac is strained' };
  return { machine: 'mac', why: remoteCan ? 'the Mac has room' : 'that folder only runs on the Mac' };
}

/** Start a chat with a name, model, effort, permission, account and machine, in a VS Code terminal. */
export async function newChat({ cwd, name = '', model, effort, permission, account = null, machine = 'auto' }) {
  if (typeof cwd !== 'string' || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return { ok: false, error: 'pick a folder that exists' };
  if (name && !/^[A-Za-z0-9 _.()-]{1,60}$/.test(name)) return { ok: false, error: 'a name is letters, digits, spaces and _ . - ( ), up to 60' };
  let flags;
  try {
    flags = launchFlags({ model: model || null, effort: effort || null, permission: permission || null }, { allowNone: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const config = remoteConfig();
  const remote = readRemoteLive({ remote: config });
  const pick = chooseMachine(machine, {
    macLevel: health(macLoad()).level, remoteLevel: health(remoteLoad(remote)).level, remoteReachable: remote.reachable, cwd, remote: config,
  });
  if (pick.error) return { ok: false, error: pick.error };
  const label = name || path.basename(cwd);
  if (pick.machine === 'remote') {
    if (account) return { ok: false, error: `an account applies to Mac chats; ${config.label} has its own login` };
    const started = await startOnRemote({ cwd, name: label, flags }, { remote: config, home: remote.home });
    if (!started.ok) return started;
    const attached = await attachSession({ name: label, cwd });
    return { ok: true, machine: 'remote', why: pick.why, attached: attached.ok };
  }
  const n = account == null || account === '' ? null : Number(account);
  if (n !== null && !(Number.isInteger(n) && n > 0)) return { ok: false, error: `no account ${account}` };
  const cswap = n ? cswapPath() : null;
  if (n && !cswap) return { ok: false, error: 'claude-swap is not installed, so a chat cannot start as another account' };
  const launcher = n ? `${shq(cswap)} run ${n} --` : 'claude';
  const text = `${cleanEnv()} ${launcher}${name ? ` --name ${shq(name)}` : ''}${flags ? ` ${flags}` : ''}`;
  const r = await runInVscodeTerminal({ cwd, name: label, text });
  return r.ok ? { ok: true, machine: 'mac', why: pick.why } : r;
}

/** One entry point for the window: the chat's machine decides how it is reached. */
export function controlChat({ sessionId, name, machine, action, value }) {
  const bad = checkControl(action, value);
  if (bad) return Promise.resolve({ ok: false, error: bad });
  if (machine === 'remote') {
    if (typeof name !== 'string' || !name) return Promise.resolve({ ok: false, error: 'no session named' });
    return controlSession(name, action, value);
  }
  return controlMacSession({ sessionId, action, value });
}

/** A stopped chat goes through the same checks as a live one; nothing to close or reopen. */
export function moveSession(sessionId) {
  return moveLiveSession({ sessionId, reopen: false });
}

export function getLive() {
  return readLiveSessions();
}

/** What a delete would remove. Never mutates. */
export function previewDelete(session) {
  return planDelete(session);
}

/** Delete here, then the remote's copy, which copying between the machines would otherwise keep. */
export async function performDelete(session) {
  const mac = deleteSession(session);
  const config = remoteConfig();
  if (!config) return mac;
  const remote = readRemoteLive({ remote: config }).reachable
    ? await trashOnRemote(session, config)
    : { ok: false, error: `${config.label} is unreachable; its copy stays until you delete it again` };
  return { ...mac, remote };
}

/**
 * Write restore tasks for one folder and optionally open it in VS Code.
 *
 * @param {string} cwd
 * @param {Array<{sessionId:string,name:string}>} sessions
 * @param {{launch?:boolean, staggerSeconds?:number}} [options]
 */
export function restoreProject(cwd, sessions, options = {}) {
  if (!fs.existsSync(cwd)) {
    throw new Error(`that folder no longer exists: ${cwd}`);
  }
  const written = writeRestoreTasks(cwd, sessions, options);
  if (options.launch !== false) openInVscode(cwd);
  return written;
}

export function clearProject(cwd) {
  return clearRestoreTasks(cwd);
}

/**
 * Fire and forget: `code <folder>`. Failure here is reported, never fatal.
 *
 * Launched with the Claude session markers stripped. VS Code passes its own
 * environment to every terminal it opens, so inheriting them turned each chat in
 * that window into a child session with transcript saving off, including ones
 * opened by hand long afterwards.
 */
export function openInVscode(cwd) {
  return new Promise((resolve) => {
    execFile(codeBin(), [cwd], { env: withoutClaudeMarkers() },
      (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

export const recorder = launchd;

/** VS Code will not auto-run restored terminals unless this is on. */
export { readAutoTaskSetting, enableAutoTasks, readPersistentSessions, setPersistentSessions };
