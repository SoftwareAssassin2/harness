// ASS-362 AC6: on the sprint screen a variation whose plan is finished — its
// planning step's sub-engine at an is-done step — shows "Planned, waiting for
// a build seat" under its Status and no 💺 (ASS-357): it holds no seat. One
// still planning keeps its 💺 and says nothing of the kind. The ticket screen's
// Status says so too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { sprintTickets, statusText, PLANNED } from '../../src/tui/screens/shared.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const wide = { columns: 220, rows: 60, now: new Date('2026-10-01T16:04:00Z') };
const workflows = [
  { name: 'e', steps: [
    { id: 'committed', name: 'Committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } },
    { id: 'plan', name: 'Plan', sequence: 2, 'is-planning-stage': true, action: { type: 'state-engine', engine: 'pl' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'build' }] },
    { id: 'build', name: 'Build', sequence: 3, action: { type: 'prompt' } },
    { id: 'done', name: 'Done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ] },
  { name: 'pl', steps: [
    { id: 'draft', name: 'Draft', sequence: 1, 'is-planning-stage': true, action: { type: 'prompt' } },
    { id: 'finished', name: 'Finished', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] },
];
const ticket = (key, state, sub) => ({ key, title: `Ticket ${key}`, variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'e', ...(sub ? { 'sub-status': { state: sub, 'state-engine': 'pl' } } : {}) } }] });
const features = [ticket('A-1', 'build'), ticket('A-2', 'plan', 'finished'), ticket('A-3', 'plan', 'draft')];
const state = initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'e', sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features, bugs: [], spikes: [] } }], workflows, assignments: [] });

test('ASS-362 AC6: a finished plan\'s row says it waits for a build seat, with no 💺; the others keep theirs', () => {
  const out = render(state, wide).map(strip);
  const rowAt = key => out.findIndex(l => l.includes(`${key}: Ticket`));
  const row = key => out[rowAt(key)];
  assert.ok(!row('A-2').includes('💺'), row('A-2'));
  for (const key of ['A-1', 'A-3']) assert.ok(row(key).includes('💺'), row(key));
  // Its Status: the chain, then the line saying so beneath it.
  const below = out.slice(rowAt('A-2'), rowAt('A-2') + 3).join('\n');
  assert.match(below, /Plan › Finished/);
  assert.match(below, /Planned, waiting for a build seat/);
  for (const key of ['A-1', 'A-3']) assert.ok(!out.slice(rowAt(key), rowAt(key) + 3).join('\n').includes(PLANNED), key);
});

test('ASS-362 AC6: the ticket screen\'s Status (statusText) says so too', () => {
  const { tickets, steps } = sprintTickets(state);
  const of = key => statusText(tickets.find(t => t.key === key), steps);
  assert.equal(of('A-2'), `Plan › Finished — ${PLANNED}`);
  assert.equal(of('A-3'), 'Plan › Draft');
});
