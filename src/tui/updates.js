// The updates screen's summary: the sprint written the way the team sees the
// work on the board (ASS-332) — each ticket variation once, under the ticket
// system's status it has now. ASS-415: a short, paste-ready list by status,
// "- <KEY>: <title>" under a bold heading counting them, no notes and no
// closing line; the statuses and their order read from the project's engines,
// never from a list of names, the held one (paused, waiting on another ticket
// — control's own dependencyHold, ASS-355 — or blocked, ASS-352) last in
// three sub-groups. Plain text; each key linked to its ticket's url only for
// display. Pure; app.js owns the screen.

import { wrap, link } from './text.js';
import { enginesOf } from './status.js';
import { statusOf } from '../control/engine.js';
import { dependencyHold } from '../control/dependencies.js';

const TYPES = ['features', 'bugs', 'spikes'];
const DAY = 24 * 60 * 60 * 1000;

// lastWeekdayMorning(now) — 04:00 UTC on the most recent weekday before
// `now`'s UTC date (ms): Monday's is the Friday before, Saturday's and
// Sunday's that Friday, any other day's the day before (ASS-332).
export function lastWeekdayMorning(now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const back = { 0: 2, 1: 3, 6: 1 }[now.getUTCDay()] ?? 1;
  return today - back * DAY + 4 * 60 * 60 * 1000;
}

// The held section's sub-groups in their order (ASS-352, ASS-355). ASS-415:
// these say why the harness holds a ticket, not a project's status, so they
// keep their names.
const PAUSED_ON_PURPOSE = 'Paused on purpose', WAITING_ON_ANOTHER = 'Waiting on another ticket', STOPPED = 'Stopped until a problem is fixed';
const HELD_GROUPS = [PAUSED_ON_PURPOSE, WAITING_ON_ANOTHER, STOPPED];
const TITLE_LENGTH = 20;

// The ticket system status a chain pairs with: its deepest step's
// paired-ticket-system-status, falling back up (a sub-engine's steps pair with none).
const pairedOf = chain => chain.findLast(l => l.step?.['paired-ticket-system-status'])?.step['paired-ticket-system-status'];

// boardOf(engines, engineNames) — the board's sections as the engines named
// (the top-level engines of the sprint's variations) define them (ASS-415),
// from their top-level steps, never a list of status names: { rank, held,
// queued, done }. rank maps each paired ticket system status
// (paired-ticket-system-status) to the highest sequence of the steps paired
// with it — the higher, the closer to done, listed first. held is the
// status paired with the blocked state (is-blocked-state), where paused,
// dependency-held and blocked tickets are gathered, listed last — unless a
// step outside quarantine pairs with it too: it is then a working status
// and the engine has no held one (undefined). queued is the status paired
// with the committed queue — the planning-stage step no one works (action
// none) nearest the work — left out. done is the one an is-done step pairs with.
export function boardOf(engines, engineNames) {
  const steps = [...new Set(engineNames)].flatMap(name => engines[name]?.steps ?? []);
  const paired = s => s['paired-ticket-system-status'];
  const rank = new Map();
  for (const s of steps.filter(paired)) rank.set(paired(s), Math.max(rank.get(paired(s)) ?? -Infinity, s.sequence ?? 0));
  const held = steps.filter(s => s['is-blocked-state'] === true).map(paired).filter(Boolean)
    .find(status => !steps.some(s => paired(s) === status && s.area !== 'quarantine'));
  const queue = steps.filter(s => s['is-planning-stage'] === true && s.action?.type === 'none' && s['is-done'] !== true)
    .toSorted((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0))[0];
  const done = steps.find(s => s['is-done'] === true && paired(s));
  return { rank, held, queued: queue && paired(queue), done: done && paired(done) };
}

