// The ticket screen: everything sprint.json holds on one ticket variation.
import { pathToFileURL } from 'node:url';
import { link, wrap, pad, visible, clip } from './text.js';
import { scrollBox } from './table.js';
import { duration } from './metrics.js';
import { stateOf, levelChanges, isPlanned, isUnopened, mrStatus, unopenedAs } from './status.js';
import { engineSteps, changePath, gateName } from '../control/engine.js';
import { ticketPath } from '../control/moves.js';
import { ticketSpend, spendText } from '../control/spend.js';

const NONE = '—';
const LABEL = 28;   // the field-name column
const BAR = 10;     // a history row's idle bar, inside its border
const STEER = 'Steer this ticket by hand.';
const HISTORY_INDENT = BAR + 6;   // a history entry's text column: "  │" + bar + "│  ", or as many spaces

// entryRows(halves, width) — a history entry's text laid into rows of `width`
// columns (ASS-64). `halves` is the entry's two halves, the step it left and
// the step it went to, each a list of pieces { sep, text }: the text, joined,
// is the separators and pieces in order. An entry that fits is one row of
// exactly that text, its runs of spaces kept. One that does not breaks before
// the second half, so `→   <to step>` always starts a row; within a half a row
// takes whole pieces (a step with its time, an agent with its time and cost)
// while they fit, dropping the separator where a row breaks; a piece wider
// than the row goes word by word, a word wider still left whole for the box
// to cut — so no emoji or escape sequence is ever split.
function entryRows(halves, width) {
  const all = halves.flat();
  const whole = all.map(p => p.sep + p.text).join('');
  if (visible(whole) <= width) return [whole];
  return halves.flatMap(half => {
    const pieces = half.filter(p => p.text).flatMap(p => (visible(p.text) <= width ? [p]
      : p.text.split(' ').filter(Boolean).map((text, i) => ({ sep: i ? ' ' : p.sep, text }))));
    return pieces.reduce((rows, { sep, text }) => {
      const last = rows.at(-1);
      if (last === undefined || visible(last + sep + text) > width) rows.push(text);
      else rows[rows.length - 1] = last + sep + text;
      return rows;
    }, []);
  });
}
const color = code => text => `\x1b[${code}m${text}\x1b[0m`;
// A check's result: green Passed, red Failed, gray anything else.
const result = status => ({ Passed: color('32'), Failed: color('31') }[status] ?? color('90'))(status ?? 'Not started');

// tokenSpend(v, chat, running) — "$x.xx", the cost-usd of every agent dispatched on
// variation `v`, summed from its state-changes, and `chat` dollars more (the
// ticket's chat, ASS-35), and `running` more — what its running agents have
// spent so far (ASS-270), marked: "$x.xx (~$y.yy running)"; null when none has a cost.
// testCounts(v['local-testing']) — the automated test tally's two numbers,
// [passing, relevant], or null unless both are there (ASS-45): ticket:sync
// starts every variation with an empty `local-testing`, and the test
// sub-engine's verdict adds is-approved, summary and a timestamp, not counts.
export function testCounts(tests) {
  const passing = tests?.['number-of-passing-relevant-automated-tests'];
  const relevant = tests?.['number-of-relevant-automated-tests'];
  return typeof passing === 'number' && typeof relevant === 'number' ? [passing, relevant] : null;
}

// workedByHand(t) — who has worked ticket `t` by hand since when, and the
// note (ASS-166: its worked-manually, ticket:set-manual): "worked by hand by
// <by> since <yyyy-mm-dd hh:mm> UTC[: <note>]" (ASS-294: the time says UTC); null when it is not.
export function workedByHand(t) {
  const m = t?.['worked-manually'];
  return m ? `worked by hand by ${m.by} since ${String(m.since).replace('T', ' ').slice(0, 16)} UTC${m.note ? `: ${m.note}` : ''}` : null;
}

// reassignedTo(t) — why ticket `t` is held when ticket:sync found it
// reassigned away from the operator's account (ASS-345: its reassigned):
// "Reassigned to <name>" (its account id when it has no name), or
// "Unassigned" with no one; null when it is not. reassignedText(t) adds
// when: "…, detected <yyyy-mm-dd hh:mm> UTC".
export function reassignedTo(t) {
  const r = t?.reassigned;
  if (!r) return null;
  return r.to != null ? `Reassigned to ${r.to}` : r['to-id'] != null ? `Reassigned to ${r['to-id']}` : 'Unassigned';
}
const reassignedText = t => (reassignedTo(t) ? `${reassignedTo(t)}, detected ${String(t.reassigned['detected-at']).replace('T', ' ').slice(0, 16)} UTC` : null);

export function tokenSpend(v, chat = 0, running = 0) {
  const costs = [...(v['state-changes'] ?? []).flatMap(c => c['agent-dispatch-log'] ?? []).map(d => d['cost-usd']), chat || null, running || null].filter(c => c != null);
  return costs.length ? `$${costs.reduce((sum, c) => sum + c, 0).toFixed(2)}${runningText(running)}` : null;
}

// runningText(usd) — " (~$y.yy running)": the running agents' spend so far
// (ASS-270), an estimate while a turn is under way; nothing for none.
const runningText = usd => (usd > 0 ? ` (~$${usd.toFixed(2)} running)` : '');

// agentTime(v) — ms agents actually worked on variation `v`: completed-
// timestamp − timestamp over every dispatch in its state-changes, those
// within a step (sub-state-change) included; null when none has finished.
export function agentTime(v) {
  const done = (v['state-changes'] ?? []).flatMap(c => c['agent-dispatch-log'] ?? []).filter(d => d.timestamp && d['completed-timestamp']);
  return done.length ? done.reduce((sum, d) => sum + Date.parse(d['completed-timestamp']) - Date.parse(d.timestamp), 0) : null;
}

// The steps by kind, for the time fields: planning (is-planning-stage),
// quarantine (area), done (is-done).
const kind = steps => {
  const of = id => steps.find(s => s.id === id) ?? {};
  return { planning: id => of(id)['is-planning-stage'] === true, quarantine: id => of(id).area === 'quarantine', done: id => of(id)['is-done'] === true };
};
const elapsed = (start, end) => (start && end ? Date.parse(end.timestamp) - Date.parse(start.timestamp) : null);

