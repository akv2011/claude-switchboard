/**
 * Enumerate every chat that has ever existed, grouped by project.
 *
 * Two things worth knowing about the on-disk layout:
 *
 * 1. Most .jsonl files under ~/.claude/projects are not sessions: they are
 *    subagent transcripts nested at <project>/<sessionId>/subagents/*.jsonl
 *    (on one real store, 235 sessions among 1,008 files). Only top level
 *    files count.
 *
 * 2. The project directory name cannot be turned back into a path (see
 *    paths.js). The real cwd is read out of the transcript body instead.
 */

import { markFamilies, markSameNames } from './families.js';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, isSessionId, encodeCwd, isInsidePath, canBeWorkspaceRoot } from './paths.js';
import { readHead, parseLines } from './jsonl.js';
import { resolveName } from './names.js';
import { readTailFacts, shortModel, asksForYou, contextWindow, permissionLabel } from './model.js';
import { readLiveSessions, readRunningSessionIds, readResidentMemory } from './registry.js';
import { readScanCache, writeScanCache, cacheHit } from './scan-cache.js';
import { readConfig } from './config.js';

/**
 * The live registry's name, unless Claude Code invented it.
 *
 * nameSource "derived" means the name was generated from the directory, like
 * "projects-d8" or "webapp-40". Those are placeholders and lose to a title you
 * actually set, which lives in the transcript. Any other source, including a
 * missing one on older registries, is fresher than the transcript and wins.
 *
 * @param {{name?:string|null, nameSource?:string|null}|null} liveEntry
 * @param {string|null} fromTranscript
 */
export function preferredLiveName(liveEntry, fromTranscript) {
  const name = liveEntry?.name ?? null;
  if (!name) return null;
  if (liveEntry?.nameSource === 'derived' && fromTranscript) return null;
  return name;
}

/** Authoritative working directory for a session, read from its transcript. */
export function readCwd(file, sessionId) {
  return readHeadFacts(file, sessionId).cwd;
}

/**
 * The cwd and the entrypoint, from one read of the head.
 *
 * The entrypoint says how the session was started. "sdk-cli" means a program
 * ran it, not a person: one experiment harness can leave thousands of
 * transcripts that way and bury the few dozen real chats among them.
 * registry.js applies the same rule to live sessions.
 */
export function readHeadFacts(file, sessionId) {
  const entries = parseLines(readHead(file, 64 * 1024), 'head');
  let cwd = null;
  let entrypoint = null;
  let parentSessionId = null;
  for (const entry of entries) {
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    if (!entrypoint && typeof entry.entrypoint === 'string' && entry.entrypoint) {
      entrypoint = entry.entrypoint;
    }
    // When a chat runs out of context, Claude Code opens a NEW transcript and
    // replays the carried entries, which keep their ORIGINAL session_id. That
    // foreign id is an explicit link to the half this one continues, so the
    // chain needs no guessing from titles or timestamps: two chats can share a
    // title and be unrelated, and this correctly leaves them apart.
    if (!parentSessionId && isSessionId(entry.session_id)
        && String(entry.session_id).toLowerCase() !== String(sessionId).toLowerCase()) {
      parentSessionId = entry.session_id;
    }
    if (cwd && entrypoint && parentSessionId) break;
  }
  return { cwd, entrypoint, parentSessionId };
}

/**
 * Started by a program rather than by a person.
 *
 * Absent is NOT an SDK run: older transcripts predate the field, and treating
 * them as programmatic would erase real history.
 */
export function isSdkRun(entrypoint) {
  return typeof entrypoint === 'string' && entrypoint.startsWith('sdk');
}

/** Bytes used by a session's subagent transcripts, 0 if it has none. */
function dirSize(dir) {
  let total = 0;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch {
      // Vanished mid-scan. Ignore.
    }
  }
  return total;
}

/**
 * Number each transcript within its continuation chain.
 *
 * A chat that runs out of context continues in a NEW transcript, so one
 * conversation becomes several files. Following parentSessionId back to a root
 * groups them; a chat with no parent and no children is a chain of one and gets
 * no numbering at all.
 *
 * Sets chainPart (1 = oldest) and chainSize on every member of a chain longer
 * than one. Rows stay listed individually: the older parts are frozen and often
 * the largest thing on disk, so hiding them would hide what is worth deleting.
 */
