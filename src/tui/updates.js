// The updates screen's summary: the sprint written the way the team sees the
// work on the board (ASS-332) — each ticket variation that changed since a
// moment, or is not yet Done, once, under the ticket system's status it has
// now, in plain words, closed by a line netting the change since then. Plain
// text, paste-ready; each key linked to its ticket's url only for display.
// Pure; app.js owns the screen.

import { wrap, link } from './text.js';
import { enginesOf } from './status.js';
import { statusOf, inPlanning, isHeld, changePath } from '../control/engine.js';

const TYPES = ['features', 'bugs', 'spikes'];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY = 24 * 60 * 60 * 1000;

// lastWeekdayMorning(now) — 04:00 UTC on the most recent weekday before
// `now`'s UTC date (ms): Monday's is the Friday before, Saturday's and
// Sunday's that Friday, any other day's the day before (ASS-332).
export function lastWeekdayMorning(now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const back = { 0: 2, 1: 3, 6: 1 }[now.getUTCDay()] ?? 1;
  return today - back * DAY + 4 * 60 * 60 * 1000;
}

// The board's columns in its order, each with what it means to the team; In
// Progress is split three ways (see progressSince). Any other status follows
// these, by name, with no meaning of its own.
const BOARD = [
  ['Done', 'Finished and accepted.'],
  ['In Testing', 'The work is done and being verified.'],
  ['In Progress: building', 'Code is written or being written, and tests are running.'],
  ['In Progress: planning', 'Being analyzed and planned before any code.'],
  ['In Progress: held on purpose', 'Started, then held until something else is ready.'],
  ['To Do', 'Committed to the sprint, not started yet.'],
  ['On Hold', 'Stopped until a problem is fixed.'],
];
const IN_PROGRESS = 'In Progress', ON_HOLD = 'On Hold', IN_TESTING = 'In Testing', DONE = 'Done';

// A side of a state change ('from-state' or 'to-state') as a status chain,
// each level { state-engine, state, step }, for the helpers that read one.
const sideOf = (engines, change, side) => ({
  chain: changePath(change).map(at => ({ 'state-engine': at['state-engine'], state: at[side], step: engines[at['state-engine']]?.steps?.find(s => s.id === at[side]) })),
});
// Where a chain stands in plain words: the name of its deepest step that does
// something (a step whose action is none, or an is-done one, is a queue or an
// end, which says nothing about the work), or undefined.
const whereOf = chain => chain.findLast(l => l.step && l.step.action?.type !== 'none' && l.step['is-done'] !== true)?.step.name;
// The ticket system status a chain pairs with: its deepest step's
// paired-ticket-system-status, falling back up (a sub-engine's steps pair with none).
const pairedOf = chain => chain.findLast(l => l.step?.['paired-ticket-system-status'])?.step['paired-ticket-system-status'];
const quarantined = chain => chain[0]?.step?.area === 'quarantine';

// Where the variation stopped before its latest move into quarantine: the
// latest step that did something in the visit that move ended — the deepest
// step each change of it moved to, else from (a sub-engine's own Blocked end
// does nothing: the step before it is where it stopped) — else the step it
// left, in plain words, or undefined.
function stoppedAt(engines, v) {
  const changes = v['state-changes'] ?? [];
  const into = changes.findLastIndex(c => quarantined(sideOf(engines, c, 'to-state').chain) && !quarantined(sideOf(engines, c, 'from-state').chain));
  if (into < 0) return undefined;
  const deepest = (change, side) => whereOf(sideOf(engines, change, side).chain.slice(-1));
  const visited = changes[into]['from-state'];
  for (let i = into - 1; i >= 0 && changes[i]['to-state'] === visited; i--) {
    const where = deepest(changes[i], 'to-state') ?? deepest(changes[i], 'from-state');
    if (where) return where;
  }
  return deepest(changes[into], 'from-state');
}

