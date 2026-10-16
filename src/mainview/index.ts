/**
 * Renderer.
 *
 * Holds no knowledge of the filesystem. Every fact on screen arrives over RPC
 * from the main process, which in turn is a thin pass-through to src/core.
 *
 * The list is grouped into what needs you, what is running, and what has
 * stopped. Rows are keyed by session and updated in place, and a refresh that
 * changes nothing on screen draws nothing.
 */

import { Electroview } from 'electrobun/view';
import { md } from '../core/markdown.js';

/**
 * In a plain browser (the design harness, test/harness/) there is no host.
 * `window.__csrMock` then stands in for the overview, so the view can be
 * rendered, screenshotted and inspected outside the app.
 */
const mock = (window as any).__csrMock as Record<string, unknown> | undefined;

let electroview: Electroview<any> | null = null;
if (!mock) {
  electroview = new Electroview({
    rpc: Electroview.defineRPC({
      // A first scan of thousands of chats can take seconds; the default 1 s
      // request timeout rejected every call and the window rendered nothing.
      // A move syncs the project first; a big folder takes minutes, and a
      // timed-out request left the window silent while the move went on.
      maxRequestTime: 600_000,
      handlers: { requests: {}, messages: {} },
    }),
  });
}

const call = (name: string, payload: unknown = {}) => {
  if (mock) {
    // The harness may supply canned replies for other requests too.
    const canned = (mock as any).__rpc?.[name];
    return Promise.resolve(name === 'overview' ? mock : canned ?? { ok: false, error: 'not available in the harness' });
  }
  return (electroview!.rpc as any).request[name](payload);
};

const $ = (id: string) => document.getElementById(id)!;

type Machine = 'mac' | 'remote' | null;
type Session = {
  sessionId: string; projectDir: string | null; cwd: string | null; name: string; nameSource: string;
  bytes: number; subagentBytes: number; modifiedAt: number;
  chainPart?: number; chainSize?: number;
  model: string | null; modelShort: string | null; effort: string | null;
  live: boolean; pid: number | null; status: string | null; transcriptMissing?: boolean;
  machine: Machine; lastMachine: Machine; lastLine: string | null; needsYou: boolean;
  contextPct: number | null; permission: string | null; permissionMode?: string | null; rssMb: number | null;
  family?: string; parentSessionId?: string | null;
  stoppedOn?: { kind: 'limit' | 'error'; text: string; at: string | null } | null; quietMin?: number | null;
  sameNameCount?: number; sameNameRank?: number; sameNamePrimaryId?: string;
  sameNameRole?: 'running' | 'latest' | 'also-running' | 'part' | 'branch' | 'older';
};
type Project = {
  label: string; cwd: string | null; projectDir: string;
  bytes: number; liveCount: number; sessionCount: number; sessions: Session[];
  depth: number; parent: string | null;
  allSessions: Session[]; allBytes: number; allLiveCount: number;
};
/** The optional second machine, as config.json names it. Unconfigured means every remote control is hidden. */
type Remote = {
  configured: boolean; label: string | null; localProjectsRoot: string | null;
  reachable: boolean; stale: boolean; checkedAt: number | null; lastReachableAt: number | null;
  memTotalMb: number | null; memAvailableMb: number | null; liveCount: number; error: string | null;
  load: Load | null; health: Health;
};
type Mac = Load & { health?: Health };
type Usage = { slot: number; active: boolean; stale: boolean; failing: boolean;
  fiveHour: { pct: number; resetsAt: string | null } | null; sevenDay: { pct: number; resetsAt: string | null } | null };
type Agent = { id: string; name: string; cwd: string | null; sessionId: string | null; needs: string | null; detail: string | null;
  suggestedReply: string | null; updatedAt: number | null; stale: boolean };
type State = { home: string; projects: Project[]; totals: any; restore: any; recorder: any; remote: Remote; mac: Mac;
  accounts: { available: boolean }; usage: Usage[]; background: Agent[]; autoTasks: any; persistence: any; configErrors: string[] };

/** What the list shows. A view is a filter; a project is a scope. */
type View = { kind: 'all' | 'needs' | 'running' | 'stopped' | 'machine' | 'project' | 'family'; value?: string; scope?: string };

let state: State | null = null;
let view: View = { kind: 'all' };
let lastFingerprint = '';
const rowEls = new Map<string, HTMLElement>();
const sessionById = new Map<string, Session>();

/**
 * Dismissals are keyed by scope AND by the offer itself, so dismissing one
 * offer does not silence every future one in that folder.
 */
const dismissed = new Set<string>();
const offerKey = (scope: string, sessions: Session[]) =>
  `${scope}::${sessions.map((s) => s.sessionId).sort().join(',')}`;

type SortMode = 'recent' | 'name';
const storedSort = localStorage.getItem('switchboard.sort');
let sortMode: SortMode = storedSort === 'name' ? 'name' : 'recent';

/** Which sidebar groups are open, kept across launches. Storage can be unavailable; then nothing is remembered. */
const navOpen = new Set<string>((() => { try { return JSON.parse(localStorage.getItem('switchboard.nav.open') ?? '[]'); } catch { return []; } })());
/** Groups closed by hand; they stay closed even while they hold the current view. */
const navClosed = new Set<string>();
const saveNavOpen = () => { try { localStorage.setItem('switchboard.nav.open', JSON.stringify([...navOpen])); } catch { /* not remembered */ } };
/** Same-name groups unfolded in the list, keyed by the primary chat's id. */
const unfolded = new Set<string>();
/** Model and effort shared by most listed chats; rows show theirs only when it differs. */
let commonModel = '';

/* ---------- formatting ---------- */

const mb = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
};
const gb = (mbs: number | null) => (mbs === null ? '' : `${(mbs / 1024).toFixed(1)} GB`);
const n = (value: number) => value.toLocaleString();

const ago = (ts: number | null) => {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const shortPath = (p: string | null) => {
  const home = state?.home;
  const v = p ?? '';
  return home && (v === home || v.startsWith(`${home}/`)) ? `~${v.slice(home.length)}` : v;
};
const baseName = (p: string | null) => (p ?? '').split('/').filter(Boolean).pop() ?? '';

function escapeHtml(value: string) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/* ---------- toast ---------- */

let toastTimer: number | undefined;
function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

/* ---------- derived ---------- */

const allSessions = () => state!.projects.flatMap((p) => p.sessions);

/** The remote machine's name on screen, from config.json. */
const R = () => state?.remote?.label ?? 'Remote';
const hasRemote = () => Boolean(state?.remote?.configured);
const machineName = (m: Machine) => (m === 'remote' ? R() : m === 'mac' ? 'Mac' : '');

/** A remote chat while the remote is not answering: its state is a memory, not a reading. */
const remoteDown = (s: Session) => s.machine === 'remote' && !state!.remote.reachable;

function stateWord(s: Session) {
  if (!s.live) return 'Stopped';
  if (s.stoppedOn) return s.stoppedOn.kind === 'limit' ? 'Limit hit' : 'Stopped on error';
  if (remoteDown(s)) return state!.remote.lastReachableAt ? `Seen ${ago(state!.remote.lastReachableAt)} ago` : `${R()} offline`;
  if (s.needsYou) return 'Needs you';
  switch (s.status) {
    case 'busy': case 'shell': return s.quietMin ? `Quiet ${s.quietMin} min` : 'Working';
    case 'idle': return 'Idle';
    default: return 'Running';
  }
}

function inView(s: Session) {
  switch (view.kind) {
    case 'all': return true;
    case 'needs': return s.needsYou;
    case 'running': return s.live;
    case 'stopped': return !s.live;
    case 'machine': return s.live ? s.machine === view.value : s.lastMachine === view.value;
    case 'project': {
      const project = state!.projects.find((p) => p.label === view.value);
      return Boolean(project?.allSessions.some((x) => x.sessionId === s.sessionId));
    }
    case 'family': {
      if (s.family !== view.value) return false;
      // A family clicked under a project means its chats in that project.
      const project = view.scope ? state!.projects.find((p) => p.label === view.scope) : null;
      // Its own chats, as the tree line counts them; subprojects list theirs under themselves.
      return !project || project.sessions.some((x) => x.sessionId === s.sessionId);
    }
  }
}

function sortSessions(list: Session[]) {
  const sorted = [...list];
  if (sortMode === 'name') {
    sorted.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base', numeric: true }));
  } else {
    sorted.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
  return sorted;
}

function viewTitle() {
  switch (view.kind) {
    case 'all': return 'All chats';
    case 'needs': return 'Needs you';
    case 'running': return 'Running';
    case 'stopped': return 'Stopped';
    case 'machine': return view.value === 'remote' ? `On ${R()}` : 'On the Mac';
    case 'project': return shortPath(view.value!);
    case 'family': return view.scope ? `${view.value} chats in ${baseName(view.scope)}` : `${view.value} chats`;
  }
}

/* ---------- titlebar ---------- */

function renderTop() {
  const rec = state!.recorder ?? {};
  const el = $('recorder');
  const action = $('recorder-action') as HTMLButtonElement;
  el.dataset.state = rec.armed ? 'armed' : 'off';
  $('recorder-label').textContent = rec.armed ? 'Recorder on' : (rec.problem ? 'Recorder broken' : 'Recorder off');
  el.title = rec.problem ?? (rec.armed ? 'Capturing what is open, so a shutdown can be undone.' : 'Nothing is recording what is open.');
  action.textContent = rec.problem ? 'Repair' : 'Arm';
  action.hidden = Boolean(rec.armed);
}

/* ---------- machine cards ---------- */

type Load = { totalMb: number | null; usedMb: number | null; swapTotalMb: number | null; swapUsedMb: number | null;
  swapInMbPerMin?: number | null; swapOutMbPerMin: number | null; pressure: string | null; load1: number | null;
  cores: number | null; tempC: number | null; diskFreeMb?: number | null; swapDynamic?: boolean; psiMem60?: number | null };
type Health = { level: 'ok' | 'strained' | 'critical' | 'unknown'; reasons: string[]; usedPct?: number };

const HEALTH_WORD = { ok: 'Healthy', strained: 'Strained', critical: 'Critical', unknown: 'No reading' } as const;

/** One figure on the strip: a muted label and a value, warm only when it is the reason for strain. */
const metric = (label: string, value: string, warn = '') =>
  value ? `<span class="m"><span class="m-k">${label}</span><span class="m-v"${warn ? ` data-warn="${warn}"` : ''}>${value}</span></span>` : '';

function swapText(load: Load) {
  const used = load.swapUsedMb ?? 0;
  const rate = Math.max(load.swapOutMbPerMin ?? 0, load.swapInMbPerMin ?? 0);
  const amount = used < 100 ? 'none' : gb(used);
  // macOS adds swap files as it needs them, so "of 12 GB" is no ceiling; free disk is.
  const ceiling = load.swapDynamic ? '' : ` of ${gb(load.swapTotalMb)}`;
  const trend = load.swapOutMbPerMin === null && load.swapInMbPerMin == null ? ''
    : rate >= 1 ? `, moving ${Math.round(rate)} MB/min` : ', steady';
  return `${amount}${used < 100 ? '' : ceiling}${trend}`;
}

function mcard(machine: 'mac' | 'remote', label: string, load: Load | null, h: Health, running: number, down: boolean, action: string) {
  const level = down ? 'unknown' : h.level;
  const why = down ? 'Not answering over ssh' : h.reasons.length ? h.reasons.join(', ') : 'Nothing is under strain';
  const has = (word: string) => (h.reasons.some((r) => r.includes(word)) ? (level === 'critical' ? 'crit' : 'warn') : '');
  const usedPct = load?.usedMb != null && load.totalMb ? Math.round((load.usedMb / load.totalMb) * 100) : null;
  const bar = usedPct === null ? '' : `<span class="m"><span class="m-k">Memory</span>
      <span class="m-bar" data-level="${usedPct >= 90 ? 'crit' : usedPct >= 80 ? 'warn' : ''}" role="meter" aria-label="${label} memory used" aria-valuenow="${usedPct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${usedPct}%"></i></span>
      <span class="m-v" title="${gb(load!.usedMb)} of ${gb(load!.totalMb)} in use (app, wired and compressed)"${has('memory') ? ` data-warn="${has('memory')}"` : ''}>${usedPct}%</span></span>`;
  const figures = !load || down ? `<span class="m"><span class="m-k">${down ? 'Last seen' : 'No reading'}</span><span class="m-v">${down && state!.remote.lastReachableAt ? `${ago(state!.remote.lastReachableAt)} ago` : ''}</span></span>` : [
    bar,
    metric('Swap', swapText(load), has('swapping')),
    load.load1 !== null && load.cores ? metric('Load', `${load.load1.toFixed(1)} / ${load.cores}`, has('load')) : '',
    load.tempC ? metric('CPU', `${load.tempC} °C`, has('CPU')) : '',
    load.diskFreeMb ? metric('Disk free', gb(load.diskFreeMb)) : '',
  ].join('');
  const current = view.kind === 'machine' && view.value === machine;
  return `<div class="mcard" data-machine="${machine}" data-health="${level}">
    <div class="mcard-head">
      <button class="mcard-name" type="button" data-filter="${machine}" aria-pressed="${current}" title="Show only chats on ${machine === 'mac' ? 'the Mac' : escapeHtml(label)}">${escapeHtml(label)}</button>
      <span class="health" data-level="${level}" title="${escapeHtml(why)}">${HEALTH_WORD[level]}</span>
      <span class="mcard-count">${down ? '' : `${running} running`}</span>
      <span class="mcard-action">${action}</span>
    </div>
    <div class="mcard-figures">${figures}</div>
  </div>`;
}

function renderMachines() {
  const t = state!.totals; const d = state!.remote; const m = state!.mac;
  const strained = m.health?.level === 'strained' || m.health?.level === 'critical';
  const auto = (state as any).autoBalance ?? { enabled: false };
  const lastAuto = auto.last?.moved ? `last moved ${escapeHtml(auto.last.moved)}` : auto.last?.wait ?? '';
  const balance = `<label class="auto-toggle" title="Each recorder tick may move one chat that has been idle ${auto.idleMin ?? 20}+ minutes from a strained Mac to a healthy ${escapeHtml(R())}. It reopens in its own tab and you get a notification.${lastAuto ? ` Now: ${lastAuto}.` : ''}"><input type="checkbox" id="auto-balance"${auto.enabled ? ' checked' : ''}> Auto</label>
    ${d.reachable ? `<button class="btn${strained ? ' btn-primary' : ''}" id="do-balance" type="button" title="Move idle Mac chats to ${escapeHtml(R())} while the Mac is strained">Balance to ${escapeHtml(R())}</button>` : ''}`;
  $('machines').dataset.count = d.configured ? '2' : '1';
  $('machines').innerHTML = mcard('mac', 'Mac', { ...m, swapDynamic: true }, m.health ?? { level: 'unknown', reasons: [] }, t.liveMac, false, d.configured ? balance : '')
    + (d.configured ? mcard('remote', R(), d.load, d.health ?? { level: 'unknown', reasons: [] }, t.liveRemote, !d.reachable, '') : '');
  $('machines').querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) => {
    const machine = b.dataset.filter!;
    b.onclick = () => setView(view.kind === 'machine' && view.value === machine ? { kind: 'all' } : { kind: 'machine', value: machine });
  });
  const toggle = document.getElementById('auto-balance') as HTMLInputElement | null;
  if (toggle) toggle.onchange = async () => {
    const r = await call('setAutoBalance', { enabled: toggle.checked });
    toast(r.ok ? (toggle.checked ? `Auto-balance is on. Idle chats move to ${R()} while the Mac is strained.` : 'Auto-balance is off.') : r.error, r.ok ? 'ok' : 'error');
    lastFingerprint = ''; await refresh();
  };
  const b = document.getElementById('do-balance') as HTMLButtonElement | null;
  if (b) b.onclick = async () => {
    b.disabled = true; b.textContent = 'Balancing…';
    const r = await call('balance', { max: 5 });
    if (!r.ok) toast(r.error, 'error');
    else if (r.note) toast(`Nothing to move: ${r.note}.`);
    else if (!r.moved.length) toast(r.skipped.length ? `Nothing moved: ${r.skipped[0].error}` : 'Nothing to move: every Mac chat is working or waiting on you.');
    else toast(`Moved ${r.moved.map((x: any) => x.name).join(', ')} to ${R()}. Mac is now ${HEALTH_WORD[r.mac.level as Health['level']].toLowerCase()}.`);
    lastFingerprint = ''; await refresh();
  };
  for (const card of document.querySelectorAll<HTMLElement>('.mcard')) {
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('is-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('is-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('is-over');
      const scope = e.dataTransfer?.getData('text/scope');
      if (scope) {
        if (card.dataset.machine !== 'remote') { toast(`Groups move to ${R()}; drop them on its card.`); return; }
        const { kind, value, scope: within } = JSON.parse(scope) as { kind: 'project' | 'family'; value: string; scope?: string };
        const project = state!.projects.find((p) => p.label === (kind === 'project' ? value : within));
        const members = kind === 'family' ? (project?.allSessions ?? allSessions()).filter((s) => s.family === value) : project?.allSessions ?? [];
        const list = members.filter(movable);
        const label = kind === 'family' ? value : shortPath(value);
        if (!list.length) toast(`Nothing in ${label} to move: none of its chats is open and idle on the Mac.`);
        else confirmBox(`Move ${list.length} idle chat${list.length === 1 ? '' : 's'} from ${label} to ${R()}?`, `Each one closes here and reopens in its own VSCode terminal, running on ${R()}.`, () => batchToRemote(list), 'Move them');
        return;
      }
      const id = e.dataTransfer?.getData('text/session-id');
      const s = id ? sessionById.get(id) : null;
      if (s) moveFlow(s, card.dataset.machine as 'mac' | 'remote');
    });
  }
}

