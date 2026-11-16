// ASS-475: the dashboard's side of a rejected analytics API token. While the
// downloader's jira-token-rejected.json is there (load.js jiraTokenRejected),
// the sprint header shows a white-on-red "Jira API token rejected" chip — a
// header warning, so it notifies too (ASS-412) — and the Performance screen
// (p) leads with a red line saying the token is rejected, what to do, and
// where its numbers stop. Neither shows once the file is gone. Generic
// projects and people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, render } from '../../src/tui/app.js';
import { headerWarnings } from '../../src/tui/screens/frame.js';
import * as performance from '../../src/tui/screens/performance.js';
import { loadProjects } from '../../src/tui/load.js';
import { liveWarnings } from '../../src/notify/warnings.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const NOW = new Date('2026-11-16T16:00:00Z');
const wide = { columns: 220, rows: 50, now: NOW, timeZone: 'UTC' };
const steps = [
  { id: 'build', name: 'Build', sequence: 5, action: { type: 'prompt' } },
  { id: 'done', name: 'Done', sequence: 10, 'is-done': true, action: { type: 'none' } },
];
const REJECTED = { since: '2026-11-14T08:30:00Z', status: 401, problem: 'HTTP 401 Unauthorized for /rest/api/3/myself', 'work-source': 'J' };
const FLAG = '\x1b[41;97m Jira API token rejected \x1b[0m';
// p, worked (A-0 has an agent, so no idle warning), with or without the record.
function dashboard(jiraTokenRejected = null) {
  const p = { id: 'p', name: 'P', stateEngine: 'e', sprint: { number: 10, start: '2026-11-03', end: '2026-11-16', features: [{ key: 'A-0', title: 'T', variations: [{ name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' } }] }], bugs: [], spikes: [] }, backlog: [], questions: [], days: {}, notifications: true, jiraTokenRejected };
  return initialState({ projects: [p], workflows: [{ name: 'e', steps }], assignments: [{ project: 'p', 'agent-name': 'Daredevil', 'work-item': 'A-0', variation: null }] });
}

test('ASS-475 AC1: load.js reads jira-token-rejected.json as jiraTokenRejected, null without it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-token-rejected-'));
  for (const id of ['a', 'b']) { mkdirSync(join(dir, id)); writeFileSync(join(dir, id, 'project.json'), JSON.stringify({ name: id.toUpperCase() })); }
  writeFileSync(join(dir, 'a', 'jira-token-rejected.json'), JSON.stringify(REJECTED));
  try {
    assert.deepEqual(loadProjects(dir, join(dir, 'lima')).map(p => [p.id, p.jiraTokenRejected]), [['a', REJECTED], ['b', null]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ASS-475 AC1/AC2: while the token is rejected the sprint header shows the chip and it notifies, saying what to do; once the record is gone, neither', () => {
  const held = render(dashboard(REJECTED), wide);
  assert.ok(held.some(l => l.includes(FLAG)), held.map(strip).join('\n'));
  const warning = headerWarnings(dashboard(REJECTED), NOW.getTime()).find(w => w.id === 'jira-token-rejected');
  assert.equal(warning.chip, true);
  assert.equal(warning.operator, false);
  assert.equal(warning.todo, 'Jira rejects the analytics API token of the "J" jira work source since 2026-11-14 08:30 UTC, so the analytics are not updated: create a new Atlassian API token and put it in project.json as the api-token of the "J" jira work source');
  assert.ok(liveWarnings(dashboard(REJECTED), NOW.getTime()).p.some(w => w.key === 'jira-token-rejected'));
  assert.ok(!render(dashboard(), wide).some(l => strip(l).includes('Jira API token rejected')));
  assert.ok(!headerWarnings(dashboard(), NOW.getTime()).some(w => w.id === 'jira-token-rejected'));
});

test('ASS-475 AC1/AC2: the Performance screen leads with a red line naming the rejected token, the fix and where its numbers stop; not once signed in again', () => {
  const data = { tickets: { 'fetched-through': '2026-11-14T08:00:00.000Z', tickets: {} }, sprints: { sprints: [] }, mergeRequests: {}, team: {}, accountId: null };
  const on = (record, loaded = { data }) => performance.analyticsLoaded({ ...dashboard(record), screen: 'p', focus: 'performance' }, 'p', loaded);
  const raw = performance.view(on(REJECTED), wide);
  const shown = raw.map(strip);
  assert.match(shown[0], /^Jira rejects the analytics API token of the "J" jira work source since 2026-11-14 08:30 UTC/);
  assert.match(shown.join(' '), /create a new Atlassian API token and put it in project\.json as the api-token of the "J" jira work source\. These numbers stop at 2026-11-14 08:00 UTC\./);
  assert.ok(raw[0].startsWith('\x1b[31m'), raw[0]);
  assert.ok(shown.every(l => l.length <= wide.columns));
  // Still loading, or no analytics yet: the line shows all the same, without the time.
  assert.match(strip(performance.view(on(REJECTED, undefined), wide)[0]), /^Jira rejects the analytics API token/);
  assert.match(strip(performance.view(on(REJECTED, { data: null }), wide)[0]), /^Jira rejects the analytics API token/);
  assert.ok(!performance.view(on(null), wide).map(strip).some(l => /Jira rejects/.test(l)));
});
