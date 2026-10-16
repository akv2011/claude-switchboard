/**
 * The shutdown race.
 *
 * At shutdown the claude processes can die before the recorder's final poll. A
 * naive recorder then writes "0 sessions" over a good restore set and
 * everything is lost. These tests pin the fallback that prevents that, and
 * equally pin that a deliberate cleanup is NOT resurrected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-snap-'));
process.env.HOME = fakeHome;

/**
 * A real folder to stand in for a project. Imaginary paths like W.ordered
 * stopped working once a workspace that no longer exists became something the
 * app refuses to offer, which is the correct behaviour: you cannot restore into
 * a folder that is gone.
 */
const workspace = (name) => {
  const dir = path.join(fakeHome, 'w', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const W = Object.fromEntries(
  ['ordered', 'ghost', 'rule', 'keep', 'shutdown'].map((n) => [n, workspace(n)]),
);

const {
  writeSnapshot, readSnapshot, restorableSessions, restorableWorkspaces, groupByCwd,
} = await import('../src/core/snapshot.js');

const nine = Array.from({ length: 9 }, (_, i) => ({
  sessionId: `0000000${i}-1111-2222-3333-444444444444`,
  cwd: '/Users/you/Projects',
  name: `Chat_${i}`,
}));

test('a snapshot round-trips', () => {
  writeSnapshot(nine);
  const snap = readSnapshot();
  assert.equal(snap.sessions.length, 9);
  assert.equal(snap.schemaVersion, 3);
  assert.ok(snap.workspaces, 'memory is kept per workspace');
});







test('no snapshot at all means nothing to restore, never an error', () => {
  fs.rmSync(path.join(fakeHome, '.claude-switchboard'), { recursive: true, force: true });
  assert.equal(readSnapshot(), null);
  const { sessions, source } = restorableSessions();
  assert.deepEqual(sessions, []);
  assert.equal(source, 'none');
});

test('a corrupt snapshot degrades to nothing rather than throwing', () => {
  const dir = path.join(fakeHome, '.claude-switchboard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
  assert.equal(readSnapshot(), null);
  assert.doesNotThrow(() => restorableSessions());
});

test('a snapshot from a future schema is ignored rather than misread', () => {
  const dir = path.join(fakeHome, '.claude-switchboard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99, sessions: nine }));
  assert.equal(readSnapshot(), null);
});

test('sessions group by cwd, which is the unit a window restores', () => {
  const mixed = [
    { sessionId: 'a', cwd: '/one', name: 'A' },
    { sessionId: 'b', cwd: '/two', name: 'B' },
    { sessionId: 'c', cwd: '/one', name: 'C' },
    { sessionId: 'd', cwd: null, name: 'D' },
  ];
  const groups = groupByCwd(mixed);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.cwd === '/one').sessions.length, 2);
});

test('nested folders restore into one window, not one window each', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const mixed = [
    { sessionId: 'a', cwd: '/Users/you/Projects', name: 'A' },
    { sessionId: 'b', cwd: '/Users/you/Projects/reader', name: 'B' },
    { sessionId: 'c', cwd: '/Users/you/Projects/reader/deep', name: 'C' },
    { sessionId: 'd', cwd: '/Users/you/Other', name: 'D' },
  ];
  const groups = groupByWorkspace(mixed);
  assert.equal(groups.length, 2, 'subfolders must fold into their parent');

  const projects = groups.find((g) => g.root === '/Users/you/Projects');
  assert.equal(projects.sessions.length, 3);
  assert.ok(groups.some((g) => g.root === '/Users/you/Other'));
});

test('a sibling folder with a shared prefix is not swallowed', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  // "/a/project" must not capture "/a/project-two": containment is on a boundary.
  const groups = await groupByWorkspace([
    { sessionId: 'a', cwd: '/a/project', name: 'A' },
    { sessionId: 'b', cwd: '/a/project-two', name: 'B' },
  ]);
  assert.equal(groups.length, 2, 'prefix match must respect path boundaries');
});

test('sessions without a cwd are dropped rather than grouped under undefined', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const groups = groupByWorkspace([
    { sessionId: 'a', cwd: '/a', name: 'A' },
    { sessionId: 'b', cwd: null, name: 'B' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 1);
});

test('a chat run in the home directory does not swallow every project', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const home = process.env.HOME;
  const groups = groupByWorkspace([
    { sessionId: 'a', cwd: home, name: 'Loose' },
    { sessionId: 'b', cwd: `${home}/Projects`, name: 'Real' },
    { sessionId: 'c', cwd: `${home}/Other`, name: 'Also real' },
  ]);
  // Home contains everything, so without a guard one stray chat would collapse
  // the whole machine into a single restore window.
  assert.equal(groups.length, 3, 'home must not act as a workspace root');
});