// progressSince({ sprint, workflows, since }) — { sections, net } (ASS-332).
// `workflows` are the loaded engines (load.js loadWorkflows); `since` ms since
// the epoch. sections, [{ title, bullets: [{ key, url, text }] }], the empty
// ones left out: every variation not soft-deleted that changed state after
// `since`, or that is not Done, once, under its status now, in BOARD order.
//
// Its status is the one its step pairs with (pairedOf), the ticket system's
// (ticket-system-status) when its step pairs with none; when the two differ
// — a transition the ticket system refused, or one not made yet — the line
// says the board may still show the ticket system's. In Progress is split:
// held on purpose when control holds it (isHeld: paused, or worked by hand)
// or a ticket it depends on in the sprint is not Done yet; planning at a
// planning-stage step (inPlanning); else building.
//
// Each text is "<KEY>: <title>. <note>", the note where it is and why it
// waits, in plain words from the engines' step names and the keys it waits
// on — never a step id, an engine name or free text written by an agent. In
// quarantine: the step it stopped at, then the fix it waits on (waits-on),
// that a person must look at it (an is-blocked-state step) or that it is
// being looked into. Elsewhere: the step it is at (whereOf), paused when it
// is, then the dependencies it waits for.
//
// net nets the change since `since`: the holds cleared (moves out of
// quarantine), the On Hold count then and now, how many are being built or
// planned now and then, how many are In Testing, and how many reached Done.
// A variation's status then is the one its step then pairs with — where its
// first change since moved it from, else where it is now — held or not as it
// is now, the ticket system's status then not being kept.
export function progressSince({ sprint, workflows, since }) {
  const engines = enginesOf(workflows);
  const tickets = TYPES.flatMap(type => sprint?.[type] ?? []);
  const live = t => (t.variations ?? []).filter(v => v['is-deleted'] !== true);
  const after = c => Boolean(c.timestamp) && Date.parse(c.timestamp) > since;
  const groups = new Map();
  let cleared = 0, onHoldThen = 0, onHoldNow = 0, activeThen = 0, activeNow = 0, testing = 0, reachedDone = 0;

  // A chain's status on the board, and its In Progress split for a variation held or not.
  const boardOf = (t, chain) => pairedOf(chain) ?? t['ticket-system-status'];
  const splitOf = (status, chain, held) => (status !== IN_PROGRESS ? status
    : `${IN_PROGRESS}: ${held ? 'held on purpose' : inPlanning({ chain }) ? 'planning' : 'building'}`);
  // Done with: the ticket system says so, or a live variation's step pairs with Done.
  const isDone = t => t['ticket-system-status'] === DONE || live(t).some(v => pairedOf(statusOf(engines, undefined, v).chain) === DONE);
  const unfinished = t => (t.dependencies ?? []).filter(key => {
    const dependency = tickets.find(d => d.key.toUpperCase() === String(key).toUpperCase());
    return dependency && !isDone(dependency);   // one not in the sprint cannot be judged: it holds nothing
  });

  for (const t of tickets) {
    const variations = live(t);
    for (const v of variations) {
      const { chain } = statusOf(engines, undefined, v);
      const changes = (v['state-changes'] ?? []).filter(after);
      const waits = unfinished(t);
      const held = isHeld(t, v) || waits.length > 0;
      const status = boardOf(t, chain);
      const then = changes.length ? sideOf(engines, changes[0], 'from-state').chain : chain;
      const statusThen = pairedOf(then) ?? t['ticket-system-status'];
      cleared += changes.filter(c => quarantined(sideOf(engines, c, 'from-state').chain) && !quarantined(sideOf(engines, c, 'to-state').chain)).length;
      onHoldThen += statusThen === ON_HOLD;
      onHoldNow += status === ON_HOLD;
      activeThen += statusThen === IN_PROGRESS && !held;
      activeNow += status === IN_PROGRESS && !held;
      testing += status === IN_TESTING;
      reachedDone += status === DONE && statusThen !== DONE;
      if (!changes.length && status === DONE) continue;

      const paused = isHeld(t, v) ? (v['is-paused'] === true || t['is-paused'] === true ? 'paused' : 'worked by hand') : null;
      const where = quarantined(chain) ? stoppedAt(engines, v) : whereOf(chain);
      const why = quarantined(chain)
        ? (v['waits-on']?.ticket ? `waiting for a fix in ${v['waits-on'].ticket}` : chain.some(l => l.step?.['is-blocked-state']) ? 'needs a person to look at it' : 'being looked into')
        : waits.length ? `waits for ${waits.join(', ')} to finish` : null;
      const at = where ? `${quarantined(chain) ? 'stopped at' : paused ? `${paused} at` : 'at'} the ${where} step` : paused;
      const note = [at, why].filter(Boolean).join(', ');
      const board = t['ticket-system-status'];
      const mismatch = board && pairedOf(chain) && board !== pairedOf(chain) ? ` (board may still show ${board})` : '';
      const title = /[.!?]$/.test(t.title ?? '') ? t.title : `${t.title}.`;
      const key = variations.length > 1 ? `${t.key}.${v.name}` : t.key;
      const text = `${key}: ${title}${note ? ` ${note[0].toUpperCase()}${note.slice(1)}.` : ''}${mismatch}`;
      const group = splitOf(status, chain, held) ?? 'No status';
      groups.set(group, [...(groups.get(group) ?? []), { key, url: t.url, text }]);
    }
  }

  const order = name => (BOARD.findIndex(([n]) => n === name) + BOARD.length + 1) % (BOARD.length + 1);
  const sections = [...groups.entries()]
    .toSorted(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([name, bullets]) => {
      const meaning = BOARD.find(([n]) => n === name)?.[1];
      return { title: `${name} (${bullets.length})${meaning ? `. ${meaning}` : ''}`, bullets };
    });
  const moment = new Date(since);
  const day = moment.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const trend = activeNow > activeThen ? 'up from' : activeNow < activeThen ? 'down from' : 'as many as';
  const net = `Net since ${day.replace(/^(\w+),/, '$1')}, ${moment.toISOString().slice(11, 16)} UTC: `
    + `${plural(cleared, 'hold')} cleared; On Hold went from ${plural(onHoldThen, 'ticket')} to ${onHoldNow}. `
    + `${plural(activeNow, 'ticket')} ${activeNow === 1 ? 'is' : 'are'} actively being built or planned, ${trend} ${activeThen}. `
    + `${testing} in testing, ${reachedDone} reached Done.`;
  return { sections, net };
}

// The update as lines `width` columns wide: each section's title over its
// bullets ("- "), a blank line between, then the net line. The text is plain
// (ASS-332: paste-ready); for display only, each key is linked to its
// ticket's url when the sprint has one (ASS-86), and a line too long for the
// screen wraps under its own text.
export const progressLines = ({ sections, net }, width) => [
  ...(sections.length ? [] : ['Nothing on the sprint has moved since then.']),
  ...sections.flatMap(({ title, bullets }, i) => [
    ...(i ? [''] : []), ...wrap(title, width),
    ...bullets.flatMap(({ key, url, text }) => {
      const shown = url ? `${link(key, url)}${text.slice(key.length)}` : text;
      return wrap(shown, Math.max(10, width - 2)).map((line, j) => (j ? '  ' : '- ') + line);
    }),
  ]),
  '', ...wrap(net, width),
];
