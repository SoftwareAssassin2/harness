// ASS-413: the downloader cycle's off-board analytics step (cycle.js 5b′):
// an off-board project's tickets, with their status histories, and its own
// sprints, through the real off-board.sh (ticket:list, ticket:history) and
// the real analytics:sync-tickets and analytics:sync-sprints, in ASS-406's
// shapes; the cycle's other agent.sh calls are only recorded. A Jira
// project's analytics are untouched by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCycle } from '../../src/downloader/cycle.js';
import * as offBoard from '../../src/downloader/off-board.js';
import { performance } from '../../src/analytics/performance.js';

const REPO = join(import.meta.dirname, '..', '..');
const AGENT = join(REPO, 'agent.sh'), OFF_BOARD = join(REPO, 'off-board.sh');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/;

// A repo root (the real scripts run from REPO) whose project p has an off-board work source, folder p, prefix HD,
// sprint 1 closed (HD-1) and sprint 2 active (HD-1 carried, HD-2 a bug); its store in a temp OFF_BOARD_DIR.
function fixture({ jira = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'off-board-analytics-'));
  const project = join(dir, 'data', 'projects', 'p');
  const projects = join(dir, 'data', 'projects');
  mkdirSync(join(project, 'sprints', 'sprint-1'), { recursive: true });
  mkdirSync(join(project, 'sprints', 'sprint-2'), { recursive: true });
  writeFileSync(join(project, 'project.json'), JSON.stringify({ 'work-sources': [
    ...jira ? [{ name: 'J', type: 'jira', url: 'https://example.atlassian.net/jira/software/c/projects/PROJ/boards/12' }] : [],
    { name: 'Off', type: 'off-board', folder: 'p', 'key-prefix': 'HD' }] }));
  writeFileSync(join(project, 'backlog.json'), JSON.stringify({ tickets: [] }));
  writeFileSync(join(project, 'sprints.json'), JSON.stringify({ list: [
    { number: 1, 'is-active': false, ...jira ? { 'jira-sprint-id': 501 } : {} },
    { number: 2, 'is-active': true, ...jira ? { 'jira-sprint-id': 502 } : {} }] }));
  const entry = key => ({ key, title: key, variations: [] });
  writeFileSync(join(project, 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, start: '2026-10-12', end: '2026-10-25', features: [entry('HD-1')], bugs: [], spikes: [] }));
  writeFileSync(join(project, 'sprints', 'sprint-2', 'sprint.json'), JSON.stringify({ number: 2, start: '2026-10-26', end: '2026-11-08',
    features: [entry('HD-1'), { ...entry('HD-9'), 'is-deleted': true }], bugs: [entry('hd-2')], spikes: [] }));
  const env = { ...process.env, PROJECTS_DIR: projects, OFF_BOARD_DIR: join(dir, 'off-board') };
  const offBoardSh = async (...args) => (await promisify(execFile)(OFF_BOARD, args, { env })).stdout;
  return { dir, project, env, offBoardSh, file: name => join(project, 'analytics', name), json: name => JSON.parse(readFileSync(join(project, 'analytics', name), 'utf8')) };
}

// exec: off-board.sh and analytics:* run for real; git config user.name answers `gitName` (rejects when null); the rest only recorded.
function executor(f, gitName = 'Ada Operator') {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file.split('/').pop(), args[0]]);
    if (file === 'git') { if (gitName === null) throw Object.assign(new Error('no name'), { code: 1 }); return `${gitName}\n`; }
    if (file.endsWith('off-board.sh') || args[0].startsWith('analytics:')) return (await promisify(execFile)(file, args, { env: f.env })).stdout;
    return '';
  };
  return { calls, exec };
}

async function cycle(f, { gitName, lines = [], adapters = { offBoard } } = {}) {
  const { calls, exec } = executor(f, gitName);
  // root is the real repo (off-board.sh and agent.sh); PROJECTS_DIR points the cycle at the fixture.
  const saved = process.env.PROJECTS_DIR;
  process.env.PROJECTS_DIR = f.env.PROJECTS_DIR;
  try { await runCycle({ root: REPO, project: 'p', now: new Date(), adapters, exec, log: l => lines.push(l) }); } finally {
    if (saved === undefined) delete process.env.PROJECTS_DIR; else process.env.PROJECTS_DIR = saved;
  }
  return { calls, lines };
}

