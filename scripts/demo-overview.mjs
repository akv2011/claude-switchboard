#!/usr/bin/env node
/**
 * An invented overview for screenshots and UI work: a demo user, made-up
 * projects and chats in every state, a strained Mac beside a healthy remote,
 * accounts on reserved example domains. Nothing here is read from your own
 * ~/.claude, so the images it produces show no real work.
 *
 *   node scripts/demo-overview.mjs > demo.json
 *
 * The output is the shape getOverview() returns, plus __rpc: canned replies the
 * window's harness mode serves for other requests (see CONTRIBUTING.md).
 */
// Times are relative to when this runs, so every "ago" and "resets in" reads as written.
const now = Date.now();
const min = (n) => now - n * 60_000;
const inMin = (n) => new Date(now + n * 60_000).toISOString();
const day = 1440;
// Each account's 5-hour and weekly windows, shared by the usage strip and the Accounts tab.
const windows = [
  { fiveHour: { pct: 41, resetsAt: inMin(130) }, sevenDay: { pct: 22, resetsAt: inMin(4 * day + 1080) } },
  { fiveHour: { pct: 88, resetsAt: inMin(68) }, sevenDay: { pct: 63, resetsAt: inMin(2 * day + 1080) } },
  { fiveHour: { pct: 3, resetsAt: inMin(280) }, sevenDay: { pct: 9, resetsAt: inMin(5 * day + 1080) } },
];
const home = '/Users/you';
const root = `${home}/Projects`;
let seq = 0;
const id = () => `${(0x1000 + (seq += 1)).toString(16).padStart(8, '0')}-4a5b-4c6d-8e7f-${String(seq).padStart(12, '0')}`;

const chat = (cwd, name, o = {}) => ({
  sessionId: id(), projectDir: `-${cwd.replaceAll('/', '-').slice(1)}`, file: null, cwd, name, nameSource: 'custom',
  parentSessionId: null, model: 'claude-opus-5-5', modelShort: 'opus 5.5', effort: 'xhigh',
  bytes: 4_000_000 + seq * 1_700_000, subagentBytes: 0, modifiedAt: min(o.ago ?? 30),
  live: false, machine: null, pid: null, status: null, lastLine: null, contextTokens: null,
  contextPct: null, permissionMode: 'bypassPermissions', permission: 'bypass', rssMb: null,
  needsYou: false, stoppedOn: null, quietMin: null, family: null, lastMachine: null, ...o,
});
const live = (machine, status, o = {}) => ({ live: true, machine, lastMachine: machine, status, pid: 40000 + seq, ...o });

