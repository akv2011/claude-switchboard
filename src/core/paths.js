/**
 * Every filesystem location this tool touches.
 *
 * One important asymmetry lives here: encoding a cwd into a project directory
 * name is easy, but decoding it back is impossible. Claude Code replaces every
 * character that is not a letter or a digit with "-", "/" and "_" and "." alike, so
 *
 *   /Volumes/Work/my_project.v2  ->  -Volumes-Work-my-project-v2
 *
 * is indistinguishable from a path that really did contain those dashes. Never
 * try to reverse it. Read the authoritative `cwd` out of the transcript instead
 * (see sessions.js readCwd).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');

export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const SESSION_ENV_DIR = path.join(CLAUDE_DIR, 'session-env');
export const IDE_DIR = path.join(CLAUDE_DIR, 'ide');
export const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

/**
 * Our own durable store. Claude never touches this.
 *
 * Resolved per call rather than captured at import. As constants these were
 * fixed before a test could point HOME at a fixture, so the suite wrote its
 * temporary workspaces into the real store and they showed up as offers.
 */
export const stateDir = () => path.join(os.homedir(), '.claude-restore');
export const stateFile = () => path.join(stateDir(), 'state.json');
export const logFile = () => path.join(stateDir(), 'recorder.log');

/** Lossy on purpose. Use for lookup only, never to recover a path. */
export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * An executable by name, or null when it is not installed: each folder on
 * PATH, then ~/.local/bin, where the Claude Code and claude-swap installers
 * put theirs. The window and the recorder extend PATH with the Homebrew
 * folders at start, since launchd starts them with /usr/bin:/bin only.
 */
export function findBin(name) {
  const dirs = [...String(process.env.PATH ?? '').split(':').filter(Boolean), path.join(os.homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/** The PATH the window and the recorder run with: what they were given, plus the usual install folders. */
export function toolPath(current = process.env.PATH) {
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set([...String(current ?? '').split(':').filter(Boolean), ...extra])].join(':');
}

/**
 * VS Code's `code` command. Installing it on PATH is a separate step in VS
 * Code ("Shell Command: Install 'code' command in PATH"), so the copy inside
 * the app bundle is the fallback.
 */
export function codeBin() {
  const bundled = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  return findBin('code') ?? (fs.existsSync(bundled) ? bundled : 'code');
}

/** Transcript path for a session inside an already known project directory. */
export function transcriptPath(projectDir, sessionId) {
  return path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
}

/** Sibling directory holding this session's subagent transcripts. */
export function subagentDir(projectDir, sessionId) {
  return path.join(PROJECTS_DIR, projectDir, sessionId);
}

export function sessionEnvDir(sessionId) {
  return path.join(SESSION_ENV_DIR, sessionId);
}

/**
 * Guard against a bug or a crafted id deleting something outside ~/.claude.
 * Returns true only if `target` really sits under `~/.claude`.
 */
export function isInsideClaudeDir(target) {
  const rel = path.relative(CLAUDE_DIR, path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * True when `child` is `parent` or sits inside it, compared on a path boundary
 * so /a/project does not swallow /a/project-two.
 */
export function isInsidePath(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Can this folder stand as a workspace that other chats fold into?
 *
 * The home directory and the filesystem root technically contain every other
 * path, so a single chat started in ~ would otherwise swallow every project in
 * the sidebar and make restore open one window holding everything. A chat run
 * directly in ~ is its own thing, not a parent.
 */
export function canBeWorkspaceRoot(cwd) {
  if (!cwd) return false;
  const normalised = cwd.replace(/\/+$/, '');
  return normalised !== '' && normalised !== HOME && normalised !== '/';
}

/**
 * Environment variables that mark a process as living inside a Claude session.
 *
 * Anything launched from within a session inherits these, and a `claude` started
 * with them present believes it is a child session: it turns transcript saving
 * OFF, does not register in ~/.claude/sessions, and reports the parent's id.
 * Such a chat is invisible even to `claude agents --json`, and its conversation
 * is never written to disk.
 *
 * Restore launches VSCode, and every terminal in that window inherits whatever
 * VSCode was launched with, so these must be stripped at both points.
 */
export const INHERITED_CLAUDE_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_EXECPATH',
];

/** A copy of `env` with the session markers removed. */
export function withoutClaudeMarkers(env = process.env) {
  const clean = { ...env };
  for (const key of INHERITED_CLAUDE_VARS) delete clean[key];
  return clean;
}