/* ---------- moving ---------- */

async function moveFlow(s: Session, target: 'mac' | 'remote', force = false, confirmed = false) {
  if (!hasRemote()) return;
  if (target === 'mac') {
    if (s.machine !== 'remote' && s.lastMachine !== 'remote') { toast(`${s.name} is already on the Mac.`); return; }
    if (!confirmed) {
      confirmBox(`Move ${s.name} back to the Mac?`, `It closes on ${R()}, its transcript and project folder come back now, and it reopens in its VSCode terminal here.`, () => moveFlow(s, target, false, true), 'Move it', 'Cancel');
      return;
    }
    toast(`Moving ${s.name} to the Mac…`);
    const r = await call('moveToLocal', { sessionId: s.sessionId });
    toast(r.ok && r.verified !== false ? `${s.name} is running on the Mac${r.reused ? ', in the same terminal' : ''}.` : r.error, r.ok && r.verified !== false ? 'ok' : 'error');
    lastFingerprint = ''; await refresh();
    return;
  }
  if (s.machine === 'remote') { toast(`${s.name} is already on ${R()}.`); return; }
  if (!state!.remote.reachable) { toast(`${R()} is unreachable.`, 'error'); return; }
  // A live chat is closed here first; one keystroke or drop must not do that unasked.
  if (s.live && !confirmed && !force) {
    confirmBox(`Move ${s.name} to ${R()}?`, `It closes here, its project folder and transcript are copied over, and it reopens in the same VSCode terminal, running on ${R()}.`, () => moveFlow(s, target, false, true), 'Move it', 'Cancel');
    return;
  }
  toast(`Moving ${s.name} to ${R()}…`);
  const r = s.live ? await call('moveLive', { sessionId: s.sessionId, force }) : await call('moveToRemote', { sessionId: s.sessionId });
  if (r.busy) { confirmBox(`${s.name} is working right now.`, `Interrupt it and move it to ${R()}?`, () => moveFlow(s, target, true, true)); return; }
  if (!r.ok) { toast(r.error, 'error'); return; }
  const where = r.reopened?.ok ? (r.reopened.reused ? ', back in the same VSCode terminal' : ', open in a VSCode terminal') : '';
  if (r.verified === false) toast(r.error, 'error');
  else if (r.reopened && !r.reopened.ok) toast(`${s.name} is running on ${R()}. ${r.reopened.error}`, 'error');
  else toast(`${s.name} is running on ${R()}${where}.`, 'ok');
  lastFingerprint = ''; await refresh();
  const moved = sessionById.get(s.sessionId); if (moved) openDetail(moved);
}

function confirmBox(title: string, question: string, onYes: () => void, yes = 'Interrupt and move', no = 'Keep it running') {
  closePopover();
  const pop = document.createElement('div');
  pop.id = 'popover'; pop.className = 'popover'; pop.setAttribute('role', 'alertdialog');
  pop.style.left = `${window.innerWidth / 2 - 160}px`; pop.style.top = `${window.innerHeight / 2 - 60}px`;
  pop.innerHTML = `<div class="pop-title">${escapeHtml(title)}</div><div class="pop-hint">${escapeHtml(question)}</div>
    <div class="pop-row"><button class="btn btn-ghost" id="pop-no" type="button">${escapeHtml(no)}</button><button class="btn btn-primary" id="pop-yes" type="button">${escapeHtml(yes)}</button></div>`;
  document.body.appendChild(pop);
  (pop.querySelector('#pop-no') as HTMLButtonElement).onclick = closePopover;
  (pop.querySelector('#pop-yes') as HTMLButtonElement).onclick = () => { closePopover(); onYes(); };
  (pop.querySelector('#pop-yes') as HTMLButtonElement).focus();
}

/* ---------- detail panel ---------- */

let selectedId: string | null = null;
let peekTimer: number | undefined;

function closeDetail() {
  selectedId = null;
  window.clearInterval(peekTimer);
  $('detail').hidden = true;
  document.querySelectorAll('.row.is-selected').forEach((r) => r.classList.remove('is-selected'));
}

