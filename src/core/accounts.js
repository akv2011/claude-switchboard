/**
 * Claude accounts through claude-swap (cswap), the parts that are safe to
 * drive from a window: read the accounts, switch the active one, and start a
 * chat as a given account in a VS Code terminal.
 *
 * claude-swap is optional. Without `cswap` on PATH (or in ~/.local/bin) the
 * window hides the Accounts tab and the recorder sends no usage notifications.
 *
 * Left to the terminal on purpose: add, add-token, remove, export, import and
 * purge. They create, copy or delete credentials.
 *
 * A switch is global on this Mac: per claude-swap's README, running chats
 * pick up the new account within about 30 s (the Keychain cache), and new
 * ones start on it. A remote machine has its own login and is not touched.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { runInVscodeTerminal, shq } from './vscode-bridge.js';
import { cleanEnv } from '../restore/tasks.js';
import { findBin } from './paths.js';

/** Where cswap is installed, or null. Looked up per call, so installing it needs no restart. */
export const cswapPath = () => findBin('cswap');

const win = (w) => (w && Number.isFinite(Number(w.pct))
  ? { pct: Math.round(Number(w.pct)), resetsAt: w.resetsAt ?? w.resets_at ?? null }
  : null);

/** `cswap list --json` in the shape the window uses. Pure. */
export function parseAccounts(raw) {
  return (raw?.accounts ?? []).map((a) => ({
    number: a.number,
    email: a.email ?? null,
    org: a.organizationName ?? null,
    active: Boolean(a.active),
    status: a.usageStatus ?? null,
    fiveHour: win(a.usage?.fiveHour),
    sevenDay: win(a.usage?.sevenDay),
    models: (a.usage?.scoped ?? []).map((m) => ({ name: m.name, ...win(m) })).filter((m) => m.name && Number.isFinite(m.pct)),
    loginExpiresAt: a.loginExpiresAt ?? null,
    ageSeconds: Number.isFinite(a.usageAgeSeconds) ? Math.round(a.usageAgeSeconds) : null,
  }));
}

/** The account with the most room: lowest of its 5-hour and weekly use, the busier window deciding. */
export function mostRoom(accounts) {
  const load = (a) => Math.max(a.fiveHour?.pct ?? 100, a.sevenDay?.pct ?? 100);
  return [...accounts].filter((a) => a.status === 'ok').sort((a, b) => load(a) - load(b))[0]?.number ?? null;
}

export function listAccounts() {
  const cswap = cswapPath();
  if (!cswap) return { ok: false, accounts: [], error: 'claude-swap is not installed (no cswap on PATH)' };
  try {
    const out = execFileSync(cswap, ['list', '--json'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const accounts = parseAccounts(JSON.parse(out));
    return { ok: true, accounts, mostRoom: mostRoom(accounts) };
  } catch (err) {
    return { ok: false, accounts: [], error: `cswap list failed: ${err.message}` };
  }
}

/** Accept only an account number cswap itself lists. */
function known(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) return null;
  return listAccounts().accounts.some((a) => a.number === n) ? n : null;
}

export function switchAccount(number) {
  const n = known(number);
  if (!n) return Promise.resolve({ ok: false, error: `no account ${number}` });
  return new Promise((resolve) => {
    execFile(cswapPath(), ['switch', String(n)], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr || stdout || err.message).trim().split('\n').pop() } : { ok: true, number: n });
    });
  });
}

/** A new chat as account N in a VS Code terminal on `cwd`; other terminals keep their account. */
export function newChatAs(number, cwd) {
  const n = known(number);
  if (!n) return Promise.resolve({ ok: false, error: `no account ${number}` });
  if (typeof cwd !== 'string' || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return Promise.resolve({ ok: false, error: 'pick a folder that exists' });
  }
  return runInVscodeTerminal({ cwd, name: `account ${n}`, text: `${cleanEnv()} ${shq(cswapPath())} run ${n}` });
}
