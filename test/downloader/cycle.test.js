// One downloader cycle for a project: snapshot the old day, sync the sprint
// and the backlog, record the time — every write an agent.sh call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCycle } from '../../src/downloader/cycle.js';
import * as jira from '../../src/downloader/jira.js';

const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

const ISO = '2026-10-10T20:00:00Z';
// A repo root whose project p (in data/projects) has sprint 10 active, a jira work source and three repositories, two of them Active,
// last downloaded at `last` (null: never, no last-data-download file).
function root({ last = ISO, sprint = 10, jira = true, offBoard = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-'));
  mkdirSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'data', 'projects', 'p', 'project.json'), JSON.stringify({
    'execution-state-engine': 'example-development',
    'work-sources': [
      ...offBoard ? [{ name: 'Off', type: 'off-board', folder: 'p' }] : [],
      ...jira ? [{ name: 'J', type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/EX/boards/5205', 'story-points-field': 'customfield_10028' }] : [],
    ],
    repositories: [
      { url: 'https://gitlab.com/g/one', status: 'Active' }, { url: 'https://gitlab.com/g/old', status: 'Archived' }, { url: 'https://gitlab.com/g/two', status: 'Active' },
    ],
  }));
  if (last) writeFileSync(join(dir, 'data', 'projects', 'p', 'last-data-download'), last);
  writeFileSync(join(dir, 'data', 'projects', 'p', 'sprints.json'), JSON.stringify({ list: sprint ? [{ number: sprint, 'is-active': true, 'jira-sprint-id': 77 }] : [] }));
  writeFileSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ name: 'S10' }));
  return dir;
}
// Fake adapters that record what they were asked and answer canned data.
function adapters() {
  const asked = { sprint: [], backlog: [], mrs: [], comments: [] };
  return {
    asked,
    jira: {
      fetchSprintTickets: async opts => { asked.sprint.push(opts); return [{ key: 'EX-1', title: 'One' }, { key: 'EX-2', title: 'Two' }]; },
      fetchBacklogTickets: async opts => { asked.backlog.push(opts); return [{ key: 'EX-9', title: 'Nine' }]; },
      fetchActiveSprints: async () => [{ id: 77, name: 'S10' }],
      fetchComments: async ({ key }) => { asked.comments.push(key); return [{ id: '1', author: 'Ann', created: ISO, updated: ISO, body: `On ${key}` }]; },
    },
    gitlab: {
      fetchMergeRequests: async ({ repoUrl, branch, search }) => {
        asked.mrs.push({ repoUrl, ...(branch ? { branch } : {}), ...(search ? { search } : {}) });
        if (branch || search) return [];
        return repoUrl.endsWith('one') ? [{ key: '!1', url: 'u1', branch: 'change/EX-1', title: 'EX-1: one' }] : [{ key: '!5', url: 'u5', branch: 'change/EX-1-fix' }, { key: '!6', url: 'u6', branch: 'x', title: 'EX-2: two' }, { key: '!7', url: 'u7', branch: 'change/HD-2' }];
      },
    },
  };
}
// A fake exec: records each agent.sh call, reading any file argument as it is at the time; fails as told.
function recorder(fail = () => null) {
  const calls = [];
  const exec = async (file, args) => {
    const payload = args[3] && existsSync(args[3]) ? JSON.parse(readFileSync(args[3], 'utf8')) : undefined;
    calls.push({ file, args: payload ? [...args.slice(0, 3), payload] : args });
    const err = fail(args[0]);
    if (err) throw err;
    return '';
  };
  return { calls, exec };
}
const local = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min);
const date = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('a cycle snapshots the previous day, syncs the sprint with its merge requests from every Active repository, syncs the backlog and records the time', async () => {
  const yesterday = local(2026, 10, 10, 23, 30), now = local(2026, 10, 11, 0, 5);
  const dir = root({ last: yesterday.toISOString() });
  const a = adapters(), { calls, exec } = recorder();
  const lines = [];
  await runCycle({ root: dir, project: 'p', now, adapters: a, exec, log: l => lines.push(l) });
  const agent = join(dir, 'agent.sh');
  assert.deepEqual(calls, [
    { file: agent, args: ['ticket:snapshot-day', 'p', date(yesterday)] },
    { file: agent, args: ['ticket:sync', 'p', 'sprint', { 'fetched-at': calls[1].args[3]['fetched-at'], tickets: [{ key: 'EX-1', title: 'One' }, { key: 'EX-2', title: 'Two' }], 'merge-requests': [
      { key: '!1', url: 'u1', branch: 'change/EX-1', ticket: 'EX-1' }, { key: '!5', url: 'u5', branch: 'change/EX-1-fix', ticket: 'EX-1' },
      { key: '!6', url: 'u6', branch: 'x', ticket: 'EX-2' }, { key: '!7', url: 'u7', branch: 'change/HD-2', ticket: null },
    ] }] },
    { file: agent, args: ['ticket:sync', 'p', 'backlog', { 'fetched-at': calls[2].args[3]['fetched-at'], tickets: [{ key: 'EX-9', title: 'Nine' }] }] },
    { file: agent, args: ['project:set-last-data-download', 'p', now.toISOString()] },
  ]);
  const board = { site: 'https://x.atlassian.net', projectKey: 'EX', boardId: 5205, storyPointsField: 'customfield_10028' };
  assert.deepEqual(a.asked.sprint, [{ ...board, sprintId: 77, sprintName: 'S10' }]);
  assert.deepEqual(a.asked.backlog, [board]);
  assert.deepEqual(a.asked.mrs, [{ repoUrl: 'https://gitlab.com/g/one' }, { repoUrl: 'https://gitlab.com/g/two' }]);   // not a lookup cycle: the lists alone
  assert.ok(lines.some(l => /snapshot/.test(l)) && lines.some(l => /sprint/.test(l)) && lines.some(l => /backlog/.test(l)), lines.join('\n'));
});