async function openDetail(s: Session) {
  selectedId = s.sessionId;
  window.clearInterval(peekTimer);
  document.querySelectorAll('.row.is-selected').forEach((r) => r.classList.remove('is-selected'));
  rowEls.get(s.sessionId)?.classList.add('is-selected');
  const d = $('detail');
  d.hidden = false;
  const machine = s.machine ?? s.lastMachine;
  const reachable = s.live && !remoteDown(s);
  const working = s.status === 'busy' || s.status === 'shell';
  const level = s.needsYou ? 'needs' : working ? 'busy' : s.live ? 'live' : 'stopped';
  const meta = [
    `<span class="d-state" data-level="${level}">${escapeHtml(stateWord(s))}</span>`,
    machine ? `<span>${escapeHtml(machineName(machine))}</span>` : '',
    s.modelShort ? `<span>${escapeHtml(s.modelShort)}${s.effort ? ` ${escapeHtml(s.effort)}` : ''}</span>` : '',
    s.permission ? `<span>${escapeHtml(s.permission)}</span>` : '',
  ].filter(Boolean).join('');
  const actions = [
    reachable && s.stoppedOn ? `<button class="btn btn-primary" data-act="continue" type="button">Continue</button>` : '',
    reachable ? `<button class="btn" data-act="more" type="button">Settings</button>` : '',
    reachable && working ? `<button class="btn" data-act="interrupt" type="button">Interrupt</button>` : '',
    reachable && s.machine === 'remote' ? `<button class="btn" data-act="attach" type="button">Attach</button><button class="btn" data-act="tomac" type="button">Move to Mac</button>` : '',
    s.live && s.machine === 'mac' ? `<button class="btn" data-act="open" type="button">Open</button>` : '',
    s.machine !== 'remote' && hasRemote() && state!.remote.reachable ? `<button class="btn" data-act="move" type="button">Move to ${escapeHtml(R())}</button>` : '',
    !s.live ? `<button class="btn" data-act="delete" type="button">Delete</button>` : '',
  ].join('');
  const fact = (k: string, v: string) => (v ? `<span class="m"><span class="m-k">${k}</span><span class="m-v">${v}</span></span>` : '');
  const ctx = s.contextPct == null ? '' : `<span class="m"><span class="m-k">Context</span><span class="m-bar" data-level="${s.contextPct >= 85 ? 'crit' : s.contextPct >= 60 ? 'warn' : ''}"><i style="width:${s.contextPct}%"></i></span><span class="m-v">${s.contextPct}%</span></span>`;
  d.innerHTML = `
    <header class="d-head">
      <div class="d-title"><div class="d-name">${escapeHtml(s.name)}</div><div class="d-meta">${meta}</div><div class="d-sub" title="${escapeHtml(s.cwd ?? '')}">${escapeHtml(shortPath(s.cwd))}</div></div>
      <button class="d-close" type="button" aria-label="Close details">&#x2715;</button>
    </header>
    ${s.live && s.stoppedOn ? `<p class="d-stop" data-kind="${s.stoppedOn.kind}">${s.stoppedOn.kind === 'limit' ? 'It stopped on a usage limit' : 'It stopped on an API error'}: ${escapeHtml(s.stoppedOn.text)}. ${s.stoppedOn.kind === 'limit' ? 'Wait for the reset or switch accounts, then Continue.' : 'Continue retries.'}</p>` : ''}
    ${s.quietMin ? `<p class="d-note">No new output for ${s.quietMin} minutes while working. A long command does this; if it should not, interrupt it.</p>` : ''}
    ${remoteDown(s) ? `<p class="d-offline">${escapeHtml(R())} is not answering, so this chat cannot be reached from here. What you see is from when it was last seen.</p>` : ''}
    ${actions ? `<div class="d-actions">${actions}</div>` : ''}
    ${reachable ? `<form class="d-reply" id="d-reply"><textarea id="d-reply-text" rows="2" placeholder="Reply to ${escapeHtml(s.name)}. Enter sends, Shift+Enter adds a line."${working ? ' disabled' : ''}></textarea><button class="btn btn-primary" type="submit"${working ? ' disabled' : ''}>Send</button></form>${working ? '<p class="d-note">It is working; you can reply once it stops, or interrupt it.</p>' : ''}` : ''}
    ${s.live && s.machine === 'remote' && !remoteDown(s) ? `<section class="d-section"><div class="d-label"><span>Live screen</span><span class="d-live">every 2 s</span></div><pre class="d-screen" id="d-screen">Reading…</pre></section>` : ''}
    <section class="d-section"><div class="d-label"><span>${s.live && s.machine === 'remote' ? 'Last reply before the move' : 'Last reply'}</span><span id="d-last-at"></span></div><div class="d-msg md" id="d-msg">Loading…</div></section>
    <section class="d-facts">${ctx}${fact('Memory', s.live && s.rssMb != null ? `${s.rssMb} MB` : '')}${fact('Transcript', s.transcriptMissing ? `on ${escapeHtml(R())}` : mb(s.bytes + s.subagentBytes))}${fact('Last used', ago(s.modifiedAt))}</section>
    ${sameNameSection(s)}
    `;
  (d.querySelector('.d-close') as HTMLButtonElement).onclick = closeDetail;
  d.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
    const copy = allSessions().find((x) => x.sessionId === b.dataset.copy);
    if (!copy) return;
    b.onclick = () => (b.dataset.do === 'delete' ? openSheet(copy) : openDetail(copy));
  });
  d.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => { b.onclick = () => detailAction(s, b.dataset.act!, b); });
  const form = d.querySelector<HTMLFormElement>('#d-reply');
  if (form) {
    const box = form.querySelector('textarea')!;
    const send = async () => {
      const value = box.value.trim();
      if (!value) return;
      box.disabled = true;
      if (await control(s, 'reply', value, `Sent to ${s.name}.`)) box.value = '';
      box.disabled = false;
    };
    form.onsubmit = (e) => { e.preventDefault(); send(); };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  if (!s.transcriptMissing) {
    const r = await call('lastMessage', { sessionId: s.sessionId, projectDir: s.projectDir });
    if (selectedId !== s.sessionId) return;
    $('d-msg').innerHTML = r.text ? md(r.text) : '<p class="muted">No reply recorded.</p>';
    $('d-last-at').textContent = r.at ? new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  } else {
    $('d-msg').innerHTML = `<p class="muted">The transcript is on ${escapeHtml(R())}. It comes back here when the chat moves back.</p>`;
  }
  if (s.live && s.machine === 'remote' && !remoteDown(s)) {
    const peek = async () => {
      const r = await call('peek', { name: s.name });
      if (selectedId !== s.sessionId) return;
      const el = document.getElementById('d-screen');
      if (!el) return;
      el.textContent = r.ok ? r.text.replace(/^\s*\n/, '').replace(/\s+$/, '') : `Could not read the screen: ${r.error}`;
      el.scrollTop = el.scrollHeight;
    };
    peek();
    peekTimer = window.setInterval(peek, 2000);
  }
}

async function attach(s: Session) {
  toast(`Opening ${s.name} in a VSCode terminal…`);
  const r = await call('attach', { name: s.name, cwd: s.cwd });
  toast(r.ok ? `${s.name} is open in VSCode${r.folder ? ` (${shortPath(r.folder)})` : ''}.` : r.error, r.ok ? 'ok' : 'error');
}

/** Every chat sharing this one's name, with what each one is, and Delete on the stopped ones. */
function sameNameSection(s: Session) {
  if (!s.sameNameCount) return '';
  const copies = allSessions().filter((x) => x.sameNamePrimaryId === s.sameNamePrimaryId)
    .sort((a, b) => (a.sameNameRank ?? 0) - (b.sameNameRank ?? 0));
  const role = (x: Session) => (x.sameNameRole === 'part' ? `part ${x.chainPart} of ${x.chainSize}` : ROLE_WORD[x.sameNameRole ?? ''] ?? '');
  const rows = copies.map((x) => `<div class="d-copy${x.sessionId === s.sessionId ? ' is-this' : ''}">
      <span class="role" data-role="${x.sameNameRole}">${escapeHtml(role(x))}</span>
      <span class="d-copy-meta">${escapeHtml(stateWord(x))}${x.machine || x.lastMachine ? ` on ${escapeHtml(machineName(x.machine ?? x.lastMachine))}` : ''}, ${ago(x.modifiedAt)}, ${mb(x.bytes + x.subagentBytes)}, ${escapeHtml(x.sessionId.slice(0, 8))}</span>
      ${x.sessionId === s.sessionId ? '<span class="d-copy-this">this one</span>' : `<button class="btn" type="button" data-copy="${x.sessionId}" data-do="show">Show</button>`}
      ${!x.live && x.sessionId !== s.sessionId ? `<button class="btn" type="button" data-copy="${x.sessionId}" data-do="delete">Delete</button>` : ''}
    </div>`).join('');
  const warn = copies.filter((x) => x.live).length > 1
    ? '<div class="d-warn">Two chats with this name are running. Close one: writing one name from two places forks the transcript.</div>' : '';
  return `<div class="d-section"><div class="d-label"><span>${copies.length} chats named ${escapeHtml(s.name)}</span></div>${warn}${rows}</div>`;
}

async function detailAction(s: Session, act: string, button: HTMLButtonElement) {
  if (act === 'reply' || act === 'more') { openPopover(button, s, act); return; }
  if (act === 'interrupt') { await control(s, 'interrupt', '', `Interrupted ${s.name}.`); return; }
  if (act === 'continue') { await control(s, 'reply', 'continue', `Told ${s.name} to continue.`); return; }
  if (act === 'attach') { attach(s); return; }
  if (act === 'open') { const r = await call('openProject', { cwd: s.cwd }); toast(r.ok ? `Opened ${shortPath(s.cwd)} in VSCode.` : r.error, r.ok ? 'ok' : 'error'); return; }
  if (act === 'move') { moveFlow(s, 'remote'); return; }
  if (act === 'tomac') { moveFlow(s, 'mac'); return; }
  if (act === 'delete') openSheet(s);
}

/* ---------- nav ---------- */

function navItem(label: string, count: string, current: boolean, onClick: () => void, extra: Partial<{ depth: number; title: string; countClass: string }> = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'nav-item';
  b.setAttribute('aria-current', String(current));
  if (extra.depth) b.dataset.depth = String(extra.depth);
  if (extra.title) b.title = extra.title;
  b.innerHTML = `<span class="nav-label">${label}</span><span class="nav-count ${extra.countClass ?? ''}">${count}</span>`;
  b.onclick = onClick;
  return b;
}

/** A disclosure triangle in front of a nav item; null key means nothing to open. */
function withChevron(item: HTMLElement, key: string | null, open = key ? navOpen.has(key) : false) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-line';
  const chev = document.createElement('button');
  chev.type = 'button';
  chev.className = 'nav-chev';
  if (key) {
    chev.setAttribute('aria-expanded', String(open));
    chev.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
    // Toggles what is shown, whichever rule opened it: a group opened because it
    // holds the current view used to reopen on every click.
    chev.onclick = () => {
      if (open) { navOpen.delete(key); navClosed.add(key); } else { navOpen.add(key); navClosed.delete(key); }
      saveNavOpen();
      renderNav();
    };
  } else {
    chev.disabled = true;
    chev.setAttribute('aria-hidden', 'true');
    chev.tabIndex = -1;
  }
  wrap.append(chev, item);
  return wrap;
}

/** "Shop_Crawl" shown under the Shop family as "Crawl". */
const baseNameOf = (name: string, family: string) =>
  (name.toLowerCase().startsWith(`${family.toLowerCase()}_`) ? name.slice(family.length + 1) : name) || name;

/** Status of a group in one mark: amber when a chat needs you, blue when any run, nothing otherwise. */
function groupDot(list: Session[]) {
  const level = list.some((s) => s.needsYou) ? 'needs' : list.some((s) => s.live) ? 'live' : '';
  return `<span class="tdot" data-level="${level}" aria-hidden="true"></span>`;
}

function groupTitle(label: string, list: Session[]) {
  const needs = list.filter((s) => s.needsYou).length;
  const live = list.filter((s) => s.live).length;
  return `${label}\n${n(list.length)} chats${live ? `, ${live} running` : ''}${needs ? `, ${needs} need you` : ''}`;
}

/**
 * The sidebar's one tree: project, then the families inside it, then chats.
 * A project lists its own families and its loose chats (the six most recent,
 * then a "more" line), then its subprojects. Everything opens under a chevron
 * and is remembered; whatever is the current view stays open.
 */
