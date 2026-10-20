/**
 * Lets a chat on one machine message a chat on the other with Claude Code's own SendMessage.
 *
 * Claude Code reaches only chats whose message socket is on its own machine, or Remote Control
 * ones on the same account. With `"relay": true` in config.json, the recorder mirrors every
 * chat's socket onto the other machine over one ssh connection. A chat's mirror lives in a
 * folder of its own, /tmp/cc-socks-<1000000 + the uid it runs under>/<its socket's name>, so it
 * never meets a socket of the machine it is mirrored to, whichever systems the two run. A
 * message arrives as a real <cross-session-message> and the reply comes back the same way.
 *
 * Each machine also gets ~/.claude-switchboard/remote-peers.json: every chat on the other
 * machine with its name, its mirror here and its own address there. tools/relay/
 * switchboard_relay.py, a Claude Code hook, reads it to tell a chat where an @-named chat on the
 * other machine is, and to send to a name or a `from` address that only the other machine has.
 *
 * Claude Code's @ list and ListAgents read only ~/.claude/sessions/<pid>.json, so each machine
 * also gets a stand-in record per named chat on the other one (standInRecord).
 *
 * ponytail: rests on Claude Code accepting a message relayed through ssh, which its receiver
 * does today (it records the relay's pid). If it starts asking each sender for a token, relayed
 * messages are dropped and this needs another way in.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { SESSIONS_DIR, stateDir } from './paths.js';
import { readConfig } from './config.js';

const ctl = () => path.join(stateDir(), 'relay.ctl');
export const MIRROR_BASE = 1_000_000;
const SOCKET = /^\/\S+\/([\w-]+\.sock)$/;
// Above any real pid (Linux pid_max is at most 4194304, macOS 99998): no liveness check here or in
// Claude Code finds it alive, so nothing counts it as a local chat or its name as taken.
const STAND_IN_PID = 900_000_000;

/**
 * Pure. Claude Code's record for a chat on the other machine, at its mirror. A pidDomain that is not
 * this machine's makes Claude Code skip the pid check, list the chat while the mirror answers, and
 * never delete the file. No sessionId, so a resume or compaction never reads the chat as held here;
 * no procStart, so a send never expects the relay's ssh to be that process.
 */
export function standInRecord(s, sock, machine) {
  return {
    pid: STAND_IN_PID + s.pid, name: s.name, cwd: s.cwd, kind: 'interactive', messagingSocketPath: sock,
    pidDomain: `relay:${machine}`, relayMirror: machine, startedAt: s.startedAt ?? 0,
    ...(s.status && { status: s.status }), ...(s.statusUpdatedAt && { statusUpdatedAt: s.statusUpdatedAt }),
  };
}

// Writes stdin's records into ~/.claude/sessions and drops stand-ins no longer listed. Python, so the
// same lines run here and over ssh on the remote.
const WRITE_RECORDS_PY = `import json, os, re, sys
d = os.path.expanduser("~/.claude/sessions"); keep = set()
os.makedirs(d, exist_ok=True)
for r in json.load(sys.stdin):
    f = os.path.join(d, "%d.json" % r["pid"]); keep.add(os.path.basename(f))
    with open(f + ".tmp", "w") as fh: json.dump(r, fh)
    os.chmod(f + ".tmp", 0o600); os.replace(f + ".tmp", f)
for n in os.listdir(d):
    if re.fullmatch(r"9\\d{8}\\.json", n) and n not in keep:
        try:
            with open(os.path.join(d, n)) as fh:
                if "relayMirror" in json.load(fh): os.remove(os.path.join(d, n))
        except (OSError, ValueError): pass
`;

/** Where a chat's socket is mirrored on the other machine, or null for a path that is not one. */
export function mirrorPath(sock, uid) {
  const m = SOCKET.exec(sock ?? '');
  return m && Number.isInteger(uid) && uid >= 0 ? `/tmp/cc-socks-${MIRROR_BASE + uid}/${m[1]}` : null;
}

/** This machine as the other one names it. */
export function localLabel() {
  return process.platform === 'darwin' ? 'the Mac' : os.hostname().split('.')[0];
}

/**
 * Pure. The forwards that should exist, keyed for the state file, and each machine's list of
 * the other machine's chats.
 *
 * @param {{local:Array<{name?:string|null, messagingSocketPath?:string|null}>, remote:Array<object>,
 *          localUid:number, remoteUid:number, remoteLabel:string, here?:string}} input
 */
