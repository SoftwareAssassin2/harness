// ASS-479: the Performance screen (p) always shows, under its header, when its
// data was last updated — analytics/tickets.json's fetched-through and the
// newest of merge-requests.json's per-repository fetched-through — in the
// operator's time zone with its age; gray while fresh, yellow once stale (past
// twice harness.json's download-updates-interval-in-minutes, never under 30
// minutes) and red once very stale (four times that); and says so when there
// is no analytics data yet. Fixed clocks; generic projects and people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../../src/tui/app.js';
import * as screen from '../../src/tui/screens/performance.js';
import { loadDownloadInterval, analyticsFiles, watchFiles } from '../../src/tui/load.js';
import { until } from '../support/until.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const NOW = Date.parse('2026-11-16T16:16:00Z');
const SIZE = { columns: 180, rows: 60, now: new Date(NOW), timeZone: 'UTC' };
const GRAY = '\x1b[90m', YELLOW = '\x1b[33m', RED = '\x1b[31m';
const minutes = n => new Date(NOW - n * 60_000).toISOString();
const data = (ticketsAt, mrs = {}) => ({ tickets: { 'fetched-through': ticketsAt, tickets: {} }, sprints: { sprints: [] }, mergeRequests: { 'fetched-through': mrs, 'merge-requests': {} }, team: {}, accountId: null });
const project = { id: 'proj', name: 'Proj', stateEngine: 'e', sprint: null };
const base = initialState({ projects: [project], workflows: [{ name: 'e', steps: [] }] });
const on = (loaded, extra = {}) => screen.analyticsLoaded({ ...base, screen: 'p', focus: 'performance', ...extra }, 'proj', loaded);
const ageLine = (state, size = SIZE) => screen.view(state, size).find(l => strip(l).startsWith('Data updated'));

test('ASS-479 AC1: under the header, the tickets\' and the merge requests\' last read in local time with their ages, gray while fresh', () => {
  const state = on({ data: data(minutes(4), { 'https://gitlab.example.com/group/app': minutes(9), 'https://github.com/example/api': minutes(6) }) });
  const out = screen.view(state, SIZE).map(strip);
  assert.ok(/ \(\d+ days?\)$/.test(out[0]), out[0]);   // the header first, the age line right under it
  assert.equal(out[1], 'Data updated: tickets 16:12 UTC (4m ago), merge requests 16:10 UTC (6m ago)');   // the newest repository read
  assert.ok(screen.view(state, SIZE)[1].startsWith(GRAY));
  // The operator's own time zone, and the date for a read on another day there.
  const la = { ...SIZE, timeZone: 'America/Los_Angeles' };
  assert.equal(strip(ageLine(state, la)), 'Data updated: tickets 08:12 PST (4m ago), merge requests 08:10 PST (6m ago)');
  const early = on({ data: data('2026-11-16T07:30:00Z') });
  assert.match(strip(ageLine(early, la)), /^Data updated: tickets 2026-11-15 23:30 PST \(8h 46m ago\)/);
  // Under a minute: just now. No merge requests read: the tickets alone.
  assert.equal(strip(ageLine(on({ data: data(new Date(NOW - 20_000).toISOString()) }))), 'Data updated: tickets 16:15 UTC (just now)');
});

test('ASS-479 AC1: the line is there with the Jira-token warning too, under the header and after the red line', () => {
  const rejected = { since: '2026-11-16T09:00:00Z', status: 401, problem: 'HTTP 401', 'work-source': 'J' };
  const state = screen.analyticsLoaded({ ...base, projects: [{ ...project, jiraTokenRejected: rejected }], screen: 'p', focus: 'performance' }, 'proj', { data: data(minutes(400)) });
  const raw = screen.view(state, SIZE), out = raw.map(strip);
  const header = out.findIndex(l => / \(\d+ days?\)$/.test(l));
  assert.ok(out.slice(0, header).every(l => !l.startsWith('Data updated')) && raw[0].startsWith(RED), 'the token warning first');
  assert.match(out[header + 1], /^Data updated: tickets 09:36 UTC \(6h 40m ago\) — very stale, over 2h old$/);
});