function renderTree(is: (kind: View['kind'], value?: string) => boolean) {
  const host = $('projects');
  host.innerHTML = '';
  const projects = state!.projects.filter((p) => !baseName(p.label).startsWith('.'));
  const byLabel = new Map(projects.map((p) => [p.label, p]));
  const childrenOf = new Map<string, Project[]>();
  for (const p of projects) if (p.parent && byLabel.has(p.parent)) (childrenOf.get(p.parent) ?? childrenOf.set(p.parent, []).get(p.parent)!).push(p);
  const selected = selectedId ? allSessions().find((s) => s.sessionId === selectedId) : null;
  const holdsView = (p: Project) => (view.kind === 'project' && (view.value === p.label || String(view.value).startsWith(`${p.label}/`)))
    || (view.kind === 'family' && (view.scope === p.label || String(view.scope).startsWith(`${p.label}/`)))
    || Boolean(selected && p.allSessions.includes(selected));
  const isOpen = (key: string, current: boolean) => navOpen.has(key) || (current && !navClosed.has(key));

  const line = (depth: number, item: HTMLElement, key: string | null, open = false) => {
    const row = withChevron(item, key, open);
    row.style.setProperty('--depth', String(depth));
    return row;
  };
  const chatLine = (s: Session, depth: number, family?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `nav-chat${s.live ? ' is-live' : ''}${s.needsYou ? ' is-needs' : ''}`;
    b.dataset.machine = s.machine ?? '';
    b.setAttribute('aria-current', String(selectedId === s.sessionId));
    const word = s.needsYou ? 'Needs you' : s.live ? (s.machine === 'remote' ? R() : stateWord(s)) : '';
    b.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="nav-label">${escapeHtml(family ? baseNameOf(s.name, family) : s.name)}</span>${word ? `<span class="nav-state">${escapeHtml(word)}</span>` : ''}`;
    b.title = `${s.name}, ${stateWord(s).toLowerCase()}${s.machine ? ` on ${s.machine === 'remote' ? R() : 'the Mac'}` : ''}`;
    b.onclick = () => { const x = allSessions().find((y) => y.sessionId === s.sessionId); if (x) { sessionById.set(x.sessionId, x); openDetail(x); renderNav(); } };
    const wrap = document.createElement('div');
    wrap.className = 'nav-line';
    wrap.style.setProperty('--depth', String(depth));
    const spacer = document.createElement('span');
    spacer.className = 'nav-chev is-blank';
    spacer.setAttribute('aria-hidden', 'true');
    wrap.append(spacer, b);
    return wrap;
  };

  const place = (p: Project, depth: number) => {
    const own = p.sessions.filter((s) => !s.sameNameRank);
    const families = new Map<string, Session[]>();
    for (const s of own) if (s.family) (families.get(s.family) ?? families.set(s.family, []).get(s.family)!).push(s);
    const loose = sortSessions(own.filter((s) => !s.family || (families.get(s.family)?.length ?? 0) < 2));
    for (const [f, list] of families) if (list.length < 2) families.delete(f);
    const kids = childrenOf.get(p.label) ?? [];
    const key = `p:${p.label}`;
    const open = isOpen(key, holdsView(p));

    const short = shortPath(p.label);
    const segments = p.cwd ? short.split('/').filter(Boolean) : [];
    let base = p.cwd ? escapeHtml(segments.pop() ?? p.label) : 'Unknown folder';
    let parent = p.cwd && depth === 0 && segments.length ? `<span class="nav-parent">${escapeHtml(segments.pop()!)}/</span>` : '';
    if (short.startsWith('~/.claude/')) { parent = '<span class="nav-parent">.claude/</span>'; base = escapeHtml(baseName(p.label)); }
    const item = navItem(`${groupDot(p.allSessions)}${parent}${base}`, n(p.allSessions.length), is('project', p.label),
      () => setView({ kind: 'project', value: p.label }), { title: groupTitle(p.label, p.allSessions) });
    item.draggable = true;
    item.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/scope', JSON.stringify({ kind: 'project', value: p.label })); });
    host.appendChild(line(depth, item, families.size || loose.length || kids.length ? key : null, open));
    if (!open) return;

    for (const [family, list] of [...families].sort((a, b) => Number(b[1].some((s) => s.live)) - Number(a[1].some((s) => s.live)) || a[0].localeCompare(b[0]))) {
      const fkey = `f:${p.label}:${family}`;
      const here = view.kind === 'family' && view.value === family && view.scope === p.label;
      // Counted with folded same-name copies, as the list header counts them.
      const every = p.sessions.filter((s) => s.family === family);
      const fitem = navItem(`${groupDot(every)}${escapeHtml(family)}`, n(every.length), here,
        () => setView({ kind: 'family', value: family, scope: p.label }), { title: `${groupTitle(`${family} chats`, list)}${hasRemote() ? `\nDrag onto the ${R()} card to move the idle ones.` : ''}` });
      fitem.classList.add('is-family');
      fitem.draggable = true;
      fitem.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/scope', JSON.stringify({ kind: 'family', value: family, scope: p.label })); });
      const fopen = isOpen(fkey, here);
      host.appendChild(line(depth + 1, fitem, fkey, fopen));
      if (fopen) {
        for (const s of sortSessions(list)) host.appendChild(chatLine(s, depth + 2, family));
      }
    }
    const shown = loose.slice(0, 6);
    for (const s of shown) host.appendChild(chatLine(s, depth + 1));
    if (loose.length > shown.length) {
      const more = navItem(`<span class="tdot" aria-hidden="true"></span>${n(loose.length - shown.length)} more`, '', false, () => setView({ kind: 'project', value: p.label }));
      more.classList.add('is-more');
      host.appendChild(line(depth + 1, more, null));
    }
    for (const kid of kids) place(kid, depth + 1);
  };
  for (const p of projects.filter((x) => !x.parent || !byLabel.has(x.parent))) place(p, 0);
}

function setView(next: View) {
  view = next;
  renderTop();
  renderMachines();
  renderNav();
  renderOffer();
  renderList();
}

/* ---------- row selection, drag, keyboard ---------- */

$('rows').addEventListener('click', (event) => {
  if ((event.target as HTMLElement).closest('button')) return;
  const row = (event.target as HTMLElement).closest('.row') as HTMLElement | null;
  const s = row ? sessionById.get(row.dataset.id ?? '') : null;
  if (!s) return;
  if (selectedId === s.sessionId) closeDetail(); else openDetail(s);
});
$('rows').addEventListener('dragstart', (event) => {
  const row = (event.target as HTMLElement).closest('.row') as HTMLElement | null;
  if (!row || !event.dataTransfer) return;
  event.dataTransfer.setData('text/session-id', row.dataset.id ?? '');
  event.dataTransfer.effectAllowed = 'move';
  row.classList.add('is-dragging');
});
$('rows').addEventListener('dragend', (event) => {
  (event.target as HTMLElement).closest('.row')?.classList.remove('is-dragging');
});

function visibleRows(): HTMLElement[] { return [...document.querySelectorAll<HTMLElement>('#rows .row')]; }
function moveSelection(delta: number) {
  const rows = visibleRows();
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.id === selectedId);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta))];
  const s = sessionById.get(next.dataset.id ?? '');
  if (s) { openDetail(s); next.scrollIntoView({ block: 'nearest' }); }
}

function renderNav() {
  const t = state!.totals;
  const sessions = allSessions();
  const agentsWaiting = (state!.background ?? []).filter((a) => !a.stale).length;
  const needs = sessions.filter((s) => s.needsYou).length + agentsWaiting;
  const running = sessions.filter((s) => s.live).length;

  const views = $('views');
  views.innerHTML = '';
  const is = (kind: View['kind'], value?: string) => view.kind === kind && view.value === value;
  views.append(
    navItem('All chats', n(t.sessions), is('all'), () => setView({ kind: 'all' })),
    navItem('Needs you', n(needs), is('needs'), () => setView({ kind: 'needs' }), { countClass: needs ? 'needs' : '' }),
    navItem('Running', n(running), is('running'), () => setView({ kind: 'running' }), { countClass: running ? 'live' : '' }),
    navItem('Stopped', n(t.sessions - running), is('stopped'), () => setView({ kind: 'stopped' })),
  );

  renderTree(is);

  const hidden = t.sdkHidden ? `<br>${n(t.sdkHidden)} automated runs hidden` : '';
  // Said out loud when the bundled fonts did not load, so a fallback face is
  // never mistaken for the design.
  const fonts = document.fonts.check('13px Geist') ? '' : '<br>Fonts did not load';
  // A broken config.json falls back to defaults; say so rather than leave the remote missing unexplained.
  const config = (state!.configErrors ?? []).length ? `<br><span class="nav-warn" title="${escapeHtml(state!.configErrors.join('\n'))}">config.json: ${escapeHtml(state!.configErrors[0])}</span>` : '';
  $('nav-foot').innerHTML = `${n(t.sessions)} chats, ${mb(t.bytes)}${hidden}${fonts}${config}`;
}

/* ---------- new chat ---------- */

const ncChoice: Record<string, string> = { model: '', effort: '', permission: '', machine: 'auto' };

function chips(name: string, options: Array<[string, string]>) {
  const host = document.querySelector<HTMLElement>(`#nc-form .pop-opts[data-name="${name}"]`)!;
  host.setAttribute('role', 'radiogroup');
  host.innerHTML = options.map(([v, label]) => `<button class="pop-opt" type="button" role="radio" data-value="${v}" aria-checked="${ncChoice[name] === v}">${label}</button>`).join('');
  host.querySelectorAll<HTMLButtonElement>('.pop-opt').forEach((b) => {
    b.onclick = () => { ncChoice[name] = b.dataset.value!; host.querySelectorAll('.pop-opt').forEach((x) => x.setAttribute('aria-checked', String(x === b))); ncHint(); };
  });
}

function ncHint() {
  const cwd = ($('nc-cwd') as HTMLSelectElement).value;
  // The same rule as api.js isRemoteProject: a project inside the folder that maps to the remote.
  const root = state!.remote.localProjectsRoot ?? '';
  const remoteOk = hasRemote() && state!.remote.reachable && Boolean(root) && cwd.startsWith(`${root}/`) && !cwd.includes('/.');
  const strained = state!.mac.health?.level && state!.mac.health.level !== 'ok';
  const auto = remoteOk && strained && state!.remote.health?.level === 'ok' ? `${R()}, since the Mac is strained` : 'this Mac';
  const account = ($('nc-account') as HTMLSelectElement).value;
  $('nc-hint').textContent = hasRemote() && ncChoice.machine === 'auto' ? `Auto picks ${auto} right now.` : '';
  $('nc-note').textContent = ncChoice.machine === 'remote' && !remoteOk ? `${R()} takes chats in a project inside ${shortPath(root)}.` : account && ncChoice.machine === 'remote' ? `An account applies to Mac chats; ${R()} has its own login.` : '';
}

function openNewChat() {
  const projects = state!.projects.filter((p) => p.cwd && !baseName(p.label).startsWith('.'));
  const current = view.kind === 'project' ? view.value : view.kind === 'family' ? view.scope : null;
  ($('nc-cwd') as HTMLSelectElement).innerHTML = projects.map((p) => `<option value="${escapeHtml(p.cwd!)}"${p.cwd === current ? ' selected' : ''}>${escapeHtml(shortPath(p.cwd))}</option>`).join('');
  const usage = state!.usage ?? [];
  const active = usage.find((u) => u.active);
  ($('nc-account') as HTMLSelectElement).innerHTML = `<option value="">This Mac's account${active ? ` (${active.slot})` : ''}</option>`
    + usage.map((u) => `<option value="${u.slot}">Account ${u.slot}${u.fiveHour ? `, ${u.fiveHour.pct}% of 5h` : ''}</option>`).join('');
  // Without claude-swap there is one account; without a remote, one machine.
  $('nc-account-field').hidden = !state!.accounts?.available;
  $('nc-machine-field').hidden = !hasRemote();
  if (!hasRemote()) ncChoice.machine = 'mac';
  chips('model', [['', 'default'], ...MODELS.map((m) => [m, m] as [string, string])]);
  chips('effort', [['', 'default'], ...EFFORTS.map((e) => [e, e] as [string, string])]);
  chips('permission', [['', 'default'], ...PERMISSIONS]);
  chips('machine', [['auto', 'auto'], ['mac', 'Mac'], ['remote', escapeHtml(R())]]);
  ($('nc-cwd') as HTMLSelectElement).onchange = ncHint;
  ($('nc-account') as HTMLSelectElement).onchange = ncHint;
  ncHint();
  $('nc-scrim').hidden = false;
  ($('nc-name') as HTMLInputElement).focus();
}

$('new-chat').onclick = openNewChat;
$('nc-cancel').onclick = () => { $('nc-scrim').hidden = true; };
$('nc-scrim').addEventListener('mousedown', (e) => { if (e.target === $('nc-scrim')) $('nc-scrim').hidden = true; });
($('nc-form') as HTMLFormElement).onsubmit = async (e) => {
  e.preventDefault();
  const go = $('nc-go') as HTMLButtonElement;
  go.disabled = true; go.textContent = 'Starting…';
  const r = await call('newChat', {
    cwd: ($('nc-cwd') as HTMLSelectElement).value, name: ($('nc-name') as HTMLInputElement).value.trim(),
    model: ncChoice.model, effort: ncChoice.effort, permission: ncChoice.permission,
    account: ($('nc-account') as HTMLSelectElement).value || null, machine: ncChoice.machine,
  });
  go.disabled = false; go.textContent = 'Start';
  if (!r.ok) { toast(r.error, 'error'); return; }
  $('nc-scrim').hidden = true;
  toast(`Started on ${r.machine === 'remote' ? R() : 'the Mac'}${r.why ? `, since ${r.why}` : ''}. It is open in a VSCode terminal.`);
  lastFingerprint = ''; window.setTimeout(refresh, 4000);
};

/* ---------- tabs and accounts ---------- */

type Window5 = { pct: number; resetsAt: string | null } | null;
type Account = { number: number; email: string | null; org: string | null; active: boolean; status: string | null;
  fiveHour: Window5; sevenDay: Window5; models: Array<{ name: string; pct: number; resetsAt: string | null }>;
  loginExpiresAt: string | null; ageSeconds: number | null };
let accountsData: { ok: boolean; accounts: Account[]; mostRoom: number | null; error?: string } | null = null;

function setTab(next: 'chats' | 'accounts') {
  $('tab-chats').setAttribute('aria-selected', String(next === 'chats'));
  $('tab-accounts').setAttribute('aria-selected', String(next === 'accounts'));
  $('shell').hidden = next !== 'chats';
  $('accounts-page').hidden = next !== 'accounts';
  if (next === 'accounts') loadAccounts();
}
$('tab-chats').onclick = () => setTab('chats');
$('tab-accounts').onclick = () => setTab('accounts');
$('acct-pill').onclick = () => setTab('accounts');
$('ap-refresh').onclick = () => loadAccounts();

async function loadAccounts() {
  if (!accountsData) $('ap-grid').innerHTML = '<div class="empty">Reading claude-swap…</div>';
  accountsData = await call('accounts');
  renderAccountsPage();
}

/**
 * The account in use and its 5-hour use, from the usage cache the overview
 * already carries. Without claude-swap the Accounts tab and the pill are
 * hidden: there is nothing to show or switch.
 */
function renderAcctPill() {
  const available = Boolean(state!.accounts?.available);
  $('tabs').hidden = !available;
  if (!available && !$('accounts-page').hidden) setTab('chats');
  const active = available ? (state!.usage ?? []).find((u) => u.active) : undefined;
  const pill = $('acct-pill') as HTMLButtonElement;
  pill.hidden = !active;
  if (!active) return;
  const pct = active.fiveHour?.pct ?? null;
  pill.dataset.level = pct === null ? '' : pct >= 85 ? 'warn' : '';
  pill.innerHTML = `Account ${active.slot}${pct === null ? '' : ` <span>${pct}% of 5h</span>`}`;
  pill.title = 'The Claude account this Mac uses. Open Accounts to switch.';
}

const until = (iso: string | null) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  if (mins <= 0) return 'resets now';
  if (mins < 90) return `resets in ${mins} min`;
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `resets ${sameDay ? '' : `${d.toLocaleDateString(undefined, { weekday: 'short' })} `}${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

function loginNote(iso: string | null): { text: string; level: string } {
  if (!iso) return { text: '', level: '' };
  const d = new Date(iso);
  const days = Math.floor((d.getTime() - Date.now()) / 86_400_000);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (d.getTime() <= Date.now()) return { text: 'Login expired, run cswap add in a terminal', level: 'crit' };
  if (d.toDateString() === new Date().toDateString()) return { text: 'Login expires today', level: 'warn' };
  if (days < 3) return { text: `Login expires ${date}`, level: 'warn' };
  return { text: `Login until ${date}`, level: '' };
}

function ameter(label: string, w: Window5, warnAt: number) {
  if (!w) return '';
  const level = w.pct >= 100 ? 'crit' : w.pct >= warnAt ? 'warn' : '';
  return `<div class="am"><span class="am-k">${label}</span>
    <span class="am-bar" data-level="${level}" role="meter" aria-label="${label} used" aria-valuenow="${w.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.min(100, w.pct)}%"></i></span>
    <span class="am-v" data-level="${level}">${w.pct}%</span><span class="am-r">${until(w.resetsAt)}</span></div>`;
}

function renderAccountsPage() {
  const data = accountsData;
  const grid = $('ap-grid');
  if (!data) return;
  if (!data.ok) { grid.innerHTML = `<div class="empty"><strong>Accounts not readable</strong>${escapeHtml(data.error ?? '')}</div>`; return; }
  const active = data.accounts.find((a) => a.active);
  $('ap-sub').textContent = `${data.accounts.length} accounts from claude-swap${active ? `, account ${active.number} in use` : ''}${data.mostRoom ? `, most room on account ${data.mostRoom}` : ''}.`;
  const folders = state!.projects.filter((p) => p.cwd && !baseName(p.label).startsWith('.')).map((p) => p.cwd!);
  const options = [...new Set([`${state!.projects.find((p) => p.depth === 0)?.cwd ?? ''}`, ...folders])].filter(Boolean)
    .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(shortPath(f))}</option>`).join('');
  grid.innerHTML = data.accounts.map((a) => {
    const login = loginNote(a.loginExpiresAt);
    const [user, domain] = (a.email ?? '').split('@');
    const badges = [
      a.active ? '<span class="badge" data-kind="use">In use</span>' : '',
      data.mostRoom === a.number && !a.active ? '<span class="badge" data-kind="room">Most room</span>' : '',
      a.status && a.status !== 'ok' ? `<span class="badge" data-kind="crit">${escapeHtml(a.status)}</span>` : '',
      login.level ? `<span class="badge" data-kind="${login.level}">${escapeHtml(login.text)}</span>` : '',
    ].join('');
    return `<article class="acard${a.active ? ' is-active' : ''}" data-n="${a.number}">
      <header class="acard-head">
        <div class="acard-id"><span class="acard-n">Account ${a.number}</span>${badges}</div>
        <div class="acard-who" title="${escapeHtml(a.email ?? '')}">${user ? `<span>${escapeHtml(user)}</span><span class="muted">@${escapeHtml(domain ?? '')}</span>` : ''}${a.org ? `<span class="acard-org">${escapeHtml(a.org)}</span>` : ''}</div>
      </header>
      <div class="ameters">
        ${ameter('5-hour', a.fiveHour, 85)}${ameter('Week', a.sevenDay, 80)}
        ${a.models.map((m) => ameter(escapeHtml(m.name), m, 80)).join('')}
      </div>
      <footer class="acard-foot">
        <span class="acard-meta">${login.level ? '' : escapeHtml(login.text)}${a.ageSeconds !== null ? `${login.level ? '' : ', '}read ${a.ageSeconds < 90 ? 'just now' : `${Math.round(a.ageSeconds / 60)} min ago`}` : ''}</span>
        <span class="acard-actions">
          <button class="btn" type="button" data-do="new" aria-expanded="false">New chat as ${a.number}</button>
          <button class="btn${a.active ? '' : ' btn-primary'}" type="button" data-do="switch"${a.active ? ' disabled title="Already in use"' : ''}>${a.active ? 'In use' : 'Switch to this'}</button>
        </span>
      </footer>
      <form class="acard-new" hidden>
        <label>Folder <select name="cwd">${options}</select></label>
        <button class="btn btn-primary" type="submit">Open in VSCode</button>
        <span class="acard-hint">Runs <code>cswap run ${a.number}</code> in a new terminal there. Other terminals keep their account.</span>
      </form>
    </article>`;
  }).join('');

  grid.querySelectorAll<HTMLElement>('.acard').forEach((card) => {
    const number = Number(card.dataset.n);
    const sw = card.querySelector<HTMLButtonElement>('[data-do="switch"]')!;
    const nw = card.querySelector<HTMLButtonElement>('[data-do="new"]')!;
    const form = card.querySelector<HTMLFormElement>('.acard-new')!;
    sw.onclick = () => confirmBox(`Switch this Mac to account ${number}?`,
      `Every chat on this Mac moves to it within about 30 seconds, and new chats start on it.${hasRemote() ? ` ${R()} keeps its own login.` : ''}`,
      async () => {
        sw.disabled = true; sw.textContent = 'Switching…';
        const r = await call('switchAccount', { number });
        toast(r.ok ? `Switched to account ${number}. Running chats follow within about 30 seconds.` : r.error, r.ok ? 'ok' : 'error');
        await loadAccounts(); lastFingerprint = ''; await refresh();
      }, 'Switch', 'Cancel');
    nw.onclick = () => { form.hidden = !form.hidden; nw.setAttribute('aria-expanded', String(!form.hidden)); if (!form.hidden) form.querySelector('select')?.focus(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const cwd = (form.elements.namedItem('cwd') as HTMLSelectElement).value;
      const r = await call('newChatAs', { number, cwd });
      toast(r.ok ? `Opened a chat as account ${number} in ${shortPath(cwd)}.` : r.error, r.ok ? 'ok' : 'error');
      if (r.ok) { form.hidden = true; nw.setAttribute('aria-expanded', 'false'); }
    };
  });
}

