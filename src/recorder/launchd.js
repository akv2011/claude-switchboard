/**
 * Keep the recorder running across logins, using launchd.
 *
 * KeepAlive restarts it if it ever dies, RunAtLoad starts it at login. Without
 * this the recorder is only running when you remember to start it, and the one
 * time you forget is the time the laptop dies.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stateDir } from '../core/paths.js';

export const LABEL = 'io.github.claude-switchboard.recorder';

const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const PLIST_PATH = path.join(AGENTS_DIR, `${LABEL}.plist`);

/**
 * Where launchd runs the recorder from: the copy scripts/install.sh makes in
 * ~/.claude-switchboard/recorder, so an edit in the source tree reaches it only
 * at install. Running the source tree itself put every half-made edit live on
 * the next 30 s tick. From inside the built app this file's own URL points
 * into the bundle, where no daemon.js exists.
 */
export const snapshotEntry = () => path.join(os.homedir(), '.claude-switchboard', 'recorder', 'src', 'recorder', 'daemon.js');

function daemonEntry() {
  return fs.existsSync(snapshotEntry()) ? snapshotEntry() : fileURLToPath(new URL('./daemon.js', import.meta.url));
}

/**
 * Two ways to run the recorder, as measured on an Apple silicon Mac:
 *
 *   resident  KeepAlive process polling itself. ~40 MB RSS under node, ~29 MB
 *             under bun, 0.0% CPU. Snapshot is never more than 5s stale.
 *   interval  launchd owns the timer and runs a one-shot tick. NOTHING stays
 *             resident: 0 MB between ticks, ~90 ms of work per tick. Snapshot
 *             can be up to `intervalSeconds` stale, which is harmless because
 *             sessions live for hours.
 *
 * @param {{mode?:'resident'|'interval', intervalSeconds?:number,
 *          nodePath?:string, entry?:string}} [options]
 */
/**
 * The interpreter the agent runs. Never a versioned Cellar path such as
 * /opt/homebrew/Cellar/node/<version>/bin/node: the next Homebrew upgrade
 * removes it, and every tick then dies in the dynamic loader ("Library not
 * loaded") while launchd still reports the job loaded. The bin/ symlink
 * follows upgrades.
 */
export function stableNodePath() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

/** Size past which launchd's own stderr log is reset. It only holds failures. */
const MAX_ERR_LOG_BYTES = 1024 * 1024;

export function trimErrorLog() {
  const file = path.join(stateDir(), 'launchd.err.log');
  try {
    if (fs.statSync(file).size > MAX_ERR_LOG_BYTES) fs.truncateSync(file, 0);
  } catch { /* no log yet */ }
}

export function buildPlist({
  mode = 'interval',
  intervalSeconds = 30,
  nodePath = stableNodePath(),
  entry = daemonEntry(),
} = {}) {
  const args = mode === 'interval'
    ? `    <string>${nodePath}</string>\n    <string>${entry}</string>\n    <string>--once</string>`
    : `    <string>${nodePath}</string>\n    <string>${entry}</string>`;

  const schedule = mode === 'interval'
    ? `  <key>StartInterval</key><integer>${intervalSeconds}</integer>\n  <key>RunAtLoad</key><true/>`
    : '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${schedule}
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${path.join(stateDir(), 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(stateDir(), 'launchd.err.log')}</string>
</dict>
</plist>
`;
}

export function install(options = {}) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(stateDir(), { recursive: true });
  trimErrorLog();
  fs.writeFileSync(PLIST_PATH, buildPlist(options), 'utf8');

  const uid = process.getuid();
  // bootout first so reinstalling picks up a changed plist.
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch { /* not loaded yet */ }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], { stdio: 'inherit' });
  return PLIST_PATH;
}

export function uninstall() {
  const uid = process.getuid();
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch { /* already gone */ }
  try {
    fs.unlinkSync(PLIST_PATH);
  } catch { /* already gone */ }
}

/**
 * Is the recorder actually protecting you?
 *
 * "running" cannot mean "a process exists right now". In interval mode nothing
 * is resident between ticks, so a PID check would report the recorder as off
 * ~99% of the time and the UI would scream about a working setup. What matters
 * is whether launchd has the agent loaded, so that is what `armed` reports.
 */
export function status() {
  const uid = process.getuid();
  const installed = fs.existsSync(PLIST_PATH);
  const mode = readMode();

  try {
    // stderr is swallowed: launchctl prints "Could not find service" when the
    // agent simply is not installed, which is a normal state, not an error.
    const out = execFileSync('launchctl', ['print', `gui/${uid}/${LABEL}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = out.match(/\bpid = (\d+)/)?.[1] ?? null;
    // Loaded is not working. launchd records how the last tick ended; a tick
    // that could not even start (a moved interpreter) exits with a dyld reason,
    // and the recorder has then been capturing nothing for however long.
    const exitCode = Number(out.match(/last exit code = (\d+)/)?.[1] ?? 0);
    const exitReason = out.match(/last exit reason = (\S+)/)?.[1] ?? null;
    const broken = exitCode !== 0 || (exitReason !== null && exitReason !== 'OS_REASON_EXEC');
    const problem = broken
      ? (exitReason === 'OS_REASON_DYLD'
        ? 'its node binary is gone (a Homebrew upgrade moved it); repair reinstalls it'
        : `last tick failed (exit ${exitCode}${exitReason ? `, ${exitReason}` : ''})`)
      : null;
    return {
      installed: true,
      loaded: true,
      armed: !broken,
      problem,
      mode,
      running: pid !== null,
      pid: pid ? Number(pid) : null,
    };
  } catch {
    return { installed, loaded: false, armed: false, problem: null, mode, running: false, pid: null };
  }
}

/** Which mode the installed agent uses, read back from the plist itself. */
function readMode() {
  try {
    const plist = fs.readFileSync(PLIST_PATH, 'utf8');
    if (plist.includes('<key>StartInterval</key>')) {
      const seconds = plist.match(/<key>StartInterval<\/key><integer>(\d+)<\/integer>/)?.[1];
      return { kind: 'interval', intervalSeconds: seconds ? Number(seconds) : null };
    }
    return { kind: 'resident', intervalSeconds: null };
  } catch {
    return { kind: null, intervalSeconds: null };
  }
}
