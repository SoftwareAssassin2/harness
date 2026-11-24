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
// fakeFetch(answer, myself?) — answer(url) gives the body (401 answers that);
// the sign-in check (/rest/api/3/myself, ASS-475) answers myself() instead,
// a signed-in account unless told otherwise. The JQLs asked are kept.
const SIGNED_IN = () => ({ accountId: 'acc-ada', displayName: 'Ada Example', accountType: 'atlassian' });
function fakeFetch(answer, myself = SIGNED_IN) {
  const jqls = [], paths = [];
  const fetchFn = async url => {
    const u = new URL(url);
    paths.push(u.pathname);
    const body = u.pathname === '/rest/api/3/myself' ? myself(u) : answer(u);
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
  assert.deepEqual(jqls, ['project = "PROJ" ORDER BY created ASC']);
  assert.equal(paths[0], '/rest/api/3/myself');   // ASS-475: the sign-in first
  assert.ok(paths.includes('/rest/agile/1.0/board/12/sprint'));
  const tickets = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  assert.ok(Date.parse(tickets['fetched-through']) >= before - 1000);
  assert.equal(tickets['includes-subtasks'], true);
  assert.deepEqual(Object.keys(tickets.tickets), ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(tickets.tickets['PROJ-1'], {
    key: 'PROJ-1', title: 'Title PROJ-1', type: 'Bug', created: '2026-10-01T09:00:00.000Z', points: 2, assignee: null, status: 'Done', 'status-category': null, sprints: [41],
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

test('ASS-440 AC1: a tickets.json read before sub-tasks were (no includes-subtasks) is read whole once, its sub-tasks added and its other data kept; later reads are incremental again', async () => {
  const r = root();
  mkdirSync(join(r.project, 'analytics'));
  const old = { key: 'PROJ-9', title: 'Gone from Jira', type: 'Story', created: '2026-09-01T09:00:00.000Z', points: 1, assignee: null, status: 'Done', sprints: [], 'status-changes': [], 'assignee-changes': [] };
  writeFileSync(r.file('tickets.json'), JSON.stringify({ 'fetched-through': new Date(Date.now() - 60_000).toISOString(), tickets: { 'PROJ-9': old } }));
  const sub = { ...issue('PROJ-3', 'Closed', [history('2026-11-02T10:00:00.000+0000', [statusItem('Open', 'Closed')])]) };
  sub.fields = { ...sub.fields, issuetype: { name: 'Sub-task', subtask: true }, parent: { key: 'PROJ-1' }, status: { name: 'Closed', statusCategory: { key: 'done' } } };
  const { fetchFn, jqls } = fakeFetch(u => (u.pathname === '/rest/api/3/search/jql' ? { issues: [issue('PROJ-1', 'To Do'), sub], isLast: true } : SPRINTS));
  const lines = [];
  await cycle(r, fetchFn, lines);
  assert.deepEqual(jqls, ['project = "PROJ" ORDER BY created ASC']);   // whole, though fetched-through was a minute ago
  assert.ok(lines.some(l => /analytics: 2 tickets read, all of them \(once, for the sub-tasks\)/.test(l)), lines.join('\n'));
  const file = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  assert.equal(file['includes-subtasks'], true);
  assert.deepEqual(Object.keys(file.tickets).sort(), ['PROJ-1', 'PROJ-3', 'PROJ-9']);
  assert.deepEqual(file.tickets['PROJ-9'], old);   // not read again: kept as it was
  assert.deepEqual([file.tickets['PROJ-3'].subtask, file.tickets['PROJ-3'].parent, file.tickets['PROJ-3']['status-category']], [true, 'PROJ-1', 'done']);
  // The marker stays: the next read is incremental, and keeps it.
  await cycle(r, fetchFn);
  assert.match(jqls[1], /AND updated >= "-\d+m"/);
  assert.equal(JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'))['includes-subtasks'], true);
});

// ASS-475: a rejected API token. Jira's search answers it as an anonymous
// user — 200, no issues — while /rest/api/3/myself answers 401.
const ANONYMOUS_SEARCH = { issues: [], isLast: true };

test('ASS-475 AC1/AC3: with a token Jira rejects, a round reads nothing, leaves tickets.json and its fetched-through untouched, never logs "0 tickets updated", records the warning for the dashboard and logs it once', async () => {
  const r = root();
  let rejected = false;
  const { fetchFn, paths } = fakeFetch(u => (rejected ? (u.pathname === '/rest/api/3/search/jql' ? ANONYMOUS_SEARCH : { values: [], isLast: true })
    : u.pathname === '/rest/api/3/search/jql' ? { issues: [issue('PROJ-1', 'To Do')], isLast: true } : SPRINTS), () => (rejected ? 401 : SIGNED_IN()));
  await cycle(r, fetchFn);
  const tickets = readFileSync(r.file('tickets.json'), 'utf8'), sprints = readFileSync(r.file('sprints.json'), 'utf8');
  rejected = true;
  paths.length = 0;
  const lines = [];
  assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'analytics:record-sign-in', 'project:set-last-data-download']);
  assert.deepEqual(paths, ['/rest/api/3/myself']);   // nothing searched, no sprints read
  assert.equal(readFileSync(r.file('tickets.json'), 'utf8'), tickets);
  assert.equal(readFileSync(r.file('sprints.json'), 'utf8'), sprints);
  const record = JSON.parse(readFileSync(join(r.project, 'jira-token-rejected.json'), 'utf8'));
  assert.equal(record.status, 401);
  assert.equal(record['work-source'], 'J');
  assert.match(record.problem, /HTTP 401/);
  assert.match(record.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // A second round: the same, logged once, the record not written again.
  assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'project:set-last-data-download']);
  assert.equal(readFileSync(r.file('tickets.json'), 'utf8'), tickets);
  assert.equal(lines.filter(l => /analytics: Jira rejected the jira work source's api-token \(HTTP 401 Unauthorized for \/rest\/api\/3\/myself\); nothing read, tickets\.json and its fetched-through stay/.test(l)).length, 1, lines.join('\n'));
  assert.ok(lines.every(l => !/tickets updated/.test(l) && !/secret-token/.test(l)), lines.join('\n'));
});

test('ASS-475 AC2: with the token fixed, the next round clears the warning and reads every ticket updated since the last good read', async () => {
  const r = root();
  let state = 'good', answer = [issue('PROJ-1', 'To Do')];
  const { fetchFn, jqls } = fakeFetch(u => (u.pathname === '/rest/api/3/search/jql' ? (state === 'bad' ? ANONYMOUS_SEARCH : { issues: answer, isLast: true }) : SPRINTS), () => (state === 'bad' ? 401 : SIGNED_IN()));
  await cycle(r, fetchFn);
  const good = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  // Back-date the last good read to two days ago: the rounds while the token was rejected must not move it.
  const lastGood = new Date(Date.now() - 2 * 86_400_000).toISOString();
  writeFileSync(r.file('tickets.json'), JSON.stringify({ ...good, 'fetched-through': lastGood }));
  state = 'bad';
  for (let i = 0; i < 3; i++) await cycle(r, fetchFn);
  assert.equal(JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'))['fetched-through'], lastGood);
  assert.ok(existsSync(join(r.project, 'jira-token-rejected.json')));
  state = 'good';
  answer = [issue('PROJ-1', 'Done'), issue('PROJ-2', 'In Progress')];
  const lines = [];
  const calls = await cycle(r, fetchFn, lines);
  assert.deepEqual(calls, ['ticket:sync', 'analytics:record-sign-in', 'analytics:sync-tickets', 'analytics:sync-sprints', 'project:set-last-data-download']);
  assert.equal(existsSync(join(r.project, 'jira-token-rejected.json')), false);
  // The search reaches back to the last good read (less the overlap), not to the rejected rounds.
  const minutes = Number(/updated >= "-(\d+)m"/.exec(jqls.at(-1))?.[1]);
  const wanted = (Date.now() - (Date.parse(lastGood) - ANALYTICS_OVERLAP_MS)) / 60_000;
  assert.ok(Math.abs(minutes - wanted) <= 2, `${jqls.at(-1)} vs ${wanted}`);
  const since = new Date(Date.parse(lastGood) - ANALYTICS_OVERLAP_MS).toISOString();
  assert.ok(lines.some(l => l.includes(`analytics: 2 tickets updated since ${since}`)), lines.join('\n'));
  assert.ok(lines.some(l => /Jira takes the jira work source's api-token again/.test(l)), lines.join('\n'));
  const after = JSON.parse(readFileSync(r.file('tickets.json'), 'utf8'));
  assert.deepEqual([after.tickets['PROJ-1'].status, after.tickets['PROJ-2'].status], ['Done', 'In Progress']);
  assert.ok(after['fetched-through'] > lastGood);
  // Signed in still: nothing to clear, no record-sign-in call.
  assert.deepEqual(await cycle(r, fetchFn), ['ticket:sync', 'analytics:sync-tickets', 'analytics:sync-sprints', 'project:set-last-data-download']);
});

test('ASS-475 AC3: /myself answering as an anonymous user, or a search Jira marks as a failed login, is a rejected token, never "0 tickets updated"', async () => {
  // /myself 200 with no account (an anonymous user).
  const r = root();
  const { fetchFn } = fakeFetch(u => (u.pathname === '/rest/api/3/search/jql' ? ANONYMOUS_SEARCH : SPRINTS), () => ({ accountType: 'anonymous' }));
  const lines = [];
  assert.deepEqual(await cycle(r, fetchFn, lines), ['ticket:sync', 'analytics:record-sign-in', 'project:set-last-data-download']);
  assert.equal(existsSync(r.file('tickets.json')), false);
  assert.equal(JSON.parse(readFileSync(join(r.project, 'jira-token-rejected.json'), 'utf8')).status, 200);
  assert.ok(lines.every(l => !/tickets updated|tickets read/.test(l)), lines.join('\n'));
  // A search answered 200 but marked AUTHENTICATED_FAILED (rejected after the check passed).
  const r2 = root();
  const seraph = async url => {
    const u = new URL(url);
    if (u.pathname === '/rest/api/3/myself') return { ok: true, status: 200, json: async () => SIGNED_IN() };
    return { ok: true, status: 200, headers: new Headers({ 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' }), json: async () => ANONYMOUS_SEARCH };
  };
  const lines2 = [];
  assert.deepEqual(await cycle(r2, seraph, lines2), ['ticket:sync', 'analytics:record-sign-in', 'project:set-last-data-download']);
  assert.equal(existsSync(r2.file('tickets.json')), false);
  assert.ok(lines2.some(l => /Jira rejected the jira work source's api-token \(HTTP 200 for \/rest\/api\/3\/search\/jql, the login failed\)/.test(l)), lines2.join('\n'));
  assert.ok(lines2.every(l => !/tickets updated|tickets read/.test(l)), lines2.join('\n'));
});

test('ASS-475: a sign-in check that fails another way (a 5xx) reads nothing, is logged once, and leaves no warning', async () => {
  const r = root();
  const { fetchFn, paths } = fakeFetch(() => SPRINTS, () => ({ status: 503 }));
  const down = async (url, init) => (new URL(url).pathname === '/rest/api/3/myself' ? { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) } : fetchFn(url, init));
  const lines = [];
  for (let i = 0; i < 2; i++) assert.deepEqual(await cycle(r, down, lines), ['ticket:sync', 'project:set-last-data-download']);
  assert.deepEqual(paths, []);
  assert.equal(lines.filter(l => /analytics: the Jira sign-in could not be checked; nothing read, tickets\.json stays as it is: HTTP 503/.test(l)).length, 1, lines.join('\n'));
  assert.equal(existsSync(join(r.project, 'jira-token-rejected.json')), false);
});

// ASS-561: the analytics' token from the keychain item the project's atlassian entry in vm-credentials.json names
// (HARNESS_HOME a folder of the test's; `security` answered by the cycle's exec), else project.json's api-token.
function harnessHome(declaration) {
  const home = mkdtempSync(join(tmpdir(), 'cycle-analytics-home-'));
  writeFileSync(join(home, 'vm-credentials.json'), JSON.stringify(declaration));
  return { ...process.env, HARNESS_HOME: home };
}
async function cycleWith(r, fetchFn, { env, keychain = {} }, lines = []) {
  const { calls, exec: base } = executor(r.dir);
  const asked = [];
  const exec = async (file, args) => {
    if (file !== 'security') return base(file, args);
    asked.push(args);
    if (!(args[2] in keychain)) throw Object.assign(new Error('security: item not found'), { code: 44 });
    return `${keychain[args[2]]}\n`;
  };
  await runCycle({ root: r.dir, project: 'p', now: new Date(), adapters: { jira, jiraRest }, exec, fetch: fetchFn, env, log: l => lines.push(l) });
  return { calls, asked };
}
const basicOf = (email, token) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
function authFetch() {
  const auths = [];
  const { fetchFn } = fakeFetch(u => (u.pathname === '/rest/api/3/search/jql' ? { issues: [], isLast: true } : SPRINTS));
  return { auths, fetchFn: async (url, opts) => { auths.push(opts?.headers?.Authorization); return fetchFn(url, opts); } };
}

test('ASS-561 AC4: with an atlassian entry the analytics sign in with its keychain item\'s token and its email, not project.json\'s', async () => {
  const r = root();   // project.json still holds secret-token: the keychain wins
  const env = harnessHome({ p: { atlassian: { 'keychain-service': 'Atlassian API Token (Test)', site: 'example.atlassian.net', email: 'kay@example.com' } } });
  const { auths, fetchFn } = authFetch();
  const lines = [];
  const { calls, asked } = await cycleWith(r, fetchFn, { env, keychain: { 'Atlassian API Token (Test)': 'keychain-token' } }, lines);
  assert.deepEqual(asked, [['find-generic-password', '-s', 'Atlassian API Token (Test)', '-w']]);
  assert.ok(auths.length > 0);
  assert.ok(auths.every(a => a === basicOf('kay@example.com', 'keychain-token')), 'every Jira call uses the keychain token');
  assert.ok(calls.includes('analytics:sync-tickets'));
  assert.ok(!lines.join('\n').includes('keychain-token'), 'the token is never logged');
});

test('ASS-561 AC4: with no atlassian entry the analytics use project.json\'s api-email and api-token, asking the keychain nothing', async () => {
  const r = root();
  const { auths, fetchFn } = authFetch();
  const { asked } = await cycleWith(r, fetchFn, { env: harnessHome({ p: { claude: { 'keychain-service': 'Claude' } } }) });
  assert.deepEqual(asked, []);
  assert.ok(auths.length > 0 && auths.every(a => a === basicOf('ada@example.com', 'secret-token')));
});

test('ASS-561 AC4/AC6: an atlassian entry whose keychain item is missing reads nothing (no fallback), logged once naming the item and project:set-atlassian-token', async () => {
  const r = root();
  const env = harnessHome({ p: { atlassian: { 'keychain-service': 'Atlassian API Token (Test)', site: 'example.atlassian.net', email: 'kay@example.com' } } });
  const { auths, fetchFn } = authFetch();
  const lines = [];
  for (let i = 0; i < 2; i++) await cycleWith(r, fetchFn, { env }, lines);
  assert.deepEqual(auths, []);
  assert.equal(lines.filter(l => l === 'analytics skipped: keychain item "Atlassian API Token (Test)" is missing — create a new Atlassian API token (id.atlassian.com, Security, API tokens), copy it, and run ./agent.sh project:set-atlassian-token p').length, 1, lines.join('\n'));
});

test('ASS-561 AC6: a rejected token\'s log names project:set-atlassian-token', async () => {
  const r = root();
  const { fetchFn } = fakeFetch(() => SPRINTS, () => 401);
  const lines = [];
  await cycle(r, fetchFn, lines);
  assert.ok(lines.some(l => /Jira rejected the jira work source's api-token .* run \.\/agent\.sh project:set-atlassian-token p$/.test(l)), lines.join('\n'));
});
