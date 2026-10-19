/**
 * The remote machine's Claude account follows this Mac's.
 *
 * A claude-swap switch here moves every chat on this Mac to the new account.
 * Chats on the remote should follow the same way, or a chat moved there runs
 * on whatever account the remote last had, another organization's limits and
 * data included. So the recorder switches the remote to this Mac's active
 * account when the remote has it, else to one of the same organization, else
 * leaves it alone. On Linux a running chat picks up a switch on its next
 * message (claude-swap's README).
 *
 * The Accounts page can also put the remote on an account by hand, for when the
 * account it follows is spent there or has no login there; it then stays on that
 * account until "Follow this Mac".
 *
 * Runs only with a remote configured and claude-swap installed here; a remote
 * without claude-swap is left as it is. Register the remote's accounts under
 * this Mac's slot numbers, from setup tokens (`cswap add-token`), never copied
 * logins: a copied login is logged out here the first time the remote renews
 * it. A slot counts only when its email matches this Mac's, so a numbering slip
 * cannot pick another person's account.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cswapPath, listAccounts, parseAccounts } from './accounts.js';
import { remoteConfig, sshScript } from './remote.js';
import { stateDir } from './paths.js';

// Unless this Mac's account changed, the remote is checked this often.
const EVERY_MS = 5 * 60_000;

/** Pure: the remote slot to switch to, or null to leave the remote as it is. */
export function pickRemoteAccount(local, remote) {
  const active = local.find((a) => a.active);
  if (!active) return null;
  const onRemote = (a) => remote.some((r) => r.number === a.number && r.email && r.email === a.email);
  const pick = onRemote(active) ? active : local.find((a) => a.org && a.org === active.org && onRemote(a));
  if (!pick || remote.some((r) => r.active && r.number === pick.number)) return null;
  return pick.number;
}

// Under the remote user's login shell, so PATH includes wherever claude-swap is installed there.
const cswapOnRemote = (host, args) => sshScript(host, `exec "\${SHELL:-/bin/sh}" -lc 'cswap ${args}'`);

const stampFile = () => path.join(stateDir(), 'remote-account.json');
function readStamp() {
  try { return JSON.parse(fs.readFileSync(stampFile(), 'utf8')); } catch { return {}; }
}
function writeStamp(next) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${stampFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, stampFile());
  } catch { /* checked again next tick */ }
}
const brief = (list) => list.map((a) => ({ number: a.number, email: a.email, active: a.active }));

/**
 * The remote's accounts, the one in use, and whether one was picked by hand. Read over ssh
 * at most every 5 minutes unless `fresh`; otherwise from the last reading.
 */
export async function remoteAccounts({ fresh = false } = {}) {
  const remote = remoteConfig();
  if (!remote) return { ok: false, error: 'no remote is configured', accounts: [], pinned: null, at: null };
  const last = readStamp();
  if (!fresh && last.remote && Date.now() - (last.remoteAt ?? 0) < EVERY_MS) {
    return { ok: true, accounts: last.remote, pinned: last.pinned ?? null, at: last.remoteAt };
  }
  try {
    const listed = await cswapOnRemote(remote.host, 'list --json');
    const accounts = brief(parseAccounts(JSON.parse(listed.stdout)));
    const at = Date.now();
    writeStamp({ ...readStamp(), remote: accounts, remoteAt: at });
    return { ok: true, accounts, pinned: last.pinned ?? null, at };
  } catch {
    return { ok: false, error: `${remote.label} is not answering, or has no claude-swap`, accounts: last.remote ?? [], pinned: last.pinned ?? null, at: last.remoteAt ?? null };
  }
}

/**
 * Put the remote on account N by hand. It then stays there, no longer following this Mac,
 * until followLocalOnRemote: an account spent on the remote, or one it has no login for,
 * otherwise left it on the account it followed.
 */
export async function useOnRemote(number, { say = () => {} } = {}) {
  const remote = remoteConfig();
  const n = Number(number);
  const list = await remoteAccounts({ fresh: true });
  if (!remote || !list.ok) return { ok: false, error: list.error };
  if (!list.accounts.some((a) => a.number === n)) {
    return { ok: false, error: `account ${n} has no login on ${remote.label}; add it there with claude setup-token, then cswap add-token` };
  }
  const r = await cswapOnRemote(remote.host, `switch ${n}`);
  if (!r.ok) return { ok: false, error: `could not switch ${remote.label}: ${r.error}` };
  writeStamp({ ...readStamp(), pinned: n });
  say(`remote account: switched ${remote.label} to account ${n} by hand; it no longer follows this Mac`);
  return { ok: true, number: n, ...(await remoteAccounts({ fresh: true })) };
}

/** Let the remote follow this Mac's account again, checked now rather than in 5 minutes. */
export async function followLocalOnRemote({ say = () => {} } = {}) {
  const { pinned, ...rest } = readStamp();
  writeStamp({ ...rest, at: 0 });
  if (pinned) say(`remote account: follows this Mac's account again (was on account ${pinned} by hand)`);
  await followLocalAccount({ say });
  return { ok: true, ...(await remoteAccounts({ fresh: true })) };
}

export async function followLocalAccount({ say = () => {} } = {}) {
  const remote = remoteConfig();
  if (!remote || !cswapPath()) return;
  const last = readStamp();
  // Picked by hand on the Accounts page: left there until "Follow this Mac".
  if (last.pinned) return;
  const local = listAccounts();
  if (!local.ok) return;
  const localActive = local.accounts.find((a) => a.active)?.number ?? null;
  if (localActive === last.localActive && Date.now() - (last.at ?? 0) < EVERY_MS) return;
  let onRemote;
  try {
    const listed = await cswapOnRemote(remote.host, 'list --json');
    onRemote = parseAccounts(JSON.parse(listed.stdout));
  } catch {
    return; // the remote is off, or has no claude-swap; the next tick tries again
  }
  const slot = pickRemoteAccount(local.accounts, onRemote);
  if (Number.isInteger(slot)) {
    const r = await cswapOnRemote(remote.host, `switch ${slot}`);
    const email = local.accounts.find((a) => a.number === slot)?.email;
    say(r.ok
      ? `remote account: switched ${remote.label} to account ${slot} (${email}), following this Mac's account ${localActive}`
      : `remote account: could not switch ${remote.label} to account ${slot}: ${r.error}`);
    if (r.ok) onRemote = onRemote.map((a) => ({ ...a, active: a.number === slot }));
  }
  writeStamp({ ...readStamp(), at: Date.now(), localActive, remote: brief(onRemote), remoteAt: Date.now() });
}
