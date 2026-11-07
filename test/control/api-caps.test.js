// ASS-217 AC4: a project's API dollar caps — project.json's
// max-api-spend-per-day-usd and max-api-spend-per-sprint-usd, null (or left
// out) for none — checked against its api-billed spend (ASS-216's records,
// subscription ones never counted) on the UTC day (ASS-294) and over the active sprint.
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiCapReached, spendRecords } from '../../src/control/spend.js';

const record = (timestamp, cost, billing = 'api') => ({ timestamp, billing, 'cost-usd': cost });
const records = [
  record('2026-10-29T15:00:00Z', 4), record('2026-10-29T16:00:00Z', 100, 'subscription'),   // today: $4 api, a subscription run never counted
  record('2026-10-27T15:00:00Z', 6),                                                        // earlier in the sprint
];
const sprint = { start: '2026-10-26' };
const at = new Date('2026-10-29T18:00:00Z');
const caps = (day, sprintCap) => ({ 'max-api-spend-per-day-usd': day, 'max-api-spend-per-sprint-usd': sprintCap });

test('ASS-217 AC4: the day cap is reached at today\'s api spend, the sprint cap at the sprint\'s; the day cap is named first', () => {
  assert.deepEqual(apiCapReached(records, caps(4, null), sprint, at), { cap: 'day', spend: 4, limit: 4 });
  assert.deepEqual(apiCapReached(records, caps(null, 10), sprint, at), { cap: 'sprint', spend: 10, limit: 10 });
  assert.deepEqual(apiCapReached(records, caps(1, 1), sprint, at), { cap: 'day', spend: 4, limit: 1 });
});

test('ASS-217 AC4: under both caps, or with null or missing caps, nothing holds', () => {
  assert.equal(apiCapReached(records, caps(5, 11), sprint, at), null);
  assert.equal(apiCapReached(records, caps(null, null), sprint, at), null);
  assert.equal(apiCapReached(records, {}, sprint, at), null);
});

test('ASS-217 AC4: the api cost of agents still running counts toward both caps', () => {
  assert.deepEqual(apiCapReached(records, caps(5, null), sprint, at, 1), { cap: 'day', spend: 5, limit: 5 });
  assert.deepEqual(apiCapReached(records, caps(null, 11), sprint, at, 1), { cap: 'sprint', spend: 11, limit: 11 });
});

test('ASS-217: with no active sprint the sprint cap does not apply; the day cap still does', () => {
  assert.equal(apiCapReached(records, caps(null, 1), null, at), null);
  assert.deepEqual(apiCapReached(records, caps(2, 1), null, at), { cap: 'day', spend: 4, limit: 2 });
});

test('ASS-271 AC3: the chat screen\'s api turns count toward both caps through spendRecords; its subscription turns never', () => {
  const chatSpend = { turns: [{ timestamp: '2026-10-29T15:30:00Z', chat: 'c', billing: 'api', 'cost-usd': 1 }, { timestamp: '2026-10-29T15:40:00Z', chat: 'c', billing: 'subscription', 'cost-usd': 0 }] };
  const all = [...records, ...spendRecords([], {}, chatSpend)];
  assert.deepEqual(apiCapReached(all, caps(5, null), sprint, at), { cap: 'day', spend: 5, limit: 5 });
  assert.deepEqual(apiCapReached(all, caps(null, 11), sprint, at), { cap: 'sprint', spend: 11, limit: 11 });
});
