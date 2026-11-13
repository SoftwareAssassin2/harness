// ASS-411: the performance screen on p — each developer's performance over a
// span (src/analytics/performance.js, ASS-410), the operator's own row
// highlighted. Invented people, tickets and repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, handleKey, render } from '../../src/tui/app.js';
import * as screen from '../../src/tui/screens/performance.js';
import { loadAnalytics } from '../../src/tui/load.js';
import { visible } from '../../src/tui/text.js';

const strip = line => line.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');

// The project's own engine, pairing made-up status names: the screen never knows one.
const ENGINE = { name: 'proj-dev', project: 'proj', steps: [
  { id: 'backlog', 'paired-ticket-system-status': 'Ready', 'is-planning-stage': true },
  { id: 'build', 'paired-ticket-system-status': 'Working' },
  { id: 'qa', 'paired-ticket-system-status': 'Checking', 'is-qa': true },
  { id: 'done', 'paired-ticket-system-status': 'Finished', 'is-done': true },
] };
const ADA = { id: 'a1', name: 'Ada' }, GRACE = { id: 'g1', name: 'Grace' };
const TEAM = { members: [
  { 'ticket-system-id': 'a1', 'ticket-system-name': 'Ada', 'git-username': 'ada', role: 'developer', 'first-seen': '2026-09-01' },
  { 'ticket-system-id': 'g1', 'ticket-system-name': 'Grace', 'git-username': 'grace', role: 'developer', 'first-seen': '2026-11-03' },
] };
const SPRINTS = { sprints: [
  { id: 11, name: 'Sprint 11', state: 'closed', start: '2026-10-05T09:00:00.000Z', end: '2026-10-19T09:00:00.000Z' },
  { id: 12, name: 'Sprint 12', state: 'closed', start: '2026-10-19T09:00:00.000Z', end: '2026-11-02T09:00:00.000Z' },
  { id: 13, name: 'Sprint 13', state: 'active', start: '2026-11-02T09:00:00.000Z', end: '2026-11-16T09:00:00.000Z' },
  { id: 14, name: 'Sprint 14', state: 'future', start: '2026-11-16T09:00:00.000Z', end: '2026-11-30T09:00:00.000Z' },
] };
const NOW = new Date('2026-11-12T15:00:00Z');
const at = (date, h = 10) => `${date}T${String(h).padStart(2, '0')}:00:00.000Z`;
const ticket = (key, assignee, moves, { points = null, sprints = [13] } = {}) => {
  let from = null;
  return {
    key, title: key, type: 'Story', points, assignee, sprints, status: moves.at(-1)[1],
    'status-changes': moves.map(([when, to]) => { const c = { at: at(when), from, to }; from = to; return c; }),
    'assignee-changes': [],
  };
};
const TICKETS = { tickets: Object.fromEntries([
  ticket('PROJ-1', ADA, [['2026-11-03', 'Working'], ['2026-11-04', 'Checking'], ['2026-11-05', 'Finished']], { points: 3 }),
  ticket('PROJ-2', ADA, [['2026-11-05', 'Working'], ['2026-11-06', 'Checking'], ['2026-11-09', 'Finished']], { points: 2 }),
  ticket('PROJ-3', GRACE, [['2026-11-04', 'Working'], ['2026-11-06', 'Checking'], ['2026-11-07', 'Working'], ['2026-11-08', 'Checking'], ['2026-11-10', 'Finished']], { points: 5 }),
  ticket('PROJ-4', GRACE, [['2026-11-11', 'Working']]),
  ticket('PROJ-5', ADA, [['2026-10-21', 'Working'], ['2026-10-23', 'Checking'], ['2026-10-26', 'Finished']], { sprints: [12] }),
].map(t => [t.key, t])) };
const mr = (repo, iid, username, day) => [`${repo}!${iid}`, { repo, iid, title: `PROJ-${iid}`, author: { username, name: username === 'bob' ? 'Bob' : username }, 'merged-at': at(day) }];
const MRS = { 'merge-requests': Object.fromEntries([
  mr('group/app', 1, 'ada', '2026-11-05'), mr('group/api', 3, 'ada', '2026-11-09'), mr('group/app', 2, 'grace', '2026-11-10'), mr('group/app', 4, 'bob', '2026-11-06'),
]) };
const DATA = { tickets: TICKETS, sprints: SPRINTS, mergeRequests: MRS, team: TEAM, accountId: 'g1' };

