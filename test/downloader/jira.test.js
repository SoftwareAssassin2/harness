// The Jira adapter: acli's work-item search mapped to the sprint's ticket shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoardUrl, fetchSprintTickets, fetchBacklogTickets, fetchComments, fetchActiveSprints, fetchTicketsByKey, fetchSignedInAccountId } from '../../src/downloader/jira.js';

const board = { site: 'https://x.atlassian.net', projectKey: 'EX', boardId: 5205 };

// An issue as acli --json returns it (the REST shape: key + fields).
const issue = (key, fields = {}) => ({
  key, id: '1', self: `https://x.atlassian.net/rest/api/3/issue/${key}`,
  fields: {
    summary: `Summary ${key}`, description: `Plain ${key}`,
    status: { name: 'In Progress' }, priority: { name: 'High' }, assignee: { accountId: 'acc-ann', displayName: 'Ann Lee' },
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
    'ticket-system-status': 'In Progress', 'ticket-system-priority': 'High', 'ticket-system-assignment': 'Ann Lee', 'ticket-system-assignment-id': 'acc-ann',
    points: 5, 'issue-type': 'Story', dependencies: ['EX-7'], 'sprint-tag': 'Sprint 10',
  }]);
});

test('fetchSprintTickets flattens an ADF description, reads the site\'s story-points field, takes the last sprint of a list and maps types and missing values', async () => {
  const adf = { type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First ' }, { type: 'text', text: 'line.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
  ] };
  const issues = [
    issue('EX-2', { description: adf, issuetype: { name: 'Bug' }, customfield_10016: null, customfield_10028: 3, assignee: null, priority: null, sprint: [{ name: 'Sprint 9' }, { name: 'Sprint 10' }] }),
    issue('EX-3', { description: null, issuetype: { name: 'Task' }, customfield_10028: undefined, sprint: null, issuelinks: undefined }),
    issue('EX-4', { issuetype: { name: 'Spike' }, customfield_10028: null }),
  ];
  const fake = { calls: [], run: async (cmd, args) => { fake.calls.push([cmd, ...args]); return args[2] === 'search' ? JSON.stringify(issues) : JSON.stringify({ key: args[3], fields: {} }); } };
  const tickets = await fetchSprintTickets({ ...board, sprintId: 10, storyPointsField: 'customfield_10028' }, fake.run);
  assert.deepEqual(fake.calls.slice(1), [['acli', 'jira', 'workitem', 'view', 'EX-3', '--fields', 'customfield_10028,issuelinks', '--json']]);   // EX-2, EX-4 carried both fields: no view (ASS-322)
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
    if (args[2] === 'search') return JSON.stringify([issue('EX-1201', { customfield_10016: undefined, issuelinks: undefined }), issue('EX-2368', { customfield_10016: undefined, issuelinks: undefined }), issue('EX-7', { customfield_10024: 2, issuelinks: undefined })]);
    const points = { 'EX-1201': 8, 'EX-2368': null, 'EX-7': 9 }[args[3]];
    return JSON.stringify({ key: args[3], fields: { customfield_10024: points, issuelinks: [] } });
  };
  const tickets = await fetchBacklogTickets({ ...board, storyPointsField: 'customfield_10024' }, run);
  assert.deepEqual(calls.slice(1), [
    ['acli', 'jira', 'workitem', 'view', 'EX-1201', '--fields', 'customfield_10024,issuelinks', '--json'],
    ['acli', 'jira', 'workitem', 'view', 'EX-2368', '--fields', 'customfield_10024,issuelinks', '--json'],
    ['acli', 'jira', 'workitem', 'view', 'EX-7', '--fields', 'customfield_10024,issuelinks', '--json'],
  ]);   // EX-7's search result carried the points but not the links: viewed for the links (ASS-322)
  assert.deepEqual(tickets.map(t => [t.key, t.points, t.dependencies]), [['EX-1201', 8, []], ['EX-2368', null, []], ['EX-7', 2, []]]);   // the search's points kept, not the view's
});

test('a view that fails leaves the ticket\'s points out — unread, not null — so sync keeps what the harness has (ASS-152 AC1, AC3)', async () => {
  const run = async (cmd, args) => {
    if (args[2] === 'search') return JSON.stringify([issue('EX-1', { customfield_10016: undefined, issuelinks: undefined })]);
    throw new Error('acli: 503');
  };
  const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, run);
  assert.equal('points' in ticket, false);
  assert.equal('dependencies' in ticket, false);   // ASS-322 AC3: links unread too
  assert.equal(ticket.key, 'EX-1');
});

// ASS-322: acli's search returns no issuelinks, so a ticket's "is blocked by"
// links are read in the same per-ticket view as its story points.
const LINKS = [
  { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'EX-7' } },
  { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'EX-8' } },
  { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'EX-9' } },
];