test('the snapshot fires only when the local date has moved on since the last download, and a day already kept is no error', async () => {
  const snapshots = async (last, now, fail) => {
    const { calls, exec } = recorder(fail);
    await runCycle({ root: root({ last }), project: 'p', now, adapters: adapters(), exec, log: () => {} });
    return calls.filter(c => c.args[0] === 'ticket:snapshot-day').map(c => c.args[2]);
  };
  assert.deepEqual(await snapshots(local(2026, 10, 10, 0, 1).toISOString(), local(2026, 10, 10, 23, 59)), []);        // same local day
  assert.deepEqual(await snapshots(local(2026, 10, 10, 23, 59).toISOString(), local(2026, 10, 11, 0, 0)), ['2026-10-10']); // past local midnight
  assert.deepEqual(await snapshots(local(2026, 10, 8, 12, 0).toISOString(), local(2026, 10, 11, 9, 0)), ['2026-10-08']);   // days missed: the last data is still that day's
  assert.deepEqual(await snapshots(null, local(2026, 10, 11, 9, 0)), []);                                                   // first download ever
  const kept = Object.assign(new Error('already exists'), { code: 2 });
  assert.deepEqual(await snapshots(local(2026, 10, 10, 1, 0).toISOString(), local(2026, 10, 11, 1, 0), cmd => cmd === 'ticket:snapshot-day' ? kept : null), ['2026-10-10']);
  const broken = Object.assign(new Error('no active sprint'), { code: 1 });
  await assert.rejects(snapshots(local(2026, 10, 10, 1, 0).toISOString(), local(2026, 10, 11, 1, 0), cmd => cmd === 'ticket:snapshot-day' ? broken : null), /no active sprint/);
});

test('without an active sprint the sprint sync is skipped; the backlog still syncs and the time is recorded', async () => {
  const a = adapters(), { calls, exec } = recorder(), now = new Date();
  await runCycle({ root: root({ sprint: null, last: now.toISOString() }), project: 'p', now, adapters: a, exec, log: () => {} });
  assert.deepEqual(calls.map(c => c.args[0]), ['ticket:sync', 'project:set-last-data-download']);
  assert.equal(calls[0].args[2], 'backlog');
  assert.deepEqual([a.asked.sprint, a.asked.mrs], [[], []]);
});

test('a dry run fetches but runs nothing: it prints the agent.sh commands and the files they would get', async () => {
  const { calls, exec } = recorder();
  const lines = [];
  await runCycle({ root: root(), project: 'p', now: local(2026, 10, 12, 9), adapters: adapters(), exec, dryRun: true, log: l => lines.push(l) });
  assert.deepEqual(calls, []);
  const text = lines.join('\n');
  assert.match(text, /agent\.sh ticket:snapshot-day p 2026-10-10/);
  assert.match(text, /agent\.sh ticket:sync p sprint/);
  assert.match(text, /"EX-1"/);
  assert.match(text, /agent\.sh ticket:sync p backlog/);
  assert.match(text, /agent\.sh project:set-last-data-download p 2026-10-12T/);
});