/* ---------- offer ---------- */

function renderOffer() {
  const host = $('offer');
  host.innerHTML = '';
  const restore = state!.restore;
  if (!restore.count) return;

  const groups = (restore.groups as Array<{ cwd: string; sessions: Session[]; lastSeen: number | null }>)
    .filter((g) => view.kind !== 'project' || g.cwd === view.value);
  if (!groups.length) return;
  const offered = groups.flatMap((g) => g.sessions);
  const scope = view.kind === 'project' ? view.value! : '*';
  const key = offerKey(scope, offered);
  if (dismissed.has(key)) return;

  const count = offered.length;
  const lastSeen = Math.max(...groups.map((g) => g.lastSeen ?? 0));
  const onRemote = offered.filter((s) => s.machine === 'remote').length;
  const onMac = count - onRemote;
  const unreachable = onRemote > 0 && !state!.remote.reachable;
  const where = view.kind === 'project'
    ? escapeHtml(baseName(view.value!))
    : `${groups.length} folder${groups.length === 1 ? '' : 's'}`;
  const split = onRemote
    ? `${onMac} on the Mac, <span class="remote">${onRemote} on ${escapeHtml(R())}</span>${unreachable ? ' <span class="down">(unreachable, those will wait)</span>' : ''}`
    : 'They reopen in VSCode terminals.';

  const card = document.createElement('div');
  card.className = 'offer';
  card.innerHTML = `
    <div class="offer-body">
      <div class="offer-title">${count} chat${count === 1 ? '' : 's'} closed ${ago(lastSeen)} ago in ${where}</div>
      <div class="offer-sub">${split}</div>
      <div class="offer-names">${escapeHtml(offered.map((s) => s.name).join(', '))}</div>
    </div>
    <button class="btn btn-primary" id="do-restore" type="button">Bring back ${count === 1 ? 'this chat' : `${count} chats`}</button>
    <button class="btn btn-ghost" id="dismiss-restore" type="button">Dismiss</button>`;
  host.appendChild(card);

  if (onMac && !state!.autoTasks?.enabled) {
    const note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = `<span class="note-body"><strong>VSCode will not start the restored terminals.</strong>
      Automatic tasks are off in your user settings.</span>
      <button class="btn" id="fix-autotasks" type="button">Turn on automatic tasks</button>`;
    host.appendChild(note);
    $('fix-autotasks').onclick = async () => {
      const r = await call('enableAutoTasks');
      toast(r.ok ? 'Automatic tasks turned on. settings.json was backed up first.' : r.error, r.ok ? 'ok' : 'error');
      lastFingerprint = '';
      await refresh();
    };
  }
  if (onMac && state!.persistence?.effective) {
    const note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = `<span class="note-body"><strong>You will also get empty terminals.</strong>
      VSCode reopens its own terminals, and the chats that ran in them have exited.</span>
      <button class="btn" id="fix-persistence" type="button">Let restore own it</button>`;
    host.appendChild(note);
    $('fix-persistence').onclick = async () => {
      const r = await call('disablePersistence');
      toast(r.ok ? 'VSCode will stop reopening its own terminals.' : r.error, r.ok ? 'ok' : 'error');
      lastFingerprint = '';
      await refresh();
    };
  }

  $('do-restore').onclick = async () => {
    const button = $('do-restore') as HTMLButtonElement;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Bringing back…';
    const written = await call('restore', { groups, launch: true });
    const failed = written.filter((w: any) => w.error);
    const macFolders = written.filter((w: any) => w.machine === 'mac' && !w.error && w.via !== 'vscode').length;
    const macChats = written.filter((w: any) => w.via === 'vscode').reduce((sum: number, w: any) => sum + (w.started ?? 0), 0);
    const remoteStarted = written.filter((w: any) => w.machine === 'remote').reduce((sum: number, w: any) => sum + (w.started ?? 0), 0);
    const remoteAttached = written.filter((w: any) => w.machine === 'remote').reduce((sum: number, w: any) => sum + (w.attached ?? 0), 0);
    if (failed.length) {
      toast(`${failed.length} part${failed.length === 1 ? '' : 's'} failed: ${failed[0].error}`, 'error');
    } else {
      const bits = [];
      if (macChats) bits.push(`${macChats} chat${macChats === 1 ? '' : 's'} reopened in VSCode terminals`);
      if (macFolders) bits.push(`VSCode is opening ${macFolders} folder${macFolders === 1 ? '' : 's'}`);
      if (remoteStarted) bits.push(`${remoteStarted} started on ${R()}${remoteAttached ? `, ${remoteAttached} open in VSCode` : ', attach from a row'}`);
      toast(bits.join('. ') || 'Nothing needed starting.');
      dismissed.add(key);
      renderOffer();
    }
    button.disabled = false;
    button.textContent = label;
  };
  $('dismiss-restore').onclick = () => { dismissed.add(key); renderOffer(); };
}

/* ---------- list ---------- */

