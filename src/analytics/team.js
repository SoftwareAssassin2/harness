// The project's team (ASS-409): data/projects/<project>/team.json, each person
// joining their ticket-system identity and their git identity, with a role.
// Worked out again on every run (team:update, from the downloader once a
// cycle) from the analytics data — analytics/tickets.json (ASS-406) and
// analytics/merge-requests.json (ASS-408) — and the team as it stands:
// people are added and linked, never removed, and a field the operator named
// in a member's set-by-operator list is never changed.
//
// A ticket-system status means only what the engine steps paired with it say
// (performance.js statusCategories): no status name is compared here.
// Pure: the caller reads the files and passes them in, with today's date.
import { statusCategories, ticketFacts, assigneeBefore } from './performance.js';

// The thresholds (AC3, AC4).
export const QA_SHARE = 0.5;          // qa: at least half of a person's status changes move a ticket out of a QA status
export const MIN_KEYED_MRS = 3;       // a ticket-key link: at least 3 merge requests naming that person's tickets…
export const KEYED_SHARE = 0.6;       // …and at least 60% of the author's keyed merge requests
export const ROLES = ['developer', 'qa', 'product', 'bot', 'unmatched'];

// A member's fields, in the order team.json lists them (AC1).
const FIELDS = ['ticket-system-id', 'ticket-system-name', 'git-username', 'git-name', 'role', 'matched-by', 'first-seen', 'set-by-operator'];

// The earlier prototype's field names and theirs now (AC6).
const PROTOTYPE = { 'jira-account-id': 'ticket-system-id', 'jira-name': 'ticket-system-name', 'gitlab-username': 'git-username', 'gitlab-name': 'git-name' };

