// ASS-326: a long Status no longer widens the sprint grid off the screen. The
// hold (ASS-195's "waits on …") goes on its own lines under the step chain,
// and every Status line wraps — the hold between keys, a long step chain
// between its " › " parts — at STATUS_WRAP, continuation lines indented; the
// row grows taller, nothing is cut with "…". When the grid must narrow, Status
// gives up width after Health and Agents (down to its header), re-wrapping
// rather than clipping; Ticket's floor (ASS-207) still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { boxTable } from '../../src/tui/table.js';
import { visible, wrap } from '../../src/tui/text.js';
import { STATUS_WRAP, statusCell, statusText } from '../../src/tui/screens/shared.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const now = new Date('2026-10-01T16:04:00Z');
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'committed', name: 'Committed', sequence: 1 },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
// ABC-1 at Committed waits on nine sprint tickets still at Build.
const DEPS = ['ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6', 'ABC-7', 'ABC-8', 'ABC-9', 'ABC-10'];
const ticket = (key, state, extra = {}) => ({ key, title: `Ticket ${key}`, variations: [{ name: 'A', 'harness-status': hs(state), ...extra.variation }], ...extra.ticket });
const features = [
  ticket('ABC-1', 'committed', {
    ticket: { title: 'Waits on the whole sprint before it starts', dependencies: DEPS },
    variation: { 'ai-feedback-short': 'Two failing tests on the results grid and a stale merge request' },
  }),
  ...DEPS.map(k => ticket(k, 'build')),
];
const assignments = [{ project: 'p', 'agent-name': 'Daredevil-of-Hells-Kitchen', 'work-item': 'ABC-2', variation: null, 'ai-status-update-short': 'Rewriting the allocation loop' }];
const project = { id: 'p', name: 'P', stateEngine: 'e', waitForDependencies: true, sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] } };
const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments });

// The grid's lines at `columns`, colors and links off: its top border to its bottom.
// Tall enough for ABC-1's Status at its narrowest (one key per line) under the
// key below the grid, which takes two lines at 150 columns since UNASSIGNED
// joined it (ASS-345).
function grid(columns) {
  const out = render(state, { columns, rows: 90, now }).map(strip);
  return out.slice(out.findIndex(l => /^┌.*┬/.test(l)), out.findLastIndex(l => /^└/.test(l)) + 1);
}
// A column's text on every body line, by the header's dividers.
function column(lines, header) {
  const head = lines[1];
  const at = head.indexOf(` ${header} `.padStart(header.length + 2));
  const left = head.lastIndexOf('│', at), right = head.indexOf('│', at + 1);
  return lines.slice(3, -1).map(l => l.slice(left + 1, right).trim());
}
// ABC-1's Status lines: from its row down to the line before the next row's separator.
function statusOf(lines) {
  const status = column(lines, 'Status');
  const ticket = column(lines, 'Ticket');
  const start = ticket.findIndex(t => t.includes('ABC-1:'));
  const end = ticket.findIndex((t, i) => i > start && /ABC-\d+:/.test(t));
  return status.slice(start, end < 0 ? undefined : end).filter(s => s && !/^(- *)+$/.test(s));
}
const keysIn = text => text.match(/ABC-\d+/g) ?? [];

test('ASS-326 AC1: the hold goes on its own lines under the step chain, wrapped between keys at STATUS_WRAP, continuation lines indented', () => {
  assert.equal(STATUS_WRAP, 40);
  const lines = grid(300);
  const status = statusOf(lines);
  assert.equal(status[0], 'Committed');                                   // the step chain, alone on its line
  assert.match(status[1], /^waits on ABC-2, /);                           // then the hold
  assert.deepEqual(keysIn(status.slice(1).join(' ')), DEPS);              // every key, in order
  assert.ok(status.length > 2, status.join('\n'));                        // over more than one line
  const cells = statusCell({ status: { chain: [{ state: 'committed', step: steps[0] }] }, variation: {}, hold: { waits: DEPS, ignores: [] } }, steps)(Infinity);
  for (const l of cells) assert.ok(visible(l) <= STATUS_WRAP, l);
  for (const l of cells.slice(2)) assert.match(l, /^ {2}\S/, l);         // continuation lines indented
  assert.ok(!status.some(s => s.includes('…')), status.join('\n'));
  // The column is no wider than STATUS_WRAP: its header's dividers.
  const head = lines[1];
  const at = head.indexOf(' Status ');
  assert.ok(head.indexOf('│', at) - head.lastIndexOf('│', at) - 3 <= STATUS_WRAP, head);
  for (const l of lines) assert.equal(visible(l), 300, l);
});