// planningTime(v, steps) — ms from the move into its first planning step to
// the move out of its last into a pipeline step (not quarantine), over its
// top-level state-changes; null while it has not left planning.
export function planningTime(v, steps) {
  const { planning, quarantine } = kind(steps);
  const changes = levelChanges(v);
  return elapsed(changes.find(c => planning(c['to-state'])),
    changes.findLast(c => planning(c['from-state']) && !planning(c['to-state']) && !quarantine(c['to-state'])));
}

// executingTime(v, steps) — ms from when it first moved out of its first
// non-planning step (the lowest sequence neither planning, quarantine nor
// done) to its move to a done step; null before then.
export function executingTime(v, steps) {
  const { planning, quarantine, done } = kind(steps);
  const first = steps.filter(s => !planning(s.id) && !quarantine(s.id) && !done(s.id)).toSorted((a, b) => a.sequence - b.sequence)[0]?.id;
  const changes = levelChanges(v);
  const start = changes.findIndex(c => c['from-state'] === first && c['to-state'] !== first);
  return start < 0 ? null : elapsed(changes[start], changes.slice(start).find(c => done(c['to-state'])));
}

// overlapsOf(t, tickets) — a ticket's overlaps for the screen (ASS-196):
// its own t.overlaps ∪ the keys of other tickets whose `overlaps` include
// t.key. An overlap is stored once, on the ticket whose Find Dependencies
// run found it; the ticket screen looks it up from either side. Matched in
// any case, own keys first (as written), reverse-lookup keys after
// (deduped, case-insensitive).
export function overlapsOf(t, tickets) {
  const own = t.overlaps ?? [];
  const key = (t.key ?? '').toUpperCase();
  const seen = new Set(own.map(k => k.toUpperCase()));
  const reverse = [];
  for (const other of tickets ?? []) {
    if (!other || (other.key ?? '').toUpperCase() === key) continue;
    if ((other.overlaps ?? []).some(k => k.toUpperCase() === key) && !seen.has((other.key ?? '').toUpperCase())) {
      seen.add((other.key ?? '').toUpperCase());
      reverse.push(other.key);
    }
  }
  return [...own, ...reverse];
}

