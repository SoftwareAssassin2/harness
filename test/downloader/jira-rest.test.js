// The Jira REST reader for analytics (ASS-406): every ticket of the board's
// project with its full changelog, and the board's sprints — with a fake
// fetch that answers canned pages and records what it was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAnalyticsTickets, fetchBoardSprints, analyticsTicket } from '../../src/downloader/jira-rest.js';

const AUTH = { site: 'https://example.atlassian.net', email: 'ada@example.com', token: 'secret-token' };
const ada = { accountId: 'acc-ada', displayName: 'Ada Example' };
const bob = { accountId: 'acc-bob', displayName: 'Bob Example' };

// fakeFetch(route) — route(url) gives the JSON body (or { status } for a failure); every URL asked and its headers are kept.
function fakeFetch(route) {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    asked.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init?.headers ?? {} });
    const body = route(u);
    if (body?.status) return { ok: false, status: body.status, statusText: body.statusText ?? '', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { asked, fetchFn };
}
const history = (created, author, ...items) => ({ id: created, created, author, items });
const status = (from, to) => ({ field: 'status', fieldtype: 'jira', fieldId: 'status', from: '1', fromString: from, to: '2', toString: to });
const assignee = (from, to) => ({ field: 'assignee', fieldtype: 'jira', fieldId: 'assignee', from: from?.accountId ?? null, fromString: from?.displayName ?? null, to: to?.accountId ?? null, toString: to?.displayName ?? null });
const issue = (key, histories, total = histories.length, extra = {}) => ({
  key,
  fields: {
    summary: `Title ${key}`, status: { name: 'In Progress' }, assignee: ada, issuetype: { name: 'Story' },
    created: '2026-10-01T09:00:00.000+0000', customfield_10028: 3, customfield_10020: [{ id: 41, name: 'Sprint 1' }, { id: 42, name: 'Sprint 2' }], ...extra,
  },
  changelog: { startAt: 0, maxResults: histories.length, total, histories },
});

test('ASS-406 AC1: a first read searches every ticket of the project (sub-tasks left out, no updated clause) with its changelog, page by page, with basic auth', async () => {
  const { asked, fetchFn } = fakeFetch(u => (u.searchParams.get('nextPageToken') === 'p2'
    ? { issues: [issue('PROJ-2', [])], isLast: true }
    : { issues: [issue('PROJ-1', [])], nextPageToken: 'p2', isLast: false }));
  const tickets = await fetchAnalyticsTickets({ ...AUTH, projectKey: 'PROJ', storyPointsField: 'customfield_10028', sprintField: 'customfield_10020' }, fetchFn);
  assert.deepEqual(tickets.map(t => t.key), ['PROJ-1', 'PROJ-2']);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].path, '/rest/api/3/search/jql');
  assert.equal(asked[0].params.jql, 'project = "PROJ" AND issuetype not in subTaskIssueTypes() ORDER BY created ASC');
  assert.equal(asked[0].params.expand, 'changelog');
  assert.equal(asked[0].params.maxResults, '100');
  assert.equal(asked[0].params.fields, 'summary,status,assignee,issuetype,created,customfield_10028,customfield_10020');
  assert.equal(asked[0].params.nextPageToken, undefined);
  assert.equal(asked[1].params.nextPageToken, 'p2');
  assert.equal(asked[0].headers.Authorization, `Basic ${Buffer.from('ada@example.com:secret-token').toString('base64')}`);
});

test('ASS-406 AC1: with since, only tickets updated in the minutes since then, relative to Jira\'s clock', async () => {
  const { asked, fetchFn } = fakeFetch(() => ({ issues: [], isLast: true }));
  const now = Date.parse('2026-11-12T12:00:00Z');
  await fetchAnalyticsTickets({ ...AUTH, projectKey: 'PROJ', since: '2026-11-12T11:30:30Z', now }, fetchFn);
  assert.equal(asked[0].params.jql, 'project = "PROJ" AND issuetype not in subTaskIssueTypes() AND updated >= "-30m" ORDER BY created ASC');
  // An unreadable since is a first read.
  await fetchAnalyticsTickets({ ...AUTH, projectKey: 'PROJ', since: 'never', now }, fetchFn);
  assert.doesNotMatch(asked[1].params.jql, /updated/);
});