const GENERIC_DIRS = new Set(['docs', 'tests', 'test', 'scripts', 'src', 'tmp', 'out', 'build', 'dist', 'node_modules', 'data', 'lib', 'bin', 'logs', 'app', 'components']);

/**
 * Subfolders of a folder of projects, or null for any other folder. Which
 * folders hold projects is set by projectsRoots in config.json; by default
 * ~/Projects, ~/Desktop/Projects and ~/code.
 */
function projectSubdirs(dir, roots) {
  if (!roots.includes(dir)) return null;
  try {
    return new Set(fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !GENERIC_DIRS.has(d.name))
      .map((d) => d.name));
  } catch {
    return null; // unreadable: treat as a project
  }
}

/** The subfolder a chat's own path mentions point at, when one clearly leads. */
export function pickWorkDir(tokens, subs) {
  if (!subs) return null;
  const hits = (tokens ?? []).filter(([name]) => subs.has(name));
  const total = hits.reduce((n, [, c]) => n + c, 0);
  const [top] = hits;
  return top && top[1] >= 3 && top[1] / total >= 0.5 ? top[0] : null;
}

/**
 * Many chats start in the folder that holds every project, so their cwd says
 * nothing about the project: on one real store, 54 chats sat under that one
 * folder. A chat in a folder of projects is filed under the subfolder its work
 * goes through; one with too few mentions takes its family's majority.
 *
 * @param {string[]} [roots] the folders of projects, expanded; from config by default
 */
export function markWorkDirs(sessions, roots = readConfig().projectsRoots) {
  const subdirs = new Map();
  const subsOf = (dir) => (subdirs.has(dir) ? subdirs.get(dir) : subdirs.set(dir, projectSubdirs(dir, roots)).get(dir));
  for (const s of sessions) {
    if (!s.cwd) continue;
    // A folder already in the chat's own path (Users, the home folder, the
    // projects root) is in every absolute path it writes, so it never decides.
    const own = new Set(s.cwd.split('/').filter(Boolean));
    const subs = subsOf(s.cwd);
    const pick = pickWorkDir((s.pathTokens ?? []).filter(([name]) => !own.has(name)), subs);
    if (pick) s.workDir = path.join(s.cwd, pick);
  }
  const byFamily = new Map();
  for (const s of sessions) if (s.family && s.workDir) (byFamily.get(s.family) ?? byFamily.set(s.family, []).get(s.family)).push(s.workDir);
  const majority = new Map();
  for (const [family, dirs] of byFamily) {
    const counts = new Map();
    for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    if (top[1] / dirs.length >= 0.6) majority.set(family, top[0]);
  }
  for (const s of sessions) {
    if (!s.workDir && s.family && majority.has(s.family) && s.cwd && majority.get(s.family).startsWith(`${s.cwd}/`)) s.workDir = majority.get(s.family);
  }
}

export function needsYou(live, status, lastLine) {
  if (!live || status === 'busy' || status === 'shell') return false;
  return status === 'waiting' || asksForYou(lastLine);
}

export function markContinuationChains(sessions) {
  const byId = new Map(sessions.map((s) => [String(s.sessionId).toLowerCase(), s]));

  const rootOf = (session) => {
    let current = session;
    const seen = new Set([String(current.sessionId).toLowerCase()]);
    for (;;) {
      const parentId = current.parentSessionId
        ? String(current.parentSessionId).toLowerCase() : null;
      // A parent that was deleted, or sits outside this scan, ends the walk.
      if (!parentId || !byId.has(parentId) || seen.has(parentId)) return current;
      // The link alone is lineage, not a rollover. Renaming or branching also
      // carries the parent's entries, and following those merged six different
      // titles into one seven-part chain. A rollover keeps the title, so a
      // change of name ends the chain.
      const parent = byId.get(parentId);
      if (parent.name !== current.name) return current;
      seen.add(parentId);
      current = parent;
    }
  };

  const chains = new Map();
  for (const session of sessions) {
    const root = rootOf(session).sessionId;
    if (!chains.has(root)) chains.set(root, []);
    chains.get(root).push(session);
  }

  for (const members of chains.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.modifiedAt - b.modifiedAt);
    members.forEach((session, index) => {
      session.chainPart = index + 1;
      session.chainSize = members.length;
    });
  }
  return sessions;
}