test('a project with only an off-board work source (the harness\'s own) skips Jira: its off-board tickets sync and the time is recorded; one with neither source is refused', async () => {
  const a = { ...adapters(), offBoard: { fetchTickets: async () => [{ key: 'HD-4', title: 'T', 'ticket-system-status': 'To Do' }] } };
  const { calls, exec } = recorder();
  await runCycle({ root: root({ jira: false }), project: 'p', now: new Date(ISO), adapters: a, exec, log: () => {} });
  assert.deepEqual([a.asked.sprint, a.asked.backlog], [[], []]);
  assert.deepEqual(a.asked.mrs, [{ repoUrl: 'https://gitlab.com/g/one' }, { repoUrl: 'https://gitlab.com/g/two' }]);   // their merge requests too (ASS-92)
  assert.deepEqual(calls.filter(c => c.args[0] === 'ticket:sync').map(c => [c.args[2], c.args[3].tickets.map(t => t.key)]), [['sprint', ['HD-4']]]);
  assert.equal(calls.at(-1).args[0], 'project:set-last-data-download');
  await assert.rejects(runCycle({ root: root({ jira: false, offBoard: false }), project: 'p', now: new Date(), adapters: adapters(), exec: async () => '', log: () => {} }), /no jira or off-board work source/);
});

test('a repository whose merge requests cannot be listed is logged, and the sprint syncs with no merge requests, so every record is kept (ASS-98 AC2)', async () => {
  const a = adapters(), { calls, exec } = recorder(), lines = [];
  a.gitlab.fetchMergeRequests = async ({ repoUrl }) => { if (repoUrl.endsWith('/one')) throw new Error('404 Not Found.\nmore'); return [{ key: '!9', url: 'u9', branch: 'change/EX-1' }]; };
  await runCycle({ root: root({ last: ISO }), project: 'p', now: local(2026, 10, 10, 20), adapters: a, exec, log: l => lines.push(l) });
  assert.ok(lines.includes('https://gitlab.com/g/one: merge requests skipped: 404 Not Found.'), lines.join('\n'));
  const sync = calls.find(c => c.args[0] === 'ticket:sync' && c.args[2] === 'sprint');
  assert.deepEqual(sync.args[3]['merge-requests'], []);
});

test('on a lookup cycle the sprint tickets with no merge request recorded in the sprint file and none listed are looked up (ASS-98 AC1); each recorded one not listed is fetched by its url, and a ticket with none on its own branch looked up too (ASS-122)', async () => {
  const dir = root({ last: ISO });
  const U3 = 'https://gitlab.com/g/one/-/merge_requests/3', U8 = 'https://gitlab.com/g/two/-/merge_requests/8';
  writeFileSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ name: 'S10', features: [
    { key: 'EX-1', variations: [{ name: 'A', 'merge-request': [] }] },
    { key: 'EX-5', variations: [{ name: 'A', 'merge-request': [{ key: '!8', url: U8 }, { id: 'p1', url: null, branch: 'change/EX-5' }] }, { name: 'B', 'is-deleted': true, 'merge-request': [{ key: '!9', url: 'https://gitlab.com/g/two/-/merge_requests/9' }] }] },
  ], bugs: [{ key: 'EX-3', variations: [{ name: 'A', 'merge-request': [{ key: '!3', url: U3 }] }] }] }));
  const a = adapters(), fetched = [];
  a.gitlab.fetchMergeRequest = async ({ url }) => { fetched.push(url); return url === U3 ? { key: '!3', url, branch: 'change/EX-3', status: 'Closed' } : { key: '!8', url, branch: 'change/EX-9', status: 'Merged' }; };
  a.jira.fetchSprintTickets = async () => [{ key: 'EX-1' }, { key: 'EX-3' }, { key: 'EX-4' }, { key: 'EX-5' }];
  const { calls, exec } = recorder();
  await runCycle({ root: dir, project: 'p', now: new Date(ISO), adapters: a, exec, lookups: true, log: () => {} });
  assert.deepEqual(fetched, [U8, U3]);   // in the sprint file's order; a deleted variation's and a planned one's are not
  // EX-1 is listed, EX-3 recorded on its branch; EX-4 has nothing, EX-5 only one on another branch.
  assert.deepEqual(a.asked.mrs.filter(m => m.branch).map(m => m.branch), ['change/EX-4', 'change/EX-4', 'change/EX-5', 'change/EX-5']);
  const sync = calls.find(c => c.args[0] === 'ticket:sync' && c.args[2] === 'sprint');
  assert.deepEqual(sync.args[3]['merge-requests'].filter(m => m.url.startsWith('https')).map(m => [m.key, m.status, m.ticket]), [['!8', 'Merged', null], ['!3', 'Closed', 'EX-3']]);
});

