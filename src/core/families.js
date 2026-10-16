/**
 * Two ways chat names relate, both checked against a real list of names
 * (94 chats, 83 distinct names, 11 names used twice).
 *
 * Families: chats named with a code prefix, "Shop_Crawl", "Shop_SEO", "3D_UI",
 * are one body of work. The prefix before "_" is the family once two different
 * names share it. Free-text titles ("Image check", "Em dash instructions...")
 * and "(unnamed ...)" never form one: a shared first word is not a project.
 *
 * Same names: a name reused by several transcripts. Each copy gets a role so
 * the window can show one row with the rest folded under it: running, latest,
 * a part of a continued chat (context ran out), a branch of another chat, an
 * older chat that reused the name, or a second live copy (two machines
 * writing one name is how transcripts fork, so it is flagged).
 */

const SUFFIX = /\s+\(\d+\)$/;
const PREFIX = /^([A-Za-z0-9]{2,12})_\S/;
const BARE = /^[A-Za-z0-9]{2,12}$/;

/** "Web_Sync_new_series (2)" and "Web_Sync_new_series" are one name. */
export function baseName(name) {
  return String(name ?? '').replace(SUFFIX, '').trim();
}

const unnamed = (name) => /^\(unnamed/.test(String(name ?? ''));

export function markFamilies(sessions) {
  const members = new Map();
  for (const s of sessions) {
    if (unnamed(s.name)) continue;
    const base = baseName(s.name);
    const prefix = base.match(PREFIX)?.[1] ?? (BARE.test(base) ? base : null);
    if (!prefix) continue;
    const key = prefix.toLowerCase();
    if (!members.has(key)) members.set(key, { sessions: [], names: new Set(), prefixed: 0, labels: new Map() });
    const m = members.get(key);
    m.sessions.push(s);
    m.names.add(base.toLowerCase());
    if (PREFIX.test(base)) m.prefixed += 1;
    m.labels.set(prefix, (m.labels.get(prefix) ?? 0) + 1);
  }
  for (const m of members.values()) {
    if (m.names.size < 2 || m.prefixed === 0) continue;
    const label = [...m.labels].sort((a, b) => b[1] - a[1])[0][0];
    for (const s of m.sessions) s.family = label;
  }
}

export function markSameNames(sessions) {
  const byId = new Map(sessions.map((s) => [String(s.sessionId).toLowerCase(), s]));
  const groups = new Map();
  for (const s of sessions) {
    if (unnamed(s.name)) continue;
    const key = baseName(s.name).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)) || b.modifiedAt - a.modifiedAt);
    const primary = group[0];
    group.forEach((s, rank) => {
      s.sameNameCount = group.length;
      s.sameNameRank = rank;
      s.sameNamePrimaryId = primary.sessionId;
      if (rank === 0) s.sameNameRole = s.live ? 'running' : 'latest';
      else if (s.live) s.sameNameRole = 'also-running';
      else if (s.chainSize) s.sameNameRole = 'part';
      else {
        const parent = s.parentSessionId ? byId.get(String(s.parentSessionId).toLowerCase()) : null;
        s.sameNameRole = parent && baseName(parent.name) !== baseName(s.name) ? 'branch' : 'older';
      }
    });
  }
}