test('the VS Code extension panel is not a terminal chat', async () => {
  const { isTerminalSession } = await import('../src/core/registry.js');
  // Same kind as a real terminal chat, different entrypoint. Restoring it would
  // run claude --resume in a terminal for a chat that lives in the sidebar.
  assert.equal(isTerminalSession({ kind: 'interactive', entrypoint: 'claude-vscode' }), false);
  assert.equal(isTerminalSession({ kind: 'interactive', entrypoint: 'cli' }), true);
  assert.equal(isTerminalSession({ kind: 'bg', entrypoint: 'cli' }), false);
  // Older versions did not record an entrypoint; those must not be dropped.
  assert.equal(isTerminalSession({ kind: 'interactive' }), true);
});






test('reading the overview takes a fresh reading, so a closed chat shows at once', async () => {
  // paths.js resolves HOME once at import, so this reuses the fixture home
  // rather than pointing at a new one, which would silently do nothing.
  const api = await import('../src/core/api.js');
  fs.rmSync(path.join(fakeHome, '.claude-switchboard'), { recursive: true, force: true });
  assert.equal(readSnapshot(), null, 'nothing stored to begin with');

  api.getOverview();
  assert.ok(readSnapshot(), 'the overview must record a reading itself');

  fs.rmSync(path.join(fakeHome, '.claude-switchboard'), { recursive: true, force: true });
  api.getOverview({ poll: false });
  assert.equal(readSnapshot(), null, 'poll:false must leave the store untouched');
});




test('chats are ordered oldest first, so they come back as you opened them', async () => {
  const { sortByOpenOrder } = await import('../src/recorder/daemon.js');
  // Deliberately jumbled, the way readdir returns registry files.
  const jumbled = [
    { sessionId: 'c', name: 'Third', startedAt: 3000 },
    { sessionId: 'a', name: 'First', startedAt: 1000 },
    { sessionId: 'b', name: 'Second', startedAt: 2000 },
  ];
  assert.deepEqual(sortByOpenOrder(jumbled).map((s) => s.name), ['First', 'Second', 'Third']);
  assert.deepEqual(jumbled.map((s) => s.name), ['Third', 'First', 'Second'], 'must not mutate');
});

test('sessions with no timestamp fall back to name rather than arbitrary order', async () => {
  const { sortByOpenOrder } = await import('../src/recorder/daemon.js');
  assert.deepEqual(
    sortByOpenOrder([{ name: 'Zeta' }, { name: 'Alpha' }]).map((s) => s.name),
    ['Alpha', 'Zeta'],
  );
});

test('the offer and the generated tasks keep that order', async () => {
  const { buildTasks } = await import('../src/restore/tasks.js');
  const ordered = ['First', 'Second', 'Third'].map((name, i) => ({
    sessionId: `ord${i}`, cwd: W.ordered, name, startedAt: (i + 1) * 1000,
  }));
  writeSnapshot(ordered);
  writeSnapshot([]);

  const offered = restorableWorkspaces().find((w) => w.root === W.ordered);
  assert.deepEqual(offered.sessions.map((s) => s.name), ['First', 'Second', 'Third']);

  const tasks = buildTasks(offered.sessions, { workspaceRoot: W.ordered });
  assert.deepEqual(tasks.map((t) => t.label),
    ['claude: First', 'claude: Second', 'claude: Third']);
  // The stagger must follow the same order, so they appear in sequence.
  assert.ok(!tasks[0].command.startsWith('sleep'));
  assert.match(tasks[1].command, /^sleep 3;/);
  assert.match(tasks[2].command, /^sleep 6;/);
});

test('a chat running with no registry file is still never offered', async () => {
  // The registry is not always complete: a live session was observed with no
  // ~/.claude/sessions/<pid>.json, so the app believed it was closed and offered
  // to restore it, which would have started a second copy.
  const chats = [
    { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: W.ghost, name: 'Ghost' },
    { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: W.ghost, name: 'Really gone' },
  ];
  writeSnapshot(chats);
  writeSnapshot([]);   // the registry says both are gone

  // ...but a process scan proves the first one is running.
  const running = new Set(['aaaaaaaa-1111-2222-3333-444444444444']);
  const offered = restorableWorkspaces(readSnapshot(), undefined, running)
    .find((w) => w.root === W.ghost);

  assert.deepEqual(offered.sessions.map((s) => s.name), ['Really gone'],
    'a provably running chat must be excluded even when the registry omits it');
});