test('a GitHub repository\'s pull requests are read through the github adapter, and the off-board tickets synced with them (ASS-92)', async () => {
  const dir = root({ last: ISO, jira: false });
  const project = JSON.parse(readFileSync(join(dir, 'data', 'projects', 'p', 'project.json'), 'utf8'));
  project.repositories = [{ url: 'https://github.com/o/r', status: 'Active' }];
  writeFileSync(join(dir, 'data', 'projects', 'p', 'project.json'), JSON.stringify(project));
  const a = { ...adapters(), offBoard: { fetchTickets: async () => [{ key: 'HD-2', title: 'T', 'ticket-system-status': 'To Do' }] },
    github: { fetchMergeRequests: async ({ repoUrl }) => [{ key: '#4', url: `${repoUrl}/pull/4`, branch: 'change/HD-2' }] } };
  const { calls, exec } = recorder();
  await runCycle({ root: dir, project: 'p', now: new Date(ISO), adapters: a, exec, log: () => {} });
  const sync = calls.find(c => c.args[0] === 'ticket:sync' && c.args[2] === 'sprint');
  assert.deepEqual(sync.args[3]['merge-requests'], [{ key: '#4', url: 'https://github.com/o/r/pull/4', branch: 'change/HD-2', ticket: 'HD-2' }]);
  assert.deepEqual(a.asked.mrs, []);
});

test('a project with an off-board work source has its off-board tickets synced too: those at Backlog to the backlog, the rest to the sprint, but a Done one not already in it (ASS-142 AC3); none, nothing', async () => {
  const dir = root({ last: ISO });
  writeFileSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ name: 'S10', features: [{ key: 'hd-4', variations: [] }] }));
  const a = { ...adapters(), offBoard: { fetchTickets: async opts => { a.askedOff = opts; return [
    { key: 'HD-1', title: 'B', 'ticket-system-status': 'Backlog' }, { key: 'HD-2', title: 'T', 'ticket-system-status': 'To Do' }, { key: 'HD-3', title: 'D', 'ticket-system-status': 'Done' },
    { key: 'HD-4', title: 'D', 'ticket-system-status': 'Done' },
  ]; } } };
  const { calls, exec } = recorder(), lines = [];
  await runCycle({ root: dir, project: 'p', now: new Date(ISO), adapters: a, exec, log: l => lines.push(l) });
  assert.deepEqual(a.askedOff, { root: dir, project: 'p' });
  const syncs = calls.filter(c => c.args[0] === 'ticket:sync').map(c => [c.args[2], c.args[3].tickets.map(t => t.key)]);
  assert.deepEqual(syncs, [['sprint', ['EX-1', 'EX-2']], ['backlog', ['EX-9']], ['sprint', ['HD-2', 'HD-4']], ['backlog', ['HD-1']]]);
  assert.equal(calls.at(-1).args[0], 'project:set-last-data-download');
  assert.ok(lines.includes('off-board: 4 tickets, 2 in the sprint, 1 in the backlog, 1 Done outside it'), lines.join('\n'));
  // No off-board tickets: no sync calls for them. No adapter (an older caller): nothing either.
  const none = { ...adapters(), offBoard: { fetchTickets: async () => [] } }, quiet = recorder();
  await runCycle({ root: root({ last: ISO }), project: 'p', now: new Date(ISO), adapters: none, exec: quiet.exec, log: () => {} });
  assert.equal(quiet.calls.filter(c => c.args[0] === 'ticket:sync').length, 2);
});