// ticketLines(t, { status, stepName, agents, columns }) — the screen's lines
// in two sections for the caller to scroll on its own, { details, history,
// starts } (ASS-101): every field of the ticket, its state history, and the
// row each history entry starts on (ASS-145). `t` is a
// sprint ticket with its icon, shownKey and the variation on show; `status`
// its Status cell text; stepName(id) a step's display name; prompted(id)
// whether that step prompts an agent; `agents` the agent names on it; `steps`
// its engine's steps (for the time fields: agentTime, planningTime,
// executingTime); `chatSpend` what its chat has cost, in its Total Token Spend;
// `spendLimit` the ticket's spending limit (ASS-191), its spend shown against it;
// `running` what the variation's running agents have spent so far and
// `ticketRunning` the ticket's — every variation's (ASS-270: their usage.json,
// spend.js usageSpend), counted in its Total Token Spend and its spend against
// the limit, marked as running;
// gateName(entry) a gate-when-leaving-state entry's display name (stepName's by default).
// `overlaps` the keys of its Overlaps field, the screen's overlapsOf over the
// project's tickets (ASS-196); its own t.overlaps by default.
// The history is the variation's state-changes — a sprint variation's its
// development engine's moves (sprint.json), a backlog one's its refinement
// engine's (backlog.json): two arrays of one shape, each entry naming its
// state-engine, and one with a "cause" (a move no step's exit made:
// requirements-changed, migrated or operator, with a rejection's "reason";
// see sprint.bash) shows it last (ASS-42). Given `refinement` { engine,
// changes, stepName } — a sprint ticket's backlog entry's history
// (refinementHistory) — that comes first, then the development history, each
// under its engine's name; without one, or with it empty, the development
// history alone, unlabelled.
// In a column too narrow for a value beside its label (a narrow screen's tab),
// labels sit above their values and a criterion's statuses above its
// description, and a history entry gives up its idle bar.
export function ticketLines(t, { status, stepName, prompted, agents, columns, steps = [], chatSpend = 0, spendLimit = null, running = 0, ticketRunning = running, gateName: gate = stepName, refinement, overlaps = t.overlaps ?? [] }) {
  const v = t.variation;
  const beside = columns >= LABEL + 20;
  const width = beside ? columns - LABEL : Math.max(10, columns);
  // A labelled field: text is wrapped beside the label, or under it in a narrow column; an array is lines as they are.
  const field = (label, value) => {
    const lines = Array.isArray(value) ? value : wrap(value == null || value === '' ? NONE : String(value), width);
    const text = lines.length ? lines : [NONE];
    return beside ? text.map((line, i) => pad(i ? '' : label, LABEL) + line) : [label, ...text];
  };
  const section = (title, lines) => ['', title, ...(lines.length ? lines : ['  none'])];
  const { branch, 'branch-url': branchUrl, worktree, 'worktree-folder': folder } = v.build ?? {};
  const tests = testCounts(v['local-testing']);
  const criteria = v['acceptance-criteria'] ?? [];
  const mrs = v['merge-request'] ?? [];
  const changes = v['state-changes'] ?? [];
  // A history entry's time, saying UTC (ASS-294): "2026-10-12 08:00 UTC"; nothing for none.
  const at = iso => (iso ? `${iso.replace('T', ' ').slice(0, 16)} UTC` : '');
  const time = ms => (ms == null ? null : duration(ms));
  const key = `${t.icon} ${t['fast-track'] === true ? '⚡ ' : ''}${workedByHand(t) ? '✋ ' : ''}${t.key}`;   // ⚡ fast-tracked (ASS-83), ✋ worked by hand (ASS-166)
  const details = [
    ...field('Ticket number', [t.url ? link(key, t.url) : key]),
    ...field('Variation', v.name),
    ...field('Ticket name', t.title),
    ...field('Description', t.description),   // whole (ASS-185 AC4)
    '',
    ...field('Status', status),
    // Paused: why, when control pre-empted it for a fast-tracked ticket (ASS-83).
    ...(v['is-paused'] === true ? field('Paused', v['paused-for-fast-track'] ? `to free a seat for fast-tracked ${v['paused-for-fast-track']}` : 'yes') : []),
    ...(workedByHand(t) ? field('By hand', workedByHand(t)) : []),
    // Held because it was reassigned away from the operator (ASS-345), whoever it went to and when that was seen.
    ...(reassignedText(t) ? field('Held', reassignedText(t)) : []),
    ...field('Status in ticketing system', t['ticket-system-status']),
    ...field('Assignee', t['ticket-system-assignment']),
    ...field('Points', t.points),
    // An estimate above the scale, noted at the family's Too Large (ASS-264, ticket:note-too-large): the ticket has no points.
    ...(t['too-large-estimate'] ? field('Estimated too large', `${t['too-large-estimate'].points} points`) : []),
    ...field('Priority', t.priority),
    ...field('Manual priority', t['manual-priority']),
    '',
    ...field('Dependencies', t.dependencies?.join(', ')),
    ...field('Overlaps', overlaps.join(', ')),
    '',
    ...field('Branch', branch && [branchUrl ? link(branch, branchUrl) : branch]),
    ...field('Worktree', worktree && [folder ? link(worktree, pathToFileURL(folder).href) : worktree]),
    '',
    // The ticket's spend, every variation's, its running agents' so far among it (ASS-270), against its limit (ASS-191, control/spend.js), when it has one.
    ...(spendLimit != null ? field('Spending limit', `${spendText(ticketSpend(t) + ticketRunning, spendLimit)}${runningText(ticketRunning)}`) : []),
    ...field('Total Token Spend', tokenSpend(v, chatSpend, running)),
    ...field('Total Agent Time', time(agentTime(v))),
    ...field('Total Time Planning', time(planningTime(v, steps))),
    ...field('Total Time Executing', time(executingTime(v, steps))),
    '',
    ...field('Health', v['ai-feedback-long']),
    ...field('Automated tests', tests && `${tests[0]}/${tests[1]} passing`),
    ...field('Gates', v['gate-when-leaving-state']?.map(gate).join(', ')),
    '',
    // Only beside another variation is there one to be preferred over.
    ...((t.variations?.length ?? 1) > 1 ? [...field("AI's feedback", v['ai-variation-feedback']), ''] : []),
    ...field('Agents', agents.map(a => `🤖 ${a}`)),
    ...section('Acceptance criteria', criteria.map((c, i) => {
      const head = `  ${pad(String(c['criteria-number'] ?? i + 1), 4)}dev ${pad(result(c['dev-status']), 12)}testing ${pad(result(c['testing-status']), 12)}`;
      if (!beside) return [head.trimEnd(), ...wrap(c.description ?? '', Math.max(10, columns - 2)).map(line => `  ${line}`)];
      const [first, ...rest] = wrap(c.description ?? '', Math.max(20, columns - 46));
      return [head + (first ?? ''), ...rest.map(line => ' '.repeat(46) + line)];
    }).flat()),
    '',
    ...field('QA', t.qa?.status),
    // A planned one (ASS-80) has no key, link or build status yet: its id, repository, branch, contents and what it waits on.
    // One closed without being opened (ASS-81) likewise, its status then "not opened".
    ...section('Merge requests', mrs.map(m => (isUnopened(m)
      ? `  MR ${m.id}  ${mrStatus(m)} (${isPlanned(m) ? 'planned' : 'not opened'})  ${String(m.repository ?? NONE).replace(/\.git$/, '').split('/').pop()}  ${m.branch ?? NONE}  ${m.contents ?? NONE}${m['depends-on']?.length ? `  after MR ${m['depends-on'].join(', ')}` : ''}`
      : `  ${link(m.key, m.url)}  ${mrStatus(m)}  ${link(m['build-status'] ?? NONE, m['build-url'] ?? m.url)}`))),
  ];
  // Each entry as tall as one with a bar, its text on the bar's line (and the rows it wraps onto, ASS-64), a ↓ under the bar between them.
  // No heading of its own: the ticket screen gives the section its header (ASS-102).
  const draw = (changes, stepName, prompted) => changes.map((c, i) => {
    const before = changes[i - 1];
    // " (2h 24m)": the time from `start` to `end`; nothing without both.
    const took = (start, end) => (start && end ? ` (${duration(Date.parse(end) - Date.parse(start))})` : '');
    // Its cost, ~ before one that is usage.json's estimate of a turn cut short (ASS-268: cost-estimated).
    const cost = d => (d['cost-usd'] == null ? '' : ` ${d['cost-estimated'] ? '~' : ''}$${d['cost-usd'].toFixed(2)}`);
    // A move no step's exit made (ASS-42): its cause, and a rejection's reason, last.
    const why = ({ cause, reason }) => (cause ? [{ sep: '   ', text: `(${cause}${reason ? `: ${reason}` : ''})` }] : []);
    // Its memory use (ASS-147) when any: " 🧠 <recalls>↓<memories returned> ↑<saves>", then " ✗<deletes>" when it deleted any.
    const memory = ({ memory: m }) => (m && (m.recalls || m.returned || m.saves || m.deletes) ? ` 🧠 ${m.recalls}↓${m.returned} ↑${m.saves}${m.deletes ? ` ✗${m.deletes}` : ''}` : '');
    // Each agent a piece: one space after its step, two between agents.
    const robots = (log, time) => (log ?? []).map((d, k) => ({ sep: k ? '  ' : ' ', text: `🤖 ${d['dispatched-to']}${time ? took(d.timestamp, d['completed-timestamp']) : ''}${cost(d)}${memory(d)}` }));
    const [first, ...more] = entryRows([
      [{ sep: '', text: at(c.timestamp ?? '') }, { sep: '  ', text: `${stepName(c['from-state'])}${took(before?.timestamp, c.timestamp)}` }, ...robots(before?.['agent-dispatch-log'], true)],
      [{ sep: '   ', text: '→' }, { sep: '   ', text: stepName(c['to-state']) }, ...robots(c['agent-dispatch-log'], false), ...why(c)],
    ], Math.max(20, columns - HISTORY_INDENT));
    const inState = before && Date.parse(c.timestamp) - Date.parse(before.timestamp);
    const indent = ' '.repeat(HISTORY_INDENT);
    if (!beside || !prompted(c['from-state']) || !(inState > 0)) return ['', indent + first, ...more.map(row => indent + row), '', ''];
    // The bar: the share of the visit agents ran, in BAR cells; beneath it the rest, idle.
    const ran = (before['agent-dispatch-log'] ?? []).filter(d => d['completed-timestamp'])
      .reduce((sum, d) => sum + Date.parse(d['completed-timestamp']) - Date.parse(d.timestamp), 0);
    const busy = Math.min(1, ran / inState);
    const cells = Math.round(busy * BAR);
    const idle = `${Math.round((1 - busy) * 100)}% idle`;
    return [
      `  ┌${'─'.repeat(BAR)}┐`,
      `  │${'█'.repeat(cells)}${'░'.repeat(BAR - cells)}│  ${first}`,
      ...more.map(row => `  │${' '.repeat(BAR)}│  ${row}`),
      `  └${'─'.repeat(BAR)}┘`,
      `  ${' '.repeat(Math.floor((BAR + 2 - idle.length) / 2))}${idle}`,
    ];
  });
  // The parts of the history (ASS-42): the backlog entry's refinement history first, when it has one, then
  // the development history, each under its engine's name; without one, the development history alone, unlabelled.
  const parts = refinement?.changes?.length
    ? [{ label: refinement.engine, entries: draw(refinement.changes, refinement.stepName, () => false) },
      { label: v['harness-status']?.['state-engine'] ?? changes.at(-1)?.['state-engine'] ?? NONE, entries: draw(changes, stepName, prompted) }]
    : [{ entries: draw(changes, stepName, prompted) }];
  // Each entry's first row, the one after the ↓ above it, for the history to scroll by (ASS-145).
  const history = [], starts = [];
  parts.forEach(({ label, entries }, p) => {
    if (label !== undefined) history.push(...(p ? [''] : []), `  ${label}`, ...(entries.length ? [] : ['  none']));
    entries.forEach((entry, i) => {
      if (i) history.push(`  ${' '.repeat(BAR / 2 + 1)}↓`);
      starts.push(history.length);
      history.push(...entry);
    });
  });
  if (!history.length) history.push('  none');
  return { details, history, starts };
}