function rowSignature(s: Session) {
  return [s.name, s.live ? 1 : 0, s.needsYou ? 1 : 0, s.machine, s.lastMachine, s.status, s.lastLine,
    s.bytes + s.subagentBytes, ago(s.modifiedAt), s.modelShort, s.effort, s.chainPart, s.chainSize,
    s.transcriptMissing ? 1 : 0, s.cwd, s.contextPct, s.permission, s.rssMb, s.stoppedOn?.kind ?? '', s.quietMin ?? '',
    state!.remote.reachable ? 1 : 0, remoteDown(s) ? ago(state!.remote.lastReachableAt) : '', R(), deep && deep.query === needle() ? deep.hits.get(s.sessionId)?.snippet ?? '' : '', commonModel, s.sameNameCount, s.sameNameRole, unfolded.has(s.sessionId) ? 1 : 0].join('|');
}

const needle = () => (($('search') as HTMLInputElement).value || '').trim().toLowerCase();
/** The last full-text search: which chats said the words, with a snippet each. */
let deep: { query: string; hits: Map<string, { count: number; snippet: string; role: string }> } | null = null;
function matchesSearch(s: Session) {
  const q = needle();
  if (!q) return true;
  if (deep && deep.query === q && deep.hits.has(s.sessionId)) return true;
  return [s.name, s.lastLine, baseName(s.cwd), s.modelShort].some((v) => (v ?? '').toLowerCase().includes(q));
}

const ROLE_WORD: Record<string, string> = {
  latest: 'latest', running: 'current', 'also-running': 'also running', branch: 'branch', older: 'older copy',
};
const ROLE_HINT: Record<string, string> = {
  'also-running': 'Two chats with this name are running. Writing one name from two places is how a transcript forks.',
  branch: 'Started from another chat and carries its history',
  older: 'A separate, older chat that used the same name',
};

function fillRow(row: HTMLElement, s: Session, sig: string, sub = false) {
  const was = row.dataset.machine;
  row.dataset.sig = sig;
  row.dataset.id = s.sessionId;
  row.dataset.machine = s.machine ?? '';
  row.draggable = hasRemote() && s.machine !== 'remote' && Boolean(s.cwd);
  row.tabIndex = 0;
  row.className = `row${s.live ? ' is-live' : ''}${s.needsYou ? ' is-needs' : ''}${
    s.live && !s.needsYou && (s.status === 'busy' || s.status === 'shell') ? ' is-busy' : ''}${
    row.classList.contains('is-new') ? ' is-new' : ''}${selectedId === s.sessionId ? ' is-selected' : ''}${sub ? ' is-sub' : ''}${remoteDown(s) ? ' is-offline' : ''}`;
  // A chat that just landed on the remote flashes once, so the move is seen.
  if (was === 'mac' && s.machine === 'remote') {
    row.classList.add('is-moved');
    window.setTimeout(() => row.classList.remove('is-moved'), 1400);
  }

  const machine = s.machine ?? s.lastMachine;
  const machineLabel = machineName(machine);
  const word = stateWord(s);
  // The model most chats use is said once in the header, not on every row.
  const modelText = `${s.modelShort ?? ''}${s.effort ? ` ${s.effort}` : ''}`;
  const model = s.modelShort && modelText !== commonModel ? `<span class="model" title="${escapeHtml(s.model ?? '')}, as of the last reply">${escapeHtml(modelText)}</span>` : '';
  const hit = deep && deep.query === needle() ? deep.hits.get(s.sessionId) : undefined;
  const line = hit
    ? `<div class="line is-hit" title="${escapeHtml(hit.snippet)}"><span class="hit-n">${hit.count} match${hit.count === 1 ? '' : 'es'}</span>${escapeHtml(hit.snippet)}</div>`
    : s.lastLine
    ? `<div class="line" title="${escapeHtml(s.lastLine)}">${model}${escapeHtml(s.lastLine)}</div>`
    : `<div class="line none">${model}${s.live && s.machine === 'remote' ? `Running on ${escapeHtml(R())}; open it for the live screen`
      : (s.live ? 'Running tools, no reply to show yet' : 'No reply recorded')}</div>`;

  const canMove = !s.live && Boolean(s.cwd) && state!.remote.reachable;
  // A remote chat lives in tmux and a Mac chat in a VSCode terminal; both can
  // be typed into from here, the Mac one through the bridge extension.
  const actions = remoteDown(s) ? ''
    : s.live && s.stoppedOn
    ? `<button class="act act-continue" data-kind="continue" type="button" title="Types continue into it, for after the limit resets or you switch accounts">Continue</button>`
    : s.live
    ? (s.machine === 'remote'
      ? `<button class="act" data-kind="reply" type="button" aria-label="Reply to ${escapeHtml(s.name)}">Reply</button>
         <button class="act" data-kind="attach" type="button" aria-label="Attach to ${escapeHtml(s.name)} in Terminal">Attach</button>
         <button class="act" data-kind="more" type="button" aria-label="Model, effort and permission for ${escapeHtml(s.name)}" aria-haspopup="dialog">&middot;&middot;&middot;</button>`
      : `<button class="act" data-kind="reply" type="button" aria-label="Reply to ${escapeHtml(s.name)}" title="Typed into its VSCode terminal once it is idle">Reply</button>
         <button class="act" data-kind="more" type="button" aria-label="Model, effort and permission for ${escapeHtml(s.name)}" aria-haspopup="dialog">&middot;&middot;&middot;</button>
         <button class="act" data-kind="open" type="button" aria-label="Open the folder of ${escapeHtml(s.name)} in VSCode">Open</button>`)
    : !hasRemote() ? ''
    : `<button class="act" data-kind="move" type="button" aria-label="Move ${escapeHtml(s.name)} to ${escapeHtml(R())}"${
      canMove ? '' : ` disabled title="${state!.remote.reachable ? 'No folder known' : `${escapeHtml(R())} unreachable`}"`}>To ${escapeHtml(R())}</button>`;

  // Context used and the permission mode, as of the last reply. Live chats
  // show the memory they hold; stopped ones the space their transcript takes.
  const ctx = s.contextPct == null ? '' : `<span class="ctx" data-level="${s.contextPct >= 85 ? 'high' : s.contextPct >= 60 ? 'mid' : 'low'}" title="${
    s.contextPct}% of the context window used, as of the last reply"><i style="width:${s.contextPct}%"></i></span><span class="ctx-n">${s.contextPct}%</span>`;
  const perm = s.permission ? `<span class="perm" title="Permission mode">${escapeHtml(s.permission)}</span>` : '';
  const mem = s.live && s.rssMb != null
    ? `<span class="num num-mem" title="Memory this chat holds right now">${s.rssMb >= 1024 ? `${(s.rssMb / 1024).toFixed(1)} GB` : `${s.rssMb} MB`}</span>`
    : `<span class="num num-mem" title="Transcript size on disk">${s.transcriptMissing ? '' : mb(s.bytes + s.subagentBytes)}</span>`;

  row.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <div class="cell-main">
      <div class="name" title="${escapeHtml(s.name)}${s.cwd ? ` in ${escapeHtml(shortPath(s.cwd))}` : ''}">${escapeHtml(s.name)}${
        s.chainSize ? `<span class="part" title="One conversation across ${s.chainSize} transcripts, it ran out of context">part ${s.chainPart} of ${s.chainSize}</span>` : ''}${
        sub && s.sameNameRole && ROLE_WORD[s.sameNameRole] ? `<span class="role" data-role="${s.sameNameRole}" title="${ROLE_HINT[s.sameNameRole] ?? ''}">${ROLE_WORD[s.sameNameRole]}</span>` : ''}${
        !sub && s.sameNameCount && !s.sameNameRank ? `<button class="dup" data-kind="dups" type="button" aria-expanded="${unfolded.has(s.sessionId)}" title="Other chats named ${escapeHtml(s.name)}">+${s.sameNameCount - 1} same name</button>` : ''}</div>
      ${line}
    </div>
    <div class="where" title="${word}${machineLabel ? ` on the ${machineLabel}` : ''}">${
      machineLabel ? `<span class="chip" data-machine="${machine}">${machineLabel}</span>` : ''
    }<span class="state">${word}</span></div>
    <span class="stats">${ctx}${perm}</span>
    ${mem}
    <span class="num">${ago(s.modifiedAt)}</span>
    <span class="actions">${actions}<button class="act act-del" type="button" aria-label="Delete ${escapeHtml(s.name)}" title="${
      s.live ? 'Running, close it first' : 'Move to Trash'}"${s.live ? ' disabled' : ''}>&#x2715;</button></span>`;
}

/* ---------- background agents ---------- */

let showOldAgents = false;

/**
 * Background agents blocked on the person, at the top of All and Needs you.
 * Recent ones show; those idle more than a week fold behind a line, since
 * most of them are abandoned. Null when there is nothing to show here.
 */
function agentsBlock(): HTMLElement | null {
  const all = state!.background ?? [];
  const inScope = view.kind === 'all' || view.kind === 'needs';
  const q = needle();
  const list = all.filter((a) => !q || [a.name, a.needs, a.detail].some((v) => (v ?? '').toLowerCase().includes(q)));
  if (!inScope || !list.length) { rowEls.get('#agents')?.remove(); rowEls.delete('#agents'); return null; }
  const recent = list.filter((a) => !a.stale);
  const old = list.filter((a) => a.stale);
  const shown = showOldAgents ? list : recent;
  const sig = JSON.stringify([shown.map((a) => [a.id, a.needs, a.updatedAt]), old.length, showOldAgents, ago(Date.now())]);
  let el = rowEls.get('#agents');
  if (el && el.dataset.sig === sig) return el;
  if (!el) { el = document.createElement('div'); el.className = 'agents'; rowEls.set('#agents', el); }
  el.dataset.sig = sig;
  el.dataset.id = '#agents';
  const row = (a: Agent) => `<div class="row agent-row${a.stale ? ' is-stale' : ''}" data-agent="${escapeHtml(a.id)}">
      <span class="dot" aria-hidden="true"></span>
      <div class="cell-main">
        <div class="name">${escapeHtml(a.name)}<span class="role" data-role="bg" title="A background agent (claude --bg). The text is its own summary from its job file.">background</span></div>
        <div class="line" title="${escapeHtml(a.needs ?? a.detail ?? '')}">${escapeHtml(a.needs ?? a.detail ?? 'Waiting on you')}</div>
      </div>
      <span class="agent-where" title="${escapeHtml(a.cwd ?? '')}">${escapeHtml(baseName(a.cwd))}</span>
      <span class="num" title="Last moved ${a.updatedAt ? new Date(a.updatedAt).toLocaleString() : 'unknown'}">${ago(a.updatedAt)}</span>
      <span class="actions">
        <button class="act" type="button" data-agent-do="open" aria-label="Open ${escapeHtml(a.name)} in a VSCode terminal">Open</button>
        ${a.suggestedReply ? `<button class="act" type="button" data-agent-do="copy" title="Suggested reply: ${escapeHtml(a.suggestedReply)}">Copy reply</button>` : ''}
        <button class="act act-del" type="button" data-agent-do="stop" aria-label="Stop ${escapeHtml(a.name)}" title="Stop it. The conversation is kept.">&#x2715;</button>
      </span>
    </div>`;
  el.innerHTML = `<div class="group" data-kind="needs"><b>Background agents waiting on you</b><span>${recent.length}</span></div>
    ${shown.map(row).join('')}
    ${old.length ? `<button class="agents-more" type="button" aria-expanded="${showOldAgents}">${showOldAgents ? 'Hide' : 'Show'} ${old.length} older, idle more than a week</button>` : ''}`;
  el.querySelector<HTMLButtonElement>('.agents-more')?.addEventListener('click', () => { showOldAgents = !showOldAgents; renderList(); });
  el.querySelectorAll<HTMLButtonElement>('[data-agent-do]').forEach((b) => {
    const id = (b.closest('[data-agent]') as HTMLElement).dataset.agent!;
    const a = all.find((x) => x.id === id)!;
    b.onclick = async () => {
      const act = b.dataset.agentDo;
      if (act === 'open') {
        const r = await call('openAgent', { id });
        toast(r.ok ? `${a.name} is open in a VSCode terminal.` : r.error, r.ok ? 'ok' : 'error');
      } else if (act === 'copy') {
        const r = await call('copyText', { text: a.suggestedReply });
        toast(r.ok ? `Copied: "${a.suggestedReply}". Paste it after opening ${a.name}.` : r.error, r.ok ? 'ok' : 'error');
      } else if (act === 'stop') {
        confirmBox(`Stop ${a.name}?`, 'It stops running. Its conversation is kept; claude attach brings it back.', async () => {
          const r = await call('stopAgent', { id });
          toast(r.ok ? `Stopped ${a.name}.` : r.error, r.ok ? 'ok' : 'error');
          lastFingerprint = ''; await refresh();
        }, 'Stop it', 'Cancel');
      }
    };
  });
  return el;
}