/**
 * Scan the whole store.
 *
 * @param {{resolveNames?:boolean}} [options] names require reading each file, so
 *   callers that only need counts can turn it off.
 * @returns {{projects:Array, sessions:Array, skipped:number}}
 */
export function scanSessions(options = {}) {
  const { resolveNames = true, remoteLive = null } = options;
  const live = readLiveSessions();
  const liveBySessionId = new Map(live.map((s) => [s.sessionId, s]));
  // Chats running on the remote machine. One moved from here keeps the copy
  // of its transcript taken at the move, so it appears in the scan; this is
  // what marks it as running there.
  const remoteBySessionId = new Map((remoteLive?.sessions ?? []).map((s) => [s.sessionId, s]));
  const transcriptIds = new Set();

  // The registry is not always complete: a running session was found with no
  // ~/.claude/sessions/<pid>.json, so it showed as closed here. A resumed
  // session carries its id in argv, so ps is a second source of truth for
  // liveness as well as for what may be restored.
  const runningIds = readRunningSessionIds();

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { projects: [], sessions: [], skipped: 0, sdkHidden: 0 };
  }

  const sessions = [];
  let skipped = 0;

  // Reading every transcript to resolve a name and a cwd measured 9.9 s across
  // 9,179 chats, which blew the RPC timeout and left the window blank. Anything
  // whose size and mtime are unchanged is answered from here instead.
  const cache = readScanCache();
  const nextCache = new Map();
  let cacheChanged = false;
  let sdkHidden = 0;

  for (const projectDir of projectDirs) {
    const dir = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!isSessionId(sessionId)) continue;
      transcriptIds.add(sessionId.toLowerCase());

      const file = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        skipped += 1;
        continue;
      }

      const subagents = dirSize(path.join(dir, sessionId));
      const liveEntry = liveBySessionId.get(sessionId);

      const cached = cacheHit(cache, sessionId, stat);
      if (cached) nextCache.set(sessionId, cached);

      const head = cached
        ? { cwd: cached.cwd, entrypoint: cached.entrypoint ?? null,
            parentSessionId: cached.parentSessionId ?? null }
        : readHeadFacts(file, sessionId);
      const cwd = liveEntry?.cwd ?? head.cwd;

      // A program ran this, not a person. Counted so the window can say so,
      // rather than a list of thousands implying you had that many
      // conversations.
      if (isSdkRun(head.entrypoint)) {
        sdkHidden += 1;
        if (!cached) {
          nextCache.set(sessionId, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            name: null,
            nameSource: null,
            cwd: head.cwd,
            entrypoint: head.entrypoint,
            parentSessionId: head.parentSessionId,
            model: null,
            effort: null,
          });
          cacheChanged = true;
        }
        continue;
      }

      // The transcript name is resolved first, because deciding whether the
      // registry name wins needs something to compare it against.
      let fileName = cached?.name ?? null;
      let fileNameSource = cached?.nameSource ?? null;
      if (!fileName && resolveNames) {
        const resolved = resolveName(file, sessionId);
        fileName = resolved.name;
        fileNameSource = resolved.source;
      }

      // A live session's registry name is fresher than the transcript's, except
      // when Claude Code derived it from the folder. It is never what gets cached.
      let name = preferredLiveName(liveEntry, fileName);
      let nameSource = name ? 'registry' : null;
      if (!name) { name = fileName; nameSource = fileNameSource; }

      // Which model and effort the chat is on. Read from the tail, because both
      // change mid-conversation and the last assistant reply is the truth.
      let model = cached?.model ?? null;
      let effort = cached?.effort ?? null;
      let lastLine = cached?.lastLine ?? null;
      let contextTokens = cached?.contextTokens ?? null;
      let permissionMode = cached?.permissionMode ?? null;
      let pathTokens = cached?.pathTokens ?? [];
      let stoppedOn = cached?.stoppedOn ?? null;
      if (!cached && resolveNames) {
        ({ model, effort, lastLine, contextTokens, permissionMode, pathTokens, stoppedOn } = readTailFacts(file));
      }

      if (!cached && resolveNames) {
        nextCache.set(sessionId, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          name: fileName,
          nameSource: fileNameSource,
          cwd: head.cwd,
          entrypoint: head.entrypoint,
          parentSessionId: head.parentSessionId,
          model,
          effort,
          lastLine,
          contextTokens,
          permissionMode,
          pathTokens,
          stoppedOn,
        });
        cacheChanged = true;
      }

      const remoteEntry = remoteBySessionId.get(sessionId);
      const onMac = Boolean(liveEntry) || runningIds.has(sessionId);
      if (!name && remoteEntry?.name) { name = remoteEntry.name; nameSource = 'registry'; }
      // A chat running on the remote writes its transcript there. The copy
      // here stops at the move, so its last line, context and stop reason are
      // old news; only the remote registry's status is current.
      const current = onMac || !remoteEntry;
      if (!current) { lastLine = null; contextTokens = null; stoppedOn = null; }

      sessions.push({
        sessionId,
        projectDir,
        file,
        cwd,
        name,
        nameSource,
        parentSessionId: head.parentSessionId,
        model,
        modelShort: shortModel(model),
        effort,
        bytes: stat.size,
        subagentBytes: subagents,
        modifiedAt: stat.mtimeMs,
        live: onMac || Boolean(remoteEntry),
        // Where it runs. A chat open on both would be a forked transcript; the
        // Mac wins the label so the user sees the copy they can reach locally.
        machine: onMac ? 'mac' : (remoteEntry ? 'remote' : null),
        remoteCwd: onMac ? null : remoteEntry?.remoteCwd ?? null,
        pid: liveEntry?.pid ?? remoteEntry?.pid ?? null,
        status: liveEntry?.status ?? remoteEntry?.status ?? null,
        lastLine,
        contextTokens,
        contextPct: contextTokens === null ? null : Math.min(100, Math.round((contextTokens / contextWindow(model)) * 100)),
        permissionMode,
        permission: permissionLabel(permissionMode),
        rssMb: remoteEntry?.rssMb ?? null,
        // Blocked on the person: the registry says so, or the reply asks. A chat
        // that is working is never waiting on anyone, whatever its last line said.
        // A live chat that stopped on a usage limit or an API error waits on the person too.
        needsYou: needsYou(onMac || Boolean(remoteEntry), liveEntry?.status ?? remoteEntry?.status, lastLine)
          || Boolean(onMac && stoppedOn),
        stoppedOn: onMac ? stoppedOn : null,
        // Busy with no transcript growth for 15 minutes: maybe a long command, maybe stuck.
        // Not judged for a remote chat: its transcript here stops at the move.
        quietMin: onMac && ['busy', 'shell'].includes(liveEntry?.status) && Date.now() - stat.mtimeMs > 15 * 60_000
          ? Math.round((Date.now() - stat.mtimeMs) / 60_000) : null,
        pathTokens,
      });
    }
  }

  // Dropped ids are pruned by rebuilding rather than deleting, so a cache never
  // grows past the chats that exist.
  if (cacheChanged || nextCache.size !== cache.size) writeScanCache(nextCache);

  // A live session does not always have a transcript on disk yet: one was
  // observed running with no .jsonl file at all. Scanning transcripts alone
  // would make it invisible in the sidebar and, worse, silently drop it from a
  // restore. Union the registry back in. The same applies to a chat started on
  // the remote, whose transcript is only there: it is running, so it is listed.
  const seen = new Set(sessions.map((s) => s.sessionId));
  for (const entry of [...live, ...remoteBySessionId.values()]) {
    if (!entry.sessionId || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    sessions.push({
      sessionId: entry.sessionId,
      projectDir: entry.cwd ? encodeCwd(entry.cwd) : null,
      file: null,
      cwd: entry.cwd,
      name: entry.name ?? `(unnamed ${entry.sessionId.slice(0, 8)})`,
      nameSource: entry.name ? 'registry' : 'id',
      bytes: 0,
      subagentBytes: 0,
      modifiedAt: entry.startedAt ?? Date.now(),
      live: true,
      machine: entry.machine ?? 'mac',
      remoteCwd: entry.remoteCwd ?? null,
      pid: entry.pid,
      status: entry.status ?? null,
      model: null,
      modelShort: null,
      effort: null,
      lastLine: null,
      contextTokens: null,
      contextPct: null,
      permissionMode: null,
      permission: null,
      rssMb: entry.rssMb ?? null,
      needsYou: entry.status === 'waiting',
      transcriptMissing: true,
    });
  }

  // A transcript whose head holds no `cwd` would otherwise surface as a raw
  // encoded directory name in the sidebar. Siblings in the same directory almost
  // always resolved, and the encoding is deterministic, so borrow theirs.
  const cwdByDir = new Map();
  for (const session of sessions) {
    if (session.cwd && !cwdByDir.has(session.projectDir)) {
      cwdByDir.set(session.projectDir, session.cwd);
    }
  }
  for (const session of sessions) {
    if (!session.cwd) session.cwd = cwdByDir.get(session.projectDir) ?? null;
  }

  markContinuationChains(sessions);
  markFamilies(sessions);
  markSameNames(sessions);
  markWorkDirs(sessions);

  // Resident memory of each running Mac chat, in one ps call. The remote's
  // comes with its registry probe.
  const macPids = sessions.filter((s) => s.machine === 'mac' && s.pid).map((s) => s.pid);
  const rss = readResidentMemory(macPids);
  for (const session of sessions) {
    if (session.machine === 'mac' && session.pid && rss.has(session.pid)) session.rssMb = rss.get(session.pid);
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // Group by the folder the chat works in: its cwd, or for a chat started in a
  // folder of projects (projectsRoots) the project it actually works on.
  // Restore and moves still use the real cwd.
  const byProject = new Map();
  for (const session of sessions) {
    const key = session.workDir ?? session.cwd ?? session.projectDir;
    if (!byProject.has(key)) {
      byProject.set(key, {
        cwd: session.workDir ?? session.cwd,
        projectDir: session.projectDir,
        label: key,
        sessions: [],
        bytes: 0,
        liveCount: 0,
      });
    }
    const project = byProject.get(key);
    project.sessions.push(session);
    project.bytes += session.bytes + session.subagentBytes;
    if (session.live) project.liveCount += 1;
  }

  const projects = [...byProject.values()];

  // Chats in a subfolder belong to the folder you open, so a parent must account
  // for its descendants. Without this the sidebar disagreed with restore: chats
  // under Projects/listings were missing from Projects, yet restore put them in
  // the Projects window.
  for (const project of projects) {
    const ancestors = projects
      .filter((other) => other !== project && other.cwd && project.cwd
        && canBeWorkspaceRoot(other.cwd) && isInsidePath(project.cwd, other.cwd))
      .sort((a, b) => b.cwd.length - a.cwd.length);
    project.parent = ancestors[0]?.cwd ?? null;
    project.depth = ancestors.length;
  }

  for (const project of projects) {
    const descendants = canBeWorkspaceRoot(project.cwd)
      ? projects.filter((other) => other !== project
        && other.cwd && isInsidePath(other.cwd, project.cwd))
      : [];
    project.allSessions = [project, ...descendants].flatMap((p) => p.sessions);
    project.allBytes = project.allSessions
      .reduce((sum, session) => sum + session.bytes + session.subagentBytes, 0);
    project.allLiveCount = project.allSessions.filter((session) => session.live).length;
  }

  // Sorted as a tree: roots by activity, each child directly under its parent.
  const rank = (p) => [-p.allLiveCount, -(p.allSessions[0]?.modifiedAt ?? 0)];
  const byRank = (a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1];

  // Children are resolved through this map rather than by comparing a child's
  // parent against a project's cwd. A project whose transcripts carry no cwd is
  // a root with cwd null, and null equals the null parent of every other root,
  // so that comparison made every root its own child: the walk recursed until
  // the stack gave out and the window could only say "could not load".
  const childrenOf = new Map();
  for (const project of projects) {
    if (project.parent === null || project.parent === undefined) continue;
    if (!childrenOf.has(project.parent)) childrenOf.set(project.parent, []);
    childrenOf.get(project.parent).push(project);
  }

  const roots = projects.filter((p) => !p.parent).sort(byRank);
  const ordered = [];
  const placed = new Set();
  const place = (project) => {
    // Belt and braces: a project belongs in the list once, whatever the shape
    // of the parent data turns out to be.
    if (placed.has(project)) return;
    placed.add(project);
    ordered.push(project);
    [...(childrenOf.get(project.cwd) ?? [])].sort(byRank).forEach(place);
  };
  roots.forEach(place);
  // Anything unreachable from a root must still be listed rather than vanish.
  for (const project of projects) place(project);

  // Every transcript id seen, SDK runs included, so restore can check "does a
  // file exist" without sweeping the directories a second time.
  return { projects: ordered, sessions, skipped, sdkHidden, transcriptIds };
}
