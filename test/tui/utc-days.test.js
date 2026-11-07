// ASS-294: every day the harness counts is a UTC day, and every time and
// date the dashboard shows says UTC — run here in a zone four or five hours
// behind UTC (Eastern), so a moment just after UTC midnight is still the day
// before on this computer's clock, and a local day would show.
process.env.TZ = 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, render } from '../../src/tui/app.js';
import { utcDate } from '../../src/downloader/cycle.js';
import { runsBefore } from '../../src/tui/since.js';
import { daySpend, sprintSpend } from '../../src/control/spend.js';
import { workedByHand, quickLines, ticketLines } from '../../src/tui/ticket.js';
import { MEMORY_HEADERS, memoryRows } from '../../src/tui/memory.js';
import { timestamp } from '../../src/tui/screens/shared.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const lines = (s, size) => render(s, size).map(strip);
// 03:30Z on Nov 8 is 22:30 EST on Nov 7: the UTC day and the local one differ.
const LATE = new Date('2026-11-08T03:30:00Z');

test('ASS-294: the test process really runs in Eastern time, so a local day would differ from the UTC one', () => {
  assert.equal(LATE.getDate(), 7);
  assert.equal(LATE.getUTCDate(), 8);
});

test('ASS-294 AC1: utcDate names the UTC day of a moment, YYYY-MM-DD — never this computer\'s', () => {
  assert.equal(utcDate(LATE), '2026-11-08');
  assert.equal(utcDate(new Date('2026-11-07T23:59:59Z')), '2026-11-07');
  assert.equal(utcDate(new Date('2026-11-08T00:00:00Z')), '2026-11-08');
  assert.equal(utcDate(new Date('not a time')), null);   // an invalid moment is on no day, rather than throwing
});