test('a ticket whose search result lacks issuelinks has its inward "is blocked by" links read as dependencies, in the one view that reads its points (ASS-322 AC1, AC2)', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[2] === 'search') return JSON.stringify([issue('EX-1', { customfield_10016: undefined, issuelinks: undefined })]);
    return JSON.stringify({ key: args[3], fields: { customfield_10016: 5, issuelinks: LINKS } });
  };
  const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, run);
  assert.deepEqual(calls.slice(1), [['acli', 'jira', 'workitem', 'view', 'EX-1', '--fields', 'customfield_10016,issuelinks', '--json']]);   // one view, both fields
  assert.deepEqual(ticket.dependencies, ['EX-7']);   // not outward "blocks", not "relates to"
  assert.equal(ticket.points, 5);
});

test('a ticket whose search result carries both the story-points field and issuelinks is not viewed (ASS-322 AC2)', async () => {
  const fake = acli([issue('EX-1', { issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'EX-9' } }] })]);
  const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, fake.run);
  assert.equal(fake.calls.length, 1);   // the search only
  assert.deepEqual([ticket.dependencies, ticket.points], [['EX-9'], 5]);
});

for (const [what, out] of [['prints nothing', ''], ['prints no JSON', 'not json']]) {
  test(`a view that ${what} leaves the ticket's points and dependencies out — unread (ASS-322 AC3)`, async () => {
    const run = async (cmd, args) => args[2] === 'search' ? JSON.stringify([issue('EX-1', { customfield_10016: undefined, issuelinks: undefined })]) : out;
    const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, run);
    assert.equal('points' in ticket, false);
    assert.equal('dependencies' in ticket, false);
  });
}

test('a view that fails leaves out only what the search lacked: links the search carried are kept (ASS-322 AC3)', async () => {
  const run = async (cmd, args) => {
    if (args[2] === 'search') return JSON.stringify([issue('EX-1', { customfield_10016: undefined, issuelinks: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'EX-9' } }] })]);
    throw new Error('acli: 503');
  };
  const [ticket] = await fetchSprintTickets({ ...board, sprintId: 1 }, run);
  assert.equal('points' in ticket, false);
  assert.deepEqual(ticket.dependencies, ['EX-9']);
});

test('fetchActiveSprints lists the board\'s active sprints with acli as { id, name, start, end }, the dates Jira\'s startDate and endDate as YYYY-MM-DD (UTC); an empty answer is none (ASS-165)', async () => {
  const fake = acli([{ id: 13423, name: 'EX Sprint 12', state: 'active', startDate: '2026-10-17T00:03:40.303Z', endDate: '2026-10-31T00:03:06.000Z' }, { id: 9, name: 'Undated', state: 'active' }]);
  assert.deepEqual(await fetchActiveSprints(board, fake.run), [{ id: 13423, name: 'EX Sprint 12', start: '2026-10-17', end: '2026-10-31' }, { id: 9, name: 'Undated', start: null, end: null }]);
  assert.deepEqual(fake.calls, [['acli', 'jira', 'board', 'list-sprints', '--id', '5205', '--state', 'active', '--json']]);
  assert.deepEqual(await fetchActiveSprints(board, async () => ''), []);
  assert.deepEqual(await fetchActiveSprints(board, async () => '[]'), []);
});

// ASS-344: reassigned tickets, read by key; the assignee's account id; the signed-in account.
// A fake acli for by-key searches: answers each `key in (…)` search with the issues it names that `issues` holds,
// failing a search that names a key in `gone` (as Jira fails a JQL naming a key it cannot return).
function byKey(issues, gone = []) {
  const calls = [];
  return { calls, run: async (cmd, args) => {
    calls.push([cmd, ...args]);
    const jql = args[args.indexOf('--jql') + 1];
    const keys = /^key in \((.*)\)$/.exec(jql)[1].split(', ');
    if (keys.some(k => gone.includes(k))) throw new Error(`An issue with key '${keys.find(k => gone.includes(k))}' does not exist for field 'key'.`);
    return JSON.stringify(issues.filter(i => keys.includes(i.key)));
  } };
}

test('ASS-344 AC1: a ticket carries its assignee\'s account id beside the display name; fetchTicketsByKey reads tickets whoever holds them, `key in (…)`', async () => {
  const fake = byKey([issue('EX-3', { assignee: { accountId: 'acc-bea', displayName: 'Bea Other' } })]);
  const tickets = await fetchTicketsByKey({ ...board, keys: ['EX-3'] }, fake.run);
  assert.deepEqual(fake.calls, [['acli', 'jira', 'workitem', 'search', '--jql', 'key in (EX-3)', '--fields', 'key,summary,description,status,priority,assignee,issuetype', '--paginate', '--json']]);
  assert.doesNotMatch(fake.calls[0].join(' '), /currentUser/);
  assert.deepEqual(tickets.map(t => [t.key, t['ticket-system-assignment'], t['ticket-system-assignment-id'], t['ticket-system-status'], t.url]), [['EX-3', 'Bea Other', 'acc-bea', 'In Progress', 'https://x.atlassian.net/browse/EX-3']]);
});