// normalName(text) — a name with case, accents, punctuation and spaces
// ignored ("Ada  Lovelace", "ada.lovelace" and "ADA-LOVELACE" are one), '' for none.
export const normalName = text => String(text ?? '').normalize('NFD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// ticketKeys(text) — the ticket keys (upper-cased, each once) a branch or title names: PROJ-12, proj-12.
export const ticketKeys = text => [...new Set([...String(text ?? '').matchAll(/(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*-\d+)(?!\d)/g)].map(m => m[1].toUpperCase()))];

// isPrototypeShape(team) — whether a team.json is the earlier prototype's (AC6).
export const isPrototypeShape = team => (team?.members ?? []).some(m => m && Object.keys(PROTOTYPE).some(k => k in m));

// member(fields) — a member with every field, in order: null where not given, set-by-operator [].
const member = (fields = {}) => Object.fromEntries(FIELDS.map(f => [f, f === 'set-by-operator'
  ? [...new Set((Array.isArray(fields[f]) ? fields[f] : []).map(String))]
  : fields[f] ?? null]));

// migrate(team) — the members in the current shape (AC6): the prototype's
// fields renamed, in its set-by-operator lists too, its roles, matched-by and
// first-seen kept; a member already in the current shape is kept as it is.
export function migrate(team) {
  return (team?.members ?? []).filter(m => m && typeof m === 'object').map(m => {
    const renamed = Object.fromEntries(Object.entries(m).map(([k, v]) => [PROTOTYPE[k] ?? k, v]));
    renamed['set-by-operator'] = (Array.isArray(m['set-by-operator']) ? m['set-by-operator'] : []).map(f => PROTOTYPE[f] ?? f);
    return member(renamed);
  });
}

const locked = (m, field) => m['set-by-operator'].includes(field);
// set(m, field, value) — the field set unless the operator set it (AC5).
const set = (m, field, value) => { if (!locked(m, field)) m[field] = value; };

const at = moment => { const t = Date.parse(moment ?? ''); return Number.isNaN(t) ? -Infinity : t; };

// memberName(m) — how a member is named in a log line.
export const memberName = m => m['ticket-system-name'] ?? m['git-name'] ?? m['git-username'] ?? m['ticket-system-id'] ?? '?';

// facts({ tickets, mergeRequests, engines }) — what the analytics data says of
// the people in it:
//   people     ticket-system id → its latest name, for everyone in the tickets (assignees, assignee and status changes)
//   credited   the ids credited as developer on a ticket that reached a done
//              status (AC2): the assignee just before its first QA status, or
//              just before its first done status when it never went through QA
//   holder     ticket key → the id holding it: its credited developer, else its current assignee
//   moves      id → its status changes; qaMoves id → those out of a QA status (AC4)
//   authors    git username → { name (its latest merge request's), mrs: [ { branch, title } ] }
export function facts({ tickets, mergeRequests, engines }) {
  const categories = statusCategories(engines);
  const people = new Map(), seenAt = new Map();
  const see = (who, when) => {
    if (!who?.id) return;
    if (!people.has(who.id) || (who.name && when >= seenAt.get(who.id))) { people.set(who.id, who.name ?? people.get(who.id) ?? null); seenAt.set(who.id, when); }
  };
  const credited = new Set(), holder = new Map(), moves = new Map(), qaMoves = new Map();
  for (const [key, ticket] of Object.entries(tickets?.tickets ?? {})) {
    if (!ticket || typeof ticket !== 'object') continue;
    const statusChanges = ticket['status-changes'] ?? [], assigneeChanges = ticket['assignee-changes'] ?? [];
    for (const c of assigneeChanges) { see(c.from, at(c.at)); see(c.to, at(c.at)); }
    for (const c of statusChanges) {
      see(c.by, at(c.at));
      if (!c.by?.id) continue;
      moves.set(c.by.id, (moves.get(c.by.id) ?? 0) + 1);
      if (categories[c.from] === 'qa') qaMoves.set(c.by.id, (qaMoves.get(c.by.id) ?? 0) + 1);
    }
    // The current assignee is the latest word on its name.
    see(ticket.assignee, Math.max(at(ticket.created), ...[...statusChanges, ...assigneeChanges].map(c => at(c.at))));
    const { done, qa } = ticketFacts(ticket, categories);
    const developer = done == null ? null : assigneeBefore(ticket, qa ?? done);
    if (developer?.id) credited.add(developer.id);
    const held = developer?.id ?? ticket.assignee?.id;
    if (held) holder.set(String(ticket.key ?? key).toUpperCase(), held);
  }
  const authors = new Map(), latest = new Map();
  for (const mr of Object.values(mergeRequests?.['merge-requests'] ?? {})) {
    const username = mr?.author?.username;
    if (!username) continue;
    const entry = authors.get(username) ?? { name: null, mrs: [] };
    entry.mrs.push({ branch: mr.branch ?? '', title: mr.title ?? '' });
    if (mr.author.name && at(mr['merged-at']) >= (latest.get(username) ?? -Infinity)) { entry.name = mr.author.name; latest.set(username, at(mr['merged-at'])); }
    authors.set(username, entry);
  }
  return { categories, people, credited, holder, moves, qaMoves, authors };
}

// byTicketKeys(mrs, holder) — the ticket-system id an author's merge requests
// point to (AC3), or null: of the merge requests whose branch or title names a
// ticket someone holds (the keyed ones), at least MIN_KEYED_MRS, and at least
// KEYED_SHARE of them, name tickets of that one person; a tie is no one.
export function byTicketKeys(mrs, holder) {
  const votes = new Map();
  let keyed = 0;
  for (const mr of mrs) {
    const held = new Set(ticketKeys(`${mr.branch} ${mr.title}`).map(k => holder.get(k)).filter(Boolean));
    if (!held.size) continue;
    keyed++;
    for (const id of held) votes.set(id, (votes.get(id) ?? 0) + 1);
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  const [id, n] = ranked[0];
  return n >= MIN_KEYED_MRS && n / keyed >= KEYED_SHARE ? id : null;
}

// updateTeam({ team, tickets, mergeRequests, engines, today }) — the team
// brought up to date. team is team.json parsed (either shape, or null);
// tickets and mergeRequests the analytics files parsed (or null); engines the
// project's state engines; today the date (YYYY-MM-DD) a new member is first
// seen. Returns { team: { members }, added: [member], linked: [member],
// migrated }. The steps:
//  1. The members, in the current shape (AC6).
//  2. Added (AC2): each ticket-system person credited as developer on a done
//     ticket not yet a member, by ticket-system id; each merged merge
//     request's author not yet a member, by git username, a git-only member.
//     New members go after the others; nobody is removed.
//  3. Names: a member's ticket-system name and git name follow the latest the
//     data shows.
//  4. Linked (AC3), each git-only member again every run: to the ticket-system
//     person whose name equals its git name or username (normalName), when
//     exactly one does; else to the one its merge requests' ticket keys
//     point to (byTicketKeys). A person already a member without a git
//     identity takes the git one (the git-only entry folded into theirs: one
//     person, nothing lost); one not yet a member is filled in on the git-only
//     entry. A person who already has a git identity takes no second one.
//     matched-by says how; a member whose ticket-system-id the operator set
//     is never linked.
//  5. Roles (AC4): a member with a ticket-system id is qa when at least
//     QA_SHARE of their status changes move a ticket out of a QA status, else
//     developer (with no status changes of theirs in the data, a qa role
//     stays qa: nothing says otherwise); a git-only one is bot when its username or name contains
//     "bot", else unmatched. product is only the operator's: a member whose
//     role is product keeps it.
// Every change skips a field in the member's set-by-operator (AC5).
export function updateTeam({ team, tickets, mergeRequests, engines, today }) {
  const migrated = isPrototypeShape(team);
  const members = migrate(team);
  const known = { ids: new Set(members.map(m => m['ticket-system-id']).filter(Boolean)), users: new Set(members.map(m => m['git-username']).filter(Boolean)) };
  const linkedBefore = new Set(members.filter(m => m['ticket-system-id'] && m['git-username']).map(m => m['git-username']));
  const { people, credited, holder, moves, qaMoves, authors } = facts({ tickets, mergeRequests, engines });
  const byId = () => new Map(members.filter(m => m['ticket-system-id']).map(m => [m['ticket-system-id'], m]));
  const byUser = () => new Map(members.filter(m => m['git-username']).map(m => [m['git-username'], m]));

  // 2. Added.
  for (const id of credited) {
    if (byId().has(id)) continue;
    members.push(member({ 'ticket-system-id': id, 'ticket-system-name': people.get(id), 'first-seen': today }));
  }
  for (const [username, { name }] of authors) {
    if (byUser().has(username)) continue;
    members.push(member({ 'git-username': username, 'git-name': name, 'first-seen': today }));
  }

  // 3. Names.
  for (const m of members) {
    if (m['ticket-system-id'] && people.get(m['ticket-system-id'])) set(m, 'ticket-system-name', people.get(m['ticket-system-id']));
    if (m['git-username'] && authors.get(m['git-username'])?.name) set(m, 'git-name', authors.get(m['git-username']).name);
  }

  // 4. Linked. The ticket-system people to link to: those in the data and the members, by normalName.
  const names = new Map();
  const nameOf = id => byId().get(id)?.['ticket-system-name'] ?? people.get(id);
  for (const id of new Set([...people.keys(), ...byId().keys()])) {
    const n = normalName(nameOf(id));
    if (n) names.set(n, [...new Set([...(names.get(n) ?? []), id])]);
  }
  const named = text => { const ids = names.get(normalName(text)) ?? []; return normalName(text) && ids.length === 1 ? ids[0] : null; };
  for (const m of [...members]) {
    if (m['ticket-system-id'] || !m['git-username'] || locked(m, 'ticket-system-id')) continue;
    let how = 'name', id = named(m['git-name']) ?? named(m['git-username']);
    if (!id) { how = 'ticket-keys'; id = byTicketKeys(authors.get(m['git-username'])?.mrs ?? [], holder); }
    if (!id) continue;
    const target = byId().get(id);
    if (target) {
      if (target['git-username'] || locked(target, 'git-username')) continue;
      // Folded into the ticket-system member: its git identity, and whatever the operator set on the git-only entry.
      target['git-username'] = m['git-username'];
      set(target, 'git-name', m['git-name']);
      set(target, 'matched-by', how);
      for (const field of m['set-by-operator']) if (!locked(target, field) && field !== 'ticket-system-id' && field !== 'ticket-system-name') { target[field] = m[field]; target['set-by-operator'].push(field); }
      if (m['first-seen'] && (!target['first-seen'] || m['first-seen'] < target['first-seen'])) set(target, 'first-seen', m['first-seen']);
      members.splice(members.indexOf(m), 1);
    } else {
      m['ticket-system-id'] = id;
      set(m, 'ticket-system-name', people.get(id) ?? null);
      set(m, 'matched-by', how);
    }
  }

  // 5. Roles.
  for (const m of members) {
    if (m.role === 'product') continue;
    const id = m['ticket-system-id'];
    // No status changes of theirs in the data: nothing to judge by, so a qa or developer role stays as it was.
    if (id) set(m, 'role', moves.get(id) ? ((qaMoves.get(id) ?? 0) / moves.get(id) >= QA_SHARE ? 'qa' : 'developer') : m.role === 'qa' ? 'qa' : 'developer');
    else set(m, 'role', /bot/i.test(`${m['git-username'] ?? ''} ${m['git-name'] ?? ''}`) ? 'bot' : 'unmatched');
  }

  const added = members.filter(m => !known.ids.has(m['ticket-system-id']) && !known.users.has(m['git-username']));
  const linked = members.filter(m => m['ticket-system-id'] && m['git-username'] && !linkedBefore.has(m['git-username']) && !added.includes(m));
  return { team: { members }, added, linked, migrated };
}