// A sprint of 14 days, Sep 18 to Oct 1, with A-1 worked so no warning takes the header's room (ASS-59).
const steps = [{ id: 'build', name: 'Build', sequence: 5 }, { id: 'done', name: 'Done', sequence: 10 }];
const feature = key => ({ key, title: 'T', points: 3, variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] });
const sprint = { number: 10, start: '2026-09-18', end: '2026-10-01', bugs: [], spikes: [], features: [feature('A-1')] };
const project = { id: 'p', name: 'P', stateEngine: 'e', sprint, backlog: [] };
const state = initialState({ projects: [project], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-1', variation: 'A' }] });

test('ASS-294 AC1: the sprint box counts UTC days — 00:30Z on Oct 1 (20:30 EDT on Sep 30) is already day 14, the last', () => {
  const before = lines(state, { columns: 140, rows: 44, now: new Date('2026-09-30T23:59:00Z') });
  assert.ok(before.some(l => / day 13 of 14 +│/.test(l)), before.join('\n'));
  assert.ok(before.some(l => / sprint ends in 1 day +│/.test(l)));
  const after = lines(state, { columns: 140, rows: 44, now: new Date('2026-10-01T00:30:00Z') });
  assert.ok(after.some(l => / day 14 of 14 +│/.test(l)), after.join('\n'));
  assert.ok(after.some(l => / sprint ends today +│/.test(l)));
});

test('ASS-294 AC1: a past day picked is seen at 23:59 UTC that day — its own day number, and its end-of-day time in UTC', () => {
  const past = { ...state, day: '2026-09-29', projects: [{ ...project, days: { '2026-09-29': sprint } }] };
  const out = lines(past, { columns: 160, rows: 44, now: new Date('2026-10-01T00:30:00Z') });
  assert.ok(out.some(l => / day 12 of 14 +│/.test(l)), out.join('\n'));
  assert.ok(out.some(l => l.includes(timestamp(new Date('2026-09-29T23:59:00Z')))), out.join('\n'));   // 'Tue Sep 29 @ 11:59 PM UTC'
  assert.equal(timestamp(new Date('2026-09-29T23:59:00Z')), 'Tue Sep 29 @ 11:59 PM UTC');
});

test('ASS-294 AC1: the progress bar\'s "yesterday" is the snapshot before the UTC day — just after UTC midnight it is the day that just ended', () => {
  const days = { '2026-09-28': { ...sprint, features: [feature('OLD')] }, '2026-09-29': { ...sprint, features: [feature('YESTERDAY')] } };
  const s = { ...state, projects: [{ ...project, days }] };
  const keys = tickets => tickets.map(t => t.key);
  assert.deepEqual(runsBefore(s, Date.parse('2026-09-30T00:30:00Z'), keys), ['YESTERDAY']);   // Sep 30 UTC, though Sep 29 20:30 EDT
  assert.deepEqual(runsBefore(s, Date.parse('2026-09-29T23:30:00Z'), keys), ['OLD']);         // still Sep 29 UTC
});

test('ASS-294 AC1: Day Spend and Sprint Spend count UTC days — from 00:00Z up to the next', () => {
  const record = (timestamp, cost) => ({ timestamp, billing: 'api', 'cost-usd': cost });
  const records = [record('2026-10-28T23:59:59Z', 1), record('2026-10-29T00:00:00Z', 2), record('2026-10-29T23:59:59Z', 4), record('2026-10-30T00:00:00Z', 8)];
  assert.equal(daySpend(records, new Date('2026-10-29T02:00:00Z')), 2 + 4);       // Oct 29 UTC, though 22:00 EDT on Oct 28
  assert.equal(daySpend(records, new Date('2026-10-28T23:00:00Z')), 1);
  assert.equal(sprintSpend(records, '2026-10-29', new Date('2026-10-29T02:00:00Z')), 2 + 4);   // the sprint starts at 00:00Z on its first day
  assert.equal(sprintSpend(records, '2026-10-28', new Date('2026-10-29T12:00:00Z')), 1 + 2 + 4);
});

// The control box's lines, as app.test.js's ASS-292 tests read them.
const controlBox = s => lines(s, { columns: 200, rows: 50, now: new Date('2026-11-08T12:00:00Z') })
  .map(l => l.match(/│ ((control|disk free|golden image)[^│]*?) +│/)?.[1]).filter(Boolean);

test('ASS-294 AC1/AC3: the golden image\'s built date is its UTC day, and says UTC', () => {
  const golden = { name: 'golden-p', 'built-at': LATE.toISOString() };
  const box = controlBox(initialState({ projects: [{ id: 'p', name: 'P', sprint: null, control: { status: 'Online' }, environments: [], golden }] }));
  assert.ok(box.includes('golden image: golden-p (built 2026-11-08 UTC)'), box.join('\n'));
});

test('ASS-294 AC2: the control log screen\'s header says its times are UTC, and each line\'s time is the UTC one', () => {
  const s = { ...state, screen: 'c', controlLog: [{ text: 'Hello world!', stream: 'stdout', at: LATE }] };
  const out = lines(s, { columns: 120, rows: 44, now: LATE });
  const top = out.find(l => l.startsWith('┌'));
  assert.match(top, /^┌─ control \(times UTC\) ─+┐$/);
  assert.equal(top.length, 120);
  assert.ok(out.some(l => l.startsWith('│ 03:30:00  Hello world!')), out.join('\n'));
});

test('ASS-294 AC2: the ticket screen\'s history times, "worked by hand since" and the quick panel\'s By hand time each say UTC', () => {
  const hand = { by: 'alice', since: '2026-10-27T10:05:00Z' };
  assert.equal(workedByHand({ 'worked-manually': hand }), 'worked by hand by alice since 2026-10-27 10:05 UTC');
  const variation = { 'state-changes': [{ 'from-state': 'plan', 'to-state': 'build', timestamp: '2026-11-08T03:30:00Z', 'agent-dispatch-log': [] }] };
  const quick = quickLines({ key: 'A-1', title: 'T', 'worked-manually': hand, variation }, { status: 'Build', now: LATE }).map(strip);
  assert.ok(quick.includes('By hand: alice since 10-27 10:05 UTC'), quick.join('\n'));
  assert.ok(quick.some(l => l.startsWith('  since 11-08 03:30 UTC (')), quick.join('\n'));
  const { history } = ticketLines({ key: 'A-1', title: 'T', variation }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 120 });
  assert.ok(history.some(l => l.trim().startsWith('2026-11-08 03:30 UTC  plan')), history.join('\n'));
});

test('ASS-294 AC3: the memory screen\'s date column is the UTC day saved, and its header says UTC', () => {
  assert.equal(MEMORY_HEADERS.at(-1), 'Saved (UTC)');
  assert.equal(memoryRows([{ id: 'm', text: 't', metadata: {}, mentioned_at: LATE.toISOString() }])[0].at(-1), '2026-11-08');
});