test('ASS-326 AC1: a step chain longer than STATUS_WRAP wraps between its " › " parts; a part longer than STATUS_WRAP sets the width alone', () => {
  const chain = ['Local Testing', 'Take Screenshots of Every Page', 'Compare Screenshots'].map((name, i) => ({ state: `s${i}`, step: { name } }));
  const t = { status: { chain }, variation: {}, hold: null };
  assert.deepEqual(statusCell(t, [])(Infinity), ['Local Testing ›', '  Take Screenshots of Every Page ›', '  Compare Screenshots']);
  const long = { status: { chain: [{ state: 'a', step: { name: 'An Exceptionally Long Step Name That Runs On' } }, { state: 'b', step: { name: 'Next' } }] }, variation: {}, hold: null };
  assert.deepEqual(statusCell(long, [])(Infinity), ['An Exceptionally Long Step Name That Runs On ›', '  Next']);   // 46 wide, never cut
  assert.equal(statusText(t, []), 'Local Testing › Take Screenshots of Every Page › Compare Screenshots');   // the one-line form, for the ticket screen
});

test('ASS-326 AC1: the one-line statusText (the ticket screen\'s) keeps the hold after " — "', () => {
  const t = { status: { chain: [{ state: 'committed', step: steps[0] }] }, variation: {}, hold: { waits: ['ABC-2', 'ABC-3'], ignores: [] } };
  assert.equal(statusText(t, steps), 'Committed — waits on ABC-2, ABC-3');
  const ignored = { ...t, hold: { waits: [], ignores: [{ key: 'ABC-9', why: 'unknown' }] } };
  assert.deepEqual(statusCell(ignored, steps)(Infinity), ['Committed', 'ignores ABC-9 (unknown)']);
});

test('ASS-326 AC2: at a narrow width the grid fits, Health and Agents show their headers in full, and Status re-wraps narrower with all its text shown, none cut with "…"', () => {
  for (const columns of [180, 160, 150]) {   // 150: about as narrow as Ticket's floor (ASS-207) lets this grid get
    const lines = grid(columns);
    for (const l of lines) assert.equal(visible(l), columns, `${columns}: ${l}`);
    assert.match(lines[1], /│ Health │ Agents │$/, `${columns}: ${lines[1]}`);
    const status = statusOf(lines);
    // All the text is there, wrapped: at Status's header width (6) a key may split, never drop.
    assert.equal(status.join('').replace(/\s/g, ''), `Committedwaitson${DEPS.join(',')}`, `${columns}:\n${status.join('\n')}`);
    assert.ok(!status.some(s => s.includes('…')), `${columns}:\n${status.join('\n')}`);
    assert.ok(lines.some(l => l.includes('ABC-1: Waits on the whole sprin')), columns);   // Ticket's floor (ASS-207): key and 24 title characters
  }
  // Narrower than at 300: Status gave up width.
  const width = lines => { const h = lines[1], at = h.indexOf(' Status '); return h.indexOf('│', at) - h.lastIndexOf('│', at) - 3; };
  assert.ok(width(grid(150)) < width(grid(300)), `${width(grid(150))} < ${width(grid(300))}`);
});

test('ASS-326 AC2: boxTable lays a function cell out at its column\'s width — wide for its natural width, narrower when it shrinks', () => {
  const words = w => wrap('one two six', w);
  const out = boxTable(['Ticket', 'Status'], [['A-1: A long title here', words]], { columns: 40, stretch: 0 });
  assert.equal(out[3], '│ A-1: A long title here   one two six │');
  const narrow = boxTable(['Ticket', 'Status'], [['A-1: A long title here', words]], { columns: 30, stretch: 0, min: 17, shrink: [1] });
  for (const l of narrow) assert.equal(visible(l), 30, l);
  assert.deepEqual(narrow.slice(1, -1), [
    '│      Ticket       │ Status │',
    '├───────────────────┴────────┤',
    '│ A-1: A long titl…   one    │',
    '│                     two    │',
    '│                     six    │',
  ]);
});

test('ASS-326 AC3: rows out of view still count toward the Status width, so it does not jump while scrolling', () => {
  const short = boxTable(['Ticket', 'Status'], [['A-1', 'x'], ['A-2', () => ['a much wider cell']]], { columns: 40, stretch: 0, height: 5 });
  assert.match(short[1], /│ +Status +│$/);
  assert.equal(short[1].length - short[1].lastIndexOf('│', short[1].length - 2) - 4, 'a much wider cell'.length);
});
