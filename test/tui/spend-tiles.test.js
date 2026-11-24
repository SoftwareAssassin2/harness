// ASS-216: Day Spend and Sprint Spend — tiles after Delivered Points until
// ASS-430 moved them into the footer's models box, under the models; ASS-566 to the footer's third line — and the
// sprint day selector — counting UTC days since ASS-294, whatever this
// computer's zone (Eastern here, so 00:00Z is 20:00 EDT the day before).
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { visible } from '../../src/tui/text.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const lines = (s, size) => render(s, size).map(strip);
const hs = state => ({ state, 'state-engine': 'e' });
const steps = [{ id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
const dispatch = (timestamp, cost) => ({ 'dispatched-to': 'Thor', timestamp, billing: 'api', 'cost-usd': cost });
const ticket = (key, log, state = 'build') => ({ key, title: 'T', points: 3, variations: [{ name: 'A', 'harness-status': hs(state), 'state-changes': [{ 'to-state': state, 'agent-dispatch-log': log }] }] });
const sprint = {
  number: 10, start: '2026-09-18', end: '2026-10-01', bugs: [], spikes: [],
  features: [
    ticket('A-1', [dispatch('2026-09-29T23:59:59Z', 1), dispatch('2026-09-30T00:00:00Z', 2)]),    // either side of UTC midnight, Sep 29 → Sep 30
    ticket('A-2', [dispatch('2026-09-17T23:59:59Z', 4), dispatch('2026-09-18T00:00:00Z', 8)], 'done'),   // either side of the sprint's start
  ],
};
const backlog = [ticket('A-3', [dispatch('2026-09-30T12:00:00Z', 0.25)])];
const collaborations = { 'A-1': { turns: [{ timestamp: '2026-09-29T23:00:00Z', billing: 'api', 'cost-usd': 16 }, { timestamp: '2026-09-30T01:00:00Z', billing: 'api', 'cost-usd': 32.01 }] } };
const project = { id: 'p', name: 'P', stateEngine: 'e', sprint, backlog, collaborations };
// An agent on A-1, so no warning takes the tiles' room (ASS-59).
const agents = [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-1', variation: 'A', model: 'opus-5' }];
const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: agents });
// The spend on the footer's third line (ASS-566; the models box's before, ASS-430): [day spend, sprint spend].
const spend = (s, size = { columns: 260, rows: 44, now }) => {
  const line = lines(s, size).find(l => l.includes('day spend: '));
  return [line.match(/day spend: \$[\d.]+/)[0], line.match(/sprint spend: \$[\d.]+/)[0]];
};
const now = new Date('2026-09-30T15:00:00Z');   // Sep 30, 11:00 EDT

test('ASS-430 AC1: the header shows Operator Needed Tickets, Delivered Tickets and Delivered Points only — no Day Spend or Sprint Spend tile', () => {
  const out = lines(state, { columns: 260, rows: 44, now });
  const tiles = [
    '┌─────────────────────────┐    ┌───────────────────┐    ┌──────────────────┐',
    '│            0            │    │         1         │    │        3         │',
    '└─────────────────────────┘    └───────────────────┘    └──────────────────┘',
    '  Operator Needed Tickets        Delivered Tickets        Delivered Points  ',
  ];
  assert.deepEqual(out.slice(6, 10).map(l => l.slice(-tiles[0].length)), tiles);   // flush right, the last tile Delivered Points
  assert.ok(!out.slice(0, 11).some(l => /Day Spend|Sprint Spend|\$\d/.test(l)), out.slice(0, 11).join('\n'));
});

test('ASS-430 AC2 (was ASS-216 AC4/AC5), ASS-566: the footer shows day spend and sprint spend, in dollars to the cent: the UTC day\'s and the sprint\'s dispatches and chat turns; the agents per model are the n screen\'s', () => {
  // Day: 2 + 0.25 (backlog) + 32.01 (a turn after UTC midnight); Sprint: that, 1, 16 and 8 — not the 4 before its start.
  assert.deepEqual(spend(state), ['day spend: $34.26', 'sprint spend: $59.26']);
  assert.ok(lines({ ...state, screen: 'n' }, { columns: 260, rows: 44, now }).some(l => l.startsWith('agents: opus-5 🤖x1')));
  // A past day on show: that day's snapshot, seen at its end (shownAt) — Sep 29's 1 and 16; the sprint through it, 1 + 16 + 8.
  const past = { ...state, day: '2026-09-29', projects: [{ ...project, days: { '2026-09-29': sprint } }] };
  assert.deepEqual(spend(past), ['day spend: $17.00', 'sprint spend: $25.00']);
  // No sprint: the sprint's spend is $0.
  const idle = initialState({ projects: [{ ...project, sprint: null, backlog: [], collaborations: {} }], workflows: [{ name: 'e', steps }] });
  assert.deepEqual(spend(idle), ['day spend: $0.00', 'sprint spend: $0.00']);
});

test('ASS-430 AC2, ASS-566: at 80 columns the spend shows whole and the footer fits the screen', () => {
  const size = { columns: 80, rows: 44, now };
  assert.deepEqual(spend(state, size), ['day spend: $34.26', 'sprint spend: $59.26']);
  const out = lines(state, size);
  assert.ok(out.every(l => visible(l) <= 80), out.join('\n'));
});

test('ASS-216 AC7: on a screen too narrow for every tile, they drop from the right — Delivered Points first', () => {
  const labels = ['Operator Needed Tickets', 'Delivered Tickets', 'Delivered Points'];
  const shown = columns => labels.filter(label => lines(state, { columns, rows: 44, now }).some(l => l.includes(label)));
  let columns = 260;
  while (shown(columns).length === labels.length) columns--;
  assert.deepEqual(shown(columns), labels.slice(0, 2));
  for (const width of [200, 180, 160, 120]) assert.deepEqual(shown(width), labels.slice(0, shown(width).length));   // always the first ones
});

test('ASS-294 (was ASS-216 AC6): the sprint day selector counts UTC days — 22:00 EDT on Sep 30 is already day 14, Oct 1 in UTC', () => {
  const late = lines(state, { columns: 140, rows: 44, now: new Date('2026-10-01T02:00:00Z') });
  assert.ok(late.some(l => / day 14 of 14 +│/.test(l)), late.join('\n'));
  assert.ok(late.some(l => / sprint ends today +│/.test(l)));
  const past = lines({ ...state, day: '2026-09-29', projects: [{ ...project, days: { '2026-09-29': sprint } }] }, { columns: 140, rows: 44, now });
  assert.ok(past.some(l => / day 12 of 14 +│/.test(l)), past.join('\n'));   // a past day is seen at its end, 23:59 UTC
});

test('ASS-271 AC3: the project\'s chat-screen turns (chatSpend, its chat-spend.json) count in Day Spend and Sprint Spend', () => {
  const chatSpend = { turns: [{ timestamp: '2026-09-30T14:00:00Z', chat: 'c', billing: 'api', 'cost-usd': 1, estimate: true }] };
  const withChats = initialState({ projects: [{ ...project, chatSpend }], workflows: [{ name: 'e', steps }], assignments: agents });
  assert.deepEqual(spend(withChats), ['day spend: $35.26', 'sprint spend: $60.26']);
});

test('ASS-269 AC3: the project\'s memory spend (its Hindsight\'s Claude calls, memory-spend.json) counts in Day Spend and Sprint Spend, which show the total alone', () => {
  const memorySpend = [
    { timestamp: '2026-09-30T14:00:00Z', billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'cost-usd': 0.4 },   // today
    { timestamp: '2026-09-29T14:00:00Z', billing: 'api', source: 'memory', model: 'claude-haiku-5-5', 'cost-usd': 0.1 },   // earlier in the sprint
  ];
  const s = { ...state, projects: [{ ...project, memorySpend }] };
  assert.ok(!lines(s, { columns: 300, rows: 44, now }).some(l => l.includes('memory')));   // the total alone, no memory part named
  assert.deepEqual(spend(s), ['day spend: $34.66', 'sprint spend: $59.76']);
});
