// The downloader cycle's analytics step (ASS-406): every ticket of the
// board's Jira project with its changelog, and the board's sprints, read
// through Jira's REST API (jira-rest.js, with a fake fetch) and handed to
// the real analytics:sync-tickets and analytics:sync-sprints; the cycle's
// other agent.sh calls are only recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCycle, ANALYTICS_OVERLAP_MS } from '../../src/downloader/cycle.js';
import * as jiraRest from '../../src/downloader/jira-rest.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const BOARD = 'https://example.atlassian.net/jira/software/c/projects/PROJ/boards/12';

// A repo root whose project p has a jira work source (with the REST credentials unless told otherwise) and no active sprint.
function root({ credentials = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-analytics-'));
  const project = join(dir, 'data', 'projects', 'p');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'project.json'), JSON.stringify({
    'work-sources': [{ name: 'J', type: 'jira', url: BOARD, 'story-points-field': 'customfield_10028', 'sprint-field': 'customfield_10020',
      ...credentials ? { 'api-email': 'ada@example.com', 'api-token': 'secret-token' } : {} }],
  }));
  writeFileSync(join(project, 'sprints.json'), JSON.stringify({ list: [] }));
  writeFileSync(join(project, 'backlog.json'), JSON.stringify({ tickets: [] }));
  return { dir, project, file: name => join(project, 'analytics', name) };
}
// The acli adapter's fakes: nothing in the backlog, nobody signed in.
const jira = { fetchBacklogTickets: async () => [], fetchSprintTickets: async () => [], fetchActiveSprints: async () => [], fetchComments: async () => [] };
// exec: analytics:* runs the real agent.sh on the fixture; the rest are only recorded.
function executor(dir) {
  const calls = [];
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'data', 'projects') };
  const exec = async (file, args) => {
    calls.push(args[0]);
    return args[0].startsWith('analytics:') ? (await promisify(execFile)(AGENT, args, { env })).stdout : '';
  };
  return { calls, exec };
}
const history = (created, items) => ({ id: created, created, author: { accountId: 'acc-ada', displayName: 'Ada Example' }, items });
const issue = (key, statusName, histories = [], total = histories.length) => ({
  key, fields: { summary: `Title ${key}`, status: { name: statusName }, assignee: null, issuetype: { name: 'Bug' }, created: '2026-10-01T09:00:00.000+0000', customfield_10028: 2, customfield_10020: [{ id: 41 }] },
  changelog: { total, histories },
});
const statusItem = (from, to) => ({ field: 'status', fieldId: 'status', fromString: from, toString: to });
// fakeFetch(issues, { fail }) — the search answers those issues, the board its sprints; fail() true answers 401. The JQLs asked are kept.
function fakeFetch(answer) {
  const jqls = [], paths = [];
  const fetchFn = async url => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body = answer(u);
    if (body === 401) return { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) };
    if (u.pathname === '/rest/api/3/search/jql') jqls.push(u.searchParams.get('jql'));
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchFn, jqls, paths };
}
const SPRINTS = { values: [{ id: 41, name: 'S41', state: 'active', startDate: '2026-11-01T09:00:00.000Z', endDate: '2026-11-15T09:00:00.000Z' }], isLast: true };

async function cycle(r, fetchFn, lines = []) {
  const { calls, exec } = executor(r.dir);
  await runCycle({ root: r.dir, project: 'p', now: new Date(), adapters: { jira, jiraRest }, exec, fetch: fetchFn, log: l => lines.push(l) });
  return calls;
}

