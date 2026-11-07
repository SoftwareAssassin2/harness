// ASS-216: the Day Spend and Sprint Spend tiles after Delivered Points, and the
// sprint day selector counting this computer's days — Eastern here, so local
// midnight is 04:00Z in October and September.
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const lines = (s, size) => render(s, size).map(strip);
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [{ id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
const dispatch = (timestamp, cost) => ({ 'dispatched-to': 'Thor', timestamp, billing: 'api', 'cost-usd': cost });
const ticket = (key, log, state = 'build') => ({ key, title: 'T', points: 3, variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [{ 'to-state': state, 'agent-dispatch-log': log }] }] });
const sprint = {
  number: 10, start: '2026-09-18', end: '2026-10-01', bugs: [], spikes: [],
  features: [
    ticket('A-1', [dispatch('2026-09-30T03:59:59Z', 1), dispatch('2026-09-30T04:00:00Z', 2)]),    // either side of local midnight, Sep 29 → Sep 30
    ticket('A-2', [dispatch('2026-09-18T03:59:59Z', 4), dispatch('2026-09-18T04:00:00Z', 8)], 'done'),   // either side of the sprint's start
  ],
};
const backlog = [ticket('A-3', [dispatch('2026-09-30T12:00:00Z', 0.25)])];
const collaborations = { 'A-1': { turns: [{ timestamp: '2026-09-30T03:00:00Z', billing: 'api', 'cost-usd': 16 }, { timestamp: '2026-09-30T05:00:00Z', billing: 'api', 'cost-usd': 32.01 }] } };
const project = { id: 'p', name: 'P', stateEngine: 'e', sprint, backlog, collaborations };
// An agent on A-1, so no warning takes the tiles' room (ASS-59).
const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-1', variation: 'A' }] });
const now = new Date('2026-09-30T15:00:00Z');   // Sep 30, 11:00 EDT

test('ASS-216 AC4/AC5: Day Spend and Sprint Spend follow Delivered Points, boxed with their labels beneath, in dollars to the cent: the local day\'s and the sprint\'s dispatches and chat turns', () => {
  const out = lines(state, { columns: 260, rows: 44, now });
  const tiles = [
    '┌──────────────────┐    ┌───────────┐    ┌──────────────┐',
    '│        3         │    │  $34.26   │    │    $59.26    │',
    '└──────────────────┘    └───────────┘    └──────────────┘',
    '  Delivered Points        Day Spend        Sprint Spend  ',
  ];
  // Day: 2 + 0.25 (backlog) + 32.01 (a turn after local midnight); Sprint: that, 1, 16 and 8 — not the 4 before its start.
  assert.deepEqual(out.slice(6, 10).map(l => l.slice(-tiles[0].length)), tiles);
});

test('ASS-216 AC7: on a screen too narrow for every tile, they drop from the right — Sprint Spend first', () => {
  const labels = ['Operator Needed Tickets', 'Delivered Tickets', 'Delivered Points', 'Day Spend', 'Sprint Spend'];
  const shown = columns => labels.filter(label => lines(state, { columns, rows: 44, now }).some(l => l.includes(label)));
  let columns = 260;
  while (shown(columns).length === labels.length) columns--;
  assert.deepEqual(shown(columns), labels.slice(0, 4));
  for (const width of [200, 180, 160, 120]) assert.deepEqual(shown(width), labels.slice(0, shown(width).length));   // always the first ones
});

test('ASS-216 AC6: the sprint day selector counts local days — 22:00 EDT on Sep 30 is still day 13, though it is Oct 1 in UTC', () => {
  const late = lines(state, { columns: 140, rows: 44, now: new Date('2026-10-01T02:00:00Z') });
  assert.ok(late.some(l => / day 13 of 14 +│/.test(l)), late.join('\n'));
  assert.ok(late.some(l => / sprint ends in 1 day +│/.test(l)));
  const past = lines({ ...state, day: '2026-09-29', projects: [{ ...project, days: { '2026-09-29': sprint } }] }, { columns: 140, rows: 44, now });
  assert.ok(past.some(l => / day 12 of 14 +│/.test(l)), past.join('\n'));   // a past day is seen at its local end
});

test('ASS-271 AC3: the project\'s chat-screen turns (chatSpend, its chat-spend.json) count in Day Spend and Sprint Spend', () => {
  const chatSpend = { turns: [{ timestamp: '2026-09-30T14:00:00Z', chat: 'c', billing: 'api', 'cost-usd': 1, estimate: true }] };
  const withChats = initialState({ projects: [{ ...project, chatSpend }], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-1', variation: 'A' }] });
  const out = lines(withChats, { columns: 260, rows: 44, now });
  assert.ok(out.slice(6, 10).some(l => l.includes('$35.26') && l.includes('$60.26')), out.slice(6, 10).join('\n'));
});

test('ASS-269 AC3: the project\'s memory spend (its Hindsight\'s Claude calls, memory-spend.json) counts in Day Spend and Sprint Spend, shown as memory spend', () => {
  const memorySpend = [
    { timestamp: '2026-09-30T14:00:00Z', billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'cost-usd': 0.4 },   // today
    { timestamp: '2026-09-29T14:00:00Z', billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'cost-usd': 0.1 },   // earlier in the sprint
  ];
  const out = lines({ ...state, projects: [{ ...project, memorySpend }] }, { columns: 300, rows: 44, now });
  assert.ok(out.some(l => l.includes('$34.66 incl. $0.40 memory')), out.join('\n'));
  assert.ok(out.some(l => l.includes('$59.76 incl. $0.50 memory')), out.join('\n'));
  assert.ok(out.some(l => /Day Spend .*Sprint Spend/.test(l)));
  const box = out.find(l => l.includes('$34.66 incl.'));
  assert.match(box, /│ \$34\.66 incl\. \$0\.40 memory │ {4}│ \$59\.76 incl\. \$0\.50 memory │$/);   // each boxed, its width the value's
});