test('ASS-344 AC2: an unassigned ticket has both its assignee fields null', async () => {
  const [ticket] = await fetchTicketsByKey({ ...board, keys: ['EX-4'] }, byKey([issue('EX-4', { assignee: null })]).run);
  assert.deepEqual([ticket['ticket-system-assignment'], ticket['ticket-system-assignment-id']], [null, null]);
  const [named] = await fetchTicketsByKey({ ...board, keys: ['EX-5'] }, byKey([issue('EX-5', { assignee: { displayName: 'No Id' } })]).run);
  assert.deepEqual([named['ticket-system-assignment'], named['ticket-system-assignment-id']], ['No Id', null]);   // an id missing or not an account id is null, not invented
});

test('ASS-344 AC3: a key the by-key search cannot return is left out, never thrown: a batch Jira fails is asked again a key at a time; a ticket answering with another key (moved) is not taken', async () => {
  const fake = byKey([issue('EX-1'), issue('EX-2'), issue('OTHER-9')], ['EX-7']);
  const tickets = await fetchTicketsByKey({ ...board, keys: ['EX-1', 'EX-7', 'EX-2', 'EX-8'] }, fake.run);
  assert.deepEqual(tickets.map(t => t.key), ['EX-1', 'EX-2']);   // EX-7 fails, EX-8 not returned
  assert.deepEqual(fake.calls.map(c => c[c.indexOf('--jql') + 1]), ['key in (EX-1, EX-7, EX-2, EX-8)', 'key in (EX-1)', 'key in (EX-7)', 'key in (EX-2)', 'key in (EX-8)']);
  const moved = { calls: [], run: async () => JSON.stringify([issue('NEW-1')]) };
  assert.deepEqual(await fetchTicketsByKey({ ...board, keys: ['EX-1'] }, moved.run), []);
  assert.deepEqual(await fetchTicketsByKey({ ...board, keys: ['EX-1'] }, async () => { throw new Error('acli: 401'); }), []);
});

test('ASS-344 AC4: fetchTicketsByKey asks in batches of 50, each key once; no keys (or none a Jira key), no acli call', async () => {
  const keys = Array.from({ length: 51 }, (_, i) => `EX-${i + 1}`);
  const fake = byKey(keys.map(k => issue(k)));
  const tickets = await fetchTicketsByKey({ ...board, keys: [...keys, 'ex-1'] }, fake.run);
  assert.equal(tickets.length, 51);
  assert.deepEqual(fake.calls.map(c => c[c.indexOf('--jql') + 1].split(', ').length), [50, 1]);
  const none = byKey([]);
  assert.deepEqual(await fetchTicketsByKey({ ...board, keys: [] }, none.run), []);
  assert.deepEqual(await fetchTicketsByKey({ ...board, keys: ['EX-1) OR (project = X', ''] }, none.run), []);
  assert.deepEqual(none.calls, []);
});

test('ASS-344: fetchSignedInAccountId reads the account id from acli jira auth status, JSON or text; without one, from the newest ticket assigned to currentUser(); null when neither tells', async () => {
  const fake = answers => { const calls = []; return { calls, run: async (cmd, args) => { calls.push([cmd, ...args]); const a = answers[args.slice(0, 3).join(' ')]; if (a instanceof Error) throw a; return a ?? ''; } }; };
  for (const status of ['{"site":"x.atlassian.net","accountId":"acc-me"}', '{"user":{"account_id":"acc-me"}}', '\u001b[32m✓\u001b[0m Authenticated\n  Site: x.atlassian.net\n  Email: me@example.com\n  Account ID: acc-me\n', 'account-id=acc-me']) {
    const f = fake({ 'jira auth status': status });
    assert.equal(await fetchSignedInAccountId(f.run), 'acc-me', status);
    assert.deepEqual(f.calls, [['acli', 'jira', 'auth', 'status']]);
  }
  const search = JSON.stringify([{ key: 'EX-1', fields: { assignee: { accountId: '712020:ab-12', displayName: 'Me' } } }]);
  for (const status of ['✓ Authenticated\n  Site: x.atlassian.net\n  Email: me@example.com\n', new Error('unknown command')]) {
    const f = fake({ 'jira auth status': status, 'jira workitem search': search });
    assert.equal(await fetchSignedInAccountId(f.run), '712020:ab-12');
    assert.deepEqual(f.calls[1], ['acli', 'jira', 'workitem', 'search', '--jql', 'assignee = currentUser() ORDER BY updated DESC', '--fields', 'assignee', '--limit', '1', '--json']);
  }
  assert.equal(await fetchSignedInAccountId(fake({ 'jira auth status': 'Authenticated', 'jira workitem search': '[]' }).run), null);
  await assert.rejects(fetchSignedInAccountId(fake({ 'jira auth status': 'Authenticated', 'jira workitem search': new Error('acli: 401') }).run), /401/);
});