test('ASS-479 AC2: stale past max(30m, 2 × the download interval) in yellow, very stale past 4 × that in red; the older read decides', () => {
  const at = (ticketsAt, mrs, extra) => ageLine(on({ data: data(ticketsAt, mrs) }, extra));
  assert.ok(at(minutes(30)).startsWith(GRAY), 'exactly 30m is not yet stale');
  assert.ok(at(minutes(31)).startsWith(YELLOW));
  assert.equal(strip(at(minutes(31))), 'Data updated: tickets 15:45 UTC (31m ago) — stale, over 30m old');
  assert.ok(at(minutes(120)).startsWith(YELLOW));
  assert.ok(at(minutes(121)).startsWith(RED));
  assert.equal(strip(at(minutes(121))), 'Data updated: tickets 14:15 UTC (2h 1m ago) — very stale, over 2h old');
  // Fresh tickets but merge requests not read for 45 minutes: stale.
  assert.ok(at(minutes(2), { 'https://gitlab.example.com/group/app': minutes(45) }).startsWith(YELLOW));
  // A 30-minute interval: stale past an hour, very stale past four.
  const slow = { downloadInterval: 30 };
  assert.ok(at(minutes(50), {}, slow).startsWith(GRAY));
  assert.equal(strip(at(minutes(61), {}, slow)), 'Data updated: tickets 15:15 UTC (1h 1m ago) — stale, over 1h old');
  assert.equal(strip(at(minutes(241), {}, slow)), 'Data updated: tickets 12:15 UTC (4h 1m ago) — very stale, over 4h old');
  assert.deepEqual(screen.staleAfter(), { stale: 30 * 60_000, veryStale: 120 * 60_000 });
  assert.deepEqual(screen.staleAfter(null), screen.staleAfter(4));
  assert.deepEqual(screen.staleAfter(20), { stale: 40 * 60_000, veryStale: 160 * 60_000 });
  // tickets.json without a fetched-through: never read, very stale.
  assert.equal(strip(at(undefined)), 'Data updated: tickets never read — very stale, over 2h old');
});

test('ASS-479 AC3: with no analytics data yet the line says so, above the screen\'s own message', () => {
  const raw = screen.view(on({ data: null }), SIZE);
  assert.deepEqual(raw.map(strip), ['Data updated: never — no analytics data downloaded yet', 'No analytics data for Proj yet: the grid fills once its tickets are downloaded (analytics/tickets.json).']);
  assert.ok(raw[0].startsWith(GRAY));
});

test('ASS-479 scope 3: the line follows new data and the passing of time', () => {
  const first = on({ data: data(minutes(4)) });
  assert.equal(strip(ageLine(first)), 'Data updated: tickets 16:12 UTC (4m ago)');
  assert.equal(strip(ageLine(first, { ...SIZE, now: new Date(NOW + 30 * 60_000) })), 'Data updated: tickets 16:12 UTC (34m ago) — stale, over 30m old');
  const reread = screen.analyticsLoaded(first, 'proj', { data: data(minutes(0)) });   // main.js reads the files again once they change
  assert.equal(strip(ageLine(reread)), 'Data updated: tickets 16:16 UTC (just now)');
});

test('ASS-479: loadDownloadInterval reads harness.json beside the projects folder; null without it or a positive number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'data-age-'));
  try {
    mkdirSync(join(dir, 'projects'));
    assert.equal(loadDownloadInterval(join(dir, 'projects')), null);
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'download-updates-interval-in-minutes': 10 }));
    assert.equal(loadDownloadInterval(join(dir, 'projects')), 10);
    writeFileSync(join(dir, 'harness.json'), JSON.stringify({ 'download-updates-interval-in-minutes': 0 }));
    assert.equal(loadDownloadInterval(join(dir, 'projects')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ASS-479 scope 3: watching analyticsFiles sees the analytics folder appear and tickets.json renamed into place', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'data-age-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const first = watchFiles(analyticsFiles(dir), () => { calls++; });
  t.after(() => first.close());
  await new Promise(resolve => setTimeout(resolve, 300));
  mkdirSync(join(dir, 'analytics'));
  assert.ok(await until(() => calls > 0), 'the folder made');
  first.close();
  calls = 0;
  const second = watchFiles(analyticsFiles(dir), () => { calls++; });   // main.js watches again once the folder is there
  t.after(() => second.close());
  await new Promise(resolve => setTimeout(resolve, 300));
  writeFileSync(join(dir, 'analytics', 'tickets.json.tmp'), '{}');
  renameSync(join(dir, 'analytics', 'tickets.json.tmp'), join(dir, 'analytics', 'tickets.json'));
  assert.ok(await until(() => calls > 0), 'tickets.json renamed into place');
});
