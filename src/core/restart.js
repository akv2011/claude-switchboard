/**
 * Change a running chat's model, effort or permission mode by restarting it
 * with launch flags, the way Claude Code documents for one session only:
 * "The --model flag and ANTHROPIC_MODEL environment variable apply only to
 * the session you launch with them", and likewise --effort and
 * --permission-mode.
 *
 * Typing /model or /effort into the chat was tried first and dropped: both
 * save a new default for every future session, a switch to another model
 * opened a second screen that swallowed the next keystrokes, and restoring
 * the default rewrote settings.json, which made every open chat reload its
 * settings and print a page of warnings.
 *
 * Only an idle chat is restarted, so no work is cut off. The conversation is
 * resumed from its transcript in the same terminal (Mac) or tmux (remote).
 */
import { readLiveSessions } from './registry.js';
import { pidExists } from './liveness.js';
import { readRemoteLive, resumeOnRemote, stopOnRemote, remoteConfig, MODELS, EFFORTS } from './remote.js';
import { runInVscodeTerminal, parentPid, shq } from './vscode-bridge.js';
import { cleanEnv } from '../restore/tasks.js';

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The flags for a choice, checked against the CLI's own lists. Throws on anything else. */
export function launchFlags(choice = {}, { allowNone = false } = {}) {
  const { model, effort, permission } = choice;
  const flags = [];
  if (model != null) { if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`); flags.push(`--model ${model}`); }
  if (effort != null) { if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`); flags.push(`--effort ${effort}`); }
  if (permission != null) { if (!PERMISSION_MODES.includes(permission)) throw new Error(`permission must be one of ${PERMISSION_MODES.join(', ')}`); flags.push(`--permission-mode ${permission}`); }
  if (!flags.length && !allowNone) throw new Error('nothing to change');
  return flags.join(' ');
}

const busy = (status) => status === 'busy' || status === 'shell' || status === 'waiting';

export async function restartWith({ sessionId, machine, model, effort, permission }) {
  let flags;
  try {
    flags = launchFlags({ model, effort, permission });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return machine === 'remote' ? restartOnRemote(sessionId, flags) : restartOnMac(sessionId, flags);
}

async function restartOnMac(sessionId, flags) {
  const live = readLiveSessions({ interactiveOnly: false }).find((s) => s.sessionId === sessionId);
  if (!live) return { ok: false, error: 'it is not open on this Mac' };
  if (busy(live.status)) return { ok: false, busy: true, error: `${live.name ?? 'the chat'} is ${live.status === 'waiting' ? 'waiting at a prompt' : 'working'}; change it when it is idle` };
  const shellPid = parentPid(live.pid);
  try {
    process.kill(live.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: `could not close it: ${err.message}` };
  }
  for (let i = 0; i < 30 && pidExists(live.pid); i += 1) await sleep(500);
  if (pidExists(live.pid)) return { ok: false, error: 'it did not exit after 15 s' };
  const text = `${cleanEnv()} claude --resume ${shq(sessionId)} ${flags}`;
  const r = await runInVscodeTerminal({ shellPid, cwd: live.cwd, name: live.name ?? sessionId.slice(0, 8), text });
  if (!r.ok) return { ok: false, error: `It closed, but could not be reopened: ${r.error}` };
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (readLiveSessions({ interactiveOnly: false }).some((s) => s.sessionId === sessionId)) return { ok: true, flags };
  }
  return { ok: true, flags, verified: false, error: 'reopened, but it has not registered yet' };
}

async function restartOnRemote(sessionId, flags) {
  const remote = remoteConfig();
  if (!remote) return { ok: false, error: 'no remote machine is configured' };
  const live = readRemoteLive({ remote, force: true });
  if (!live.reachable) return { ok: false, error: `${remote.label} is unreachable` };
  const same = (s) => String(s.sessionId).toLowerCase() === String(sessionId).toLowerCase();
  const entry = live.sessions.find(same);
  if (!entry) return { ok: false, error: `it is not running on ${remote.label}` };
  if (busy(entry.status)) return { ok: false, busy: true, error: `${entry.name ?? 'the chat'} is working; change it when it is idle` };
  if (!(await stopOnRemote(entry.pid, remote))) return { ok: false, error: `it did not exit on ${remote.label} after 15 s` };
  const r = await resumeOnRemote([entry], { staggerSeconds: 0, extraArgs: flags, remote, home: live.home });
  if (!r.ok || !r.started) return { ok: false, error: `It closed on ${remote.label}, but did not start again: ${r.error ?? 'tmux skipped it'}` };
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    if (readRemoteLive({ remote, force: true }).sessions.some(same)) return { ok: true, flags };
  }
  return { ok: true, flags, verified: false, error: `restarted, but ${remote.label} has not listed it yet` };
}