/* ---------- batch actions for a family or project ---------- */

const movable = (s: Session) => s.live && s.machine === 'mac' && s.status === 'idle' && Boolean(s.cwd);
const working = (s: Session) => s.live && s.machine === 'mac' && (s.status === 'busy' || s.status === 'shell');
/**
 * Stopped chats worth starting: one per name. Same-name copies are ranked live
 * first, then newest, so a stopped copy at rank 0 means no copy is running.
 */
const startable = (list: Session[]) =>
  list.filter((s) => !s.live && !s.sameNameRank && Boolean(s.cwd) && !s.transcriptMissing);
const BATCH_START_MAX = 12;

function renderBatch() {
  const host = $('batch');
  if (view.kind !== 'family' && view.kind !== 'project') { host.innerHTML = ''; host.hidden = true; return; }
  const scope = allSessions().filter(inView);
  const toMove = scope.filter(movable);
  const busy = scope.filter(working).length;
  const stopped = startable(scope);
  const remoteUp = hasRemote() && state!.remote.reachable;
  const parts = [
    toMove.length && remoteUp ? `<button class="btn btn-primary" id="batch-move" type="button">Move ${toMove.length} idle to ${escapeHtml(R())}</button>` : '',
    stopped.length && stopped.length <= BATCH_START_MAX && remoteUp ? `<button class="btn" id="batch-start-remote" type="button">Start ${stopped.length} stopped on ${escapeHtml(R())}</button>` : '',
    stopped.length && stopped.length <= BATCH_START_MAX ? `<button class="btn" id="batch-open-mac" type="button">Open ${stopped.length} on the Mac</button>` : '',
  ].filter(Boolean);
  const notes = [
    busy ? `${busy} working, left where ${busy === 1 ? 'it is' : 'they are'}` : '',
    stopped.length > BATCH_START_MAX ? `${stopped.length} stopped, too many to start at once` : '',
    hasRemote() && !remoteUp ? `${R()} unreachable` : '',
  ].filter(Boolean);
  host.hidden = !parts.length && !notes.length;
  host.innerHTML = `${parts.join('')}${notes.length ? `<span class="batch-note">${notes.join(', ')}</span>` : ''}`;
  const on = (id: string, fn: () => void) => { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.onclick = () => { b.disabled = true; fn(); }; };
  on('batch-move', () => batchToRemote(toMove));
  on('batch-start-remote', () => batchToRemote(stopped));
  on('batch-open-mac', () => batchOpenOnMac(stopped));
}

/**
 * Move several chats to the remote one at a time, so each is verified there
 * before the next, and the toast says how far it got. Live ones reopen in
 * their own VSCode terminal; stopped ones start on the remote and open in one.
 */
async function batchToRemote(list: Session[]) {
  let moved = 0;
  const failed: string[] = [];
  for (const [i, s] of list.entries()) {
    toast(`Moving ${s.name} to ${R()}, ${i + 1} of ${list.length}…`);
    const r = s.live ? await call('moveLive', { sessionId: s.sessionId }) : await call('moveToRemote', { sessionId: s.sessionId });
    if (r.ok) {
      moved += 1;
      if (!s.live) await call('attach', { name: s.name, cwd: s.cwd });
    } else failed.push(`${s.name}: ${r.busy ? 'working' : r.error}`);
    lastFingerprint = '';
    await refresh();
  }
  toast(failed.length ? `Moved ${moved} of ${list.length}. ${failed[0]}` : `Moved ${moved} to ${R()}, each open in a VSCode terminal.`, failed.length ? 'error' : 'ok');
}

async function batchOpenOnMac(list: Session[]) {
  const byCwd = new Map<string, Session[]>();
  for (const s of list) (byCwd.get(s.cwd!) ?? byCwd.set(s.cwd!, []).get(s.cwd!)!).push({ ...s, machine: 'mac' });
  toast(`Opening ${list.length} chats in VSCode terminals…`);
  const written = await call('restore', { groups: [...byCwd].map(([cwd, sessions]) => ({ cwd, sessions })), launch: true });
  const started = written.reduce((sum: number, w: any) => sum + (w.started ?? 0), 0);
  const failed = written.find((w: any) => w.error);
  toast(failed ? `Opened ${started}. ${failed.error}` : `Opened ${started} in VSCode terminals.`, failed ? 'error' : 'ok');
  lastFingerprint = '';
  await refresh();
}

function groupHeader(kind: string, label: string, count: number) {
  const el = document.createElement('div');
  el.className = 'group';
  el.dataset.kind = kind;
  el.dataset.id = `#${kind}`;
  el.innerHTML = `<b>${label}</b><span>${count}</span>`;
  return el;
}

function renderList() {
  $('title').textContent = viewTitle();
  const matching = sortSessions(allSessions().filter(inView).filter(matchesSearch));
  const bytes = matching.reduce((sum, s) => sum + s.bytes + s.subagentBytes, 0);
  const running = matching.filter((s) => s.live).length;
  const tally = new Map<string, number>();
  // From running chats: those sit at the top and all repeat one model. Stopped
  // rows span older models, where the label still tells something.
  for (const s of matching) if (s.live && s.modelShort) { const k = `${s.modelShort}${s.effort ? ` ${s.effort}` : ''}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
  const top = [...tally].sort((a, b) => b[1] - a[1])[0];
  const withModel = [...tally.values()].reduce((a, b) => a + b, 0);
  commonModel = top && withModel >= 3 && top[1] >= withModel * 0.6 ? top[0] : '';
  $('meta').textContent = `${n(matching.length)} chats, ${mb(bytes)}${running ? `, ${running} running` : ''}${commonModel ? `, running chats on ${commonModel} unless marked` : ''}`;
  renderBatch();

  // Same-name copies fold under their primary row while it is listed too.
  // A search lists every match unfolded.
  const listed = new Set(matching.map((s) => s.sessionId));
  const folds = (s: Session) => !needle() && Boolean(s.sameNameRank) && listed.has(s.sameNamePrimaryId ?? '');
  const subsOf = new Map<string, Session[]>();
  for (const s of matching) if (folds(s)) (subsOf.get(s.sameNamePrimaryId!) ?? subsOf.set(s.sameNamePrimaryId!, []).get(s.sameNamePrimaryId!)!).push(s);
  const visible = matching.filter((s) => !folds(s));

  const host = $('rows');
  host.setAttribute('aria-busy', 'false');
  sessionById.clear();
  for (const s of matching) sessionById.set(s.sessionId, s);

  if (!visible.length && !agentsBlock()) {
    rowEls.clear();
    host.innerHTML = view.kind === 'needs'
      ? '<div class="empty"><strong>Nothing needs you</strong>Every running chat is working on its own.</div>'
      : '<div class="empty"><strong>Nothing here</strong>No chats match this view.</div>';
    return;
  }
  if (host.querySelector('.empty')) host.innerHTML = '';

  // Sections only when the view mixes states; a filtered view is one list.
  const grouped = view.kind === 'all' || view.kind === 'machine' || view.kind === 'project' || view.kind === 'family';
  const states: Array<{ kind: string; label: string; is: (s: Session) => boolean }> = [
    { kind: 'needs', label: 'Needs you', is: (s) => s.needsYou },
    { kind: 'running', label: 'Running', is: (s) => s.live && !s.needsYou },
    { kind: 'stopped', label: 'Stopped', is: (s) => !s.live },
  ];
  const sections: Array<{ kind: string; label: string; items: Session[]; count: number }> = grouped
    ? states.map((g) => ({ kind: g.kind, label: g.label, items: visible.filter(g.is), count: matching.filter(g.is).length }))
      .filter((g) => g.items.length)
    : [{ kind: view.kind, label: viewTitle(), items: visible, count: matching.length }];

  const keep = new Set<string>();
  // Before the cursor is taken: leaving the view removes the block, and a
  // cursor still pointing at it made insertBefore throw.
  const agentsEl = agentsBlock();
  let cursor = host.firstElementChild;
  if (agentsEl) { keep.add('#agents'); if (agentsEl === cursor) cursor = cursor.nextElementSibling; else host.insertBefore(agentsEl, cursor); }
  let fresh = 0;
  const place = (el: Element) => {
    if (el === cursor) cursor = cursor!.nextElementSibling;
    else host.insertBefore(el, cursor);
  };
  for (const section of sections) {
    const id = `#${section.kind}`;
    keep.add(id);
    let header = rowEls.get(id);
    const label = grouped ? section.label : '';
    // Counted by each chat's own state, folded or not, so the header agrees with the sidebar.
    const count = section.count;
    if (!header) { header = groupHeader(section.kind, label, count); rowEls.set(id, header); }
    else header.innerHTML = `<b>${label}</b><span>${count}</span>`;
    // Several chats stopped on a limit: after a reset or an account switch, one click resumes them all.
    const paused = section.kind === 'needs' ? section.items.filter((x) => x.stoppedOn?.kind === 'limit' && !remoteDown(x)) : [];
    if (paused.length >= 2) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'group-act'; b.textContent = `Continue all ${paused.length}`;
      b.onclick = async () => {
        b.disabled = true;
        let done = 0;
        for (const x of paused) if ((await call('control', { sessionId: x.sessionId, name: x.name, machine: x.machine, action: 'reply', value: 'continue' })).ok) done += 1;
        toast(`Told ${done} of ${paused.length} chats to continue.`, done === paused.length ? 'ok' : 'error');
        lastFingerprint = ''; window.setTimeout(refresh, 2000);
      };
      header.appendChild(b);
    }
    header.hidden = !grouped;
    place(header);

    const put = (s: Session, sub: boolean) => {
      keep.add(s.sessionId);
      sessionById.set(s.sessionId, s);
      const sig = `${rowSignature(s)}|${sub ? 1 : 0}`;
      let row = rowEls.get(s.sessionId);
      if (!row) {
        row = document.createElement('div');
        row.classList.add('is-new');
        if (fresh < 24) row.style.animationDelay = `${fresh * 12}ms`;
        fresh += 1;
        row.addEventListener('animationend', (e) => { if (e.animationName === 'rise') { row!.classList.remove('is-new'); row!.style.animationDelay = ''; } });
        fillRow(row, s, sig, sub);
        rowEls.set(s.sessionId, row);
      } else if (row.dataset.sig !== sig) {
        fillRow(row, s, sig, sub);
      }
      place(row);
    };
    for (const s of section.items) {
      put(s, false);
      if (unfolded.has(s.sessionId)) for (const x of (subsOf.get(s.sessionId) ?? []).sort((a, b) => (a.sameNameRank ?? 0) - (b.sameNameRank ?? 0))) put(x, true);
    }
  }
  for (const [id, el] of rowEls) {
    if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
  }
}

/* ---------- row actions (one listener for the whole list) ---------- */

$('rows').addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!button || button.disabled) return;
  const row = button.closest('.row') as HTMLElement | null;
  const session = row ? sessionById.get(row.dataset.id ?? '') : null;
  if (!session) return;

  if (button.classList.contains('act-del')) { openSheet(session); return; }
  const kind = button.dataset.kind;
  if (kind === 'reply' || kind === 'more') { openPopover(button, session, kind); return; }
  if (kind === 'dups') {
    if (unfolded.has(session.sessionId)) unfolded.delete(session.sessionId); else unfolded.add(session.sessionId);
    renderList();
    return;
  }
  const label = button.textContent;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    if (kind === 'attach') {
      await attach(session);
    } else if (kind === 'continue') {
      await control(session, 'reply', 'continue', `Told ${session.name} to continue.`);
    } else if (kind === 'open') {
      const r = await call('openProject', { cwd: session.cwd });
      toast(r.ok ? `Opened ${shortPath(session.cwd)} in VSCode.` : r.error, r.ok ? 'ok' : 'error');
    } else if (kind === 'move') {
      button.textContent = 'Moving…';
      await moveFlow(session, 'remote');
    }
  } finally {
    button.classList.remove('is-busy');
    button.disabled = false;
    button.textContent = label;
  }
});

