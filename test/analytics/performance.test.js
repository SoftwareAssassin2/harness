// ASS-410: each developer's performance over a time span, from the analytics
// data and the project's engines. Invented people and tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance, statusCategories, workOutSpan, cellLines, COLUMNS, dateIn } from '../../src/analytics/performance.js';

// Engine steps pairing made-up status names: the module never knows a name.
const ENGINE = { steps: [
  { id: 'backlog', 'paired-ticket-system-status': 'Ready', 'is-planning-stage': true },
  { id: 'plan', 'paired-ticket-system-status': 'Working', 'is-planning-stage': true },
  { id: 'build', 'paired-ticket-system-status': 'Working' },
  { id: 'release', 'paired-ticket-system-status': 'Reviewing' },
  { id: 'qa', 'paired-ticket-system-status': 'Checking', 'is-qa': true },
  { id: 'done', 'paired-ticket-system-status': 'Finished', 'is-done': true },
  { id: 'blocked', 'paired-ticket-system-status': 'Parked', area: 'quarantine' },
  { id: 'self-healing', 'paired-ticket-system-status': 'Working', area: 'quarantine', 'is-done': true },
] };

const ADA = { id: 'a1', name: 'Ada' };
const GRACE = { id: 'g1', name: 'Grace' };
const LIN = { id: 'q1', name: 'Lin' };
const TEAM = { members: [
  { 'ticket-system-id': 'a1', 'ticket-system-name': 'Ada', 'git-username': 'ada', 'git-name': 'Ada', role: 'developer', 'first-seen': '2026-09-01' },
  { 'ticket-system-id': 'g1', 'ticket-system-name': 'Grace', 'git-username': 'grace', 'git-name': 'Grace', role: 'developer', 'first-seen': '2026-11-03' },
  { 'ticket-system-id': 'q1', 'ticket-system-name': 'Lin', 'git-username': null, 'git-name': null, role: 'qa', 'first-seen': '2026-09-01' },
  { 'ticket-system-id': 'i1', 'ticket-system-name': 'Idle', 'git-username': 'idle', role: 'developer', 'first-seen': '2026-09-01' },
  { 'ticket-system-id': null, 'git-username': 'helper-bot', 'git-name': 'Helper Bot', role: 'bot', 'first-seen': '2026-09-01' },
] };

const SPRINTS = { sprints: [
  { id: 7, name: 'Sprint 7', state: 'closed', start: '2026-10-20T09:00:00.000Z', end: '2026-11-02T09:00:00.000Z' },
  { id: 8, name: 'Sprint 8', state: 'active', start: '2026-11-02T09:00:00.000Z', end: '2026-11-16T09:00:00.000Z' },
] };
const NOW = new Date('2026-11-05T15:00:00Z');   // Sprint 8, day 4

const day = (d, h = 10) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
const move = (at, from, to) => ({ at, from, to, by: LIN });
// A ticket from a list of [at, to] status moves; assignee changes as [at, from, to].
function ticket(key, { moves = [], assigns = [], assignee = null, points = null, status, sprints = [8] }) {
  let from = null;
  return {
    key, title: key, type: 'Story', created: day(1, 1), points, assignee, sprints,
    status: status ?? moves.at(-1)?.[1] ?? 'Ready',
    'status-changes': moves.map(([at, to]) => { const c = move(at, from, to); from = to; return c; }),
    'assignee-changes': assigns.map(([at, f, t]) => ({ at, from: f, to: t })),
  };
}
const tickets = (...list) => ({ 'fetched-through': NOW.toISOString(), tickets: Object.fromEntries(list.map(t => [t.key, t])) });
const mr = (repo, iid, username, at) => [`${repo}!${iid}`, { repo, iid, title: `PROJ-${iid}`, branch: `PROJ-${iid}`, author: { username, name: username }, 'merged-at': at }];
const mrs = (...list) => ({ 'fetched-through': {}, 'merge-requests': Object.fromEntries(list) });

const run = (over = {}) => performance({ tickets: tickets(), sprints: SPRINTS, mergeRequests: mrs(), team: TEAM, engines: [ENGINE], now: NOW, ...over });
const rowOf = (result, name) => result.rows.find(r => r.member.name === name);

