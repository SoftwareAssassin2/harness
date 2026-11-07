// ASS-216 AC5: a project's spend over a day and over its active sprint
// — every agent dispatch on its sprint and backlog tickets and every ticket
// chat turn, each once, by when it was timestamped — UTC days since ASS-294,
// whatever this computer's zone (Eastern here, so 00:00Z is 20:00 EDT the day before).
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendRecords, daySpend, sprintSpend } from '../../src/control/spend.js';

const dispatch = (timestamp, cost, billing = 'api') => ({ 'dispatched-to': 'Thor', timestamp, billing, 'cost-usd': cost });
const ticket = (key, ...logs) => ({ key, variations: logs.map((log, i) => ({ name: 'AB'[i], 'state-changes': [{ 'to-state': 'build', 'agent-dispatch-log': log }] })) });
const sprint = [
  ticket('A-1', [dispatch('2026-10-28T23:59:59Z', 1), dispatch('2026-10-29T00:00:00Z', 2)]),   // just before and at UTC midnight (19:59:59 / 20:00 EDT, both Oct 28 locally)
  ticket('A-2', [dispatch('2026-10-29T20:00:00Z', 4), dispatch('2026-10-29T20:00:00Z', null)], [dispatch('2026-10-29T23:59:59Z', 8)]),   // a second variation, the last second of Oct 29
];
const backlog = [ticket('A-3', [dispatch('2026-10-25T23:59:59Z', 16), dispatch('2026-10-26T00:00:00Z', 32)])];   // either side of the sprint's start
const collaborations = {
  'A-1': { turns: [{ timestamp: '2026-10-28T23:59:00Z', billing: 'api', 'cost-usd': 64 }, { timestamp: '2026-10-29T00:01:00Z', billing: 'api', 'cost-usd': 128 }] },
  'A-9': { turns: [{ timestamp: null, billing: 'api', 'cost-usd': 256 }] },   // an undated total from before ASS-216: never in a day
  'A-8': { 'session-id': 's' },                                             // no turns
};
// The chat screen's turns (ASS-271): its project's chat-spend.json, an estimate among them.
const chatSpend = { turns: [{ timestamp: '2026-10-29T12:00:00Z', chat: 'c1', billing: 'api', 'cost-usd': 512 }, { timestamp: '2026-10-29T13:00:00Z', chat: 'c1', billing: 'api', 'cost-usd': 1024, estimate: true }] };
const records = spendRecords([...sprint, ...backlog], collaborations);
const withChats = spendRecords([...sprint, ...backlog], collaborations, chatSpend);
const at = iso => new Date(iso);

test('ASS-216 AC5: Day Spend is the UTC day\'s dispatches and chat turns, from UTC midnight up to the next (ASS-294)', () => {
  assert.equal(daySpend(records, at('2026-10-29T15:00:00Z')), 2 + 4 + 8 + 128);           // Oct 29 UTC; a dispatch without a cost adds nothing
  assert.equal(daySpend(records, at('2026-10-28T23:00:00Z')), 1 + 64);                    // still Oct 28 UTC
  assert.equal(daySpend(records, at('2026-10-29T23:59:59Z')), 2 + 4 + 8 + 128);           // the last second of Oct 29 UTC, though 19:59 EDT
  assert.equal(daySpend(records, at('2026-10-29T02:00:00Z')), 2 + 4 + 8 + 128);           // Oct 29 UTC, though 22:00 EDT on Oct 28
});

test('ASS-216 AC5: Sprint Spend is the same from the sprint\'s start, UTC midnight, through today; before it is not counted; no sprint, $0 (ASS-294)', () => {
  assert.equal(sprintSpend(records, '2026-10-26', at('2026-10-29T15:00:00Z')), 32 + 1 + 2 + 4 + 8 + 64 + 128);
  assert.equal(sprintSpend(records, '2026-10-26', at('2026-10-28T15:00:00Z')), 32 + 1 + 64);   // through Oct 28 only
  assert.equal(sprintSpend(records, null, at('2026-10-29T15:00:00Z')), 0);
});

test('ASS-216 AC5: each dispatch and turn is a record once, with its time, billing and cost, for ASS-217 to sum by billing', () => {
  assert.equal(records.length, 7 + 3);   // seven dispatches, three turns
  assert.deepEqual(records.at(-1), { timestamp: null, billing: 'api', 'cost-usd': 256 });
});

test('ASS-271 AC3: the chat screen\'s turns, an estimate among them, count in Day and Sprint Spend as records of their own; none (null) adds nothing', () => {
  assert.equal(withChats.length, 7 + 3 + 2);
  assert.equal(daySpend(withChats, at('2026-10-29T15:00:00Z')), 2 + 4 + 8 + 128 + 512 + 1024);
  assert.equal(sprintSpend(withChats, '2026-10-26', at('2026-10-29T15:00:00Z')), 32 + 1 + 2 + 4 + 8 + 64 + 128 + 512 + 1024);
  assert.deepEqual(spendRecords([...sprint, ...backlog], collaborations, null), records);
});