test('ASS-406 AC1: a changelog the search truncated is completed from the issue\'s changelog, every page', async () => {
  const early = history('2026-10-02T10:00:00.000+0000', ada, status('To Do', 'In Progress'));
  const mid = history('2026-10-03T10:00:00.000+0000', bob, assignee(ada, bob));
  const late = history('2026-10-04T10:00:00.000+0000', bob, status('In Progress', 'Done'));
  const { asked, fetchFn } = fakeFetch(u => {
    if (u.pathname === '/rest/api/3/search/jql') return { issues: [issue('PROJ-1', [late], 3), issue('PROJ-2', [])], isLast: true };
    return u.searchParams.get('startAt') === '0' ? { values: [early, mid], isLast: false } : { values: [late], isLast: true };
  });
  const [one, two] = await fetchAnalyticsTickets({ ...AUTH, projectKey: 'PROJ' }, fetchFn);
  assert.deepEqual(asked.slice(1).map(a => [a.path, a.params.startAt, a.params.maxResults]), [
    ['/rest/api/3/issue/PROJ-1/changelog', '0', '100'], ['/rest/api/3/issue/PROJ-1/changelog', '2', '100'],
  ]);   // PROJ-2's changelog was whole: not asked for
  assert.deepEqual(one['status-changes'], [
    { at: '2026-10-02T10:00:00.000Z', from: 'To Do', to: 'In Progress', by: { id: 'acc-ada', name: 'Ada Example' } },
    { at: '2026-10-04T10:00:00.000Z', from: 'In Progress', to: 'Done', by: { id: 'acc-bob', name: 'Bob Example' } },
  ]);
  assert.deepEqual(one['assignee-changes'], [{ at: '2026-10-03T10:00:00.000Z', from: { id: 'acc-ada', name: 'Ada Example' }, to: { id: 'acc-bob', name: 'Bob Example' } }]);
  assert.deepEqual(two['status-changes'], []);
});

test('ASS-406 AC2: a ticket maps to key, title, type, created, points, assignee, status, sprints and its changes in time order', () => {
  const t = analyticsTicket(issue('PROJ-7', [
    history('2026-10-05T10:00:00.000-0500', null, status('In Progress', 'Done')),
    history('2026-10-02T10:00:00.000+0000', ada, assignee(null, ada), { field: 'labels', fromString: '', toString: 'x' }),
    history('2026-10-03T10:00:00.000+0000', ada, assignee(ada, null)),
  ], 3, { customfield_10028: null, assignee: null }), 'customfield_10028', 'customfield_10020');
  assert.deepEqual(t, {
    key: 'PROJ-7', title: 'Title PROJ-7', type: 'Story', created: '2026-10-01T09:00:00.000Z', points: null, assignee: null, status: 'In Progress', sprints: [41, 42],
    'status-changes': [{ at: '2026-10-05T15:00:00.000Z', from: 'In Progress', to: 'Done', by: null }],
    'assignee-changes': [
      { at: '2026-10-02T10:00:00.000Z', from: null, to: { id: 'acc-ada', name: 'Ada Example' } },
      { at: '2026-10-03T10:00:00.000Z', from: { id: 'acc-ada', name: 'Ada Example' }, to: null },
    ],
  });
  // Points as a number; no sprint field, no sprints; an item without fromString/toString gives null, not Object's toString.
  const u = analyticsTicket({ key: 'PROJ-8', fields: { customfield_10016: 5 }, changelog: { histories: [history('2026-10-02T10:00:00Z', ada, { field: 'status', fieldId: 'status' })] } });
  assert.equal(u.points, 5);
  assert.deepEqual(u.sprints, []);
  assert.deepEqual(u['status-changes'], [{ at: '2026-10-02T10:00:00.000Z', from: null, to: null, by: { id: 'acc-ada', name: 'Ada Example' } }]);
});

test('ASS-406 AC3: the board\'s sprints of every state, page by page, in start order with the undated last', async () => {
  const { asked, fetchFn } = fakeFetch(u => (u.searchParams.get('startAt') === '0'
    ? { values: [{ id: 3, name: 'S3', state: 'future' }, { id: 2, name: 'S2', state: 'active', startDate: '2026-10-15T09:00:00.000Z', endDate: '2026-10-29T09:00:00.000Z' }], isLast: false }
    : { values: [{ id: 1, name: 'S1', state: 'closed', startDate: '2026-10-01T09:00:00.000Z', endDate: '2026-10-15T09:00:00.000Z' }], isLast: true }));
  const sprints = await fetchBoardSprints({ ...AUTH, boardId: 12 }, fetchFn);
  assert.deepEqual(asked.map(a => [a.path, a.params.state, a.params.startAt, a.params.maxResults]), [
    ['/rest/agile/1.0/board/12/sprint', 'active,closed,future', '0', '50'], ['/rest/agile/1.0/board/12/sprint', 'active,closed,future', '2', '50'],
  ]);
  assert.deepEqual(sprints, [
    { id: 1, name: 'S1', state: 'closed', start: '2026-10-01T09:00:00.000Z', end: '2026-10-15T09:00:00.000Z' },
    { id: 2, name: 'S2', state: 'active', start: '2026-10-15T09:00:00.000Z', end: '2026-10-29T09:00:00.000Z' },
    { id: 3, name: 'S3', state: 'future', start: null, end: null },
  ]);
});

test('ASS-406 AC5: a response that is not ok throws, naming the status and path but never the credentials', async () => {
  const { fetchFn } = fakeFetch(() => ({ status: 401, statusText: 'Unauthorized' }));
  await assert.rejects(fetchAnalyticsTickets({ ...AUTH, projectKey: 'PROJ' }, fetchFn), err => {
    assert.match(err.message, /HTTP 401 Unauthorized for \/rest\/api\/3\/search\/jql/);
    assert.doesNotMatch(err.message, /secret-token|ada@example\.com/);
    return true;
  });
  await assert.rejects(fetchBoardSprints({ ...AUTH, boardId: 12 }, fetchFn), /HTTP 401/);
});