const SIZE = { columns: 180, rows: 70, now: NOW, timeZone: 'UTC' };
const project = { id: 'proj', name: 'Proj', stateEngine: 'proj-dev', sprint: null };
const base = initialState({ projects: [project, { id: 'other', name: 'Other', stateEngine: 'proj-dev', sprint: null }], workflows: [ENGINE] });
const onScreen = (data = DATA) => screen.analyticsLoaded({ ...base, screen: 'p', focus: 'performance' }, 'proj', { data });
const key = (name, sequence) => ({ name, sequence });
const typed = text => [...text].map(ch => key(ch, ch));
const press = (state, ...keys) => keys.reduce((s, k) => handleKey(s, typeof k === 'string' ? key(k) : k, SIZE), state);
const lines = (state, size = SIZE) => screen.view(state, size).map(strip);
const header = state => lines(state)[0];

// AC1
test('p opens the performance screen for the selected project, its grid focused and its analytics asked of main.js', () => {
  const opened = handleKey(base, key('p', 'p'), SIZE);
  assert.equal(opened.screen, 'p');
  assert.equal(opened.focus, 'performance');
  assert.equal(opened.performanceLoad, 'proj');
  assert.equal(lines(opened)[0], "loading proj's analytics…");
});

test('the ? menu lists p as "performance"', () => {
  const open = render(handleKey(base, key('?', '?'), SIZE), SIZE).map(strip);
  assert.ok(open.some(l => /│\s*p\s+performance\s/.test(l)), open.join('\n'));
});

test('switching project on the screen asks for that project\'s analytics, back on its active sprint', () => {
  const s = { ...onScreen(), focus: 'menu', performanceSpan: { sprint: 12 } };
  const next = handleKey(s, key('right'), SIZE);
  assert.equal(next.project, 1);
  assert.equal(next.performanceLoad, 'other');
  assert.equal(next.performanceSpan, null);
});

// AC2
test('a boxed grid: the columns in order, each cell its value over its labelled variables', () => {
  const out = lines(onScreen());
  const top = out.findIndex(l => l.startsWith('┌'));
  assert.deepEqual(out[top + 1].split('│').slice(1, -1).map(h => h.trim()),
    ['Developer', 'Tickets/day', 'Pts/day', 'MRs/day', 'First pass', 'Dev time', 'Test time', 'In progress now', 'Main layer']);
  const ada = out.findIndex(l => l.includes('Ada'));
  const cells = i => out[ada + i].split('│').slice(1, -1).map(c => c.trim());
  assert.deepEqual(cells(0).slice(0, 4), ['Ada', '0.18', '0.45', '0.18']);   // 2 tickets, 5 points, 2 MRs over 11 days
  assert.deepEqual(cells(1).slice(1, 4), ['tickets: 2', 'points: 5', 'MRs: 2']);
  assert.deepEqual(cells(2).slice(1, 4), ['days: 11', 'days: 11', 'days: 11']);
  assert.equal(cells(0)[8], 'api 50% (1)');
  assert.equal(cells(1)[8], 'app 50% (1)');   // Main layer's further repositories under its first
  assert.ok(out.every(l => visible(l) <= SIZE.columns));
});

test('rows are sorted by tickets moved to Done, most first', () => {
  const out = lines(onScreen());
  assert.ok(out.findIndex(l => l.includes('Ada')) < out.findIndex(l => l.includes('Grace')));
});