// refinementHistory(entry, name, engines) — what ticketLines takes as
// `refinement` for a sprint ticket (ASS-42 Q3): `entry` its ticket in
// backlog.json (kept there when it joined the sprint), the history its
// variation `name` — else its first live one — keeps there, its engine the
// one that variation's harness-status names (else its last entry's), step
// names from that engine in `engines` (its id where it has no such step).
// Null without a backlog entry.
export function refinementHistory(entry, name, engines) {
  const live = (entry?.variations ?? []).filter(v => !v['is-deleted']);
  const v = live.find(x => x.name === name) ?? live[0];
  if (!v) return null;
  const changes = v['state-changes'] ?? [];
  const engine = v['harness-status']?.['state-engine'] ?? changes.at(-1)?.['state-engine'];
  const steps = engines[engine]?.steps ?? [];
  return { engine, changes, stepName: id => steps.find(s => s.id === id)?.name ?? id };
}

// pendingChange(t, columns) — a pending requirements change's lines (ASS-78
// AC2): when it was detected, then the ticket's current description and the
// new one side by side, each whole and wrapped to its half of `columns`, its
// line breaks kept. The Actions tab shows them under Keep current and Take
// new (ASS-184), what the choice is about.
export function pendingChange(t, columns) {
  const change = t['pending-requirements-change'];
  const half = Math.max(10, Math.floor((columns - 5) / 2));
  const lines = text => String(text ?? NONE).split('\n').flatMap(line => wrap(line, half));
  const [left, right] = [lines(t.description), lines(change.description)];
  return [
    `  detected ${String(change['detected-at'] ?? NONE).replace('T', ' ').slice(0, 16)} UTC`,
    `  ${pad('Current', half)} │ New`,
    ...Array.from({ length: Math.max(left.length, right.length) }, (_, i) => `  ${pad(left[i] ?? '', half)} │ ${right[i] ?? ''}`),
  ];
}

// stateCounts(v, steps) — a variation's visits and dispatches per state
// (ASS-101 AC3), { <step id>: { visits, dispatches } } for every step of
// `steps`, so one it has never been in reads 0 and 0. Visits are the moves
// into the state at the top level of its history (levelChanges, so a move
// made within it is not an arrival); dispatches the agents sent on the moves
// out of it, those sent within the state (a move's sub-state-change, as deep
// as it goes) rolled into it. A dispatch still running counts. A
// state-engine step's dispatches are the sub-engine runs started from it
// instead (ASS-67, ASS-66's rule): one an entry into its sub-engine, never
// its children's agents.
export function stateCounts(v, steps) {
  const changes = levelChanges(v);
  const sent = change => {
    let log = 0;
    for (let at = change; at; at = at['sub-state-change']) log += at['agent-dispatch-log']?.length ?? 0;
    return log;
  };
  const entries = id => (v['state-changes'] ?? []).filter(c => c['to-state'] === id && c['sub-state-change']?.['from-state'] === null && !c['sub-state-change']['sub-state-change']).length;
  return Object.fromEntries(steps.map(s => [s.id, {
    visits: changes.filter(c => c['to-state'] === s.id).length,
    dispatches: s.action?.type === 'state-engine' ? entries(s.id) : (v['state-changes'] ?? []).filter(c => c['from-state'] === s.id).reduce((sum, c) => sum + sent(c), 0),
  }]));
}