test('on a comment cycle (comments given) each Jira sprint and backlog ticket\'s comments go to ticket:sync-jira-comments before the time is recorded; off-board tickets and other cycles fetch none', async () => {
  const a = { ...adapters(), offBoard: { fetchTickets: async () => [{ key: 'HD-2', title: 'T', 'ticket-system-status': 'To Do' }] } };
  const { calls, exec } = recorder();
  await runCycle({ root: root({ last: ISO }), project: 'p', now: new Date(ISO), adapters: a, exec, comments: new Set(), log: () => {} });
  assert.deepEqual(a.asked.comments, ['EX-1', 'EX-2', 'EX-9']);
  const kept = calls.filter(c => c.args[0] === 'ticket:sync-jira-comments');
  assert.deepEqual(kept.map(c => c.args), ['EX-1', 'EX-2', 'EX-9'].map(k => ['ticket:sync-jira-comments', 'p', k, { comments: [{ id: '1', author: 'Ann', created: ISO, updated: ISO, body: `On ${k}` }] }]));
  assert.equal(calls.at(-1).args[0], 'project:set-last-data-download');
  const other = adapters(), quiet = recorder();
  await runCycle({ root: root({ last: ISO }), project: 'p', now: new Date(ISO), adapters: other, exec: quiet.exec, log: () => {} });
  assert.deepEqual(other.asked.comments, []);
  assert.equal(quiet.calls.filter(c => c.args[0] === 'ticket:sync-jira-comments').length, 0);
});

test('a ticket whose comments cannot be fetched keeps what it had and the cycle goes on; the failure is logged once, until a fetch for it works again', async () => {
  const comments = new Set(), lines = [];
  let broken = true;
  const cycle = async () => {
    const a = adapters();
    const fetch = a.jira.fetchComments;
    a.jira.fetchComments = async opts => { if (broken && opts.key === 'EX-2') throw new Error('acli: 503\nmore'); return fetch(opts); };
    const { calls, exec } = recorder();
    await runCycle({ root: root({ last: ISO }), project: 'p', now: new Date(ISO), adapters: a, exec, comments, log: l => lines.push(l) });
    return calls.filter(c => c.args[0] === 'ticket:sync-jira-comments').map(c => c.args[2]);
  };
  assert.deepEqual(await cycle(), ['EX-1', 'EX-9']);
  assert.deepEqual(await cycle(), ['EX-1', 'EX-9']);
  assert.deepEqual(lines.filter(l => /comments skipped/.test(l)), ['EX-2: comments skipped: acli: 503']);
  broken = false;
  assert.deepEqual(await cycle(), ['EX-1', 'EX-2', 'EX-9']);
  broken = true;
  await cycle();
  assert.equal(lines.filter(l => /comments skipped/.test(l)).length, 2);
});

test('a status control sets while the cycle looks up merge requests survives the sprint sync of the list read before it (ASS-128 AC4)', async () => {
  const dir = root({ last: ISO, offBoard: false });
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'data', 'projects'), ACLI_DISABLED: '1' };
  const agent = (...args) => promisify(execFile)(AGENT, args, { env }).then(r => r.stdout);
  writeFileSync(join(dir, 'data', 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [] }));
  const ticket = { key: 'EX-1', title: 'One', description: '', url: null, 'ticket-system-status': 'Committed', 'ticket-system-priority': null, 'ticket-system-assignment': null, points: null, 'issue-type': 'Story', dependencies: [], 'sprint-tag': null };
  writeFileSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({ name: 'S10', features: [{ ...ticket, priority: 1, variations: [] }], bugs: [], spikes: [] }));
  const a = adapters();
  a.jira.fetchSprintTickets = async () => [ticket];
  a.jira.fetchBacklogTickets = async () => [];
  a.gitlab.fetchMergeRequests = async ({ repoUrl }) => {
    if (repoUrl.endsWith('/one')) await agent('ticket:set-ticket-system-status', 'p', 'EX-1', 'In Progress');   // control moves it mid-lookup
    return [];
  };
  await runCycle({ root: dir, project: 'p', now: new Date(), adapters: a, exec: (file, args) => agent(...args), log: () => {} });
  const s = JSON.parse(readFileSync(join(dir, 'data', 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), 'utf8'));
  assert.equal(s.features[0]['ticket-system-status'], 'In Progress');
});

