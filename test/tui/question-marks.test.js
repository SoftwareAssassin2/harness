// Blocking and non-blocking questions on the dashboard (ASS-248 AC1, AC7):
// an open blocking question — or one with no flag — counts on Operator Needed
// and marks its ticket with the blue ●; a ticket whose only call on the
// operator is an open non-blocking question wears a small dim grey ● (the same
// glyph, never red, yellow or orange) and is not counted. The ? menu explains
// both; the questions tab shows each question's flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import { ticketQuestionLines, questionDetails } from '../../src/tui/questions.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 44, now: new Date('2026-10-01T16:04:00Z') };
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const refinement = { name: 'r', steps: [{ id: 'groom', name: 'Groom', sequence: 1, action: { type: 'prompt' } }, { id: 'ready', name: 'Ready', sequence: 2, 'is-done': true, action: { type: 'none' } }] };
const ticket = (key, state, extra = {}) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': hs(state) }], ...extra });
const busy = ticket('A-0', 'build');                                                  // worked, so no warning takes the tiles' room (ASS-59)
const asked = (key, blocking) => ({ 'asked-on-ticket': key.toLowerCase(), status: 'Asked', ...(blocking == null ? {} : { blocking }) });
// Each mark in its color: ● on the backlog, ⦿ on the sprint (ASS-259).
const BLUE = /\x1b\[34m[●⦿]/, GREY = /\x1b\[2;90m[●⦿]/;

// The tile's count and, on the sprint and backlog screens, the tickets wearing each mark (on
// the sprint, only its ⚉ column between the mark and the text, ASS-259).
function shown(features, { backlog = [], questions = [] } = {}) {
  const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] }, backlog, questions };
  const s = initialState({ projects: [project], workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
  const out = render(s, wide);
  const raw = [...out, ...render(handleKey(s, { name: 'b' }), wide)];
  const marked = dot => [...new Set(raw.filter(l => dot.test(l)).map(l => strip(l).match(/[●⦿][ ⚉]*(A-\d+)/u)?.[1]).filter(Boolean))].sort();
  return { n: Number(strip(out[7]).match(/│ +(\d+) +│/)[1]), blue: marked(BLUE), grey: marked(GREY), raw };
}

test('AC7: an open blocking question — or one with no flag — counts on Operator Needed and wears the blue ●', () => {
  const r =shown([busy, ticket('A-1', 'build'), ticket('A-2', 'build')], { questions: [asked('A-1', true), asked('A-2')] });
  assert.deepEqual([r.n, r.blue, r.grey], [2, ['A-1', 'A-2'], []]);
});

test('AC7: a ticket with only open non-blocking questions wears a small dim grey ● and is not counted; anything else needing the operator makes it blue', () => {
  const only = shown([busy, ticket('A-1', 'build')], { questions: [asked('A-1', false)] });
  assert.deepEqual([only.n, only.blue, only.grey], [0, [], ['A-1']]);
  const blocked = shown([busy, ticket('A-1', 'stuck')], { questions: [asked('A-1', false)] });              // blocked too: blue, counted, no grey
  assert.deepEqual([blocked.n, blocked.blue, blocked.grey], [1, ['A-1'], []]);
  const both = shown([busy, ticket('A-1', 'build')], { questions: [asked('A-1', false), asked('A-1', true)] });
  assert.deepEqual([both.n, both.blue, both.grey], [1, ['A-1'], []]);
  const backlog = shown([busy], { backlog: [{ key: 'A-5', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'r' } }] }], questions: [asked('A-5', false)] });
  assert.deepEqual([backlog.n, backlog.blue, backlog.grey], [0, [], ['A-5']]);
  // Closed (Assumed, Answered) or on a complete ticket: no mark at all.
  const closed = shown([busy, ticket('A-1', 'build'), ticket('A-2', 'done')], { questions: [{ ...asked('A-1', false), status: 'Assumed' }, asked('A-2', false)] });
  assert.deepEqual([closed.n, closed.blue, closed.grey], [0, [], []]);
});

test('AC7: the grey ● is the blue one\'s glyph in dim grey — never red, yellow or orange — one per row', () => {
  const { raw } = shown([busy, ticket('A-1', 'build')], { questions: [asked('A-1', false)] });
  const row = raw.find(l => GREY.test(l));
  assert.equal(strip(row).split(/[●⦿]/).length - 1, 1);
  assert.ok(!/\x1b\[(3[13]|9[13]|38;2;255;(165|215))m[●⦿]/.test(row), JSON.stringify(row));
});

test('AC7: the ? menu explains both marks', () => {
  const s = initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: null }], workflows: [{ name: 'e', steps }] });
  const out = render(handleKey(s, { sequence: '?' }, wide), wide);
  const blue = out.find(l => strip(l).includes('needs you')), grey = out.find(l => strip(l).includes('assumption'));
  assert.ok(BLUE.test(blue ?? '') && /Operator Needed/.test(strip(blue)), blue);
  assert.ok(GREY.test(grey ?? '') && /not counted/.test(strip(grey)), grey);
});

test('AC1: the questions tab shows each open question\'s flag; a non-blocking one\'s recommended answer is its assumption', () => {
  const list = [
    { question: 'Which cards?', status: 'Asked', blocking: true, scope: '' },
    { question: 'Refunds?', status: 'Asked', blocking: false, scope: '' },
    { question: 'Legacy?', status: 'Asked', scope: '' },
    { question: 'Done?', status: 'Assumed', blocking: false, scope: '' },
  ];
  const rows = ticketQuestionLines(list, { columns: 120 }).map(strip);
  assert.match(rows.find(l => l.includes('Which cards?')), /Asked · blocking/);
  assert.match(rows.find(l => l.includes('Refunds?')), /Asked · non-blocking/);
  assert.match(rows.find(l => l.includes('Legacy?')), /Asked · blocking/);
  assert.match(rows.find(l => l.includes('Done?')), /Assumed/);
  const details = q => questionDetails({ ...q, 'recomended-answer': 'Visa only.', 'asked-on-ticket': 'A-1' }, null, 120).map(strip);
  assert.ok(details(list[0]).some(l => /^Blocking +yes — the ticket waits for the answer/.test(l)));
  assert.ok(details(list[0]).some(l => /^Recommended answer +Visa only\./.test(l)));
  assert.ok(details(list[1]).some(l => /^Blocking +no — work goes on, assuming the recommended answer/.test(l)));
  assert.ok(details(list[1]).some(l => /^Assumption +Visa only\./.test(l)));
});