const P = (sub) => `${root}/${sub}`;
const sessions = [
  // storefront: the SHOP family
  chat(P('storefront'), 'SHOP_checkout', { ...live('mac', 'idle'), family: 'SHOP', needsYou: true, ago: 4, contextPct: 46, rssMb: 612,
    lastLine: 'The cart tests pass on Safari and Chrome. Want me to ship the new checkout behind the flag, or wait for the copy review?' }),
  chat(P('storefront'), 'SHOP_search', { ...live('mac', 'busy'), family: 'SHOP', ago: 0, contextPct: 31, rssMb: 744,
    lastLine: 'Reindexing 48,210 products with the new synonym table, 61% done.' }),
  chat(P('storefront'), 'SHOP_seo', { family: 'SHOP', ago: 190, contextPct: 22, lastLine: 'Sitemaps regenerated: 3 files, 48,210 URLs, all 200.' }),
  chat(P('storefront'), 'SHOP_images', { family: 'SHOP', ago: 600, modelShort: 'sonnet 5.5', effort: 'high', lastLine: 'Converted 12,400 images to AVIF, saving 3.1 GB.' }),
  // api-gateway: the API family
  chat(P('api-gateway'), 'API_auth', { ...live('mac', 'idle'), family: 'API', needsYou: true, ago: 11, contextPct: 72, rssMb: 538,
    lastLine: 'Two ways to rotate the signing keys without logging anyone out. Should I go with the overlap window or the key ring?' }),
  chat(P('api-gateway'), 'API_ratelimit', { ...live('mac', 'shell'), family: 'API', ago: 1, contextPct: 38, rssMb: 902,
    lastLine: 'Load test at 2,000 req/s: p99 41 ms, no 429s below the limit.' }),
  chat(P('api-gateway'), 'API_ci', { ...live('mac', 'idle'), family: 'API', ago: 26, contextPct: 18, rssMb: 410, modelShort: 'sonnet 5.5', effort: 'medium',
    lastLine: 'CI is green on all 6 jobs; build time down from 9m 40s to 6m 05s.' }),
  chat(P('api-gateway'), 'API_docs', { family: 'API', ago: 1500, lastLine: 'OpenAPI spec regenerated from the routes.' }),
  // data-pipeline: running on the remote
  chat(P('data-pipeline'), 'ETL_crawl', { ...live('remote', 'busy'), family: 'ETL', ago: 0, contextPct: 55, rssMb: 466, modelShort: 'sonnet 5.5', effort: 'high',
    lastLine: 'Crawled 18,400 of 52,000 listings; 0 errors, 3 retries.' }),
  chat(P('data-pipeline'), 'ETL_backfill', { ...live('remote', 'idle'), family: 'ETL', needsYou: true, ago: 8, contextPct: 63, rssMb: 391,
    lastLine: 'The March partition has 1,204 duplicate rows. Delete them, or keep both and flag them?' }),
  chat(P('data-pipeline'), 'ETL_reports', { ...live('remote', 'idle'), family: 'ETL', ago: 44, contextPct: 27, rssMb: 352,
    lastLine: 'Weekly report built: 14 charts, 2 anomalies noted.' }),
  // docs-site
  chat(P('docs-site'), 'DOCS_search', { ...live('mac', 'idle'), family: 'DOCS', ago: 19, contextPct: 81, rssMb: 487,
    stoppedOn: { kind: 'limit', text: "You've hit your session limit · resets 4:10pm", at: null }, needsYou: true,
    lastLine: "You've hit your session limit · resets 4:10pm" }),
  chat(P('docs-site'), 'DOCS_build', { family: 'DOCS', ago: 320, lastLine: 'Site built in 38 s; 412 pages, no broken links.' }),
  chat(P('docs-site'), 'DOCS_i18n', { family: 'DOCS', ago: 2900, modelShort: 'opus 5', effort: 'high', lastLine: 'German and Japanese strings merged.' }),
  // mobile-app, single chats
  chat(P('mobile-app'), 'ios_release', { ...live('mac', 'busy', { quietMin: 23 }), ago: 23, contextPct: 49, rssMb: 1240,
    lastLine: 'Archiving the 2.8 build for TestFlight.' }),
  chat(P('mobile-app'), 'android_crash', { ago: 95, lastLine: 'Fixed: the crash came from a null locale on first launch.' }),
  // the projects folder itself
  chat(root, 'Weekly_planning', { ...live('mac', 'idle'), ago: 52, contextPct: 12, rssMb: 298, modelShort: 'opus 5.5', effort: 'high',
    lastLine: 'Plan for the week is in docs/plan.md.' }),
  chat(root, 'Repo_cleanup', { ago: 4300, lastLine: 'Archived 9 old branches.' }),
  // a second folder of work
  chat(`${home}/code/ml-notebook`, 'Model_eval', { ago: 210, modelShort: 'opus 5.5', effort: 'max', lastLine: 'Eval done: 0.912 F1 on the held-out set, up from 0.874.' }),
  chat(`${home}/code/ml-notebook`, 'Feature_store', { ago: 8800, lastLine: 'Feature store schema v3 migrated.' }),
];

// A second copy under one name, folded under the newer one.
const older = chat(P('storefront'), 'SHOP_search', { family: 'SHOP', ago: 3000, lastLine: 'First pass at the synonym table.' });
sessions.push(older);
const primary = sessions.find((s) => s.name === 'SHOP_search' && s.live);
for (const [s, rank, role] of [[primary, 0, 'running'], [older, 1, 'older']]) Object.assign(s, { sameNameCount: 2, sameNameRank: rank, sameNamePrimaryId: primary.sessionId, sameNameRole: role });

const order = [root, P('storefront'), P('api-gateway'), P('data-pipeline'), P('docs-site'), P('mobile-app'), `${home}/code/ml-notebook`];
const own = (cwd) => sessions.filter((s) => s.cwd === cwd);
const projects = order.map((cwd) => {
  const top = cwd === root || cwd.startsWith(`${home}/code`);
  const mine = own(cwd);
  const all = cwd === root ? sessions.filter((s) => s.cwd.startsWith(root)) : mine;
  return {
    label: cwd, cwd, projectDir: mine[0].projectDir, bytes: mine.reduce((n, s) => n + s.bytes, 0),
    liveCount: mine.filter((s) => s.live).length, sessionCount: mine.length, sessions: mine,
    depth: top ? 0 : 1, parent: top ? null : root,
    allSessions: all, allBytes: all.reduce((n, s) => n + s.bytes, 0), allLiveCount: all.filter((s) => s.live).length,
  };
});