const ticket = (f, key, status, created = '2026-10-10T09:00:00Z', updated = '2026-10-20T09:00:00Z') => {
  mkdirSync(join(f.env.OFF_BOARD_DIR, 'p'), { recursive: true });
  writeFileSync(join(f.env.OFF_BOARD_DIR, 'p', `${key}.md`), `---\nkey: ${key}\ntype: Bug\nstatus: ${status}\ncreated: ${created}\nupdated: ${updated}\n---\n# ${key} title\n`);
};

test('ASS-413 AC3: every off-board ticket goes to analytics:sync-tickets in ASS-406\'s shape — history as status-changes (by null), the operator the assignee from creation, points from the front matter, sprints from the sprint files', async () => {
  const f = fixture();
  await f.offBoardSh('ticket:create', 'p', 'Story', 'First story');
  await f.offBoardSh('ticket:update-points', 'p', 'HD-1', '3');
  await f.offBoardSh('ticket:update-status', 'p', 'HD-1', 'Committed');
  await f.offBoardSh('ticket:update-status', 'p', 'HD-1', 'Done');
  ticket(f, 'HD-2', 'In Progress');   // hand-written, no history: backfilled
  ticket(f, 'HD-3', 'Backlog');       // in no sprint
  const { calls, lines } = await cycle(f);
  assert.ok(calls.some(c => c[0] === 'off-board.sh' && c[1] === 'ticket:history'));
  assert.ok(lines.includes('analytics: 3 off-board tickets'), lines.join('\n'));
  const got = f.json('tickets.json');
  assert.match(got['fetched-through'], ISO);
  assert.deepEqual(Object.keys(got.tickets), ['HD-1', 'HD-2', 'HD-3']);
  const operator = { id: 'operator', name: 'Ada Operator' };
  const one = got.tickets['HD-1'];
  assert.deepEqual(Object.keys(one).sort(), ['assignee', 'assignee-changes', 'created', 'key', 'points', 'sprints', 'status', 'status-changes', 'title', 'type']);
  assert.deepEqual({ ...one, created: 'c', 'status-changes': [] }, { key: 'HD-1', title: 'First story', type: 'Story', created: 'c', points: 3, assignee: operator, status: 'Done', sprints: [1, 2], 'status-changes': [], 'assignee-changes': [] });
  assert.deepEqual(one['status-changes'].map(c => [c.from, c.to, c.by]), [[null, 'Backlog', null], ['Backlog', 'Committed', null], ['Committed', 'Done', null]]);
  assert.equal(one['status-changes'][0].at, one.created);
  assert.deepEqual(got.tickets['HD-2'], { key: 'HD-2', title: 'HD-2 title', type: 'Bug', created: '2026-10-10T09:00:00Z', points: null, assignee: operator, status: 'In Progress', sprints: [2],
    'status-changes': [{ at: '2026-10-10T09:00:00Z', from: null, to: 'Backlog', by: null }, { at: '2026-10-20T09:00:00Z', from: 'Backlog', to: 'In Progress', by: null }], 'assignee-changes': [] });
  assert.deepEqual(got.tickets['HD-3'].sprints, []);
  // The backfill was written beside the ticket, so it is not made up again.
  assert.ok(existsSync(join(f.env.OFF_BOARD_DIR, 'p', 'HD-2.history.json')));
});

test('ASS-413 AC3: the next cycle sends every ticket again, each replacing its entry (a new status change appears); with no git user name the operator is $USER', async () => {
  const f = fixture();
  await f.offBoardSh('ticket:create', 'p', 'Story', 'First');
  await cycle(f);
  const first = f.json('tickets.json');
  await f.offBoardSh('ticket:update-status', 'p', 'HD-1', 'In Progress');
  await f.offBoardSh('ticket:create', 'p', 'Bug', 'Second');
  await cycle(f, { gitName: null });
  const second = f.json('tickets.json');
  assert.ok(Date.parse(second['fetched-through']) >= Date.parse(first['fetched-through']));
  assert.deepEqual(Object.keys(second.tickets), ['HD-1', 'HD-2']);
  assert.equal(second.tickets['HD-1'].status, 'In Progress');
  assert.deepEqual(second.tickets['HD-1']['status-changes'].map(c => c.to), ['Backlog', 'In Progress']);
  assert.deepEqual(second.tickets['HD-1'].assignee, { id: 'operator', name: process.env.USER || 'operator' });
});