test('ASS-406 AC1-AC4: a first read takes every ticket with its changelog (a truncated one completed) and the board\'s sprints, through agent.sh, touching no sprint or backlog file', async () => {
  const r = root();
  const backlog = readFileSync(join(r.project, 'backlog.json'), 'utf8');
  const done = history('2026-10-03T10:00:00.000+0000', [statusItem('In Progress', 'Done')]);
  const started = history('2026-10-02T10:00:00.000+0000', [statusItem('To Do', 'In Progress')]);
  const { fetchFn, jqls, paths } = fakeFetch(u => {
    if (u.pathname === '/rest/api/3/search/jql') return { issues: [issue('PROJ-1', 'Done', [done], 2), issue('PROJ-2', 'To Do')], isLast: true };
    if (u.pathname === '/rest/api/3/issue/PROJ-1/changelog') return { values: [started, done], isLast: true };
    return SPRINTS;
  });
  const lines = [];
  const before = Date.now();
  const calls = await cycle(r, fetchFn, lines);
  assert.deepEqual(calls, ['ticket:sync', 'analytics:sync-tickets', 'analytics:sync-sprints', 'project:set-last-data-download']);
  assert.deepEqual(jqls, ['project = "PROJ" AND issuetype not in subTaskIssueTypes() ORDER BY created ASC']);
  assert.ok(paths.includes('/rest/agile/1.0/board/12/sprint'));
  const tickets = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  assert.ok(Date.parse(tickets['fetched-through']) >= before - 1000);
  assert.deepEqual(Object.keys(tickets.tickets), ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(tickets.tickets['PROJ-1'], {
    key: 'PROJ-1', title: 'Title PROJ-1', type: 'Bug', created: '2026-10-01T09:00:00.000Z', points: 2, assignee: null, status: 'Done', sprints: [41],
    'status-changes': [
      { at: '2026-10-02T10:00:00.000Z', from: 'To Do', to: 'In Progress', by: { id: 'acc-ada', name: 'Ada Example' } },
      { at: '2026-10-03T10:00:00.000Z', from: 'In Progress', to: 'Done', by: { id: 'acc-ada', name: 'Ada Example' } },
    ],
    'assignee-changes': [],
  });
  assert.deepEqual(JSON.parse(readFileSync(r.file('sprints.json'), 'utf8')), { sprints: [{ id: 41, name: 'S41', state: 'active', start: '2026-11-01T09:00:00.000Z', end: '2026-11-15T09:00:00.000Z' }] });
  assert.equal(readFileSync(join(r.project, 'backlog.json'), 'utf8'), backlog);
  assert.ok(lines.some(l => /analytics: 2 tickets read, all of them/.test(l)), lines.join('\n'));
});

test('ASS-406 AC1/AC2: a later read starts a few minutes before the last one\'s fetched-through; a ticket read again replaces its entry, the rest stay', async () => {
  const r = root();
  let answer = [issue('PROJ-1', 'To Do'), issue('PROJ-2', 'To Do')];
  const { fetchFn, jqls } = fakeFetch(u => (u.pathname === '/rest/api/3/search/jql' ? { issues: answer, isLast: true } : SPRINTS));
  await cycle(r, fetchFn);
  const first = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  answer = [issue('PROJ-1', 'In Progress', [history('2026-11-12T10:00:00.000+0000', [statusItem('To Do', 'In Progress')])])];
  const lines = [];
  await cycle(r, fetchFn, lines);
  const minutes = Number(/updated >= "-(\d+)m"/.exec(jqls[1])?.[1]);
  assert.ok(minutes >= ANALYTICS_OVERLAP_MS / 60_000 && minutes <= ANALYTICS_OVERLAP_MS / 60_000 + 2, jqls[1]);
  const since = new Date(Date.parse(first['fetched-through']) - ANALYTICS_OVERLAP_MS).toISOString();
  assert.ok(lines.some(l => l.includes(`analytics: 1 tickets updated since ${since}`)), lines.join('\n'));
  const second = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  assert.ok(second['fetched-through'] >= first['fetched-through']);
  assert.equal(second.tickets['PROJ-1'].status, 'In Progress');
  assert.equal(second.tickets['PROJ-1']['status-changes'].length, 1);
  assert.deepEqual(second.tickets['PROJ-2'], first.tickets['PROJ-2']);
});

test('ASS-406 AC5: a project without the credentials reads nothing, is logged once, and the cycle goes on', async () => {
  const r = root({ credentials: false });
  const { fetchFn, paths } = fakeFetch(() => SPRINTS);
  const lines = [];
  for (let i = 0; i < 2; i++) assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'project:set-last-data-download']);
  assert.deepEqual(paths, []);
  assert.equal(lines.filter(l => /analytics skipped: the jira work source has no api-email and api-token/.test(l)).length, 1, lines.join('\n'));
  assert.equal(existsSync(join(r.project, 'analytics')), false);
});

test('ASS-406 AC5: a read that fails is logged once until it changes, the files stay as they were, and the cycle goes on', async () => {
  const r = root();
  let fail = false;
  const { fetchFn } = fakeFetch(u => (fail ? 401 : u.pathname === '/rest/api/3/search/jql' ? { issues: [issue('PROJ-1', 'To Do')], isLast: true } : SPRINTS));
  await cycle(r, fetchFn);
  const tickets = readFileSync(r.file('tickets.json'), 'utf8'), sprints = readFileSync(r.file('sprints.json'), 'utf8');
  fail = true;
  const lines = [];
  for (let i = 0; i < 2; i++) assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'project:set-last-data-download']);
  assert.equal(lines.filter(l => /analytics: the tickets could not be read; tickets\.json stays as it is: HTTP 401/.test(l)).length, 1, lines.join('\n'));
  assert.equal(lines.filter(l => /analytics: the board's sprints could not be read; sprints\.json stays as it is: HTTP 401/.test(l)).length, 1, lines.join('\n'));
  assert.ok(lines.every(l => !/secret-token/.test(l)));
  assert.equal(readFileSync(r.file('tickets.json'), 'utf8'), tickets);
  assert.equal(readFileSync(r.file('sprints.json'), 'utf8'), sprints);
  // It reads again; a later failure is logged afresh.
  fail = false;
  assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'analytics:sync-tickets', 'analytics:sync-sprints', 'project:set-last-data-download']);
  fail = true;
  await cycle(r, fetchFn, lines);
  assert.equal(lines.filter(l => /tickets could not be read/.test(l)).length, 2);
});