// AC1
test('a status takes the category of the steps paired with it: done, qa, planning, or in-progress for any other step', () => {
  const c = statusCategories([ENGINE]);
  assert.equal(c.Ready, 'planning');
  assert.equal(c.Reviewing, 'in-progress');
  assert.equal(c.Checking, 'qa');
  assert.equal(c.Finished, 'done');
});

test('a status shared by several kinds of step takes the most advanced; quarantine steps are ignored', () => {
  const c = statusCategories([ENGINE, [{ id: 'x', 'paired-ticket-system-status': 'Ready', 'is-qa': true }]]);
  assert.equal(c.Working, 'in-progress');        // planning + in-progress, and its quarantine done step ignored
  assert.equal(c.Ready, 'qa');                    // planning in one engine, qa in another
  assert.equal('Parked' in c, false);             // quarantine only: no category
});

// AC2
test('the span defaults to the active sprint from its start date to today', () => {
  const span = workOutSpan(undefined, SPRINTS, NOW);
  assert.deepEqual(span, { start: '2026-11-02', end: '2026-11-05', days: 4, label: 'Sprint 8: 2026-11-02 → 2026-11-05', sprint: { id: 8, name: 'Sprint 8' } });
});

test('the default span ends at the sprint\'s end when that is before today', () => {
  const span = workOutSpan(undefined, SPRINTS, new Date('2026-11-20T12:00:00Z'));
  assert.equal(span.end, '2026-11-16');
  assert.equal(span.days, 15);
});

test('a given span is used as is, both dates in it, weekends counted', () => {
  const span = workOutSpan({ start: '2026-11-01', end: '2026-11-07' }, SPRINTS, NOW);
  assert.equal(span.days, 7);
  assert.equal(span.label, '2026-11-01 → 2026-11-07');
});

test('with no active sprint the span is today alone', () => {
  const span = workOutSpan(undefined, { sprints: [SPRINTS.sprints[0]] }, NOW);
  assert.deepEqual([span.start, span.end, span.days, span.sprint], ['2026-11-05', '2026-11-05', 1, null]);
});

test('days are calendar days in the given time zone', () => {
  assert.equal(dateIn('2026-11-05T03:00:00Z', 'America/New_York'), '2026-11-04');
  assert.equal(workOutSpan(undefined, SPRINTS, new Date('2026-11-05T03:00:00Z'), 'America/New_York').end, '2026-11-04');
});

// AC3: done in the span, and the developer rule
test('a ticket counts when its first change into a done status falls in the span', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { moves: [[day(3), 'Working'], [day(4), 'Finished']], assigns: [[day(2), null, ADA]], assignee: ADA }),
    ticket('PROJ-2', { moves: [[day(3), 'Working'], [day(4), 'Finished']], assigns: [[day(2), null, ADA]], assignee: ADA, status: 'Finished', sprints: [7] }),
    // done before the span, done again inside it: its first done change counts, so it is out
    ticket('PROJ-3', { moves: [[`2026-10-30T10:00:00Z`, 'Finished'], [day(3), 'Working'], [day(4), 'Finished']], assigns: [[day(1), null, ADA]], assignee: ADA }),
  ) });
  assert.deepEqual(cellLines(rowOf(result, 'Ada').cells.ticketsPerDay), ['0.5', 'tickets: 2', 'days: 4']);
});

test('the developer is the assignee just before the first QA status, else just before the done change', () => {
  const result = run({ tickets: tickets(
    // Ada builds it, it is handed to Lin for QA at the same moment and then done: Ada's
    ticket('PROJ-1', { moves: [[day(2), 'Working'], [day(3), 'Checking'], [day(4), 'Finished']],
      assigns: [[day(2, 1), null, ADA], [day(3, 11), ADA, LIN]], assignee: LIN }),
    // never through QA: Grace held it just before done
    ticket('PROJ-2', { moves: [[day(2), 'Working'], [day(4), 'Finished']], assigns: [[day(2, 1), null, ADA], [day(3), ADA, GRACE]], assignee: GRACE }),
    // credited to someone who is not a developer: no row gets it
    ticket('PROJ-3', { moves: [[day(2), 'Working'], [day(4), 'Finished']], assigns: [[day(2, 1), null, LIN]], assignee: LIN }),
    // no assignee changes: the current assignee
    ticket('PROJ-4', { moves: [[day(2), 'Working'], [day(4), 'Finished']], assignee: GRACE }),
  ) });
  assert.equal(rowOf(result, 'Ada').cells.ticketsPerDay.variables[0][1], 1);
  assert.equal(rowOf(result, 'Grace').cells.ticketsPerDay.variables[0][1], 2);
  assert.equal(rowOf(result, 'Lin'), undefined);                   // role qa: never a row
});

