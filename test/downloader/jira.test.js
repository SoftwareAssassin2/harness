// The Jira adapter: acli's work-item search mapped to the sprint's ticket shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardUrl, fetchSprintTickets, fetchBacklogTickets, fetchComments, fetchActiveSprints } from '../../src/downloader/jira.js';

const board = { site: 'https://x.atlassian.net', projectKey: 'EX', boardId: 5205 };

// An issue as acli --json returns it (the REST shape: key + fields).
const issue = (key, fields = {}) => ({
  key, id: '1', self: `https://x.atlassian.net/rest/api/3/issue/${key}`,
  fields: {
    summary: `Summary ${key}`, description: `Plain ${key}`,
    status: { name: 'In Progress' }, priority: { name: 'High' }, assignee: { displayName: 'Ann Lee' },
    issuetype: { name: 'Story' }, customfield_10016: 5, issuelinks: [], sprint: { id: 1, name: 'Sprint 10' },
    created: '2026-10-01T00:00:00.000+0000', updated: '2026-10-09T00:00:00.000+0000', ...fields,
  },
});
// A fake acli: records the call, answers with the issues.
const acli = (issues, calls = []) => ({ calls, run: async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify(issues); } });

test('parseBoardUrl reads site, project key and board id from a company-managed board url', () => {
  assert.deepEqual(parseBoardUrl('https://example.atlassian.net/jira/software/c/projects/EX/boards/5205'), { site: 'https://example.atlassian.net', projectKey: 'EX', boardId: 5205 });
  assert.deepEqual(parseBoardUrl('https://x.atlassian.net/jira/software/projects/AB2/boards/7/backlog?x=1'), { site: 'https://x.atlassian.net', projectKey: 'AB2', boardId: 7 });
  assert.throws(() => parseBoardUrl('https://x.atlassian.net/browse/EX-1'), /board url/);
});

test('fetchSprintTickets searches the sprint with acli and maps each issue to the ticket shape', async () => {
  const fake = acli([issue('EX-1', {
    issuelinks: [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'EX-7' } },
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'EX-8' } },
      { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'EX-9' } },
    ],
  })]);
  const tickets = await fetchSprintTickets({ ...board, sprintId: 13422, sprintName: 'Sprint 10' }, fake.run);
  assert.deepEqual(fake.calls, [['acli', 'jira', 'workitem', 'search', '--jql', 'sprint = 13422 AND assignee = currentUser() AND issuetype not in subTaskIssueTypes()', '--fields', 'key,summary,description,status,priority,assignee,issuetype', '--paginate', '--json']]);
  assert.deepEqual(tickets, [{
    key: 'EX-1', title: 'Summary EX-1', description: 'Plain EX-1', url: 'https://x.atlassian.net/browse/EX-1',
    'ticket-system-status': 'In Progress', 'ticket-system-priority': 'High', 'ticket-system-assignment': 'Ann Lee',
    points: 5, 'issue-type': 'Story', dependencies: ['EX-7'], 'sprint-tag': 'Sprint 10',
  }]);
});

test('fetchSprintTickets flattens an ADF description, reads the site\'s story-points field, takes the last sprint of a list and maps types and missing values', async () => {
  const adf = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First ' }, { type: 'text', text: 'line.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
  ] };
  const fake = acli([
    issue('EX-2', { description: adf, issuetype: { name: 'Bug' }, customfield_10016: null, customfield_10028: 3, assignee: null, priority: null, sprint: [{ name: 'Sprint 9' }, { name: 'Sprint 10' }] }),
    issue('EX-3', { description: null, issuetype: { name: 'Task' }, customfield_10028: undefined, sprint: null, issuelinks: undefined }),
    issue('EX-4', { issuetype: { name: 'Spike' } }),
  ]);
  const tickets = await fetchSprintTickets({ ...board, sprintId: 10, storyPointsField: 'customfield_10028' }, fake.run);
  assert.doesNotMatch(fake.calls[0].join(' '), /customfield/);   // acli's search takes no custom field; the value is read when it comes anyway
  assert.doesNotMatch(fake.calls[0].join(' '), /customfield_10016/);
  assert.deepEqual(tickets.map(t => [t.key, t.description, t['issue-type'], t.points, t['ticket-system-assignment'], t['ticket-system-priority'], t['sprint-tag'], t.dependencies]), [
    ['EX-2', 'First line.\nItem', 'Bug', 3, null, null, 'Sprint 10', []],
    ['EX-3', '', 'Story', null, 'Ann Lee', 'High', null, []],
    ['EX-4', 'Plain EX-4', 'Spike', null, 'Ann Lee', 'High', 'Sprint 10', []],
  ]);
});

test('fetchBacklogTickets searches the backlog, accepts the wrapped { issues } shape, and an empty answer', async () => {
  const calls = [];
  const run = async (cmd, args) => { calls.push(args); return JSON.stringify({ issues: [issue('EX-5')], total: 1 }); };
  const tickets = await fetchBacklogTickets(board, run);
  assert.equal(calls[0][calls[0].indexOf('--jql') + 1], 'project = EX AND assignee = currentUser() AND statusCategory != Done AND (sprint in futureSprints() OR sprint is EMPTY)');
  assert.deepEqual(tickets.map(t => t.key), ['EX-5']);
  assert.deepEqual(await fetchBacklogTickets(board, async () => ''), []);
  await assert.rejects(fetchBacklogTickets(board, async () => 'not json'), /acli/);
});