// A title cut to its first TITLE_LENGTH characters and "..." when longer (ASS-415).
const shortTitle = title => (title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH)}...` : title);

// progressSince({ sprint, workflows, since, hold }) — { sections } (ASS-332,
// ASS-415). `workflows` are the loaded engines (load.js loadWorkflows);
// `since` ms since the epoch; `hold(ticket, variation)` what its
// dependencies hold it on — control's dependencyHold over the project as
// control sees it (ASS-355, screens/updates.js) — by default dependencyHold
// on, over this sprint and the variation's own engine. sections, [{ name,
// bullets: [{ key, url, text }], groups? }], the empty ones left out, in the
// order boardOf reads from the engines of the sprint's variations, closest
// to done first; a status no step pairs with after those, by name; the held
// one last. Every variation not soft-deleted is listed once, under its
// status now: a done one only when it changed state after `since`, one at
// the committed queue's status never. Each text is "<KEY>: <title>", the
// title cut (shortTitle); a ticket with more than one variation is listed
// by variation, "<KEY>.<name>".
//
// Its status is the one its step pairs with (pairedOf), the ticket system's
// (ticket-system-status) when its step pairs with none. When the engine has
// a held status, the held section has `groups` [{ name, bullets }] in
// HELD_GROUPS order, the empty ones left out, its bullets theirs: a
// variation not done and paused on purpose (ASS-352: pausedOnPurpose — the
// operator's pause, a requirements change's or a reassignment's, not
// control's for a fast-track) is under Paused on purpose, whatever its step;
// one its dependencies hold (`hold`'s waits, ASS-355) and not paused on
// purpose under Waiting on another ticket; one at the held status otherwise
// under Stopped until a problem is fixed. ASS-415: every other status, In
// Progress among them, is one flat list.
export function progressSince({ sprint, workflows, since, hold }) {
  const engines = enginesOf(workflows);
  const tickets = TYPES.flatMap(type => sprint?.[type] ?? []);
  hold ??= (t, v) => dependencyHold({ on: true, engine: engines[v['harness-status']?.['state-engine']], engines, tickets }, t, v);
  const live = t => (t.variations ?? []).filter(v => v['is-deleted'] !== true);
  const after = c => Boolean(c.timestamp) && Date.parse(c.timestamp) > since;
  const board = boardOf(engines, tickets.flatMap(t => live(t).map(v => v['harness-status']?.['state-engine']).filter(Boolean)));
  // Paused on purpose (ASS-352): the ticket, or the variation not by control
  // to free a seat for a fast-track (paused-for-fast-track). A requirements
  // change's hold and a reassignment's set is-paused too, so they count.
  const pausedOnPurpose = (t, v) => t['is-paused'] === true || (v['is-paused'] === true && !v['paused-for-fast-track']);
  const groups = new Map();

  for (const t of tickets) {
    const variations = live(t);
    for (const v of variations) {
      const status = pairedOf(statusOf(engines, undefined, v).chain) ?? t['ticket-system-status'] ?? 'No status';
      const done = board.done !== undefined && status === board.done;
      if (done && !(v['state-changes'] ?? []).some(after)) continue;
      const group = !board.held || done ? status
        : pausedOnPurpose(t, v) ? `${board.held}/${PAUSED_ON_PURPOSE}`
          : (hold(t, v)?.waits ?? []).length ? `${board.held}/${WAITING_ON_ANOTHER}`
            : status === board.held ? `${board.held}/${STOPPED}` : status;
      if (board.queued !== undefined && group === board.queued) continue;
      const key = variations.length > 1 ? `${t.key}.${v.name}` : t.key;
      groups.set(group, [...(groups.get(group) ?? []), { key, url: t.url, text: `${key}: ${shortTitle(t.title ?? '')}` }]);
    }
  }

  // The held section's sub-groups, the empty ones left out, under one heading counting them all.
  const held = HELD_GROUPS.filter(name => groups.has(`${board.held}/${name}`)).map(name => ({ name, bullets: groups.get(`${board.held}/${name}`) }));
  for (const name of HELD_GROUPS) groups.delete(`${board.held}/${name}`);
  if (held.length) groups.set(board.held, held.flatMap(g => g.bullets));
  const order = name => (name === board.held ? Infinity : board.rank.has(name) ? -board.rank.get(name) : Number.MAX_VALUE);
  const sections = [...groups.entries()]
    .toSorted(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([name, bullets]) => ({ name, bullets, ...(name === board.held && held.length ? { groups: held } : {}) }));
  return { sections };
}

// The update as lines `width` columns wide (ASS-415): each section's bold
// heading with its count ("*Done (7):*"), its tickets ("- <KEY>: <title>"),
// then a blank line; a section with groups (the held one) has, in place of
// its tickets, each group's plain heading with its count over its own, a
// blank line between. The text is plain (ASS-332: paste-ready); for display
// only, each key is linked to its ticket's url when the sprint has one
// (ASS-86), and a line too long for the screen wraps under its own text.
const bulletLines = (bullets, width) => bullets.flatMap(({ key, url, text }) => {
  const shown = url ? `${link(key, url)}${text.slice(key.length)}` : text;
  return wrap(shown, Math.max(10, width - 2)).map((line, j) => (j ? '  ' : '- ') + line);
});
export const progressLines = ({ sections }, width) => [
  ...(sections.length ? [] : ['Nothing on the sprint has moved since then.']),
  ...sections.flatMap(({ name, bullets, groups }) => [
    ...wrap(`*${name} (${bullets.length}):*`, width),
    ...(groups
      ? groups.flatMap((g, i) => [...(i ? [''] : []), ...wrap(`${g.name} (${g.bullets.length}):`, width), ...bulletLines(g.bullets, width)])
      : bulletLines(bullets, width)),
    '',
  ]),
];