// statesColumn(steps, { current, counts, width }) — the states beside a
// ticket screen's history (ASS-101 AC2, ASS-184's History tab): each step's name, wrapped at `width` so no
// name is cut, with its "(visits, dispatches)" from `counts` when there are
// any, a `↓` line between them, and the step `current` names in reverse
// video. The pipeline comes first in sequence order, the engine's quarantine
// states (AC9) after it in theirs.
export function statesColumn(steps, { current, counts, width }) {
  const inOrder = area => steps.filter(s => (s.area === 'quarantine') === area).toSorted((a, b) => a.sequence - b.sequence);
  return [...inOrder(false), ...inOrder(true)].flatMap((s, i) => {
    const count = counts?.[s.id];
    const lines = wrap(count ? `${s.name} (${count.visits}, ${count.dispatches})` : s.name, Math.max(4, width));
    return [...(i ? ['↓'] : []), ...(s.id === current ? lines.map(line => `\x1b[7m${line}\x1b[0m`) : lines)];
  });
}

// Where a variation goes back to on an exit that follows the return-to-state,
// walking `changes` (its history at one level) back from `at`, where it is:
// the step it came from sends it to that step's return-to-state when it has
// one; else, when it follows the return-to-state itself (as blocked and
// blocked-for-human do), the walk goes on to the step before it; else it is
// that step. Null when its history does not say.
function returnTo(at, changes, steps) {
  for (let i = changes.length; ;) {
    i = changes.findLastIndex((c, k) => k < i && c['to-state'] === at);
    if (i < 0) return null;
    at = changes[i]['from-state'];
    const step = steps.find(s => s.id === at);
    if (step?.['return-to-state']) return step['return-to-state'];
    if (!step?.['follow-return-to-state']) return at;
  }
}

// The steps a Human Review rejection may send the ticket back to (ASS-228), the
// first the default: [id, name], the id ticket:human-review's <return-to>.
export const RETURN_STEPS = [['write-execution-plan', 'Write Execution Plan'], ['write-test-plan', 'Write Test Plan'], ['generate-solution', 'Generate Solution']];

// A human gate's choices, from its exits in order: one per exit waiting on
// { "human-review": <decision> }, and for an exit waiting on
// { "variation-selected": true } one per variation of ticket `t` to go with,
// linked to its first merge request. Rejected at Human Review takes a reason
// (form: 'reason'), passed last — then, when its exit moves by the human's
// return step (move-to-state-from-human-review, ASS-228), that step
// (returnSteps, RETURN_STEPS), passed after it.
// Each leads to its exit's step, or for one that follows the return-to-state
// the step returnTo finds — "back where it came from" when there is none —
// and passes that step's id ("" for none) for the ticket to move there; each
// recorded `at` the step. Given the `run` the step is in (ASS-67), `steps`
// its engine's: the return walked over the run's own history, and "" passed
// for every choice — control moves the run by the exit the choice meets.
const gateChoices = (step, steps, t, run) => (step['exit-events'] ?? []).flatMap(e => {
  const back = () => (run ? returnTo(run.state, run['state-changes'] ?? [], steps) : returnTo(stateOf(t.variation), levelChanges(t.variation), steps));
  const target = e['follow-return-to-state'] || e['follow-return-to'] ? back() : e['move-to-state'];
  const leadsTo = target ? steps.find(s => s.id === target)?.name ?? target : 'back where it came from';
  const to = run ? '' : target ?? '', at = step.id;
  if (Object.hasOwn(e.condition ?? {}, 'human-review')) {
    const decision = String(e.condition['human-review']);
    // Rejected at Human Review asks why (ASS-118), as does an exit that says so (asks-for-reason: a backlog
    // ticket's Reject at Awaiting Approval, ASS-144): the reason is the command's last argument.
    const why = (step.id === 'human-review' && decision === 'Rejected') || e['asks-for-reason'] === true
      ? { form: 'reason', ...(e['move-to-state-from-human-review'] ? { returnSteps: RETURN_STEPS } : {}) } : {};
    return [{ decision, leadsTo, at, command: 'ticket:human-review', args: [decision, to], ...why }];
  }
  if (e.condition?.['variation-selected'] === true) {
    return (t.variations ?? []).map(v => ({ decision: `Go with ${t.key}.${v.name}`, url: v['merge-request']?.find(m => m.url)?.url, leadsTo, at, command: 'ticket:select-variation', args: [v.name, to] }));
  }
  return [];
});