test('fetchSprintTickets without a Jira sprint id takes the open sprint; the sprint name given tags a ticket acli returns no sprint for', async () => {
  const fake = acli([issue('EX-4', { sprint: undefined, customfield_10016: undefined, issuelinks: undefined })]);
  const tickets = await fetchSprintTickets({ ...board, sprintName: 'EX Sprint 11 - Beta' }, fake.run);
  assert.equal(fake.calls[0][fake.calls[0].indexOf('--jql') + 1], 'project = EX AND assignee = currentUser() AND sprint in openSprints() AND issuetype not in subTaskIssueTypes()');
  assert.deepEqual(tickets.map(t => [t.key, t['sprint-tag'], t.points, t.dependencies]), [['EX-4', 'EX Sprint 11 - Beta', null, []]]);
});

test('fetchComments lists a ticket\'s comments with acli, every page, as { id, author, created, updated, body } with an ADF body flattened; wrapped, bare or empty output', async () => {
  const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks ' }, { type: 'text', text: 'good.' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Ship it.' }] }] };
  const rest = { id: '10001', author: { accountId: 'a1', displayName: 'Ann Lee' }, body: adf, created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T11:00:00.000+0000' };
  const calls = [];
  const comments = await fetchComments({ key: 'EX-1' }, async (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify({ comments: [rest, { id: 10002, author: 'Bo', body: 'Plain' }], total: 2 }); });
  assert.deepEqual(calls, [['acli', 'jira', 'workitem', 'comment', 'list', '--key', 'EX-1', '--paginate', '--json']]);
  assert.deepEqual(comments, [
    { id: '10001', author: 'Ann Lee', created: '2026-10-14T10:00:00.000+0000', updated: '2026-10-14T11:00:00.000+0000', body: 'Looks good.\nShip it.' },
    { id: '10002', author: 'Bo', created: null, updated: null, body: 'Plain' },
  ]);
  assert.deepEqual((await fetchComments({ key: 'EX-1' }, async () => JSON.stringify([rest]))).map(c => c.id), ['10001']);
  assert.deepEqual(await fetchComments({ key: 'EX-1' }, async () => ''), []);
  await assert.rejects(fetchComments({ key: 'EX-1' }, async () => 'not json'), /acli/);
});

test('fetchComments reads acli as it really prints with --paginate (checked live 2026-10-14): one JSON object per page, back to back, raw newlines inside strings', async () => {
  const out = '{\n  "comments": [\n    { "author": "Ann Lee", "body": "Line one\nline two", "id": "541894", "visibility": "public" }\n  ],\n  "isLast": false, "startAt": 0, "total": 2\n}\n'
    + '{\n  "comments": [{ "author": "Bo", "body": "Tab\there", "id": "541895", "visibility": "public" }],\n  "isLast": true, "startAt": 50, "total": 2\n}\n';
  assert.deepEqual(await fetchComments({ key: 'EX-843' }, async () => out), [
    { id: '541894', author: 'Ann Lee', created: null, updated: null, body: 'Line one\nline two' },
    { id: '541895', author: 'Bo', created: null, updated: null, body: 'Tab\there' },
  ]);
});

// ASS-152 AC1: acli's search refuses custom fields, so a ticket whose search
// result lacks the work source's story-points field has it read with
// `acli jira workitem view <key> --fields <field> --json`.
test('a ticket whose search result lacks the story-points field has it read with acli\'s view, on the field the work source names (ASS-152 AC1)', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[2] === 'search') return JSON.stringify([issue('EX-1201', { customfield_10016: undefined }), issue('EX-2368', { customfield_10016: undefined }), issue('EX-7', { customfield_10024: 2 })]);
    const points = { 'EX-1201': 8, 'EX-2368': null }[args[3]];
    return JSON.stringify({ key: args[3], fields: { customfield_10024: points } });
  };
  const tickets = await fetchBacklogTickets({ ...board, storyPointsField: 'customfield_10024' }, run);
  assert.deepEqual(calls.slice(1), [
    ['acli', 'jira', 'workitem', 'view', 'EX-1201', '--fields', 'customfield_10024', '--json'],
    ['acli', 'jira', 'workitem', 'view', 'EX-2368', '--fields', 'customfield_10024', '--json'],
  ]);   // EX-7's search result carried the field: no view
  assert.deepEqual(tickets.map(t => [t.key, t.points]), [['EX-1201', 8], ['EX-2368', null], ['EX-7', 2]]);
});

test('a view that fails leaves the ticket\'s points out — unread, not null — so sync keeps what the harness has (ASS-152 AC1, AC3)', async () => {
  const run = async (cmd, args) => {
    if (args[2] === 'search') return JSON.stringify([issue('EX-1', { customfield_10016: undefined })]);
    throw new Error('acli: 503');
  };
  const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, run);
  assert.equal('points' in ticket, false);
  assert.equal(ticket.key, 'EX-1');
});

test('fetchActiveSprints lists the board\'s active sprints with acli as { id, name, start, end }, the dates Jira\'s startDate and endDate as YYYY-MM-DD (UTC); an empty answer is none (ASS-165)', async () => {
  const fake = acli([{ id: 13423, name: 'EX Sprint 12', state: 'active', startDate: '2026-10-17T00:03:40.303Z', endDate: '2026-10-31T00:03:06.000Z' }, { id: 9, name: 'Undated', state: 'active' }]);
  assert.deepEqual(await fetchActiveSprints(board, fake.run), [{ id: 13423, name: 'EX Sprint 12', start: '2026-10-17', end: '2026-10-31' }, { id: 9, name: 'Undated', start: null, end: null }]);
  assert.deepEqual(fake.calls, [['acli', 'jira', 'board', 'list-sprints', '--id', '5205', '--state', 'active', '--json']]);
  assert.deepEqual(await fetchActiveSprints(board, async () => ''), []);
  assert.deepEqual(await fetchActiveSprints(board, async () => '[]'), []);
});