const health = (level, reasons, usedPct) => ({ level, reasons, usedPct });
const overview = {
  home,
  projects,
  totals: {
    projects: projects.length, sessions: sessions.length, bytes: sessions.reduce((n, s) => n + s.bytes, 0),
    live: sessions.filter((s) => s.live).length, liveMac: sessions.filter((s) => s.machine === 'mac').length,
    liveRemote: sessions.filter((s) => s.machine === 'remote').length, needsYou: sessions.filter((s) => s.needsYou).length,
    skipped: 0, sdkHidden: 312,
  },
  restore: {
    count: 2, capturedAt: min(180), source: 'snapshot', remoteCount: 0,
    groups: [{ cwd: P('mobile-app'), lastSeen: min(180), sessions: [
      { sessionId: id(), name: 'android_build', cwd: P('mobile-app'), machine: 'mac' },
      { sessionId: id(), name: 'store_listing', cwd: P('mobile-app'), machine: 'mac' },
    ] }],
  },
  mac: {
    totalMb: 24576, usedMb: 21120, swapTotalMb: 8192, swapUsedMb: 7370, pressure: 'warn', load1: 9.1, cores: 12, tempC: null,
    diskFreeMb: 184_000, swapDynamic: true, swapInMbPerMin: 34, swapOutMbPerMin: 12,
    health: health('strained', ['memory pressure warning', '86% memory used', 'swapping in 34 MB/min'], 86),
  },
  autoBalance: { enabled: false, idleMin: 20, last: null },
  accounts: { available: true },
  usage: [
    { slot: 1, active: true, stale: false, failing: false, ...windows[0] },
    { slot: 2, active: false, stale: false, failing: false, ...windows[1] },
    { slot: 3, active: false, stale: false, failing: false, ...windows[2] },
  ],
  background: [
    { id: 'bg-release-notes', name: 'release_notes', cwd: P('docs-site'), sessionId: id(), needs: 'Approve publishing the 1.4 changelog to the docs site?',
      detail: 'Changelog drafted from 38 merged pull requests', suggestedReply: 'yes, publish it', updatedAt: min(35), stale: false },
    { id: 'bg-old-1', name: 'deps_audit', cwd: P('api-gateway'), sessionId: id(), needs: 'Pick which of 3 major upgrades to try first', detail: null, suggestedReply: null, updatedAt: now - 9 * 86_400_000, stale: true },
  ],
  remote: {
    configured: true, label: 'Devbox', localProjectsRoot: root, reachable: true, stale: false, checkedAt: now, lastReachableAt: now,
    memTotalMb: 15209, memAvailableMb: 11850, liveCount: 3, error: null,
    load: { totalMb: 15209, usedMb: 3359, swapTotalMb: 32768, swapUsedMb: 0, swapOutMbPerMin: 0, swapInMbPerMin: 0, psiMem60: 0, pressure: null, load1: 1.4, cores: 16, tempC: 58 },
    health: health('ok', [], 22),
  },
  configErrors: [],
  recorder: { installed: true, loaded: true, armed: true, problem: null, mode: 'interval', running: false, pid: null },
  autoTasks: { enabled: true, present: true, value: 'on', readable: true },
  persistence: { value: false, present: true, readable: true, effective: false },
};

overview.__rpc = {
  accounts: {
    ok: true, mostRoom: 3, accounts: [
      { number: 1, email: 'dev@example.com', org: 'Example Labs', active: true, status: 'ok', ...windows[0], models: [{ name: 'Fable', pct: 18, resetsAt: null }], loginExpiresAt: inMin(35 * day), ageSeconds: 70 },
      { number: 2, email: 'team@example.org', org: 'Example Org', active: false, status: 'ok', ...windows[1], models: [{ name: 'Fable', pct: 51, resetsAt: null }], loginExpiresAt: inMin(1020), ageSeconds: 140 },
      { number: 3, email: 'side@example.net', org: 'Side Project', active: false, status: 'ok', ...windows[2], models: [{ name: 'Fable', pct: 4, resetsAt: null }], loginExpiresAt: inMin(47 * day), ageSeconds: 95 },
    ],
  },
  lastMessage: {
    at: new Date(min(4)).toISOString(),
    text: `The new checkout is ready. Here is where it stands.

## What changed
1. **One page instead of three.** Address, shipping and payment sit together, with inline validation.
   - Card errors show next to the field, not in a banner.
2. **Saved carts survive a sign-in.** The guest cart merges into the account cart on login.
3. \`checkout_v2\` is a feature flag, off by default.

## Tests
| Suite | Result |
|---|---|
| Unit | 412 passed |
| Cart, Safari and Chrome | 38 passed |
| Payments sandbox | 12 passed |

Want me to ship the new checkout behind the flag, or wait for the copy review?`,
  },
  peek: { ok: true, text: `● Crawled 18,400 of 52,000 listings
  ⎿ 0 errors, 3 retries, 412 listings/min

● Bash(python crawl.py --resume --from 18400)
  ⎿ Running…

✶ Crawling… (12m 40s · ↓ 18.2k tokens)

────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)` },
  searchAll: { ok: true, hits: [] },
  setAutoBalance: { ok: true },
};

process.stdout.write(JSON.stringify(overview));
