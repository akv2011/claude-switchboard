/**
 * Close a remote chat that nothing shows any more, once its work is done.
 *
 * A chat on this Mac ends with its tab. A remote chat runs in tmux and outlives
 * it: the switchboard-remote extension closes one when its tab is closed by hand,
 * but a tab closed while that extension was not loaded, VS Code quitting or a
 * restart of this Mac leaves the chat running with nothing showing it, for hours.
 *
 * A chat counts as shown while a tmux client is attached to it, or while a tab's
 * shell here for it lives (that tab outlasts a dropped link). One shown by neither
 * for 10 minutes, and idle for 10 minutes, gets SIGTERM, a clean exit for Claude
 * Code; its history stays for a resume. One still working waits until it finishes.
 * One left with only background jobs (a dev server, a crawl) is not closed, since
 * that would stop them: it gets one notification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';
import { remoteConfig, sshScript, tmuxName } from './remote.js';

export const GRACE_MS = 10 * 60_000;
// Readings further apart than this (either machine asleep, the link down) start the count again,
// so a tab that is about to reconnect after an outage is not judged on the minutes it was away.
const GAP_MS = 3 * 60_000;

/**
 * Pure. Which remote chats to close and which to ask about, and the next state:
 * { sessionId: { since, seen, asked } } for each chat nothing shows.
 *
 * @param {{sessions:Array<object>, tabs:Record<string, number>, state?:object, now?:number, graceMs?:number}} input
 *   tabs: tmux name to the live shell of its tab here, as rememberRemoteTabs keeps it.
 */
export function tablessPlan({ sessions, tabs, state = {}, now = Date.now(), graceMs = GRACE_MS }) {
  const next = {};
  const close = [];
  const ask = [];
  for (const s of sessions) {
    if (!s.sessionId || !s.pid) continue;
    if (s.clients > 0 || Object.hasOwn(tabs, s.tmux ?? tmuxName(s.name ?? s.sessionId.slice(0, 8)))) continue;
    const prev = state[s.sessionId];
    const since = prev && now - prev.seen <= GAP_MS ? prev.since : now;
    const entry = { since, seen: now, asked: prev?.asked ?? false };
    next[s.sessionId] = entry;
    if (now - since < graceMs) continue;
    if (s.status === 'idle' && now - (s.statusUpdatedAt ?? 0) >= graceMs) close.push(s);
    else if (s.status === 'shell' && !entry.asked) { ask.push(s); entry.asked = true; }
  }
  return { close, ask, next };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * SIGTERM each chat, checked again on the remote first: the pid still holds that chat, it is
 * still idle, and no terminal attached to it in the meantime. Resolves the closed ids.
 */
async function closeOnRemote(sessions, remote = remoteConfig()) {
  const script = sessions.map((s) => {
    const f = `"$HOME/.claude/sessions/${Number(s.pid)}.json"`;
    const clients = s.tmux ? `[ "$(tmux display -p -t ${q(`=${s.tmux}:`)} '#{session_attached}' 2>/dev/null || echo 0)" = 0 ] && ` : '';
    return `grep -q ${q(`"sessionId":"${s.sessionId}"`)} ${f} && grep -q '"status":"idle"' ${f} && ${clients}kill -TERM ${Number(s.pid)} && echo ${q(s.sessionId)}`;
  }).join('\n');
  const r = await sshScript(remote.host, script, 30_000);
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/** One tick: read the plan, close and ask. Readings come from the caller's remote probe and tab map. */
export async function closeTablessRemote({ remote, tabs, notify = () => {}, say = () => {}, file = path.join(stateDir(), 'remote-tabless.json'), now = Date.now(), close = closeOnRemote }) {
  if (!remote?.configured || !remote.reachable || remote.stale) return [];
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const plan = tablessPlan({ sessions: remote.sessions ?? [], tabs, state, now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan.next));
  const label = (s) => s.name ?? s.sessionId.slice(0, 8);
  for (const s of plan.ask) notify(`${label(s)} on ${remote.label} has no tab and runs only background jobs; attach it or close it`);
  if (!plan.close.length) return [];
  const closed = await close(plan.close);
  const names = plan.close.filter((s) => closed.has(s.sessionId)).map(label);
  if (names.length) {
    say(`closed on ${remote.label}, no tab and idle ${GRACE_MS / 60_000} min: ${names.join(', ')}`);
    notify(`Closed ${names.length} chat${names.length === 1 ? '' : 's'} on ${remote.label} with no tab, idle 10+ minutes: ${names.join(', ')}`);
  }
  return names;
}