// humanGate(t, steps, { engines, runs }) — what a human must do before a sprint ticket variation
// moves on, or null: { choices, step }, each choice { decision, leadsTo,
// command, args } recorded by running `command <project> <ticket> <variation>
// <state> ...args` — or { decision, leadsTo, decide }, the whole command —
// and `step` the step it waits at. At a human step: choose one of its human-review exits, or
// the variation to go with (see gateChoices) — unless it has a
// { "has-variations": false } exit and the ticket only one variation, which
// meets it, so no human is needed. At
// a state the variation's gate-when-leaving-state lists ("<engine>/<step>"),
// once its latest change, into that state, has work-is-done: approve the
// move control held there, its pending move (ASS-132: where the step's exit
// was going, with the step's output; ticket:approve-gate) — or, a gate marked
// without one, the move to the next step by sequence, quarantine skipped. Given the ticket's
// status (t.status, statusOf), its `engines` and the control's `runs`
// (transient-state-engines), a step inside a sub-engine (ASS-67), the deepest
// first: at a human step there, its choices (gateChoices, in its run); at a
// gated one, approve the next step in that sub-engine, moving its run
// (transient-state-engine:change-state). Ahead of all of these, while the
// ticket has a pending-requirements-change (ASS-77, ASS-78): { title, choices,
// step } — Keep current or Take new, whole commands on the ticket in
// `project` (ticket:keep-current, ticket:take-new). A pending move held at a
// leaving-gate is offered as its Approve, marked `held`, ahead of any human
// step's choices or pass by itself (ASS-220).
export function humanGate(t, steps, { engines = {}, runs = [], project } = {}) {
  const step = t.step;
  if (!step) return null;
  if (t['pending-requirements-change']) {
    return { title: 'Pending requirements change', step, choices: [
      { decision: 'Keep current', decide: ['ticket:keep-current', project, t.key] },
      { decision: 'Take new', decide: ['ticket:take-new', project, t.key] },
    ] };
  }
  const chain = t.status?.chain ?? [{ 'state-engine': t.variation['harness-status']?.['state-engine'], state: step.id, step }];
  const levelSteps = at => (at ? engineSteps(engines, chain[at]['state-engine'])?.steps ?? [] : steps);
  // The run the ticket's level `at` (1 and down) sits in.
  const runAt = at => runs.find(r => {
    const of = ticketPath(r, runs);
    return r['state-engine'] === chain[at]['state-engine'] && r.state === chain[at].state && of?.workItem === t.key && of.variation === t.variation.name && of.path.length === at - 1;
  });
  const last = t.variation['state-changes']?.at(-1), path = changePath(last);
  const at = chain.findLastIndex((l, i) => l.step && (t.variation['gate-when-leaving-state'] ?? []).includes(gateName(l)) && path[i]?.['to-state'] === l.state && last['work-is-done'] === true);
  const level = chain[at], pending = at >= 0 && last['pending-move'];
  // The move control held there (ASS-132): approved as it was, wherever its exit was going, with its output —
  // ahead of a human step's choices, its decision recorded already, or its pass by itself (ASS-220).
  if (pending) return { choices: [{ decision: 'Approve', leadsTo: levelSteps(at).find(s => s.id === pending.to)?.name ?? pending.to, command: 'ticket:approve-gate', args: [] }], step: level.step, held: true };
  const human = chain.findLastIndex(l => l.step?.action?.type === 'human');
  if (human >= 0) {
    const at = chain[human].step;
    const passes = (at['exit-events'] ?? []).some(e => e.condition?.['has-variations'] === false);
    if (passes && (t.variations?.length ?? 1) <= 1) return null;
    const run = human ? runAt(human) : undefined;
    return { choices: human && !run ? [] : gateChoices(at, levelSteps(human), t, run), step: at };
  }
  if (at < 0) return null;
  const next = levelSteps(at).filter(s => s.area !== 'quarantine' && s.sequence > level.step.sequence).toSorted((a, b) => a.sequence - b.sequence)[0];
  if (!next) return { choices: [], step: level.step };
  if (!at) return { choices: [{ decision: 'Approve State Transition', leadsTo: next.name, command: 'ticket:change-state', args: [next.id] }], step };
  const run = runAt(at);
  return { choices: run ? [{ decision: 'Approve State Transition', leadsTo: next.name, decide: ['transient-state-engine:change-state', run.id, level.state, next.id] }] : [], step: level.step };
}

