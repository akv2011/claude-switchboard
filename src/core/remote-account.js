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

export async function followLocalAccount({ say = () => {} } = {}) {
  const remote = remoteConfig();
  if (!remote || !cswapPath()) return;
  const stamp = path.join(stateDir(), 'remote-account.json');
  let last = {};
  try { last = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { /* first run */ }
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
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify({ at: Date.now(), localActive }));
  } catch { /* checked again next tick */ }
}
