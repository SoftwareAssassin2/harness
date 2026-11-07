// The off-board adapter: a project's off-board tickets (off-board.sh
// ticket:list) in the shape ticket:sync takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fetchTickets } from '../../src/downloader/off-board.js';

const listed = [
  { key: 'HD-1', type: 'Bug', status: 'Backlog', title: 'Broken thing', created: 'c', updated: 'u', file: '/f/HD-1.md', description: '## User story\nAs a dev…', 'acceptance-criteria': [{ 'criteria-number': 1, description: 'AC1: fixed' }] },
  // HD-2 carries a depends-on and an overlaps-with list, HD-1 neither at all (ASS-194, ASS-196): the mapper's fallback.
  { key: 'HD-2', type: 'Story', status: 'In Progress', points: 3, priority: 'High', 'depends-on': ['HD-1'], 'overlaps-with': ['HD-1'], title: 'Nicer thing', created: 'c', updated: 'u', file: '/f/HD-2.md', description: '', 'acceptance-criteria': [] },
];

test('fetchTickets lists the project\'s off-board tickets through off-board.sh and maps each to the ticket shape: its status and priority as the ticket system\'s (no priority: null), its url the file\'s (file://), no assignee; its points when estimated', async () => {
  const calls = [];
  const run = async (file, args) => { calls.push([file, args]); return JSON.stringify(listed); };
  const tickets = await fetchTickets({ root: '/repo', project: 'p' }, run);
  assert.deepEqual(calls, [[join('/repo', 'off-board.sh'), ['ticket:list', 'p']]]);
  assert.deepEqual(tickets, [
    { key: 'HD-1', title: 'Broken thing', description: '## User story\nAs a dev…', url: 'file:///f/HD-1.md', 'ticket-system-status': 'Backlog', 'ticket-system-priority': null, 'ticket-system-assignment': null, points: null, 'issue-type': 'Bug', dependencies: [], overlaps: [], 'sprint-tag': null },
    { key: 'HD-2', title: 'Nicer thing', description: '', url: 'file:///f/HD-2.md', 'ticket-system-status': 'In Progress', 'ticket-system-priority': 'High', 'ticket-system-assignment': null, points: 3, 'issue-type': 'Story', dependencies: ['HD-1'], overlaps: ['HD-1'], 'sprint-tag': null },
  ]);
  assert.deepEqual(await fetchTickets({ root: '/repo', project: 'p' }, async () => '[]'), []);
  await assert.rejects(fetchTickets({ root: '/repo', project: 'p' }, async () => 'not json'), /off-board\.sh printed no JSON/);
  await assert.rejects(fetchTickets({ root: '/repo', project: 'p' }, async () => '{"a":1}'), /off-board\.sh printed no list/);
});

test('an off-board ticket\'s url is its file\'s, resolved and escaped, so the TUI can link its key', async () => {
  const run = async () => JSON.stringify([{ key: 'HD-3', status: 'Backlog', title: 't', file: '/h/src/off-board-cli/../off-board/my proj/HD-3.md' }]);
  const [ticket] = await fetchTickets({ root: '/h', project: 'p' }, run);
  assert.equal(ticket.url, 'file:///h/src/off-board/my%20proj/HD-3.md');
});

test('ASS-83 AC1: a fast-tracked off-board ticket keeps its fast-track: true; any other carries none', async () => {
  const run = async () => JSON.stringify([{ key: 'HD-5', status: 'Backlog', title: 't', 'fast-track': true }, { key: 'HD-6', status: 'Backlog', title: 'u' }]);
  const [fast, plain] = await fetchTickets({ root: '/h', project: 'p' }, run);
  assert.equal(fast['fast-track'], true);
  assert.equal('fast-track' in plain, false);
});