// gateLines({ title, choices, selected, focused, recorded, held, past, message, width }) —
// the human actions on a ticket screen's Actions tab (ASS-101 AC9, ASS-184): "Steer this
// ticket by hand.", the gate's title when it has one, the choices (each `decision → leadsTo`, or the decision
// alone without one) with the selected one marked
// (in reverse video when `focused`), the choice already recorded at this gate (and, `held`, its move held at a leaving-gate, ASS-220),
// and any message from recording one. A choice too wide for the column wraps
// into it, marked and highlighted line by line. On a `past` day nothing can be chosen.
export function gateLines({ title, choices, selected, focused, recorded, held, past, message, width }) {
  const keyWidth = Math.max(0, ...choices.map(c => c.decision.length));
  const choiceLines = choices.flatMap((c, i) => {
    const text = c.leadsTo == null ? (c.url ? link(c.decision, c.url) : c.decision) : `${pad(c.url ? link(c.decision, c.url) : c.decision, keyWidth)}  → ${c.leadsTo}`;
    const lines = visible(text) <= width - 4 ? [text] : wrap(text, Math.max(4, width - 4));
    if (i !== selected || past) return lines.map(line => `    ${line}`);
    return lines.map((line, k) => `${k ? '    ' : '  ▸ '}${focused ? `\x1b[7m${line}\x1b[0m` : line}`);
  });
  return [
    STEER,
    '',
    ...(title ? [title] : []),
    'Choose one:',
    ...(choiceLines.length ? choiceLines : ['  nothing to choose: this gate has no way on']),
    '',
    ...(recorded ? wrap(`Recorded: ${recorded.decision} at ${recorded.timestamp.replace('T', ' ').slice(0, 16)} UTC — ${held ? 'the move is held at the gate: approve it to move on' : 'control moves the ticket on'}.`, width) : []),
    ...(past ? ['This is a past day: go to today to choose.'] : []),
    ...(message ? wrap(color('31')(message), width) : []),
  ];
}

// ticketColumn(sections, width) — one column of the ticket screen's box (ASS-101),
// boxed `width` wide: each section's `height` lines — its `head` lines, then
// as many of its `lines` as are left from `scroll` (scrollBox, so a section
// that does not fit carries its own scrollbar thumb on the border), then its
// `foot` lines — with a rule between sections. A section with `wrap` (the
// chat's log, ASS-63) wraps its wider lines as scrollBox does rather than clipping them. Rules sit inside the borders,
// so every line of every column cuts at the same places and they join into a row.
function ticketColumn(sections, width) {
  const text = width - 4;
  const row = line => `│ ${pad(visible(line) <= text ? line : `${clip(line, text - 1)}…`, text)} │`;
  const inner = sections.flatMap(({ head = [], lines, foot = [], height, scroll = 0, wrap = false }, i) => [
    ...(i ? [row('─'.repeat(Math.max(0, text)))] : []),
    ...head.map(row),
    ...scrollBox(lines, { width, height: Math.max(1, height - head.length - foot.length) + 2, scroll, wrap }).slice(1, -1),
    ...foot.map(row),
  ]);
  return [`┌${'─'.repeat(width - 2)}┐`, ...inner, `└${'─'.repeat(width - 2)}┘`];
}

// joinColumns(columns) — the ticket screen's columns side by side: each row is
// one line of each column, neighbours sharing the border between them.
const joinColumns = columns => columns[0].map((line, i) => columns.slice(1).reduce((row, column) => row + (column[i] ?? '').slice(1), line));

// The ticket screen's tabs (ASS-184), in order, each [id, label]: the one
// open fills the box left of the quick-details panel, PANEL columns wide,
// borders included; 1–5 name them.
export const TABS = [['actions', 'Actions'], ['details', 'Details'], ['history', 'History'], ['questions', 'Questions'], ['chat', 'Chat']];
// tabsOf(chat) — the tabs shown: TABS, less Chat without `chat` (its flag,
// ticket-chat-tab, off: ASS-262), the rest then numbered 1–4.
export const tabsOf = chat => (chat ? TABS : TABS.filter(([id]) => id !== 'chat'));
export const PANEL = 40;
const NARROW_PANEL = 28;   // the panel from 100 to 119 columns (ASS-185 AC1)
const TAB_FLOOR = 20;   // the tabs' least width, borders included, on a screen too narrow for more
// panelWidth(columns) — the panel's width, borders included, on a screen
// `columns` wide (ASS-185 AC1): PANEL from 120 up, NARROW_PANEL from 100, and
// below that 0 — the panel a strip of lines above the tabs (stripLines).
export const panelWidth = columns => (columns >= 120 ? PANEL : columns >= 100 ? NARROW_PANEL : 0);
// tabWidth(columns) — the tabs' width on a screen `columns` wide, borders
// included: all the panel leaves, the border between them shared; the whole width with no panel.
export const tabWidth = columns => Math.max(TAB_FLOOR, panelWidth(columns) ? columns - panelWidth(columns) + 1 : columns);

// gateWaits(gate) — whether a `gate` (humanGate's) waits on the operator's
// Actions: only with a choice to make. One without (Awaiting Answers, whose
// exit is no open questions; a gate on leaving the last step) has nothing there.
export const gateWaits = gate => Boolean(gate?.choices?.length);

// defaultTab(gate, open) — the tab a ticket screen opens on (ASS-184 AC4):
// Actions while a `gate` waits (gateWaits: a human step, a gate on leaving, a
// pending requirements change), else Questions with `open` questions waiting
// on the operator, else Chat — Details without the Chat tab (`chat` false, ASS-262).
export const defaultTab = (gate, open, chat = true) => (gateWaits(gate) ? 'actions' : open ? 'questions' : chat ? 'chat' : 'details');

// needsYou(gate, open) — what the panel's Needs you says, by defaultTab's
// rule, and the tab to do it on; null when nothing waits.
export function needsYou(gate, open) {
  if (gateWaits(gate)) {
    const what = gate.title ? 'Requirements changed' : gate.step.action?.type === 'human' ? gate.step.name : `Approve leaving ${gate.step.name}`;
    return `${what} — tab 1`;
  }
  return open ? `${open} open question${open === 1 ? '' : 's'} — tab 4` : null;
}

// tabBar(active, width, { gate, open }) — the top border of the tabs' box,
// `width` wide: each tab numbered, the `active` one in reverse video; Actions
// with a red ● while a `gate` waits (gateWaits), Questions with its `open`
// count and a red ● while any is open (ASS-185 AC2); `tabs` those shown (tabsOf, ASS-262).
export function tabBar(active, width, { gate = false, open = 0 } = {}, tabs = TABS) {
  const dot = ' \x1b[31m●\x1b[39m';
  const badge = { actions: gate ? dot : '', questions: open ? ` (${open})${dot}` : '' };
  const bar = `┌${tabs.map(([id, label], i) => {
    const name = ` ${i + 1} ${label}${badge[id] ?? ''} `;
    return id === active ? `\x1b[7m${name}\x1b[0m` : name;
  }).join('│')}`;
  return visible(bar) >= width ? clip(bar, width) : bar + '─'.repeat(width - visible(bar));
}

// quickLines(t, { status, agents, needs, chatSpend, running, now, width }) — the
// quick-details panel (ASS-184 AC2): ticket `t`'s key with its icons (⚡
// fast-tracked, ✋ by hand), linked, and its variation ("A of 2" among
// several); its title in at most two lines; `needs` (needsYou) in red when
// something waits; its `status` and since when, and how long, from its last
// move; Paused, By hand and Held (reassigned away, ASS-345) when they apply; the `agents` on it; priority (🪪
// when set by hand) · points, and beneath an estimate noted too large (ASS-264); its ticketing system's status · assignee; up to
// three merge requests, then how many more; its automated tests; Health's
// first line; spend (its chat's too, and its running agents' so far, marked:
// `running`, ASS-270) · agent time; its branch, linked; then
// its `documents` (review.js ticketDocuments, ASS-261), when it has any, each
// linked to its file; then its `screenshots` (review.js ticketScreenshots),
// when it has any, under each group's name, each linked to its file
// (ASS-244). The documents' risk level, when known, just below the key
// (ASS-261), High in the red Needs you is in. Every line at most `width`
// columns, cut with … past it.
// The facts the panel and the strip both show: the key line, the
// priority, the agents, the tests and the spend; and a line cut to `width`.
const fitTo = width => line => (visible(line) <= width ? line : `${clip(line, width - 1)}…`);
function keyLine(t) {
  const v = t.variation ?? {};
  const icons = `${t.icon ? `${t.icon} ` : ''}${t['fast-track'] === true ? '⚡ ' : ''}${t['worked-manually'] ? '✋ ' : ''}`;
  const live = (t.variations ?? []).filter(x => !x['is-deleted']).length;
  return `${icons}${t.url ? link(t.key, t.url) : t.key}${v.name ? ` · ${v.name}${live > 1 ? ` of ${live}` : ''}` : ''}`;
}
const priorityOf = t => `Priority ${t['manual-priority'] ?? t.priority ?? NONE}${t['manual-priority'] != null ? ' 🪪' : ''}`;
const agentsOf = agents => `Agents: ${agents.length ? agents.map(a => `🤖 ${a}`).join(', ') : NONE}`;
const testsOf = v => { const tests = testCounts(v['local-testing']); return `Tests: ${tests ? `${tests[0]}/${tests[1]} passing` : NONE}`; };
const spendOf = (v, chatSpend, running) => `Spend ${tokenSpend(v, chatSpend, running) ?? NONE}`;
const fileLink = (text, path) => link(text, pathToFileURL(path).href);
const riskOf = documents => (documents?.risk ? (documents.risk === 'High' ? color('31') : String)(`Risk: ${documents.risk}`) : null);

export function quickLines(t, { status, agents = [], needs, chatSpend = 0, running = 0, documents, screenshots, now = new Date(), width = PANEL - 4 }) {
  const v = t.variation ?? {};
  const fit = fitTo(width);
  const key = keyLine(t);
  const title = wrap(t.title ?? NONE, width);
  const moved = levelChanges(v).at(-1)?.timestamp;
  const at = iso => String(iso).replace('T', ' ').slice(5, 16);
  const hand = t['worked-manually'];
  const mrs = v['merge-request'] ?? [];
  const mr = m => (isUnopened(m) ? `MR ${m.id} ${unopenedAs(m)}` : `${link(m.key, m.url)} ${mrStatus(m)} ${link(m['build-status'] ?? NONE, m['build-url'] ?? m.url)}`);
  const { branch, 'branch-url': branchUrl } = v.build ?? {};
  const time = agentTime(v);
  const risk = riskOf(documents);
  return [
    key,
    ...(risk ? [risk] : []),
    ...(title.length > 2 ? [title[0], `${clip(title[1], width - 1)}…`] : title),
    '',
    ...(needs ? [color('31')(`Needs you: ${needs}`)] : []),
    `State: ${status ?? NONE}`,
    ...(moved ? [`  since ${at(moved)} UTC (${duration(now - Date.parse(moved))})`] : []),
    ...(v['is-paused'] === true ? [`Paused: ${v['paused-for-fast-track'] ? `for fast-track ${v['paused-for-fast-track']}` : 'yes'}`] : []),
    ...(hand ? [`By hand: ${hand.by} since ${at(hand.since)} UTC`] : []),   // UTC, as State's since (ASS-294)
    ...(reassignedTo(t) ? [`Held: ${reassignedTo(t)}`, `  since ${at(t.reassigned['detected-at'])} UTC`] : []),   // reassigned away (ASS-345), detected when
    agentsOf(agents),
    '',
    `${priorityOf(t)} · Points ${t.points ?? NONE}`,
    ...(t['too-large-estimate'] ? [`Estimated too large: ${t['too-large-estimate'].points}`] : []),
    `Jira: ${t['ticket-system-status'] ?? NONE} · ${t['ticket-system-assignment'] ?? NONE}`,
    '',
    ...(mrs.length ? mrs.slice(0, 3).map((m, i) => `${i ? '     ' : 'MRs: '}${mr(m)}`) : [`MRs: ${NONE}`]),
    ...(mrs.length > 3 ? [`     +${mrs.length - 3} more — tab 2`] : []),
    testsOf(v),
    `Health: ${v['ai-feedback-long']?.split('\n')[0] || NONE}`,
    '',
    // With agents running (ASS-270) the spend's mark leaves no room for the agent time beside it: it goes beneath.
    ...(running > 0 ? [spendOf(v, chatSpend, running), `Agent time ${time == null ? NONE : duration(time)}`] : [`${spendOf(v, chatSpend)} · Agent time ${time == null ? NONE : duration(time)}`]),
    `Branch: ${branch ? (branchUrl ? link(branch, branchUrl) : branch) : NONE}`,
    ...(documents?.links.length ? ['', 'Documents', ...documents.links.map(d => `  ${fileLink(d.label, d.path)}`)] : []),
    ...(screenshots ? ['', 'Screenshots', ...screenshots.groups.flatMap(g => [`  ${g.name}`, ...g.shots.map(s => `    ${fileLink(s.label, s.path)}`)])] : []),
  ].map(fit);
}

// stripLines(t, { status, agents, needs, chatSpend, running, width }) — the panel as
// three lines above the tabs on a screen under 100 columns (ASS-185 AC1): key
// · variation · title; state · Needs you (red); priority · agents · tests ·
// spend — each cut with … past `width`; and, with `screenshots` (ASS-244), a
// fourth: how many, linked to their folder. The `documents`' risk level
// (ASS-261) after the key, before the title, so the title is cut first.
export function stripLines(t, { status, agents = [], needs, chatSpend = 0, running = 0, documents, screenshots, width }) {
  const v = t.variation ?? {};
  const risk = riskOf(documents);
  return [
    `${keyLine(t)}${risk ? ` · ${risk}` : ''} · ${t.title ?? NONE}`,
    `State: ${status ?? NONE}${needs ? ` · ${color('31')(`Needs you: ${needs}`)}` : ''}`,
    [priorityOf(t), agentsOf(agents), testsOf(v), spendOf(v, chatSpend, running)].join(' · '),
    ...(screenshots ? [`Screenshots: ${fileLink(`${screenshots.groups.flatMap(g => g.shots).length} — open the folder`, screenshots.folder)}`] : []),
  ].map(fitTo(width));
}

// ticketTabs({ tab, panes, panel, columns, height }) — the ticket screen's box
// (ASS-184), `columns` wide and `height` lines inside its borders: the open
// `tab`'s panes side by side under the tab bar — each { lines, head, foot,
// scroll, wrap } as a ticketColumn section, a pane before the last `width`
// wide, the last taking the rest of tabWidth — and the `panel`'s lines in a
// box of their own, panelWidth wide, at the right — its blank lines dropped when
// it does not fit, then cut at the box's foot, never scrolled. Only the panes scroll, each by its own scroll.
// With no panel (under 100 columns, ASS-185) `panel` is the strip's lines, above the box. `badges` and `tabs` are tabBar's.
export function ticketTabs({ tab, panes, panel, columns, height, badges, tabs }) {
  const left = tabWidth(columns), side = panelWidth(columns);
  const fixed = panes.slice(0, -1).reduce((sum, p) => sum + p.width - 1, 0);
  const boxes = panes.map((p, i) => ticketColumn([{ ...p, height }], i < panes.length - 1 ? p.width : left - fixed));
  const box = side ? ticketColumn([{ lines: (panel.length > height ? panel.filter(Boolean) : panel).slice(0, height), height }], side) : null;
  const rows = joinColumns(box ? [...boxes, box] : boxes);
  rows[0] = `${tabBar(tab, left - 1, badges, tabs)}${box ? `┬ Ticket ${'─'.repeat(side - 10)}` : ''}┐`;
  rows[rows.length - 1] = `${rows.at(-1).slice(0, -1).replaceAll('┘', '┴')}┘`;   // the boxes' bottom corners where they meet
  return box ? rows : [...panel, ...rows];
}
