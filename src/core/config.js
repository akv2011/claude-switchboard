/**
 * The user's settings, from ~/.config/claude-switchboard/config.json.
 *
 * Everything here is optional. With no file at all the app runs on this Mac
 * only: no remote machine, nothing tries ssh, and the folder-of-projects rule
 * uses the default roots.
 *
 *   {
 *     "remote": { "host": "devbox", "label": "Devbox", "projectsRoot": "~/Projects" },
 *     "projectsRoots": ["~/Projects", "~/Desktop/Projects", "~/code"],
 *     "localOnlyMcp": ["browser-"],
 *     "notify": { "command": ["/opt/homebrew/bin/terminal-notifier", "-message"] }
 *   }
 *
 * The file is a trust boundary: its values reach ssh, rsync and tmux. A host
 * that could be read as an ssh option, or a remote root that a remote shell
 * would split or expand, is refused here and reported, never passed on.
 *
 * Read per call, not cached at import, so an edit takes effect on the next
 * refresh and a test can point HOME at a fixture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PROJECTS_ROOTS = ['~/Projects', '~/Desktop/Projects', '~/code'];
export const DEFAULT_REMOTE_ROOT = '~/Projects';
export const DEFAULT_LABEL = 'Remote';

export const configFile = () => path.join(os.homedir(), '.config', 'claude-switchboard', 'config.json');

/** An ssh host or alias. Never starts with "-", so ssh cannot read it as an option. */
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,252}$/;
/**
 * A remote root goes into rsync remote paths and ssh scripts. Plain path
 * characters only: older rsync builds hand remote paths to the remote shell
 * unquoted, so a space or a quote would be split or interpreted there.
 */
const REMOTE_ROOT_RE = /^(~|~?(\/[A-Za-z0-9._+@=,-]+)+)$/;
/** An MCP server name, or the start of one, as it appears in tool names (mcp__<server>__<tool>). */
const MCP_PREFIX_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** "~" and "~/x" relative to `home`; anything else unchanged. */
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  return typeof p === 'string' && p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Validate a parsed config. Pure: `home` is the local home folder.
 *
 * @returns {{remote: null | {host:string, label:string, projectsRoot:string, localProjectsRoot:string},
 *            projectsRoots: string[], localOnlyMcp: string[], notify: {command: string[] | null}, relay: boolean, errors: string[]}}
 */
export function parseConfig(raw, home = os.homedir()) {
  const errors = [];
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let remote = null;
  if (obj.remote != null) {
    const r = typeof obj.remote === 'object' ? obj.remote : {};
    const host = typeof r.host === 'string' ? r.host.trim() : '';
    const projectsRoot = typeof r.projectsRoot === 'string' && r.projectsRoot.trim()
      ? trimSlash(r.projectsRoot.trim()) : DEFAULT_REMOTE_ROOT;
    const localRaw = typeof r.localProjectsRoot === 'string' && r.localProjectsRoot.trim()
      ? r.localProjectsRoot.trim() : projectsRoot;
    const localProjectsRoot = trimSlash(expandHome(localRaw, home));
    if (!HOST_RE.test(host)) {
      errors.push('remote.host must be an ssh host or alias: letters, digits, and . _ - @, not starting with -');
    } else if (!REMOTE_ROOT_RE.test(projectsRoot) || projectsRoot.split('/').includes('..')) {
      errors.push('remote.projectsRoot must be ~, ~/folder or /absolute/folder, with letters, digits and . _ - + @ = , only');
    } else if (!path.isAbsolute(localProjectsRoot)) {
      errors.push('remote.localProjectsRoot must be ~/folder or an absolute path');
    } else {
      const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 24) : DEFAULT_LABEL;
      remote = { host, label, projectsRoot, localProjectsRoot };
    }
  }

  let roots = DEFAULT_PROJECTS_ROOTS;
  if (obj.projectsRoots !== undefined) {
    if (Array.isArray(obj.projectsRoots) && obj.projectsRoots.every((x) => typeof x === 'string' && x.trim())) roots = obj.projectsRoots;
    else errors.push('projectsRoots must be a list of folders');
  }
  const projectsRoots = [...new Set(roots.map((x) => trimSlash(expandHome(x.trim(), home))))].filter((x) => path.isAbsolute(x));

  let localOnlyMcp = [];
  if (obj.localOnlyMcp !== undefined) {
    if (Array.isArray(obj.localOnlyMcp) && obj.localOnlyMcp.every((x) => typeof x === 'string' && MCP_PREFIX_RE.test(x))) localOnlyMcp = obj.localOnlyMcp;
    else errors.push('localOnlyMcp must be a list of MCP server names, or the start of one: letters, digits, _ and -');
  }

  let command = null;
  if (obj.notify?.command !== undefined && obj.notify?.command !== null) {
    const c = obj.notify.command;
    if (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string' && x)) command = c.map((x, i) => (i === 0 ? expandHome(x, home) : x));
    else errors.push('notify.command must be a list: the program, then its arguments; the message is added last');
  }

  // Off unless asked for: it opens every chat's message socket to the other machine (peer-relay.js).
  let relay = false;
  if (obj.relay !== undefined) {
    if (typeof obj.relay === 'boolean') relay = obj.relay;
    else errors.push('relay must be true or false');
  }

  return { remote, projectsRoots, localOnlyMcp, notify: { command }, relay, errors };
}

/** The current settings. A missing file is the default; a broken one is reported, not fatal. */
export function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const why = err instanceof SyntaxError ? 'is not valid JSON' : `cannot be read (${err.code ?? err.message})`;
      return { ...parseConfig({}), errors: [`${configFile()} ${why}; using defaults`] };
    }
  }
  return parseConfig(raw);
}
