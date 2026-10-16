#!/usr/bin/env node
/**
 * csr: the terminal face of claude-session-restore.
 *
 * Everything here is a thin wrapper over src/core/api.js, so the CLI and the GUI
 * can never drift apart in behaviour.
 */

import process from 'node:process';
import {
  getOverview, getLive, previewDelete, performDelete,
  restoreProject, clearProject, recorder,
} from '../src/core/api.js';
import { restorableSessions, readSnapshot, restorableWorkspaces } from '../src/core/snapshot.js';
import { readAutoTaskSetting, enableAutoTasks } from '../src/core/api.js';
import {
  setTerminalLocation, readTerminalLocation,
  readPersistentSessions, setPersistentSessions,
} from '../src/restore/vscode-settings.js';
import { pollOnce } from '../src/recorder/daemon.js';

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';
const GREEN = '\x1b[32m'; const YELLOW = '\x1b[33m'; const RED = '\x1b[31m';

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const ago = (ts) => {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

function cmdList(args) {
  const overview = getOverview();
  const filter = args.find((a) => !a.startsWith('-'));

  for (const project of overview.projects) {
    if (filter && !project.label.toLowerCase().includes(filter.toLowerCase())) continue;
    const live = project.allLiveCount ? `${GREEN}${project.allLiveCount} live${RESET}  ` : '';
    const indent = '  '.repeat(project.depth);
    const label = project.depth > 0 ? project.label.split('/').pop() : project.label;
    // Children are printed as their own rows, so say plainly when the inclusive
    // count differs from what is listed directly beneath this heading.
    const scope = project.allSessions.length === project.sessionCount
      ? `${project.sessionCount} chats`
      : `${project.sessionCount} here, ${project.allSessions.length} with subfolders`;
    console.log(`\n${indent}${BOLD}${label}${RESET}  ${DIM}${scope}, ${mb(project.allBytes)}${RESET}  ${live}`);
    for (const session of project.sessions) {
      const mark = session.live ? `${GREEN}*${RESET}` : ' ';
      const size = session.transcriptMissing ? `${DIM}no transcript${RESET}` : mb(session.bytes + session.subagentBytes).padStart(9);
      console.log(`  ${mark} ${session.name.slice(0, 44).padEnd(46)} ${size}  ${DIM}${session.sessionId.slice(0, 8)}  ${ago(session.modifiedAt)}${RESET}`);
    }
  }

  const t = overview.totals;
  console.log(`\n${DIM}${t.sessions} chats across ${t.projects} projects, ${mb(t.bytes)} total, ${t.live} running${RESET}`);
  if (!overview.recorder.armed) {
    console.log(`${YELLOW}recorder is not running: restore will not work. run: csr daemon install${RESET}`);
  }
}

function cmdLive() {
  const live = getLive();
  if (!live.length) return console.log('no running sessions');
  for (const session of live) {
    console.log(`${GREEN}*${RESET} ${String(session.pid).padEnd(7)} ${(session.name ?? '-').padEnd(24)} ${(session.status ?? '').padEnd(6)} ${DIM}${session.cwd}${RESET}`);
  }
  console.log(`\n${DIM}${live.length} running${RESET}`);
}

function findSession(idPrefix) {
  const overview = getOverview();
  const all = overview.projects.flatMap((p) => p.sessions);
  const matches = all.filter(
    (s) => s.sessionId.startsWith(idPrefix) || s.name.toLowerCase() === idPrefix.toLowerCase(),
  );
  if (matches.length === 0) throw new Error(`no chat matches "${idPrefix}"`);
  if (matches.length > 1) {
    throw new Error(`"${idPrefix}" matches ${matches.length} chats:\n  ${matches.map((m) => `${m.sessionId.slice(0, 8)}  ${m.name}`).join('\n  ')}`);
  }
  return matches[0];
}

function cmdDelete(args) {
  const idPrefix = args.find((a) => !a.startsWith('-'));
  if (!idPrefix) throw new Error('usage: csr delete <session-id-prefix|name> [--yes]');

  const session = findSession(idPrefix);
  const plan = previewDelete(session);

  console.log(`\n${BOLD}Delete "${session.name}"${RESET}  ${DIM}${session.sessionId}${RESET}`);
  if (session.live) console.log(`${RED}this chat is running right now (pid ${session.pid}). close it first.${RESET}\n`);
  for (const target of plan.targets) {
    console.log(`  ${target.kind.padEnd(22)} ${mb(target.bytes).padStart(9)}  ${DIM}${target.path.replace(process.env.HOME, '~')}${RESET}`);
  }
  if (plan.historyLines) console.log(`  ${'history lines'.padEnd(22)} ${String(plan.historyLines).padStart(9)}`);
  console.log(`  ${BOLD}${'total'.padEnd(22)} ${mb(plan.totalBytes).padStart(9)}${RESET}  -> Trash\n`);

  if (!args.includes('--yes')) {
    console.log(`${DIM}dry run. add --yes to actually move these to Trash.${RESET}`);
    return;
  }
  const result = performDelete(session);
  console.log(`${GREEN}moved ${result.moved.length} item(s) to Trash, pruned ${result.historyRemoved} history line(s), reclaimed ${mb(result.bytesReclaimed)}${RESET}`);
}

async function cmdRestore(args) {
  const { sessions, source, capturedAt } = restorableSessions();
  if (!sessions.length) {
    console.log('nothing to restore.');
    console.log(`${DIM}the recorder captures what is open while you work. if it was not running before the last shutdown, there is nothing to bring back.${RESET}`);
    return;
  }

  // Per workspace, so a project closed an hour ago is still offered and is
  // labelled as closed rather than looking like it is still running.
  const workspaces = restorableWorkspaces();
  const byCwd = new Map(workspaces.map((w) => [w.root, w.sessions]));

  console.log(`\n${BOLD}${sessions.length} chat(s) across ${workspaces.length} folder(s)${RESET}`);
  for (const workspace of workspaces) {
    const tag = workspace.source === 'closed'
      ? `${YELLOW}closed ${ago(workspace.lastSeen)}${RESET}`
      : `${GREEN}running${RESET}`;
    console.log(`\n  ${workspace.root}  ${tag}`);
    for (const session of workspace.sessions) console.log(`    ${session.name}`);
  }

  if (!args.includes('--yes')) {
    console.log(`\n${DIM}dry run. add --yes to write .vscode/tasks.json and open VSCode.${RESET}`);
    return;
  }
  for (const [cwd, group] of byCwd) {
    const written = restoreProject(cwd, group, { launch: !args.includes('--no-launch') });
    console.log(`${GREEN}wrote ${written.taskCount} task(s) to ${written.tasksFile.replace(process.env.HOME, '~')}${RESET}`);
  }
  const auto = readAutoTaskSetting();
  if (auto.enabled) {
    console.log(`${DIM}VSCode will spawn the terminals when the folder opens.${RESET}`);
  } else {
    console.log(`${YELLOW}tasks written, but VSCode will NOT run them.${RESET}`);
    console.log(`${DIM}task.allowAutomaticTasks is application-scoped, so it only counts in user settings. run: csr autotasks${RESET}`);
  }
  console.log(`${DIM}the folder must also be trusted, or VSCode blocks automatic tasks silently.${RESET}`);
  if (readPersistentSessions().effective) {
    console.log(`${YELLOW}heads up: VSCode terminal revival is on, so you will also get empty shells beside these. run: csr persistence off${RESET}`);
  }
}

function cmdDaemon(args) {
  const sub = args[0] ?? 'status';
  if (sub === 'install') {
    const mode = args.includes('--resident') ? 'resident' : 'interval';
    const flagIndex = args.indexOf('--interval');
    const intervalSeconds = flagIndex >= 0 ? Number(args[flagIndex + 1]) || 30 : 30;
    const plist = recorder.install({ mode, intervalSeconds });
    const cost = mode === 'resident'
      ? 'a resident process, roughly 40 MB'
      : `nothing resident, one ~90 ms tick every ${intervalSeconds}s`;
    console.log(`${GREEN}recorder armed (${mode} mode)${RESET}  ${DIM}${cost}${RESET}`);
    console.log(`${DIM}${plist.replace(process.env.HOME, '~')}${RESET}`);
  } else if (sub === 'uninstall') {
    recorder.uninstall();
    console.log('recorder removed');
  } else if (sub === 'poll') {
    const sessions = pollOnce();
    console.log(`captured ${sessions.length} session(s): ${sessions.map((s) => s.name).join(', ')}`);
  } else {
    const status = recorder.status();
    const mode = status.mode?.kind
      ? `${status.mode.kind}${status.mode.intervalSeconds ? ` (${status.mode.intervalSeconds}s)` : ''}`
      : 'none';
    console.log(`${status.armed ? `${GREEN}armed${RESET}` : `${YELLOW}not armed${RESET}`}  mode: ${mode}  resident pid: ${status.pid ?? 'none'}`);
    const snapshot = readSnapshot();
    if (snapshot) {
      console.log(`${DIM}last capture ${ago(snapshot.capturedAt)}: ${snapshot.sessions.length} session(s)${RESET}`);
    } else {
      console.log(`${DIM}no snapshot captured yet${RESET}`);
    }
  }
}

function cmdAutotasks(args) {
  const before = readAutoTaskSetting();
  if (before.enabled && !args.includes('--force')) {
    return console.log(`${GREEN}automatic tasks already on${RESET}  ${DIM}${before.file.replace(process.env.HOME, '~')}${RESET}`);
  }
  const result = enableAutoTasks();
  if (!result.changed) return console.log(`${YELLOW}no change: ${result.reason}${RESET}`);
  console.log(`${GREEN}automatic tasks enabled (${result.reason})${RESET}`);
  console.log(`${DIM}${result.file.replace(process.env.HOME, '~')}${result.backup ? `  backup: ${result.backup.replace(process.env.HOME, '~')}` : ''}${RESET}`);
}

function cmdLayout(args) {
  const wanted = args.find((a) => !a.startsWith('-'));
  if (!wanted) {
    const current = readTerminalLocation();
    console.log(`terminal location: ${BOLD}${current.effective}${RESET}`);
    console.log(`${DIM}csr layout view    restored terminals in the bottom panel${RESET}`);
    console.log(`${DIM}csr layout editor  restored terminals as editor tabs${RESET}`);
    console.log(`${DIM}VSCode has no per-task option for this (microsoft/vscode#212070), it is one global setting.${RESET}`);
    return;
  }
  const result = setTerminalLocation(wanted);
  if (!result.changed) return console.log(`${YELLOW}no change: ${result.reason}${RESET}`);
  console.log(`${GREEN}terminals will open in the ${wanted === 'view' ? 'bottom panel' : 'editor area'} (${result.reason})${RESET}`);
  console.log(`${DIM}applies to terminals opened from now on${RESET}`);
}

function cmdPersistence(args) {
  const wanted = args.find((a) => !a.startsWith('-'));
  const current = readPersistentSessions();
  if (!wanted) {
    console.log(`VSCode terminal revival: ${BOLD}${current.effective ? 'on' : 'off'}${RESET}${current.present ? '' : `${DIM} (unset, VSCode defaults to on)${RESET}`}`);
    if (current.effective) {
      console.log(`${YELLOW}while this is on you get duplicates after a restore.${RESET}`);
      console.log(`${DIM}VSCode revives your old terminals as empty shells (the chat that was running in them is gone) and restore spawns fresh ones alongside.${RESET}`);
      console.log(`${DIM}csr persistence off   leave restore as the only thing reopening terminals${RESET}`);
    }
    return;
  }
  const enabled = wanted === 'on';
  if (!['on', 'off'].includes(wanted)) throw new Error('usage: csr persistence <on|off>');
  const result = setPersistentSessions(enabled);
  if (!result.changed) return console.log(`${YELLOW}no change: ${result.reason}${RESET}`);
  console.log(`${GREEN}VSCode terminal revival ${enabled ? 'on' : 'off'} (${result.reason})${RESET}`);
  console.log(`${DIM}${enabled ? 'VSCode will reopen its own terminals again.' : 'restore is now the only thing that reopens terminals.'}${RESET}`);
}

function cmdClear(args) {
  const cwd = args.find((a) => !a.startsWith('-')) ?? process.cwd();
  const { removed, tasksFile } = clearProject(cwd);
  console.log(`removed ${removed} generated task(s) from ${tasksFile.replace(process.env.HOME, '~')}`);
}

const HELP = `
${BOLD}csr${RESET} - claude session restore

  ${BOLD}csr list${RESET} [filter]        every chat, grouped by project
  ${BOLD}csr live${RESET}                 chats running right now
  ${BOLD}csr restore${RESET} [--yes]      bring back what was open before shutdown
  ${BOLD}csr delete${RESET} <id|name> [--yes]   delete a chat and everything keyed to it
  ${BOLD}csr clear${RESET} [folder]       remove generated tasks from a folder
  ${BOLD}csr autotasks${RESET}            let VSCode auto-run restored terminals
  ${BOLD}csr layout${RESET} [view|editor]  where restored terminals open
  ${BOLD}csr persistence${RESET} [on|off]  VSCode's own terminal revival (off avoids duplicates)
  ${BOLD}csr daemon${RESET} <install|uninstall|status|poll>

${DIM}delete and restore are dry runs until you pass --yes.${RESET}
`;

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case 'list': case 'ls': cmdList(args); break;
    case 'live': cmdLive(); break;
    case 'restore': await cmdRestore(args); break;
    case 'delete': case 'rm': cmdDelete(args); break;
    case 'clear': cmdClear(args); break;
    case 'autotasks': cmdAutotasks(args); break;
    case 'layout': cmdLayout(args); break;
    case 'persistence': cmdPersistence(args); break;
    case 'daemon': cmdDaemon(args); break;
    default: console.log(HELP);
  }
} catch (err) {
  console.error(`${RED}${err.message}${RESET}`);
  process.exit(1);
}
