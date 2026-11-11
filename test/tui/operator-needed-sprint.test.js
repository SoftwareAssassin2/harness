// Operator Needed Tickets counts only the sprint on show (ASS-254): a backlog
// ticket never counts, whatever its marks or questions, though it keeps its
// blue ● or grey ● on the backlog screen; a sprint ticket waiting on the
// operator counts, once, even when it is in the backlog too; and with a past
// day on show, that day's sprint is the one counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, handleKey, render } from '../../src/tui/app.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 200, rows: 44, now: new Date('2026-10-01T16:04:00Z') };
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [
  { id: 'stuck', name: 'Stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true },
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const refinement = { name: 'r', steps: [{ id: 'groom', name: 'Groom', sequence: 1, action: { type: 'prompt' } }, { id: 'ready', name: 'Ready', sequence: 2, 'is-done': true, action: { type: 'none' } }] };
const ticket = (key, state) => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': hs(state) }] });
const groomed = key => ({ key, title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'groom', 'state-engine': 'r' } }] });
const busy = ticket('A-0', 'build');                                                  // worked, so no warning takes the tiles' room (ASS-59)
const asked = (key, blocking) => ({ 'asked-on-ticket': key.toLowerCase(), status: 'Asked', ...(blocking == null ? {} : { blocking }) });
const BLUE = '\x1b[34m●', GREY = '\x1b[2;90m●';
const sprintOf = features => ({ number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] });

// The tile's count and the tickets wearing each ● on the backlog screen.
function shown(features, { backlog = [], questions = [], days = {}, day = null } = {}) {
  const project = { id: 'p', name: 'P', stateEngine: 'e', sprint: sprintOf(features), backlog, questions, days };
  const s = { ...initialState({ projects: [project], workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] }), day };
  const out = render(s, wide);
  const raw = render(handleKey(s, { name: 'b' }), wide);
  const marked = dot => [...new Set(raw.filter(l => l.includes(dot)).map(l => strip(l).match(/● (A-\d+)/)?.[1]).filter(Boolean))].sort();
  const tile = strip(out[7]).match(/│ +(\d+) +│/);
  return { n: Number(tile[1]), blue: marked(BLUE), grey: marked(GREY) };
}

test('AC1, AC4: a backlog ticket with an open blocking question is not counted, and keeps its blue ●', () => {
  const r = shown([busy], { backlog: [groomed('A-5')], questions: [asked('A-5', true)] });
  assert.deepEqual([r.n, r.blue], [0, ['A-5']]);
});

test('AC1, AC2: backlog tickets waiting on the operator in other ways (blocked, non-blocking question) are not counted, and keep their marks', () => {
  const stuck = { key: 'A-6', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'stuck', 'state-engine': 'e' } }] };
  const r = shown([busy], { backlog: [stuck, groomed('A-7')], questions: [asked('A-7', false)] });
  assert.deepEqual([r.n, r.blue, r.grey], [0, ['A-6'], ['A-7']]);
});

test('AC1, AC4: a sprint ticket with an open blocking question is counted, beside backlog ones that are not', () => {
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-5'), groomed('A-8')], questions: [asked('A-1', true), asked('A-5', true), asked('A-8')] });
  assert.equal(r.n, 1);
});

test('AC1, AC4: a ticket in both the sprint and the backlog is counted once', () => {
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-1')], questions: [asked('A-1', true)] });
  assert.equal(r.n, 1);
});

test('AC1: with a past day on show, that day\'s sprint is counted — not the live sprint\'s, never the backlog\'s', () => {
  const days = { '2026-09-30': sprintOf([busy, ticket('A-2', 'build')]) };
  const r = shown([busy, ticket('A-1', 'build')], { backlog: [groomed('A-5')], questions: [asked('A-1', true), asked('A-2', true), asked('A-5', true)], days, day: '2026-09-30' });
  assert.equal(r.n, 1);
});

// ASS-370: the project menu's blue ● before each project with Operator Needed tickets.
test('ASS-370 AC1-AC3: the menu dots each project with tickets waiting on the operator, the selected one agreeing with its tile, a past day changing nothing', () => {
  const project = (id, features, questions = [], days = {}) => ({ id, name: id.toUpperCase(), stateEngine: 'e', sprint: sprintOf(features), backlog: [], questions, days });
  const days = { '2026-09-30': sprintOf([busy]) };
  const projects = [project('p', [busy, ticket('A-1', 'build')], [asked('A-1', true)], days), project('q', [busy]), project('r', [busy, ticket('A-3', 'stuck')])];
  const s = initialState({ projects, workflows: [{ name: 'e', steps }, refinement], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
  const out = render(s, wide);
  const names = out[2], counts = out[3];
  assert.match(names, /\x1b\[34m●\x1b\[0m P /);
  assert.match(strip(names), /● P\s+Q\s+● R/);
  assert.ok(!strip(names).includes('● Q'));
  assert.equal(Number(strip(out[7]).match(/│ +(\d+) +│/)[1]), 1);            // the selected project's tile agrees
  const centre = (line, text) => { const v = strip(line); return v.indexOf(text) + text.length / 2; };
  assert.equal(Math.floor(centre(names, '● P')), Math.floor(centre(counts, '🤖x1')));
  assert.equal(render({ ...s, day: '2026-09-30' }, wide)[2], names);           // a past day leaves the dots alone
});