test('rows are developers with something to show, most tickets done first; idle ones only on request', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { moves: [[day(4), 'Finished']], assignee: GRACE }),
    ticket('PROJ-2', { moves: [[day(4), 'Finished']], assignee: GRACE }),
    ticket('PROJ-3', { moves: [[day(4), 'Finished']], assignee: ADA }),
  ) });
  assert.deepEqual(result.rows.map(r => r.member.name), ['Grace', 'Ada']);
  assert.deepEqual(run({ includeIdle: true }).rows.map(r => r.member.name), ['Ada', 'Grace', 'Idle']);
  assert.deepEqual(result.rows[0].member, { id: 'g1', name: 'Grace', gitUsername: 'grace' });
  assert.deepEqual(Object.keys(result.rows[0].cells), COLUMNS.map(c => c.key));
});

// AC4: each metric and its variables
test('Pts/day: points over days, a ticket without points counting 0 and named as unpointed', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { moves: [[day(4), 'Finished']], assignee: ADA, points: 3 }),
    ticket('PROJ-2', { moves: [[day(4), 'Finished']], assignee: ADA, points: 2.5 }),
    ticket('PROJ-3', { moves: [[day(4), 'Finished']], assignee: ADA }),
  ) });
  assert.deepEqual(cellLines(rowOf(result, 'Ada').cells.pointsPerDay), ['1.38', 'points: 5.5', 'days: 4', 'unpointed: 1']);
});

test('MRs/day and Main layer: merged merge requests in the span by author, top 5 repositories with % and count', () => {
  const result = run({ mergeRequests: mrs(
    mr('group/app', 1, 'ada', day(2)), mr('group/app', 2, 'ada', day(3)), mr('group/app', 3, 'ada', day(5)),
    mr('group/api', 4, 'ada', day(3)), mr('group/web', 5, 'ada', day(3)), mr('group/a', 6, 'ada', day(3)),
    mr('group/b', 7, 'ada', day(3)), mr('group/c', 8, 'ada', day(3)),
    mr('group/app', 9, 'ada', '2026-11-01T10:00:00Z'),            // before the span
    mr('group/app', 10, 'grace', day(3)),
  ) });
  const ada = rowOf(result, 'Ada').cells;
  assert.deepEqual(cellLines(ada.mrsPerDay), ['2', 'MRs: 8', 'days: 4']);
  assert.deepEqual(cellLines(ada.mainLayer), ['app 38% (3)', 'a 13% (1)', 'api 13% (1)', 'b 13% (1)', 'c 13% (1)', 'MRs: 8']);
  assert.deepEqual(cellLines(rowOf(result, 'Grace').cells.mainLayer), ['app 100% (1)', 'MRs: 1']);
});

test('First pass: tickets through QA never sent back to planning or in progress, over those done via QA', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { moves: [[day(2), 'Working'], [day(3), 'Checking'], [day(4), 'Finished']], assignee: ADA }),
    ticket('PROJ-2', { moves: [[day(2), 'Working'], [day(3), 'Checking'], [day(3, 12), 'Working'], [day(3, 14), 'Checking'], [day(4), 'Finished']], assignee: ADA }),
    ticket('PROJ-3', { moves: [[day(2), 'Working'], [day(3), 'Checking'], [day(3, 12), 'Reviewing'], [day(4), 'Finished']], assignee: ADA }),
    ticket('PROJ-4', { moves: [[day(2), 'Working'], [day(4), 'Finished']], assignee: ADA }),      // skipped QA: left out
  ) });
  assert.deepEqual(cellLines(rowOf(result, 'Ada').cells.firstPass), ['33%', 'first pass: 1', 'done via QA: 3']);
});

