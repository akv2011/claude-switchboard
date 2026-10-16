/**
 * Restore terminals without a VSCode extension.
 *
 * VSCode natively runs tasks when a folder opens, via
 * runOptions.runOn = "folderOpen", and gives each task its own terminal panel.
 * So restoring is just writing a tasks.json: open the folder and VSCode itself
 * spawns the terminals and resumes every chat. No extension, no AppleScript, no
 * driving the UI from outside.
 *
 * Two gates decide whether those tasks ever run, and both fail silently. This
 * was verified by experiment, not assumption: a probe task in an untrusted
 * folder never fired, the same probe in a trusted folder fired in 4 seconds.
 *
 *   1. "task.allowAutomaticTasks" must be "on" in USER settings. VSCode's own
 *      schema marks it scope 1 (APPLICATION), like update.mode, so a workspace
 *      .vscode/settings.json copy is read by nobody. This module used to write
 *      exactly that and report success. See restore/vscode-settings.js.
 *   2. The folder must be trusted. VSCode's RunAutomaticTasks returns before it
 *      even inspects the setting when isWorkspaceTrusted() is false, so a fresh
 *      folder does nothing at all until you answer the trust prompt.
 *
 * A third, and the awkward one: VSCode does not reliably run several tasks that
 * start together. Since 1.70 multiple runOn folderOpen tasks do not all fire
 * (microsoft/vscode#160013), and a dependsOn parent did not help either.
 * Measured on four tasks, only presentation.group ran all of them:
 *
 *   shared group                4 of 4
 *   no group, dedicated panel   1 of 4
 *   dependsOn + dedicated       1 of 4
 *   dependsOn + panel "new"     0 of 4
 *
 * So tasks share a group. VSCode presents grouped tasks as split panes rather
 * than tabs, which is a real cost, but silently restoring one chat out of four
 * is a worse one. The panes can be rearranged by hand afterwards.
 *
 * dependsOn is not used: combined with grouping it measured 0 of 4.
 *
 * Starts are staggered with a leading sleep so a dozen terminals do not launch
 * in the same instant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { INHERITED_CLAUDE_VARS } from '../core/paths.js';
import { readAutoTaskSetting } from './vscode-settings.js';

const TASK_PREFIX = 'claude: ';
const DEFAULT_STAGGER_SECONDS = 3;

/** Shell-quote for the single-quoted context we build commands in. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {Array<{sessionId:string, name:string, cwd?:string}>} sessions
 * @param {{staggerSeconds?:number, claudePath?:string, workspaceRoot?:string,
 *          splitTerminals?:boolean}} [options]
 */
/**
 * The shell command that resumes a chat with the inherited session markers
 * stripped. Without that the restored chat is a child session: no transcript,
 * no registry entry, invisible to the app and to `claude agents`.
 */
export function resumeCommand(sessionId, claude = 'claude') {
  return `${cleanEnv()} ${claude} --resume ${shellQuote(sessionId)}`;
}

/**
 * `env -u ...` for every marker a parent Claude session leaves behind. A
 * VSCode window opened from inside a chat passes them to all its terminals,
 * and a chat started there saves no transcript (Claude Code says "Transcript
 * saving is off, inherited CLAUDE_CODE_CHILD_SESSION marker").
 */
export function cleanEnv() {
  return `env ${INHERITED_CLAUDE_VARS.map((v) => `-u ${v}`).join(' ')} -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN`;
}

export function buildTasks(sessions, options = {}) {
  const stagger = options.staggerSeconds ?? DEFAULT_STAGGER_SECONDS;
  const claude = options.claudePath ?? 'claude';
  const root = options.workspaceRoot ?? null;
  // presentation.group is documented as "use split terminals", and it is the
  // only configuration in which VSCode actually runs every task. Measured on
  // four tasks: with a shared group 4 of 4 ran; without it 1 of 4; via
  // dependsOn with a dedicated panel 1 of 4; with panel "new" 0 of 4.
  // Losing chats is worse than the layout, so grouping is the default. Opting
  // out gives tabs but only the last chat comes back.
  const split = options.separateTabs !== true;

  const children = sessions.map((session, index) => {
    const delay = index * stagger;
    // Belt and braces with the clean launch env, since the folder may be
    // opened by hand rather than by restore.
    const resume = resumeCommand(session.sessionId, claude);
    const needsCwd = session.cwd && root && session.cwd !== root;
    return {
      label: `${TASK_PREFIX}${session.name ?? session.sessionId.slice(0, 8)}`,
      type: 'shell',
      command: delay > 0 ? `sleep ${delay}; ${resume}` : resume,
      ...(needsCwd ? { options: { cwd: session.cwd } } : {}),
      runOptions: { runOn: 'folderOpen' },
      presentation: {
        panel: 'dedicated',
        ...(split ? { group: 'claude' } : {}),
        reveal: 'always',
        focus: false,
        echo: false,
      },
      problemMatcher: [],
    };
  });

  return children;
}

/**
 * Merge our tasks into an existing tasks.json.
 *
 * Anything the user wrote themselves is preserved. Only tasks we previously
 * generated (label starts with "claude: ") are replaced, so repeated restores
 * do not accumulate duplicates.
 */
export function mergeTasks(existing, generated) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const previous = Array.isArray(base.tasks) ? base.tasks : [];
  const userTasks = previous.filter(
    (task) => typeof task?.label !== 'string' || !task.label.startsWith(TASK_PREFIX),
  );
  return { ...base, version: base.version ?? '2.0.0', tasks: [...userTasks, ...generated] };
}

function readJsonIfPresent(file) {
  try {
    // tasks.json permits comments. Strip the common cases before parsing.
    const raw = fs.readFileSync(file, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write .vscode/tasks.json for one project folder.
 *
 * @param {string} cwd project folder
 * @param {Array<{sessionId:string, name:string}>} sessions
 * @param {{staggerSeconds?:number, claudePath?:string}} [options]
 */
export function writeRestoreTasks(cwd, sessions, options = {}) {
  const vscodeDir = path.join(cwd, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });

  const tasksFile = path.join(vscodeDir, 'tasks.json');
  const merged = mergeTasks(
    readJsonIfPresent(tasksFile),
    buildTasks(sessions, { ...options, workspaceRoot: cwd }),
  );
  fs.writeFileSync(tasksFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  // Deliberately does NOT write task.allowAutomaticTasks here. That setting is
  // application-scoped, so a workspace copy is inert, and writing it produced a
  // convincing-looking file that changed nothing.
  return {
    tasksFile,
    taskCount: merged.tasks.length,
    autoTasks: readAutoTaskSetting(),
  };
}

/** Remove only our generated tasks, leaving the user's own intact. */
export function clearRestoreTasks(cwd) {
  const tasksFile = path.join(cwd, '.vscode', 'tasks.json');
  const existing = readJsonIfPresent(tasksFile);
  if (!existing) return { tasksFile, removed: 0 };

  const previous = Array.isArray(existing.tasks) ? existing.tasks : [];
  const kept = previous.filter(
    (task) => typeof task?.label !== 'string' || !task.label.startsWith(TASK_PREFIX),
  );
  const removed = previous.length - kept.length;
  if (removed > 0) {
    fs.writeFileSync(
      tasksFile,
      `${JSON.stringify({ ...existing, tasks: kept }, null, 2)}\n`,
      'utf8',
    );
  }
  return { tasksFile, removed };
}
