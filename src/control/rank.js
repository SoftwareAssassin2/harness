// Ranking tickets for control: the sprint's,
// to decide what is dispatched next, and the backlog's, to decide what is
// refined next. Pure and stable: a sorted copy, the input untouched. Also the
// shared backlog hide predicate (isLiveBacklogEntry) control, the TUI and
// renumber-backlog use (ASS-202).
import { stepOf } from './engine.js';

// priorityOrder — Jira's priorities, highest first.
// Jira's priority names, highest first: the default scale and the Critical … Very Low one some sites use.
export const priorityOrder = ['Highest', 'Critical', 'Very High', 'High', 'Medium', 'Low', 'Very Low', 'Lowest'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A comparator from ranking functions, each breaking the ties the one before left.
const by = (...ranks) => (a, b) => { for (const rank of ranks) { const c = cmp(rank(a), rank(b)); if (c) return c; } return 0; };
// Null manual priority (the sprint's, the backlog's) after every set one; unknown Jira priority after the known.
const manual = t => t['manual-priority'] ?? Infinity;
const backlogManual = t => t['manual-backlog-priority'] ?? Infinity;
const jira = t => { const i = priorityOrder.indexOf(t['ticket-system-priority']); return i < 0 ? priorityOrder.length : i; };
const number = t => parseInt(t.key?.split('-').at(-1), 10) || 0;

// flattenSprint(sprint) — a sprint's features, bugs and spikes as one list,
// each ticket tagged type: 'feature' | 'bug' | 'spike', its fields kept.
export const flattenSprint = sprint => [['features', 'feature'], ['bugs', 'bug'], ['spikes', 'spike']].flatMap(([list, type]) => (sprint[list] ?? []).map(t => ({ ...t, type })));

// isLiveBacklogEntry(t, inSprint) — a backlog.json entry control, the TUI and
// renumber-backlog show: not soft deleted, its ticket not Done, not in the
// active sprint (inSprint: its keys, upper case) — so a reopened ticket
// returns to the backlog (ASS-202).
export const isLiveBacklogEntry = (t, inSprint) => t['is-deleted'] !== true && t['ticket-system-status'] !== 'Done' && !inSprint.has(t.key.toUpperCase());

// rankSprint(tickets, { engine }) — the sprint's tickets (see flattenSprint)
// in dispatch order: a fast-tracked ticket (fast-track: true, ASS-83 — one
// the health check raised for the harness itself) above every other, manual
// priorities included; then manual-priority, ascending; then Jira priority
// (priorityOrder, then none); bugs before the rest; tickets another in the
// list depends on; closer to done (the highest step sequence in `engine`
// over variations not deleted); more points (missing: 0); then ticket number.
export function rankSprint(tickets, { engine }) {
  const depended = new Set(tickets.flatMap(t => t.dependencies ?? []));
  const progress = t => -Math.max(-1, ...(t.variations ?? []).filter(v => !v['is-deleted']).map(v => stepOf(engine, v['harness-status']?.state)?.sequence ?? -1));
  return tickets.toSorted(by(t => (t['fast-track'] === true ? 0 : 1), manual, jira, t => (t.type === 'bug' ? 0 : 1), t => (depended.has(t.key) ? 0 : 1), progress, t => -(t.points ?? 0), number));
}

// rankBacklog(tickets) — the backlog in refinement order. A ticket with a
// manual-backlog-priority (the operator's, ASS-100; never the sprint's
// manual-priority) takes that place, 1-based; the rest fill the places left
// free, in order: tagged for a sprint before untagged, the earlier sprint first
// (the number ending the tag, "Sprint 11" < "Sprint 12"); then Jira priority;
// then deeper in the dependency chain (more tickets transitively depending on
// it) first; then ticket number. Before sorting, a ticket others depend on
// takes their sprint tag and Jira priority where better, transitively, so it
// is not refined after the tickets waiting on it. Manual places past the end,
// or shared, follow one another in manual order.
export function rankBacklog(tickets) {
  const byKey = new Map(tickets.map(t => [t.key, t]));
  const sprintOf = tag => (tag == null ? Infinity : parseInt(/(\d+)\s*$/.exec(tag)?.[1], 10) || Number.MAX_SAFE_INTEGER);   // a tag without a number: after the numbered, before none
  // Effective (sprint number, Jira rank) per ticket, lowest wins, inherited from dependents until nothing changes.
  const effective = new Map(tickets.map(t => [t.key, { sprint: sprintOf(t['sprint-tag']), jira: jira(t) }]));
  for (let changed = true; changed;) {
    changed = false;
    for (const t of tickets) for (const dep of t.dependencies ?? []) {
      const [from, to] = [effective.get(t.key), effective.get(dep)];
      if (!to) continue;
      for (const field of ['sprint', 'jira']) if (from[field] < to[field]) { to[field] = from[field]; changed = true; }
    }
  }
  // Transitive dependents of each ticket, counted once, cycles included but the ticket itself not.
  const dependents = new Map();
  for (const t of tickets) for (const dep of t.dependencies ?? []) if (byKey.has(dep)) dependents.set(dep, [...(dependents.get(dep) ?? []), t.key]);
  const depth = key => { const seen = new Set(); const walk = k => { for (const d of dependents.get(k) ?? []) if (!seen.has(d)) { seen.add(d); walk(d); } }; walk(key); seen.delete(key); return seen.size; };
  const ruled = tickets.toSorted(by(t => effective.get(t.key).sprint, t => effective.get(t.key).jira, t => -depth(t.key), number));
  const manuals = ruled.filter(t => backlogManual(t) !== Infinity).toSorted(by(backlogManual));
  const rest = ruled.filter(t => backlogManual(t) === Infinity);
  const ranked = [];
  while (manuals.length || rest.length) ranked.push(manuals.length && (!rest.length || backlogManual(manuals[0]) <= ranked.length + 1) ? manuals.shift() : rest.shift());
  return ranked;
}

// backlogPriorities(tickets) — { key: priority } for the backlog: a ticket's
// manual-backlog-priority when set, else its 1-based place in rankBacklog —
// never a place a manual one holds. What ticket:renumber-backlog writes (ASS-84).
export const backlogPriorities = tickets => Object.fromEntries(rankBacklog(tickets).map((t, i) => [t.key, t['manual-backlog-priority'] ?? i + 1]));