export function relayPlan({ local, remote, localUid, remoteUid, remoteLabel, here = localLabel() }) {
  const forwards = {};
  const onLocal = [];
  const onRemote = [];
  const recordsLocal = [];
  const recordsRemote = [];
  const named = (s) => s.name && Number.isInteger(s.pid) && s.pid > 0 && s.cwd;
  for (const s of remote) {
    const mirror = mirrorPath(s.messagingSocketPath, remoteUid);
    if (!mirror) continue;
    forwards[`L ${mirror}`] = ['-L', `${mirror}:${s.messagingSocketPath}`];
    onLocal.push({ name: s.name ?? null, to: `uds:${mirror}`, addr: `uds:${s.messagingSocketPath}`, machine: remoteLabel });
    if (named(s)) recordsLocal.push(standInRecord(s, mirror, remoteLabel));
  }
  for (const s of local) {
    const mirror = mirrorPath(s.messagingSocketPath, localUid);
    if (!mirror) continue;
    forwards[`R ${mirror}`] = ['-R', `${mirror}:${s.messagingSocketPath}`];
    onRemote.push({ name: s.name ?? null, to: `uds:${mirror}`, addr: `uds:${s.messagingSocketPath}`, machine: here });
    if (named(s)) recordsRemote.push(standInRecord(s, mirror, here));
  }
  return { forwards, onLocal, onRemote, recordsLocal, recordsRemote };
}

/** ssh through the relay's own connection; resolves true on exit 0. Never waits on a backgrounded child. */
function ssh(host, args, input) {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', `ControlPath=${ctl()}`, ...args, host].concat(input?.remote ?? []),
      { stdio: [input?.stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    if (input?.stdin !== undefined) child.stdin.end(input.stdin);
  });
}

/** Open the shared connection unless it is up. True when it had to be opened, so every forward is gone. */
async function ensureMaster(host) {
  if (await ssh(host, ['-O', 'check'])) return false;
  fs.rmSync(ctl(), { force: true });
  // StreamLocalBindUnlink: a mirror left here by the last connection would block the new one.
  const up = await ssh(host, ['-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'StreamLocalBindUnlink=yes', '-fN']);
  if (!up) throw new Error('could not open the relay connection to the remote');
  return true;
}

/** One tick: make the mirrors match the chats running on both machines. Off unless config.relay. */
export async function syncRelay({ remote, mac: local, file = path.join(stateDir(), 'relay.json'), config = readConfig() }) {
  if (!config.relay || !config.remote || !remote?.reachable || remote.stale || !Number.isInteger(remote.uid)) return null;
  const host = config.remote.host;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (await ensureMaster(host)) state = {};
  const plan = relayPlan({ local, remote: remote.sessions ?? [], localUid: process.getuid(), remoteUid: remote.uid, remoteLabel: config.remote.label });
  const had = state.forwards ?? {};
  const fresh = Object.keys(plan.forwards).filter((k) => !had[k]);
  const gone = Object.keys(had).filter((k) => !plan.forwards[k]);

  for (const k of gone) {
    await ssh(host, ['-O', 'cancel', ...had[k]]);
    if (k.startsWith('L ')) fs.rmSync(k.slice(2), { force: true });
  }
  for (const k of fresh) if (k.startsWith('L ')) fs.mkdirSync(path.dirname(k.slice(2)), { recursive: true, mode: 0o700 });
  // A mirror left on the remote by an earlier connection blocks the bind; nothing else uses these folders.
  const remoteNew = fresh.filter((k) => k.startsWith('R ')).map((k) => k.slice(2));
  if (remoteNew.length) {
    const dirs = [...new Set(remoteNew.map((p) => path.dirname(p)))];
    await ssh(host, [], { remote: [`mkdir -p -m 700 ${dirs.map((d) => `'${d}'`).join(' ')} && rm -f ${remoteNew.map((p) => `'${p}'`).join(' ')}`] });
  }
  const forwards = Object.fromEntries(Object.entries(had).filter(([k]) => plan.forwards[k]));
  for (const k of fresh) if (await ssh(host, ['-O', 'forward', ...plan.forwards[k]])) forwards[k] = plan.forwards[k];

  const onLocal = JSON.stringify(plan.onLocal);
  const onRemote = JSON.stringify(plan.onRemote);
  if (onLocal !== state.onLocal) fs.writeFileSync(path.join(stateDir(), 'remote-peers.json'), onLocal);
  const remoteWritten = onRemote === state.onRemote
    || await ssh(host, [], { remote: ['mkdir -p ~/.claude-switchboard && cat > ~/.claude-switchboard/remote-peers.json.tmp && mv ~/.claude-switchboard/remote-peers.json.tmp ~/.claude-switchboard/remote-peers.json'], stdin: onRemote });

  const recordsLocal = JSON.stringify(plan.recordsLocal);
  const recordsRemote = JSON.stringify(plan.recordsRemote);
  if (recordsLocal !== state.recordsLocal || plan.recordsLocal.some((r) => !fs.existsSync(path.join(SESSIONS_DIR, `${r.pid}.json`)))) {
    spawnSync('python3', ['-c', WRITE_RECORDS_PY], { input: recordsLocal, timeout: 10_000 });
  }
  const remoteRecords = recordsRemote === state.recordsRemote
    || await ssh(host, [], { remote: [`python3 -c '${WRITE_RECORDS_PY.replace(/'/g, `'\\''`)}'`], stdin: recordsRemote });
  fs.writeFileSync(file, JSON.stringify({ forwards, onLocal, onRemote: remoteWritten ? onRemote : null,
    recordsLocal, recordsRemote: remoteRecords ? recordsRemote : null }));
  return { added: fresh.length, removed: gone.length, mirrored: Object.keys(forwards).length };
}