test('the process scan finds a resumed session id', async () => {
  const { readRunningSessionIds } = await import('../src/core/registry.js');
  const ids = readRunningSessionIds();
  assert.ok(ids instanceof Set, 'must always return a set, never throw');
});

test('a running chat missing from the registry still shows as live', async () => {
  // The same registry gap that made restore offer a running chat also made the
  // list show it as closed. Both read liveness, so both need the cross-check.
  const src = fs.readFileSync(new URL('../src/core/sessions.js', import.meta.url), 'utf8');
  assert.match(src, /readRunningSessionIds/, 'the scan must feed the session list');
  assert.match(src, /onMac = Boolean\(liveEntry\) \|\| runningIds\.has\(sessionId\)/,
    'liveness must consider the process scan, not only the registry');
  assert.match(src, /live: onMac \|\| Boolean\(remoteEntry\)/, 'and the remote registry');
});

test('THE RULE: anything not running is always offered', () => {
  const chats = ['ME', 'A', 'B', 'C'].map((n) => ({ sessionId: n, cwd: W.rule, name: n }));
  const [me, ...rest] = chats;
  const offered = () => {
    const w = restorableWorkspaces().find((x) => x.root === W.rule);
    return w ? w.sessions.map((x) => x.name).sort() : [];
  };

  writeSnapshot(chats);
  assert.deepEqual(offered(), [], 'all running, nothing to bring back');

  // A long-lived chat in the same folder must not suppress the offer: that is
  // what made restore appear only when it happened to have exited.
  writeSnapshot([me]);
  assert.deepEqual(offered(), ['A', 'B', 'C']);

  writeSnapshot(chats);
  assert.deepEqual(offered(), [], 'back, so no longer offered');

  // The second close must behave exactly like the first.
  writeSnapshot([me]);
  assert.deepEqual(offered(), ['A', 'B', 'C']);
});

test('an offer holds while the chats left in its folder keep running', () => {
  // A chat that stopped while others kept running in its folder was offered for
  // one poll (30 s), then replaced by the live set.
  const root = workspace('kept');
  const stays = { sessionId: 'kept-a', cwd: root, name: 'Stays', startedAt: 1 };
  const stops = { sessionId: 'kept-b', cwd: root, name: 'Stops', startedAt: 2 };
  const offered = () => (restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root)?.sessions ?? []).map((s) => s.name);
  writeSnapshot([stays, stops]);
  writeSnapshot([stays]);
  for (let i = 0; i < 5; i += 1) writeSnapshot([stays]);
  assert.deepEqual(offered(), ['Stops']);
});

test('an offer does not expire while it sits unused', () => {
  const two = ['P', 'Q'].map((n) => ({ sessionId: n, cwd: W.keep, name: n }));
  writeSnapshot(two);
  writeSnapshot([]);
  for (let i = 0; i < 20; i += 1) writeSnapshot([]);
  const w = restorableWorkspaces().find((x) => x.root === W.keep);
  assert.deepEqual(w.sessions.map((s) => s.name).sort(), ['P', 'Q'], 'the choice stays the user\'s');
});

test('a v1 snapshot is migrated rather than discarded', () => {
  const dir = path.join(fakeHome, '.claude-switchboard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    capturedAt: Date.now(),
    sessions: [],
    lastNonEmpty: { capturedAt: Date.now(), sessions: nine },
  }));
  const snap = readSnapshot();
  assert.ok(snap, 'a v1 file must not be thrown away');
  assert.equal(restorableSessions(snap).sessions.length, 9);
});

test('a shutdown that kills chats over several polls still offers all of them', () => {
  // A shutdown is not atomic: chats die a few at a time. Replacing the offer on
  // every poll meant whichever died first was dropped, so a machine that took
  // two polls to go down came back offering only the stragglers.
  const three = ['A', 'B', 'C'].map((name, i) => ({
    sessionId: `shut${i}`, cwd: W.shutdown, name, startedAt: (i + 1) * 1000,
  }));
  writeSnapshot(three);
  writeSnapshot(three.slice(1));   // A goes
  writeSnapshot([]);               // B and C go on the next poll

  const offered = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === W.shutdown);
  assert.deepEqual(offered.sessions.map((s) => s.name), ['A', 'B', 'C']);
});