// AC3
test('the operator\'s row: ▶ before the name, reverse video, double rules above and below it', () => {
  const raw = screen.view(onScreen(), SIZE), out = raw.map(strip);
  const grace = out.findIndex(l => l.includes('▶ Grace'));
  assert.ok(grace > 0);
  assert.match(raw[grace], /^│\x1b\[7m/);
  assert.match(out[grace - 1], /^╞═+╪/);
  const below = out.findIndex((l, i) => i > grace && !l.startsWith('│'));
  assert.ok(out.slice(grace, below).every((l, i) => raw[grace + i].startsWith('│\x1b[7m')));   // every line of the row
  assert.match(out[below], /^╘═+╧/);                                                        // last row: the bottom border doubled
  const ada = out.findIndex(l => l.includes('Ada'));
  assert.ok(!out[ada].includes('▶') && !raw[ada].includes('\x1b[7m'));
  assert.match(out[ada - 1], /^├─+┼/);                                                     // the headings' rule over a row not the operator's
});

test('a double rule between rows when the operator\'s row is in the middle, single ones elsewhere', () => {
  const cells = Object.fromEntries(['ticketsPerDay', 'pointsPerDay', 'mrsPerDay', 'firstPass', 'devTime', 'testTime', 'inProgressNow', 'mainLayer'].map(k => [k, { value: '1', more: [], variables: [] }]));
  const rows = ['Ada', 'Grace', 'Lin'].map((name, i) => ({ member: { id: `x${i}`, name }, cells }));
  const { head, body, foot } = screen.grid(rows, 'x1');
  assert.deepEqual(body.map(l => l[0]), ['├', '│', '╞', '│', '╞', '│']);
  assert.equal(foot[0], '└');
  assert.equal(head.length, 2);
});

test('no highlight when the signed-in user is not on the team', () => {
  const raw = screen.view(onScreen({ ...DATA, accountId: 'z9' }), SIZE);
  assert.ok(!raw.some(l => l.includes('\x1b[7m') || l.includes('▶') || l.includes('═')));
});

test('a project with no ticket-system-account-id (off-board) highlights the member whose id is "operator"', () => {
  const team = { members: [...TEAM.members, { 'ticket-system-id': 'operator', 'ticket-system-name': 'Me', role: 'developer', 'first-seen': '2026-09-01' }] };
  const tickets = { tickets: { ...TICKETS.tickets, 'PROJ-6': ticket('PROJ-6', { id: 'operator', name: 'Me' }, [['2026-11-11', 'Working']]) } };
  const out = lines(onScreen({ ...DATA, team, tickets, accountId: null }));
  assert.ok(out.some(l => l.includes('▶ Me')));
  assert.ok(!out.some(l => l.includes('▶ Grace')));
});

// AC4
test('the header names the span: the active sprint to today by default', () => {
  assert.equal(header(onScreen()), 'Sprint 13: 2026-11-02 → 2026-11-12 (11 days)');
  assert.match(lines(onScreen())[1], /\[ previous sprint {3}\] next sprint {3}t this sprint/);   // the keys, as other screens show theirs
});

test('enter opens a from/to form on the span on show; dates typed and enter set any span', () => {
  const form = press(onScreen(), 'return');
  assert.deepEqual(form.performanceForm, { field: 'from', from: '2026-11-02', to: '2026-11-12' });
  assert.match(lines(form)[1], /^From 2026-11-02█ {3}to 2026-11-12 {3}\(dates in UTC\)/);
  const set = press(form, ...Array(10).fill('backspace'), ...typed('2026-11-03'), 'tab', ...Array(10).fill('backspace'), ...typed('2026-11-05'), 'return');
  assert.equal(set.performanceForm, null);
  assert.deepEqual(set.performanceSpan, { start: '2026-11-03', end: '2026-11-05' });
  assert.equal(header(set), '2026-11-03 → 2026-11-05 (3 days)');
  assert.ok(lines(set).some(l => /^│ {3}Ada +│ 0\.33/.test(l)));   // worked out over the new span: 1 ticket in 3 days
});

test('the form refuses dates that are not real or run backwards, and esc gives up', () => {
  const form = { ...onScreen(), performanceForm: { field: 'to', from: '2026-11-05', to: '2026-11-03' } };
  const refused = press(form, 'return');
  assert.ok(refused.performanceForm);
  assert.match(refused.performanceMessage, /YYYY-MM-DD, from no later than to/);
  assert.ok(press({ ...form, performanceForm: { ...form.performanceForm, to: '2026-02-30' } }, 'return').performanceForm);
  const gone = press(form, { name: 'escape' });
  assert.equal(gone.performanceForm, null);
  assert.equal(gone.performanceSpan, null);
});

test('[ and ] step to the previous and next started sprint, t back to the current one', () => {
  const back = press(onScreen(), key('[', '['));
  assert.deepEqual(back.performanceSpan, { sprint: 12 });
  assert.equal(header(back), 'Sprint 12: 2026-10-19 → 2026-11-02 (15 days)');
  const twice = press(back, key('[', '['));
  assert.equal(header(twice), 'Sprint 11: 2026-10-05 → 2026-10-19 (15 days)');
  assert.equal(press(twice, key('[', '[')).performanceMessage, 'No earlier sprint.');
  assert.equal(press(twice, key(']', ']')).performanceSpan.sprint, 12);
  assert.equal(press(back, key(']', ']')).performanceSpan, null);                       // the active sprint: the default span again
  assert.equal(press(onScreen(), key(']', ']')).performanceMessage, 'No later sprint.');   // Sprint 14 has not started
  assert.equal(press(twice, key('t', 't')).performanceSpan, null);
  const set = { ...onScreen(), performanceSpan: { start: '2026-10-25', end: '2026-10-30' } };
  assert.equal(press(set, key('[', '[')).performanceSpan.sprint, 11);                    // from dates set by hand: the sprint they start in
});

test('a sprint stepped to is worked out over its own dates', () => {
  const out = lines(press(onScreen(), key('[', '[')));
  const ada = out.findIndex(l => l.includes('Ada'));
  assert.match(out[ada + 1], /tickets: 1/);   // PROJ-5, done in Sprint 12
});

// AC5
test('a line under the grid notes new team members first seen in the span and git authors not on the team', () => {
  const out = lines(onScreen());
  const bottom = out.findIndex(l => l.startsWith('╘') || l.startsWith('└'));
  const notice = out.slice(bottom + 1).join(' ');
  assert.match(notice, /Check team\.json/);
  assert.match(notice, /new on the team in this span: Grace \(developer, first seen 2026-11-03\)/);
  assert.match(notice, /git authors not on the team: bob \(Bob\), 1 MR/);
  assert.ok(!lines(press(onScreen(), key('[', '['))).some(l => l.includes('Check team.json')));   // Sprint 12: neither
});

// AC6
test('a grid taller than the screen scrolls under its headings, with a scrollbar', () => {
  const short = { ...SIZE, rows: 30 };
  const s = onScreen();
  const first = screen.view(s, short).map(strip);
  assert.ok(first.some(l => l.endsWith('█')));
  const headings = first.findIndex(l => l.startsWith('│ Developer'));
  const down = screen.onKey(s, key('down'), short, { step: 1, sideways: false });
  assert.equal(down.performanceScroll, 1);
  const moved = screen.view(down, short).map(strip);
  assert.equal(moved[headings], first[headings]);                 // the headings stay
  assert.equal(moved[headings + 1].slice(0, -1), first[headings + 2].slice(0, -1));   // the body moved up a line (its right border the scrollbar's)
  const far = screen.onKey({ ...s, performanceScroll: 999 }, key('down'), short, { step: 1, sideways: false });
  assert.ok(far.performanceScroll < 999);                         // never past the end
});

test('a project with no analytics data yet says so in one line, with no grid', () => {
  const out = lines(screen.analyticsLoaded({ ...base, screen: 'p' }, 'proj', { data: null }));
  assert.deepEqual(out, ['No analytics data for Proj yet: the grid fills once its tickets are downloaded (analytics/tickets.json).']);
  const whole = render(screen.analyticsLoaded({ ...base, screen: 'p' }, 'proj', { data: null }), SIZE).map(strip);
  assert.ok(!whole.some(l => l.includes('Developer')));
});

test('a failed read says what went wrong', () => {
  assert.match(lines(screen.analyticsLoaded({ ...base, screen: 'p' }, 'proj', { error: "proj's analytics: Unexpected token" }))[0], /Unexpected token/);
});

// The loader beside the TUI's others: read when asked, never with the dashboard's reloads.
test('loadAnalytics reads the analytics files, team.json and the account id; null with no tickets.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-'));
  try {
    assert.equal(await loadAnalytics(dir), null);
    mkdirSync(join(dir, 'analytics'));
    writeFileSync(join(dir, 'analytics', 'tickets.json'), JSON.stringify(TICKETS));
    writeFileSync(join(dir, 'analytics', 'sprints.json'), JSON.stringify(SPRINTS));
    const offBoard = await loadAnalytics(dir);
    assert.deepEqual([offBoard.mergeRequests, offBoard.team, offBoard.accountId], [{}, {}, null]);
    writeFileSync(join(dir, 'team.json'), JSON.stringify(TEAM));
    writeFileSync(join(dir, 'ticket-system-account-id'), 'g1\n');
    const loaded = await loadAnalytics(dir);
    assert.deepEqual(loaded.team, TEAM);
    assert.deepEqual(loaded.sprints, SPRINTS);
    assert.equal(loaded.accountId, 'g1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
