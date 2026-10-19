/**
 * Groups: how the sidebar files chats, by name rather than by folder.
 *
 * A chat's group is, first, one the person picked for it (by dragging it onto
 * a group or choosing one in the detail panel), kept per base name so every
 * copy of "Web_Sync_new_series" moves together; then the prefix before its
 * first "_" ("Web"), even when only one chat has it, so renaming a chat to
 * "Shop_Billing" files it under Shop; then the folder it runs in ("Projects",
 * "Tools"). Families (families.js) need two names and steer folder
 * inference; groups do not. Restore does not use this: it reopens one VS Code
 * window per folder, so it keeps grouping by folder.
 *
 * The folder tree files each chat under a root: the window folder the restore
 * snapshot knows it ran in, else the projects root (projectsRoots in
 * config.json) that holds its cwd, else the first two levels of its cwd below
 * home. There, a chat whose group came only from its folder sits loose in the
 * root.
 *
 * Stored in ~/.claude-switchboard/groups.json:
 *   { "groups": ["Billing"], "assign": { "shop_billing": "Billing" } }
 * "groups" lists the ones the person created, which show even while empty.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir, isInsidePath } from './paths.js';
import { baseName, prefixOf } from './families.js';

const groupsFile = () => path.join(stateDir(), 'groups.json');
const keyOf = (name) => baseName(name).toLowerCase();
const BAD_NAME = 'a group name is 1 to 40 characters, with no "/"';

/** The name trimmed, or null when it cannot be a group: empty, over 40, a control character or "/". */
export function cleanGroupName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= 40 && !/[\u0000-\u001f\u007f/]/.test(name) ? name : null;
}

/**
 * The projects root holding `cwd`, the deepest when they nest; else two levels
 * below home. A cwd outside home, or only one level down, is its own root.
 */
export function rootOf(cwd, home = os.homedir(), projectsRoots = []) {
  if (!cwd) return '';
  const holder = projectsRoots.filter((r) => isInsidePath(cwd, r)).sort((a, b) => b.length - a.length)[0];
  if (holder) return holder;
  const rel = path.relative(home, cwd);
  const parts = rel.split(path.sep);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || parts.length < 2) return cwd;
  return path.join(home, parts[0], parts[1]);
}

/**
 * An old copy: a chat renamed <name>_old once a newer chat took its name. It stays in
 * its family's group, marked s.isOld, and the sidebar lists it under that group's own
 * "Old" row, where it is easy to check and delete. Whole-group actions leave it out:
 * opening a whole family had reopened its old copies next to the chats that replaced them.
 */
const OLD_NAME = /_old(?:[_-]?\d+)?$/i;

/**
 * Pure. Sets s.group, s.autoGroup (where it goes when nothing is picked),
 * s.groupFrom ('pick', 'prefix' or 'folder'), s.isOld and s.root for the folder tree.
 */
export function applyGroups(sessions, config, { home = os.homedir(), projectsRoots = [] } = {}) {
  // A prefix is matched in any casing and labelled with its most common one: "Shop" over "shop".
  const casings = new Map();
  for (const s of sessions) {
    const prefix = prefixOf(s.name);
    if (!prefix) continue;
    const seen = casings.get(prefix.toLowerCase()) ?? casings.set(prefix.toLowerCase(), new Map()).get(prefix.toLowerCase());
    seen.set(prefix, (seen.get(prefix) ?? 0) + 1);
  }
  const label = new Map([...casings].map(([key, seen]) => [key, [...seen].sort((a, b) => b[1] - a[1])[0][0]]));
  for (const s of sessions) {
    const prefix = prefixOf(s.name);
    const pick = config.assign[keyOf(s.name)];
    s.isOld = OLD_NAME.test(baseName(s.name));
    s.autoGroup = prefix ? label.get(prefix.toLowerCase()) : s.cwd ? path.basename(s.cwd) || s.cwd : 'No folder';
    s.group = pick ?? s.autoGroup;
    s.groupFrom = pick ? 'pick' : prefix ? 'prefix' : 'folder';
    s.root = s.workspaceRoot ?? rootOf(s.cwd, home, projectsRoots);
  }
  return sessions;
}

/** Missing or corrupt reads as empty; entries that are not valid names are dropped. */
export function readGroups() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(groupsFile(), 'utf8'));
  } catch {
    return { groups: [], assign: {} };
  }
  const groups = [...new Set((Array.isArray(raw?.groups) ? raw.groups : []).map(cleanGroupName).filter(Boolean))];
  const assign = {};
  for (const [key, value] of Object.entries(raw?.assign ?? {})) {
    const group = cleanGroupName(value);
    if (key && group) assign[key] = group;
  }
  return { groups, assign };
}

function save(config) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = path.join(stateDir(), `.groups.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, groupsFile());
    return { ok: true, groups: config.groups };
  } catch (err) {
    return { ok: false, error: `could not save groups: ${err.message}` };
  }
}

/** File these chats under `group`, or back under their automatic group when it is null. */
export function assignGroup({ names, group }) {
  if (!Array.isArray(names) || !names.length || names.some((n) => typeof n !== 'string' || !keyOf(n))) {
    return { ok: false, error: 'no chat named' };
  }
  const target = group == null ? null : cleanGroupName(group);
  if (group != null && !target) return { ok: false, error: BAD_NAME };
  const config = readGroups();
  for (const name of names) {
    if (target) config.assign[keyOf(name)] = target;
    else delete config.assign[keyOf(name)];
  }
  return save(config);
}

/** Creating one that exists, in any casing, returns the existing name. */
export function createGroup(name) {
  const clean = cleanGroupName(name);
  if (!clean) return { ok: false, error: BAD_NAME };
  const config = readGroups();
  const existing = config.groups.find((g) => g.toLowerCase() === clean.toLowerCase());
  if (existing) return { ok: true, name: existing, groups: config.groups };
  config.groups.push(clean);
  return { ...save(config), name: clean };
}

/** Its chats go back to their automatic groups. */
export function deleteGroup(name) {
  const clean = cleanGroupName(name);
  if (!clean) return { ok: false, error: BAD_NAME };
  const config = readGroups();
  config.groups = config.groups.filter((g) => g !== clean);
  for (const [key, group] of Object.entries(config.assign)) if (group === clean) delete config.assign[key];
  return save(config);
}