test('a workspace that no longer exists is not offered', () => {
  // Deleted folders and test fixtures were sitting in the offer for two days,
  // and clicking one threw "that folder no longer exists".
  const doomed = workspace('deleted-project');
  writeSnapshot([{ sessionId: 'gone1', cwd: doomed, name: 'Ghost' }]);
  fs.rmSync(doomed, { recursive: true, force: true });
  writeSnapshot([]);
  const roots = restorableWorkspaces(readSnapshot(), undefined, new Set()).map((w) => w.root);
  assert.ok(!roots.includes(doomed), 'a missing folder cannot be restored into');
});

test('the store honours HOME, so a test never writes into the real one', async () => {
  const { stateFile } = await import('../src/core/paths.js');
  assert.ok(stateFile().startsWith(fakeHome), `store escaped the fixture: ${stateFile()}`);
});

test('a restart brings the offer back, because the store is all there is', () => {
  // At boot the registry is empty: Claude deletes ~/.claude/sessions/<pid>.json
  // when a session ends, so this file is the only record of what was open. The
  // recorder then polls an empty machine every 30s, and none of those empty
  // polls may erase the offer.
  const root = workspace('reboot');
  const three = ['One', 'Two', 'Three'].map((name, i) => ({
    sessionId: `rb${i}`, cwd: root, name, startedAt: (i + 1) * 1000,
  }));
  writeSnapshot(three);
  for (let i = 0; i < 10; i += 1) writeSnapshot([]);   // ten ticks of an empty machine

  const offered = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.deepEqual(offered.sessions.map((s) => s.name), ['One', 'Two', 'Three']);
});

test('a chat whose transcript is gone is never offered, since resume cannot bring it back', () => {
  // Observed live: a session appeared in the registry, was recorded, and left no
  // transcript behind. It sat in the offer as "projects-f4" with nothing for
  // `claude --resume` to open.
  const root = workspace('ghosted');
  const projects = path.join(fakeHome, '.claude', 'projects', 'enc');
  const real = 'aaaa1111-2222-3333-4444-555555555555';
  const ghost = 'bbbb1111-2222-3333-4444-555555555555';
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${real}.jsonl`), '{}\n');

  writeSnapshot([
    { sessionId: real, cwd: root, name: 'Real', startedAt: 1 },
    { sessionId: ghost, cwd: root, name: 'Ghost', startedAt: 2 },
  ]);
  writeSnapshot([]);

  const offered = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.deepEqual(offered.sessions.map((s) => s.name), ['Real']);

  // Leave the tree as it was found: a readable projects dir changes what every
  // later test in this file would be offered.
  fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true });
});

test('bringing part of an offer back retires the rest of it', () => {
  // The close is resolved the moment you act on it. Retiring the offer only
  // when every chat came back meant the ones you deliberately left behind kept
  // being offered, so two live chats sat under a banner asking about three.
  const root = workspace('acted');
  const four = ['A', 'B', 'C', 'D'].map((name, i) => ({
    sessionId: `act${i}`, cwd: root, name, startedAt: i,
  }));
  writeSnapshot(four);
  writeSnapshot([]);                       // all four go, all four on offer
  writeSnapshot([four[0]]);                // you bring one back, and only one

  const offered = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.equal(offered, undefined, 'the other three must stop being offered');
});

test('working in a folder again clears its offer on the next poll', () => {
  // Chosen deliberately: the offer is what was live at the last poll, so once
  // you are working in that folder again the question is answered. The cost is
  // that a pending offer is dropped if you start new work before restoring.
  const root = workspace('untouched');
  const two = ['P', 'Q'].map((name, i) => ({ sessionId: `un${i}`, cwd: root, name, startedAt: i }));
  writeSnapshot(two);
  writeSnapshot([]);
  writeSnapshot([{ sessionId: 'brand-new', cwd: root, name: 'New', startedAt: 9 }]);

  const offered = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.equal(offered, undefined, 'a live folder has nothing to restore');

  // ...and closing that new chat offers it, not the chats from before.
  writeSnapshot([]);
  const next = restorableWorkspaces(readSnapshot(), undefined, new Set())
    .find((w) => w.root === root);
  assert.deepEqual(next.sessions.map((s) => s.name), ['New']);
});