test('each ticket list the cycle syncs, Jira and off-board, is stamped with when it was read, taken just before the read (fetched-at, ASS-128 AC1)', async () => {
  const read = {}, at = name => async () => { read[name] = Date.now(); await new Promise(r => setTimeout(r, 5)); return name === 'off-board' ? [{ key: 'HD-1', 'ticket-system-status': 'Backlog' }, { key: 'HD-2', 'ticket-system-status': 'To Do' }] : [{ key: `EX-${name}` }]; };
  const a = { ...adapters(), offBoard: { fetchTickets: at('off-board') } };
  a.jira.fetchSprintTickets = at('sprint');
  a.jira.fetchBacklogTickets = at('backlog');
  const { calls, exec } = recorder(), start = Date.now();
  await runCycle({ root: root({ last: ISO }), project: 'p', now: new Date(ISO), adapters: a, exec, log: () => {} });
  const stamps = calls.filter(c => c.args[0] === 'ticket:sync').map(c => [c.args[2], c.args[3]['fetched-at']]);
  assert.deepEqual(stamps.map(([target]) => target), ['sprint', 'backlog', 'sprint', 'backlog']);
  for (const [[, fetchedAt], list] of stamps.map((s, i) => [s, ['sprint', 'backlog', 'off-board', 'off-board'][i]])) {
    assert.match(fetchedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(start <= Date.parse(fetchedAt) && Date.parse(fetchedAt) <= read[list], `${list}: ${fetchedAt}`);
  }
});

test('an off-board project\'s first cycle after its sprint\'s last day advances the sprint (ASS-142): the unfinished tickets carried, the Done one left and not re-added by the sync, a new one joining the new sprint, the advance logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-'));
  const p = join(dir, 'data', 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-1'), { recursive: true });
  mkdirSync(join(dir, 'engines', 'dev'), { recursive: true });
  writeFileSync(join(dir, 'engines', 'dev', 'state-engine.json'), JSON.stringify({ steps: [
    { id: 'todo', sequence: 1, 'paired-ticket-system-status': 'To Do' }, { id: 'build', sequence: 2 }, { id: 'done', sequence: 3, 'is-done': true, 'paired-ticket-system-status': 'Done' }] }));
  writeFileSync(join(p, 'project.json'), JSON.stringify({ 'execution-state-engine': 'dev', 'work-sources': [{ name: 'Off', type: 'off-board', folder: 'p' }] }));
  writeFileSync(join(p, 'backlog.json'), JSON.stringify({ tickets: [] }));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  const offBoard = (key, status) => ({ key, title: key, description: '', url: null, 'ticket-system-status': status, 'ticket-system-priority': null, 'ticket-system-assignment': null, points: null, 'issue-type': 'Story', dependencies: [], 'sprint-tag': null });
  const held = (key, status, state) => ({ ...offBoard(key, status), priority: 1, 'manual-priority': 2, qa: { status: null },
    variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'dev' }, 'merge-request': [], 'state-changes': [{ 'to-state': state, 'work-is-done': false }], 'local-testing': { vm: 'v' } }] });
  writeFileSync(join(p, 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, name: 'Harness Sprint 1', start: '2026-10-12', end: '2026-10-25',
    features: [held('ASS-1', 'In Progress', 'build'), held('ASS-2', 'Done', 'done')], bugs: [], spikes: [] }));
  const last = local(2026, 10, 25, 22), now = local(2026, 10, 26, 0, 5);
  writeFileSync(join(p, 'last-data-download'), last.toISOString());
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'data', 'projects'), ENGINES_DIR: join(dir, 'engines') };
  const agent = (...args) => promisify(execFile)(AGENT, args, { env }).then(r => r.stdout);
  const a = { offBoard: { fetchTickets: async () => [offBoard('ASS-1', 'In Progress'), offBoard('ASS-2', 'Done'), offBoard('ASS-5', 'To Do')] } };
  const lines = [];
  const cycle = () => runCycle({ root: dir, project: 'p', now, adapters: a, exec: (file, args) => agent(...args), log: l => lines.push(l) });
  await cycle();
  const sprint = n => JSON.parse(readFileSync(join(p, 'sprints', `sprint-${n}`, 'sprint.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(p, 'sprints.json'), 'utf8')).list.find(s => s['is-active']).number, 2);
  assert.deepEqual(sprint(2).features.map(t => t.key), ['ASS-1', 'ASS-5']);
  assert.deepEqual(sprint(2).features[0].variations, held('ASS-1', 'In Progress', 'build').variations);
  assert.deepEqual(sprint(1).features.map(t => t.key), ['ASS-2']);
  assert.ok(lines.includes('p sprint 1 → 2: 1 tickets carried, 1 left'), lines.join('\n'));
  assert.ok(existsSync(join(p, 'sprints', 'days', '2026-10-25.json')));   // the old day kept first
  await cycle();   // the next cycle: still no ASS-2 in the new sprint
  assert.deepEqual(sprint(2).features.map(t => t.key), ['ASS-1', 'ASS-5']);
});

test('the sprint advance runs only on a new day, and never for a project with a jira work source (ASS-142 AC5)', async () => {
  const advances = async (opts, last, now) => {
    const { calls, exec } = recorder();
    const a = { ...adapters(), offBoard: { fetchTickets: async () => [] } };
    await runCycle({ root: root({ ...opts, last }), project: 'p', now, adapters: a, exec, log: () => {} });
    return calls.filter(c => c.args[0] === 'sprint:advance').map(c => c.args);
  };
  const last = local(2026, 10, 10, 23).toISOString(), now = local(2026, 10, 11, 0, 5);
  assert.deepEqual(await advances({ jira: false }, last, now), [['sprint:advance', 'p', '2026-10-11']]);
  assert.deepEqual(await advances({ jira: false }, last, local(2026, 10, 10, 23, 30)), []);
  assert.deepEqual(await advances({}, last, now), []);
});

// ASS-165: a Jira project's harness sprint follows the board's active sprint.
// The board's active sprints, answered by a fake acli: list-sprints gives `active` (or fails), a search `issues` (REST shape, none by default).
const fakeAcli = (active, searches = [], issues = []) => async (file, args) => {
  if (args[1] === 'board' && args[2] === 'list-sprints') { if (active instanceof Error) throw active; return JSON.stringify(active.map(s => ({ ...s, state: 'active' }))); }
  if (args[2] === 'search') { searches.push(args[4]); return JSON.stringify(args[4].startsWith('sprint = ') ? issues : []); }
  if (args[2] === 'view') return '{}';
  throw new Error(`unexpected acli ${args.join(' ')}`);
};

test('a Jira project\'s cycle, the pinned Jira sprint no longer the board\'s active one, advances the harness\'s sprint to it (ASS-165 AC1): the new entry with its jira-sprint-id, name and Jira\'s dates, the unfinished tickets carried, the new sprint\'s tickets fetched, logged; dates edited in Jira follow; its tickets\' Jira statuses too — all while the project is paused, so unpausing finds nothing stale (ASS-165 AC5)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-'));
  const p = join(dir, 'data', 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-11'), { recursive: true });
  mkdirSync(join(dir, 'engines', 'dev'), { recursive: true });
  writeFileSync(join(dir, 'engines', 'dev', 'state-engine.json'), JSON.stringify({ steps: [{ id: 'build', sequence: 1 }, { id: 'done', sequence: 2, 'is-done': true }] }));
  writeFileSync(join(p, 'project.json'), JSON.stringify({ 'execution-state-engine': 'dev', 'work-sources': [{ name: 'J', type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/EX/boards/5205' }] }));
  writeFileSync(join(p, 'backlog.json'), JSON.stringify({ tickets: [] }));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 11, 'is-active': true, 'jira-sprint-id': 13422 }] }));
  const held = (key, state) => ({ key, title: key, 'ticket-system-status': 'In Progress', priority: 1, 'manual-priority': null, qa: { status: null },
    variations: [{ name: 'A', 'harness-status': { state, 'state-engine': 'dev' }, 'merge-request': [] }] });
  writeFileSync(join(p, 'sprints', 'sprint-11', 'sprint.json'), JSON.stringify({ number: 11, name: 'EX Sprint 11 - Beta', start: '2026-10-04', end: '2026-10-18',
    features: [held('EX-1', 'build'), held('EX-2', 'done')], bugs: [], spikes: [] }));
  const now = new Date();
  writeFileSync(join(p, 'last-data-download'), now.toISOString());
  // Paused (assignments:pause's shape): the sprint follows Jira all the same.
  writeFileSync(join(dir, 'data', 'assignments.json'), JSON.stringify({ assignments: [], pauses: { p: { human: { since: ISO } }, all: { human: { since: ISO } } } }));
  const env = { ...process.env, PROJECTS_DIR: join(dir, 'data', 'projects'), ENGINES_DIR: join(dir, 'engines'), ASSIGNMENTS_FILE: join(dir, 'data', 'assignments.json') };
  const agent = (...args) => promisify(execFile)(AGENT, args, { env }).then(r => r.stdout);
  const board = [{ id: 13423, name: 'EX Sprint 12', startDate: '2026-10-17T00:03:40.303Z', endDate: '2026-10-31T00:03:06.000Z' }];
  const issue = status => ({ key: 'EX-1', fields: { summary: 'EX-1', status: { name: status }, issuetype: { name: 'Story' } } });
  const issues = [issue('In Review')];
  const searches = [], acli = fakeAcli(board, searches, issues);
  const lines = [];
  const cycle = () => runCycle({ root: dir, project: 'p', now, adapters: { jira }, exec: (file, args) => file === 'acli' ? acli(file, args) : agent(...args), log: l => lines.push(l) });
  await cycle();
  const read = f => JSON.parse(readFileSync(join(p, f), 'utf8'));
  assert.deepEqual(read('sprints.json').list, [{ number: 11, 'is-active': false, 'jira-sprint-id': 13422 }, { number: 12, 'is-active': true, 'jira-sprint-id': 13423 }]);
  const { name, start, end } = read('sprints/sprint-12/sprint.json');
  assert.deepEqual({ name, start, end }, { name: 'EX Sprint 12', start: '2026-10-17', end: '2026-10-31' });
  assert.deepEqual(read('sprints/sprint-12/sprint.json').features.map(t => [t.key, t['ticket-system-status']]), [['EX-1', 'In Review']]);
  assert.deepEqual(read('sprints/sprint-11/sprint.json').features.map(t => t.key), ['EX-2']);
  assert.match(searches[0], /^sprint = 13423 /);
  assert.ok(lines.some(l => /board's active sprint is EX Sprint 12 \(13423\), not 13422/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('p sprint 11 → 12: 1 tickets carried, 1 left'), lines.join('\n'));
  await cycle();   // the next cycle: it follows, nothing more
  assert.equal(read('sprints.json').list.length, 2);
  assert.match(searches[2], /^sprint = 13423 /);
  board[0].endDate = '2026-11-03T00:00:00.000Z';   // the end moved in Jira
  issues[0] = issue('Done');                         // and EX-1 was finished there
  await cycle();
  assert.equal(read('sprints/sprint-12/sprint.json').features[0]['ticket-system-status'], 'Done');
  assert.deepEqual([read('sprints/sprint-12/sprint.json').start, read('sprints/sprint-12/sprint.json').end], ['2026-10-17', '2026-11-03']);
  assert.ok(lines.includes('p sprint 12: 2026-10-17 to 2026-11-03, as in Jira'), lines.join('\n'));
  assert.deepEqual(read('sprints/sprint-12/sprint.json').features.map(t => t.key), ['EX-1']);
  assert.equal(read('sprints.json').list.length, 2);
});

test('a Jira project\'s cycle with its pinned sprint still the board\'s active one changes nothing (ASS-165 AC3)', async () => {
  const { calls, exec } = recorder();
  const searches = [], acli = fakeAcli([{ id: 76, name: 'Other' }, { id: 77, name: 'S10' }], searches);
  await runCycle({ root: root({ offBoard: false }), project: 'p', now: new Date(ISO), adapters: { ...adapters(), jira }, exec: (file, args) => file === 'acli' ? acli(file, args) : exec(file, args), log: () => {} });
  assert.deepEqual(calls.map(c => c.args[0]).filter(c => c === 'sprint:advance'), []);
  assert.match(searches[0], /^sprint = 77 /);
});

test('a Jira project\'s cycle with no active sprint on the board, or the board unreadable, leaves the sprint as it is, logged once (ASS-165 AC2)', async () => {
  const dir = root({ offBoard: false });
  const lines = [], { calls, exec } = recorder();
  const cycle = active => runCycle({ root: dir, project: 'p', now: new Date(ISO), adapters: { ...adapters(), jira }, exec: (file, args) => file === 'acli' ? fakeAcli(active)(file, args) : exec(file, args), log: l => lines.push(l) });
  await cycle([]);
  await cycle([]);
  assert.deepEqual(calls.map(c => c.args[0]).filter(c => c === 'sprint:advance'), []);
  assert.deepEqual(lines.filter(l => /no active sprint on the board/.test(l)), ['no active sprint on the board; sprint 10 stays on Jira sprint 77']);
  await cycle([{ id: 77, name: 'S10' }]);
  await cycle(new Error('acli: down'));
  await cycle(new Error('acli: down'));
  assert.deepEqual(lines.filter(l => /board's sprints/.test(l)), ['the board\'s sprints could not be read; sprint 10 stays on Jira sprint 77: acli: down']);
  assert.equal(calls.filter(c => c.args[0] === 'project:set-last-data-download').length, 5);
});