/* ---------- popover: reply, model, effort, permission ---------- */

const PERMISSIONS: Array<[string, string]> = [['manual', 'ask'], ['acceptEdits', 'accept edits'], ['plan', 'plan'], ['auto', 'auto'], ['bypassPermissions', 'bypass']];
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function closePopover() {
  const el = document.getElementById('popover');
  if (el) el.remove();
}

async function control(session: Session, action: string, value = '', done: string) {
  const r = await call('control', { sessionId: session.sessionId, name: session.name, machine: session.machine, action, value });
  toast(r.ok ? done : r.error, r.ok ? 'ok' : 'error');
  if (r.ok) { lastFingerprint = ''; window.setTimeout(refresh, 1500); }
  return r.ok;
}

function openPopover(anchor: HTMLElement, s: Session, kind: 'reply' | 'more') {
  closePopover();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', kind === 'reply' ? `Reply to ${s.name}` : `Settings for ${s.name}`);
  if (kind === 'reply') {
    pop.innerHTML = `
      <div class="pop-title">Reply to ${escapeHtml(s.name)}</div>
      ${s.lastLine ? `<div class="pop-quote">${escapeHtml(s.lastLine)}</div>` : ''}
      <textarea class="pop-input" id="pop-text" rows="3" placeholder="Typed into the chat as if you were at its keyboard" autocomplete="off"></textarea>
      <div class="pop-row"><span class="pop-hint">Enter sends, Shift+Enter for a new line</span><button class="btn btn-primary" id="pop-send" type="button">Send</button></div>`;
  } else {
    const currentModel = (s.modelShort ?? '').split(' ')[0] || null;
    const currentPerm = s.permissionMode === 'default' ? 'manual' : s.permissionMode ?? null;
    const group = (title: string, name: string, options: Array<[string, string]>, current: string | null) =>
      `<div class="pop-group"><div class="pop-label">${title}</div><div class="pop-opts" role="radiogroup" aria-label="${title}">${options.map(([value, label]) =>
        `<button class="pop-opt" type="button" role="radio" data-name="${name}" data-value="${value}" aria-checked="${current === value}">${label}</button>`).join('')}</div></div>`;
    const working = s.status === 'busy' || s.status === 'shell' || s.status === 'waiting';
    pop.innerHTML = `
      <div class="pop-title">${escapeHtml(s.name)} <span class="pop-sub">on ${s.machine === 'remote' ? escapeHtml(R()) : 'the Mac'}</span></div>
      ${group('Model', 'model', MODELS.map((m) => [m, m]), currentModel)}
      ${group('Effort', 'effort', EFFORTS.map((e) => [e, e]), s.effort)}
      ${group('Permission mode', 'permission', PERMISSIONS, currentPerm)}
      <div class="pop-hint">Applies by restarting this chat with these settings, for this chat only. Your defaults and other chats stay as they are.${working ? ' It is working now; apply once it is idle.' : ''}</div>
      <div class="pop-row"><button class="btn btn-ghost" id="pop-interrupt" type="button">Interrupt (Esc)</button><button class="btn btn-primary" id="pop-apply" type="button"${working ? ' disabled' : ''}>Apply</button></div>`;
  }
  document.body.appendChild(pop);

  const a = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(a.right - width, window.innerWidth - width - 8))}px`;
  pop.style.top = `${a.bottom + 6 + pop.offsetHeight > window.innerHeight ? a.top - pop.offsetHeight - 6 : a.bottom + 6}px`;

  if (kind === 'reply') {
    const text = pop.querySelector('#pop-text') as HTMLTextAreaElement;
    const send = async () => {
      const value = text.value.trim();
      if (!value) return;
      (pop.querySelector('#pop-send') as HTMLButtonElement).disabled = true;
      if (await control(s, 'reply', value, `Sent to ${s.name}.`)) closePopover();
      else (pop.querySelector('#pop-send') as HTMLButtonElement).disabled = false;
    };
    (pop.querySelector('#pop-send') as HTMLButtonElement).onclick = send;
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    text.focus();
  } else {
    const chosen: Record<string, string | null> = {};
    pop.querySelectorAll<HTMLButtonElement>('.pop-opt').forEach((b) => {
      b.onclick = () => {
        pop.querySelectorAll<HTMLButtonElement>(`.pop-opt[data-name="${b.dataset.name}"]`).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        chosen[b.dataset.name!] = b.dataset.value!;
      };
    });
    (pop.querySelector('#pop-interrupt') as HTMLButtonElement).onclick = async () => { if (await control(s, 'interrupt', '', `Interrupted ${s.name}.`)) closePopover(); };
    const apply = pop.querySelector('#pop-apply') as HTMLButtonElement;
    apply.onclick = async () => {
      const change = Object.fromEntries(Object.entries(chosen).filter(([k, v]) => v && v !== ({ model: (s.modelShort ?? '').split(' ')[0], effort: s.effort, permission: s.permissionMode }[k])));
      if (!Object.keys(change).length) { toast('Nothing changed.'); return; }
      apply.disabled = true; apply.textContent = 'Restarting…';
      const r = await call('restartWith', { sessionId: s.sessionId, machine: s.machine, ...change });
      toast(r.ok ? `${s.name} restarted with ${r.flags}.` : r.error, r.ok && r.verified !== false ? 'ok' : 'error');
      if (r.ok) { closePopover(); lastFingerprint = ''; window.setTimeout(refresh, 1500); }
      else { apply.disabled = false; apply.textContent = 'Apply'; }
    };
    (pop.querySelector('.pop-opt[aria-checked="true"]') as HTMLButtonElement ?? pop.querySelector('.pop-opt') as HTMLButtonElement).focus();
  }
}

document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('popover');
  if (pop && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest('.act')) closePopover();
});

/* ---------- delete sheet ---------- */

let pending: Session | null = null;

async function openSheet(session: Session) {
  pending = session;
  const plan = await call('previewDelete', { sessionId: session.sessionId, projectDir: session.projectDir });
  $('sheet-title').textContent = session.name;
  $('sheet-sub').textContent = session.sessionId;

  const body = $('sheet-body');
  body.innerHTML = '';
  for (const target of plan.targets) {
    const el = document.createElement('div');
    el.className = 'target';
    el.innerHTML = `<div><div class="target-kind">${escapeHtml(target.kind)}</div>
      <div class="target-path">${escapeHtml(shortPath(target.path))}</div></div>
      <div class="target-size">${mb(target.bytes)}</div>`;
    body.appendChild(el);
  }
  if (plan.historyLines) {
    const el = document.createElement('div');
    el.className = 'target';
    el.innerHTML = `<div><div class="target-kind">Prompt history</div>
      <div class="target-path">~/.claude/history.jsonl</div></div>
      <div class="target-size">${plan.historyLines} lines</div>`;
    body.appendChild(el);
  }
  const total = document.createElement('div');
  total.className = 'target total';
  total.innerHTML = `<div class="target-kind">Total reclaimed</div><div class="target-size">${mb(plan.totalBytes)}</div>`;
  body.appendChild(total);
  $('sheet-scrim').hidden = false;
  ($('sheet-cancel') as HTMLButtonElement).focus();
}

function closeSheet() {
  $('sheet-scrim').hidden = true;
  pending = null;
}

$('sheet-cancel').onclick = closeSheet;
$('sheet-confirm').onclick = async () => {
  if (!pending) return;
  const button = $('sheet-confirm') as HTMLButtonElement;
  button.disabled = true;
  const r = await call('confirmDelete', { sessionId: pending.sessionId, projectDir: pending.projectDir });
  button.disabled = false;
  if (!r.ok) toast(r.error, 'error');
  else toast(`Moved ${mb(r.result.bytesReclaimed)} to the Trash and removed ${r.result.historyRemoved} history line${r.result.historyRemoved === 1 ? '' : 's'}.`);
  closeSheet();
  lastFingerprint = '';
  await refresh();
};
$('sheet-scrim').addEventListener('click', (event) => {
  if (event.target === $('sheet-scrim')) closeSheet();
});

/* ---------- boot ---------- */

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await call('overview');
    const t = state!.totals; const d = state!.remote; const r = state!.recorder;
    const fingerprint = [
      t.sessions, t.bytes, t.live, t.liveMac, t.liveRemote, t.sdkHidden,
      d.configured, d.label, d.reachable, d.liveCount, d.memAvailableMb, JSON.stringify((state as any).autoBalance ?? {}), state!.accounts?.available, (state!.configErrors ?? []).join(';'), JSON.stringify(state!.usage ?? []), JSON.stringify((state!.background ?? []).map((a) => [a.id, a.updatedAt])), state!.mac.usedMb, state!.mac.swapUsedMb, state!.mac.health?.level, d.health?.level, r.armed, r.problem,
      state!.restore.count, (state!.restore.groups as any[]).flatMap((g) => g.sessions.map((s: Session) => s.sessionId)).join(','),
      state!.projects.flatMap((p) => p.sessions.map(rowSignature)).join('\n'),
      Math.floor(Date.now() / 60000),
    ].join('\u0001');
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    renderTop();
    renderAcctPill();
    renderMachines();
    renderNav();
    renderOffer();
    renderList();
    if (selectedId && !sessionById.has(selectedId)) closeDetail();
  } catch (err) {
    $('recorder-label').textContent = 'Cannot read chats';
    $('nav-foot').textContent = 'Could not load';
    toast(`Could not load your chats: ${(err as Error).message}`, 'error');
  } finally {
    refreshing = false;
  }
}

function renderSort() {
  ($('sort-recent') as HTMLButtonElement).setAttribute('aria-pressed', String(sortMode === 'recent'));
  ($('sort-name') as HTMLButtonElement).setAttribute('aria-pressed', String(sortMode === 'name'));
}
function setSort(mode: SortMode) {
  if (sortMode === mode) return;
  sortMode = mode;
  localStorage.setItem('switchboard.sort', mode);
  renderSort();
  renderList();
}
$('sort-recent').onclick = () => setSort('recent');
$('sort-name').onclick = () => setSort('name');
renderSort();


$('recorder-action').onclick = async () => {
  const r = await call('recorderInstall');
  toast(r.ok ? 'Recorder on. It captures what is open from now on.' : r.error, r.ok ? 'ok' : 'error');
  lastFingerprint = '';
  await refresh();
};

let searchTimer: number | undefined;
$('search').addEventListener('input', () => {
  // A new query drops the last full-text result; Enter runs it again.
  if (deep && deep.query !== needle()) deep = null;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(renderList, 80);
});
$('search').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const query = needle();
  if (query.length < 3) { toast('Type at least 3 characters to search inside chats.'); return; }
  toast(`Searching every chat for "${query}"…`);
  const r = await call('searchAll', { query });
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (needle() !== query) return;
  deep = { query, hits: new Map(r.hits.filter((h: any) => h.sessionId).map((h: any) => [h.sessionId, h])) };
  toast(deep.hits.size ? `${deep.hits.size} chat${deep.hits.size === 1 ? '' : 's'} mention "${query}".` : `No chat mentions "${query}".`);
  renderList();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { $('nc-scrim').hidden = true; closeSheet(); closePopover(); if (document.activeElement === $('search')) ($('search') as HTMLElement).blur(); else closeDetail(); }
  if (event.key === 'f' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); ($('search') as HTMLInputElement).focus(); }
  // Before the modifier bail-out below, which used to swallow it.
  if (event.key === 'r' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); lastFingerprint = ''; refresh(); return; }
  const typing = ['INPUT', 'TEXTAREA'].includes((document.activeElement as HTMLElement)?.tagName ?? '');
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const s = selectedId ? sessionById.get(selectedId) : null;
  if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
  if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
  if (!s) return;
  if (event.key === 'r' && s.live && !remoteDown(s)) openPopover($('detail').querySelector('[data-act="reply"]') as HTMLElement ?? $('detail'), s, 'reply');
  if (event.key === 'a' && s.live && s.machine === 'remote' && !remoteDown(s)) attach(s);
  if (event.key === 'm' && hasRemote() && s.machine !== 'remote') moveFlow(s, 'remote');
});

refresh();
setInterval(refresh, 15000);
// The font notice in the nav foot is only honest once the fonts have settled.
document.fonts.ready.then(() => { if (state) renderNav(); });