test('ASS-413 AC4: the project\'s sprints go to analytics:sync-sprints — id the number, name "Sprint <n>", active or closed, the sprint\'s first day from 00:00 UTC to its last day\'s end', async () => {
  const f = fixture();
  await cycle(f);
  assert.deepEqual(f.json('sprints.json'), { sprints: [
    { id: 1, name: 'Sprint 1', state: 'closed', start: '2026-10-12T00:00:00.000Z', end: '2026-10-25T23:59:59.999Z' },
    { id: 2, name: 'Sprint 2', state: 'active', start: '2026-10-26T00:00:00.000Z', end: '2026-11-08T23:59:59.999Z' }] });
  // An empty store still writes the sprints and an empty ticket list.
  assert.deepEqual(f.json('tickets.json').tickets, {});
});

test('ASS-413 AC5: the performance screen reads an off-board project as a Jira one — statuses meaning what the engine pairs them with, the operator a developer', async () => {
  const f = fixture();
  ticket(f, 'HD-2', 'Done', '2026-10-27T09:00:00Z', '2026-10-29T09:00:00Z');   // Backlog → Done, inside sprint 2
  await cycle(f);
  const engine = { steps: [
    { id: 'plan', 'paired-ticket-system-status': 'Backlog', 'is-planning-stage': true },
    { id: 'build', 'paired-ticket-system-status': 'In Progress' },
    { id: 'done', 'paired-ticket-system-status': 'Done', 'is-done': true }] };
  const team = { members: [{ role: 'developer', 'ticket-system-id': 'operator', 'ticket-system-name': 'Ada Operator' }] };
  const result = performance({ tickets: f.json('tickets.json'), sprints: f.json('sprints.json'), mergeRequests: {}, team, engines: [engine], now: '2026-11-01T12:00:00Z' });
  assert.equal(result.span.sprint.id, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].member.name, 'Ada Operator');
  assert.deepEqual(result.rows[0].cells.ticketsPerDay.variables[0], ['tickets', 1]);   // HD-2, done in the span, credited to the operator
});

test('ASS-413 AC6: a Jira-only project runs no off-board analytics; a failing off-board read is logged once and the cycle goes on', async () => {
  // Jira only: no off-board work source, so neither ticket:history nor an off-board analytics write.
  const j = fixture();
  writeFileSync(join(j.project, 'project.json'), JSON.stringify({ 'work-sources': [{ name: 'J', type: 'jira', url: 'https://example.atlassian.net/jira/software/c/projects/PROJ/boards/12' }] }));
  const jira = { fetchBacklogTickets: async () => [], fetchSprintTickets: async () => [], fetchActiveSprints: async () => [], fetchComments: async () => [], fetchTicketsByKey: async () => [] };
  const { calls } = await cycle(j, { adapters: { jira, offBoard } });
  assert.deepEqual(calls.filter(c => c[1]?.startsWith('analytics:') || c[1] === 'ticket:history'), []);
  assert.equal(existsSync(j.file('tickets.json')), false);

  // A failing history read: logged once across cycles, the sprints still written, the cycle finished.
  const f = fixture();
  const broken = { ...offBoard, fetchAnalyticsTickets: async () => { throw new Error('store unreadable'); } };
  const lines = [];
  const first = await cycle(f, { adapters: { offBoard: broken }, lines });
  await cycle(f, { adapters: { offBoard: broken }, lines });
  assert.equal(lines.filter(l => l.includes('the off-board tickets could not be read')).length, 1, lines.join('\n'));
  assert.equal(existsSync(f.file('tickets.json')), false);
  assert.ok(existsSync(f.file('sprints.json')));
  assert.ok(first.calls.some(c => c[1] === 'project:set-last-data-download'));
});

test('ASS-413: a project with a jira work source too keeps Jira\'s analytics — no sprints written, ticket sprints the jira-sprint-ids, fetched-through left as Jira\'s read set it', async () => {
  const f = fixture({ jira: true });
  mkdirSync(join(f.project, 'analytics'), { recursive: true });
  writeFileSync(f.file('tickets.json'), JSON.stringify({ 'fetched-through': '2026-11-01T10:00:00.000Z', tickets: { 'PROJ-1': { key: 'PROJ-1' } } }));
  ticket(f, 'HD-1', 'In Progress');
  const jira = { fetchBacklogTickets: async () => [], fetchSprintTickets: async () => [], fetchActiveSprints: async () => [], fetchComments: async () => [], fetchTicketsByKey: async () => [] };
  await cycle(f, { adapters: { jira, offBoard } });
  const got = f.json('tickets.json');
  assert.equal(got['fetched-through'], '2026-11-01T10:00:00.000Z');
  assert.deepEqual(Object.keys(got.tickets), ['PROJ-1', 'HD-1']);
  assert.deepEqual(got.tickets['HD-1'].sprints, [501, 502]);
  assert.equal(existsSync(f.file('sprints.json')), false);
});