test('Dev time and Test time: medians in days, with the tickets counted and the range', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { moves: [[day(1), 'Ready'], [day(2, 0), 'Working'], [day(3, 0), 'Checking'], [day(3, 12), 'Finished']], assignee: ADA }),
    ticket('PROJ-2', { moves: [[day(1, 0), 'Working'], [day(4, 0), 'Checking'], [day(5, 0), 'Finished']], assignee: ADA }),
    ticket('PROJ-3', { moves: [[day(2, 0), 'Checking'], [day(4, 0), 'Finished']], assignee: ADA }),        // never in progress: no dev time
  ) });
  const ada = rowOf(result, 'Ada').cells;
  assert.deepEqual(cellLines(ada.devTime), ['2.0 d', 'tickets: 2', 'range: 1.0–3.0 d']);
  assert.deepEqual(cellLines(ada.testTime), ['1.0 d', 'tickets: 3', 'range: 0.5–2.0 d']);
});

test('In progress now: the developer\'s active-sprint tickets by current assignee in a planning or in-progress status', () => {
  const result = run({ tickets: tickets(
    ticket('PROJ-1', { assignee: ADA, status: 'Ready' }),
    ticket('PROJ-2', { assignee: ADA, status: 'Working' }),
    ticket('PROJ-3', { assignee: ADA, status: 'Reviewing' }),
    ticket('PROJ-4', { assignee: ADA, status: 'Checking' }),          // qa: not counted
    ticket('PROJ-5', { assignee: ADA, status: 'Parked' }),            // quarantine: not counted
    ticket('PROJ-6', { assignee: ADA, status: 'Working', sprints: [7] }),   // not the active sprint
  ) });
  assert.deepEqual(cellLines(rowOf(result, 'Ada').cells.inProgressNow), ['3', 'planning: 1', 'in progress: 2']);
});

// AC5
test('a metric with nothing to divide by shows "–" with its variables still shown', () => {
  const result = run({ tickets: tickets(ticket('PROJ-1', { assignee: ADA, status: 'Working' })) });
  const ada = rowOf(result, 'Ada').cells;
  assert.deepEqual(cellLines(ada.ticketsPerDay), ['0', 'tickets: 0', 'days: 4']);
  assert.deepEqual(cellLines(ada.firstPass), ['–', 'first pass: 0', 'done via QA: 0']);
  assert.deepEqual(cellLines(ada.devTime), ['–', 'tickets: 0', 'range: –']);
  assert.deepEqual(cellLines(ada.testTime), ['–', 'tickets: 0', 'range: –']);
  assert.deepEqual(cellLines(ada.mainLayer), ['–', 'MRs: 0']);
  assert.equal(ada.firstPass.number, null);
  const empty = workOutSpan({ start: '2026-11-05', end: '2026-11-04' }, SPRINTS, NOW);
  assert.equal(empty.days, 0);
  const none = run({ span: { start: '2026-11-05', end: '2026-11-04' }, includeIdle: true });
  assert.deepEqual(cellLines(rowOf(none, 'Ada').cells.ticketsPerDay), ['–', 'tickets: 0', 'days: 0']);
});

test('with no data at all there are no rows and nothing to notice', () => {
  const result = performance({ tickets: undefined, sprints: undefined, mergeRequests: undefined, team: undefined, engines: [], now: NOW });
  assert.deepEqual([result.rows, result.newMembers, result.unknownAuthors], [[], [], []]);
  assert.equal(result.span.days, 1);
});

// AC6
test('the result lists git authors in the span missing from team.json, and members first seen in the span', () => {
  const result = run({ mergeRequests: mrs(
    mr('group/app', 1, 'newcomer', day(3)), mr('group/app', 2, 'newcomer', day(4)), mr('group/app', 3, 'helper-bot', day(3)),
    mr('group/app', 4, 'oldtimer', '2026-10-01T10:00:00Z'),
  ) });
  assert.deepEqual(result.unknownAuthors, [{ username: 'newcomer', name: 'newcomer', mrs: 2 }]);
  assert.deepEqual(result.newMembers, [{ name: 'Grace', role: 'developer', firstSeen: '2026-11-03' }]);
});
