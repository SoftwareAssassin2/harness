import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from '../support/until.js';
import * as load from '../../src/tui/load.js';   // loadHarness is ASS-188's, by the namespace so the suite still runs before it is there
import { loadProjects, loadPauses, loadSelfHealing, loadAssignments, loadTransientEngines, loadQuestions, loadChats, watchFiles, dataFiles, keepSame, projectsChanged, loadWorkflows, loadApiCost, loadDiskSpace } from '../../src/tui/load.js';

const write = (file, json) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
};

for (const tool of ['gcloud', 'glab']) test(`the ${tool} warning shows only for a project that checks for an expired ${tool} login (ASS-28, ASS-61), from its ${tool}-requires-reauthentication file (ASS-58): exactly true; missing or anything else is false`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gc-'));
  const check = `check-for-expired-${tool}-auth`;
  const project = (id, json, flag) => { write(join(dir, id, 'project.json'), json); if (flag != null) writeFileSync(join(dir, id, `${tool}-requires-reauthentication`), flag); };
  project('on', { name: 'On', [check]: true }, 'true');
  project('off', { name: 'Off', [check]: false }, 'true');
  project('none', { name: 'None' }, 'true');
  project('live', { name: 'Live', [check]: true }, 'false');
  project('missing', { name: 'Missing', [check]: true });
  project('newline', { name: 'Newline', [check]: true }, 'true\n');
  project('old', { name: 'Old', [check]: true, [`${tool}-requires-reauthentication`]: true });   // the key in project.json is no longer read
  assert.deepEqual(loadProjects(dir).map(p => [p.name, p[`${tool}Reauthentication`]]), [['Live', false], ['Missing', false], ['Newline', false], ['None', false], ['Off', false], ['Old', false], ['On', true]]);
});

test('projects come from project.json, sorted by name, each with its folder as id, its state engine, repositories, active sprint and end-of-day snapshots, and its push account (ASS-307: push-account.json, null without)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'z-dir', 'project.json'), { name: 'Alpha' });
  write(join(dir, 'a-dir', 'project.json'), { name: 'Beta', 'execution-state-engine': 'example-development', control: { status: 'Online' }, 'local-environments': [{ name: 'ws', type: 'local-pc' }], repositories: [{ url: 'https://gitlab.com/g/r' }], 'highlighted-tickets': [{ ticket: 'ABC-1', color: '#ffff00' }], 'check-for-expired-gcloud-auth': true, 'background-work': false });   // control: no longer read (ASS-310); kept here to prove loadProjects ignores it
  writeFileSync(join(dir, 'a-dir', 'gcloud-requires-reauthentication'), 'true');
  write(join(dir, 'a-dir', 'rate-limit.json'), { since: '2026-10-11T12:00:00Z', type: 'five_hour', 'resets-at': '2026-10-11T13:00:00Z' });
  write(join(dir, 'a-dir', 'claude-usage.json'), { email: 'me@example.com', session: { percent: 7, 'resets-at': '2026-10-11T13:00:00Z' }, 'as-of': '2026-10-11T12:00:00Z' });
  write(join(dir, 'a-dir', 'push-account.json'), { project: 'a-dir', provider: 'GitLab', account: 'ada', error: null, 'checked-at': '2026-10-11T12:00:00Z' });   // ASS-307: control's last push-account check
  write(join(dir, 'z-dir', 'project.json'), { name: 'Alpha', 'rate-limit': { 'resets-at': '2026-10-11T13:00:00Z' } });   // no longer read from project.json (ASS-94)
  write(join(dir, 'a-dir', 'sprints.json'), { list: [{ number: 9, 'is-active': false }, { number: 10, 'is-active': true }] });
  write(join(dir, 'a-dir', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, start: '2026-09-18', end: '2026-10-01', features: [{ key: 'ABC-2' }] });
  write(join(dir, 'a-dir', 'backlog.json'), { tickets: [{ key: 'ABC-1' }, { key: 'abc-2' }] });   // ABC-2 is in the sprint: not the backlog's, but its backlog entry kept for its refinement history (ASS-42)
  write(join(dir, 'a-dir', 'sprints', 'days', '2026-09-18.json'), { number: 10, features: [] });
  write(join(dir, 'a-dir', 'sprints', 'days', 'notes.json'), { ignored: true });
  mkdirSync(join(dir, 'not-a-project'));
  assert.deepEqual(loadProjects(dir), [
    { id: 'z-dir', dir: join(dir, 'z-dir'), name: 'Alpha', stateEngine: undefined, switchedOffSteps: [], environments: [], repositories: [], sprint: null, backlog: [], backlogOfSprint: [], days: {}, questions: [], highlights: [], gcloudReauthentication: false, glabReauthentication: false, backgroundWorkOff: false, waitForDependencies: false, outside: [], rateLimit: null, claudeUsage: null, pushAccount: null, accountHold: null, apiCapHold: null, apiKey: false, hindsight: null, collaborations: {}, chatSpend: null, memorySpend: [], demoPlans: {}, reviews: {}, spendLimit: null, apiCost: null, golden: null },
    { id: 'a-dir', dir: join(dir, 'a-dir'), name: 'Beta', stateEngine: 'example-development', switchedOffSteps: [], environments: [{ name: 'ws', type: 'local-pc' }], repositories: [{ url: 'https://gitlab.com/g/r' }], sprint: { number: 10, start: '2026-09-18', end: '2026-10-01', features: [{ key: 'ABC-2' }] }, backlog: [{ key: 'ABC-1' }], backlogOfSprint: [{ key: 'abc-2' }], days: { '2026-09-18': { number: 10, features: [] } }, questions: [], highlights: [{ ticket: 'ABC-1', color: '#ffff00' }], gcloudReauthentication: true, glabReauthentication: false, backgroundWorkOff: true, waitForDependencies: false, outside: [], rateLimit: { since: '2026-10-11T12:00:00Z', type: 'five_hour', 'resets-at': '2026-10-11T13:00:00Z' }, claudeUsage: { email: 'me@example.com', session: { percent: 7, 'resets-at': '2026-10-11T13:00:00Z' }, 'as-of': '2026-10-11T12:00:00Z' }, pushAccount: { project: 'a-dir', provider: 'GitLab', account: 'ada', error: null, 'checked-at': '2026-10-11T12:00:00Z' }, accountHold: null, apiCapHold: null, apiKey: false, hindsight: null, collaborations: {}, chatSpend: null, memorySpend: [], demoPlans: {}, reviews: {}, spendLimit: null, apiCost: null, golden: null },
  ]);
});

test('ASS-333 AC3: a project\'s apiKey — whether it has an API key to fall back to, as control\'s paymentFor reads it — is true with its .claude-api folder (a host step\'s, dispatch.js configDir) or a VM in its vms.json recording credential-kind both (a VM step\'s, credentialKindOf); false otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'host', 'project.json'), { name: 'Host' });
  mkdirSync(join(dir, 'host', '.claude-api'));
  write(join(dir, 'vm', 'project.json'), { name: 'Vm' });
  write(join(dir, 'vm', 'vms.json'), { 'vm-1': { 'credential-kind': 'claude' }, 'vm-2': { 'credential-kind': 'both' } });
  write(join(dir, 'one', 'project.json'), { name: 'One' });
  write(join(dir, 'one', 'vms.json'), { 'vm-1': { 'credential-kind': 'claude' }, 'vm-2': { 'credential-kind': 'anthropic' }, 'vm-3': {} });
  mkdirSync(join(dir, 'one', '.claude'));   // the subscription's own login is no API key
  write(join(dir, 'none', 'project.json'), { name: 'None' });
  assert.deepEqual(loadProjects(dir).map(p => [p.id, p.apiKey]), [['host', true], ['none', false], ['one', false], ['vm', true]]);
});

test('ASS-191 AC1, AC5: a project\'s spendLimit is its project.json\'s max-spend-per-ticket-usd, else the data folder\'s harness.json\'s, else null', () => {
  const data = mkdtempSync(join(tmpdir(), 'tui-')), dir = join(data, 'projects');
  write(join(dir, 'own', 'project.json'), { name: 'Own', 'max-spend-per-ticket-usd': 100 });
  write(join(dir, 'none', 'project.json'), { name: 'None' });
  assert.deepEqual(loadProjects(dir).map(p => [p.id, p.spendLimit]), [['none', null], ['own', 100]]);
  write(join(data, 'harness.json'), { 'max-spend-per-ticket-usd': 25 });
  assert.deepEqual(loadProjects(dir).map(p => [p.id, p.spendLimit]), [['none', 25], ['own', 100]]);
});

test('ASS-221 AC2: a project\'s apiCost is its own api-cost.json with its api-monthly-budget-usd, when its project.json names an admin key; the harness project\'s the data folder\'s (loadApiCost); any other\'s null, never borrowed', () => {
  const data = mkdtempSync(join(tmpdir(), 'tui-')), dir = join(data, 'projects');
  write(join(data, 'harness.json'), { 'harness-project': 'harness', 'api-monthly-budget-usd': 50 });
  write(join(data, 'api-cost.json'), { month: '2026-10', usd: 3.92, 'as-of': '2026-10-26T13:00:00Z' });
  write(join(dir, 'harness', 'project.json'), { name: 'Harness' });
  write(join(dir, 'keyed', 'project.json'), { name: 'Keyed', 'api-cost-admin-keychain-service': 'k', 'api-monthly-budget-usd': 20 });
  write(join(dir, 'keyed', 'api-cost.json'), { month: '2026-10', usd: 1.5, 'as-of': '2026-10-26T13:00:00Z' });
  write(join(dir, 'unread', 'project.json'), { name: 'Unread', 'api-cost-admin-keychain-service': 'k' });
  write(join(dir, 'stray', 'project.json'), { name: 'Stray' });
  write(join(dir, 'stray', 'api-cost.json'), { month: '2026-10', usd: 9, 'as-of': '2026-10-26T13:00:00Z' });   // no admin key named: not its org's
  assert.deepEqual(Object.fromEntries(loadProjects(dir).map(p => [p.id, p.apiCost])), {
    harness: { month: '2026-10', usd: 3.92, 'as-of': '2026-10-26T13:00:00Z', budget: 50 },
    keyed: { month: '2026-10', usd: 1.5, 'as-of': '2026-10-26T13:00:00Z', budget: 20 },
    stray: null,
    unread: null,
  });
});

test('ASS-188 AC1: the agents grid is as wide and high as the data folder\'s harness.json says — 3 by 2 without it, or without its keys', () => {
  const data = mkdtempSync(join(tmpdir(), 'tui-')), dir = join(data, 'projects');
  write(join(dir, 'own', 'project.json'), { name: 'Own' });
  assert.deepEqual(load.loadHarness(dir), { agentsGridColumns: 3, agentsGridRows: 2 });     // no harness.json at all
  write(join(data, 'harness.json'), { 'max-spend-per-ticket-usd': 25 });
  assert.deepEqual(load.loadHarness(dir), { agentsGridColumns: 3, agentsGridRows: 2 });     // one without either key
  write(join(data, 'harness.json'), { 'agents-grid-columns': 4 });
  assert.deepEqual(load.loadHarness(dir), { agentsGridColumns: 4, agentsGridRows: 2 });
  write(join(data, 'harness.json'), { 'agents-grid-columns': 2, 'agents-grid-rows': 5 });
  assert.deepEqual(load.loadHarness(dir), { agentsGridColumns: 2, agentsGridRows: 5 });
});

test('pauses and assignments are read from assignments.json; no pauses without the key', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tui-')), 'assignments.json');
  const assignments = [{ 'agent-name': 'Daredevil', 'work-item': 'ABC-1' }];
  const pauses = { ai: { since: '2026-10-01T16:00:00Z', reason: 'Fixing', eta: '2026-10-01T16:20:00Z' } };
  write(file, { status: 'Paused', pauses, assignments });
  assert.deepEqual(loadPauses(file), pauses);
  write(file, { status: 'Running', assignments });
  assert.deepEqual(loadPauses(file), {});
  assert.deepEqual(loadAssignments(file), assignments);
});

test('self-healing is read from assignments.json, by fix ticket; {} without the key', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tui-')), 'assignments.json');
  const selfHealing = { 'ABC-1': { since: '2026-10-01T16:00:00Z', summary: 'Fixing', ticket: 'ABC-1', 'ticket-url': null, project: 'example', paused: [] } };
  write(file, { status: 'Paused', 'self-healing': selfHealing, assignments: [] });
  assert.deepEqual(loadSelfHealing(file), selfHealing);
  write(file, { status: 'Running', assignments: [] });
  assert.deepEqual(loadSelfHealing(file), {});
});

test('questions come from the global file and every ticket\'s file, each tagged with the file it is in and its place there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'global-questions-and-answers.json'), { list: [{ question: 'G0' }, { question: 'G1' }] });
  write(join(dir, 'work', 'abc-1', 'questions-and-answers.json'), { list: [{ question: 'T0' }] });
  mkdirSync(join(dir, 'work', 'abc-2'), { recursive: true });
  writeFileSync(join(dir, 'work', 'abc-2', 'questions-and-answers.json'), '');   // an empty file has no questions
  assert.deepEqual(loadQuestions(dir), [
    { question: 'G0', source: 'global', index: 0 },
    { question: 'G1', source: 'global', index: 1 },
    { question: 'T0', source: 'abc-1', index: 0 },
  ]);
  assert.deepEqual(loadQuestions(mkdtempSync(join(tmpdir(), 'tui-'))), []);
});

test('soft-deleted variations are left out of the sprint and its snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  const spike = { key: 'ABC-5', variations: [{ name: 'A', 'is-deleted': true }, { name: 'B' }] };
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [{ key: 'ABC-1' }], spikes: [spike] });
  write(join(dir, 'p', 'sprints', 'days', '2026-09-18.json'), { number: 10, spikes: [spike] });
  const [project] = loadProjects(dir);
  assert.deepEqual(project.sprint.spikes[0].variations, [{ name: 'B' }]);
  assert.deepEqual(project.sprint.features, [{ key: 'ABC-1' }]);
  assert.deepEqual(project.days['2026-09-18'].spikes[0].variations, [{ name: 'B' }]);
});

// ASS-104: a soft-deleted ticket (ticket:delete) is hidden from the dashboard: the sprint, its snapshots, the backlog and the questions.
test('soft-deleted tickets are left out of the sprint, its snapshots and the backlog, and their questions out of the questions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  const gone = { key: 'ABC-5', 'is-deleted': true, 'deleted-timestamp': '2026-10-25T13:00:00Z', variations: [{ name: 'A' }] };
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [{ key: 'ABC-1' }, gone] });
  write(join(dir, 'p', 'sprints', 'days', '2026-09-18.json'), { number: 10, features: [gone] });
  write(join(dir, 'p', 'backlog.json'), { tickets: [{ key: 'ABC-5' }, { key: 'ABC-6', 'is-deleted': true }, { key: 'ABC-7' }] });   // ABC-5 is the sprint's, deleted there
  write(join(dir, 'p', 'work', 'ABC-6', 'questions-and-answers.json'), { list: [{ question: 'Q6', 'asked-on-ticket': 'ABC-6' }] });
  write(join(dir, 'p', 'work', 'ABC-7', 'questions-and-answers.json'), { list: [{ question: 'Q7', 'asked-on-ticket': 'ABC-7' }] });
  const [project] = loadProjects(dir);
  assert.deepEqual(project.sprint.features.map(t => t.key), ['ABC-1']);
  assert.deepEqual(project.days['2026-09-18'].features, []);
  assert.deepEqual(project.backlog.map(t => t.key), ['ABC-7']);
  assert.deepEqual(project.questions.map(q => q.question), ['Q7']);
});

// ASS-202 AC1: backlog is a ticket not Done and not in the active sprint;
// backlogOfSprint (the refinement tab, ASS-42) still carries a Done entry of
// an active-sprint ticket. A ticket reopened from Done returns to the backlog.
test('ASS-202 AC1: a Done backlog entry is hidden from backlog but stays in backlogOfSprint for an active-sprint ticket; reopened, it returns to backlog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'sprints.json'), { list: [{ number: 9, 'is-active': false }, { number: 10, 'is-active': true }] });
  write(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: [{ key: 'ABC-2' }] });
  // ABC-1 Done not in active sprint → hidden; abc-2 Done but in active sprint → kept entry visible in backlogOfSprint; ABC-3 plain Backlog visible.
  write(join(dir, 'p', 'backlog.json'), { tickets: [{ key: 'ABC-1', 'ticket-system-status': 'Done' }, { key: 'abc-2', 'ticket-system-status': 'Done' }, { key: 'ABC-3' }] });
  const [p] = loadProjects(dir);
  assert.deepEqual(p.backlog.map(t => t.key), ['ABC-3']);
  assert.deepEqual(p.backlogOfSprint.map(t => t.key), ['abc-2']);
  // Reopened: ABC-1's status back to Backlog, it reappears.
  write(join(dir, 'p', 'backlog.json'), { tickets: [{ key: 'ABC-1', 'ticket-system-status': 'Backlog' }, { key: 'abc-2', 'ticket-system-status': 'Done' }, { key: 'ABC-3' }] });
  assert.deepEqual(loadProjects(dir)[0].backlog.map(t => t.key), ['ABC-1', 'ABC-3']);
});

test('a ticket\'s manual-priority, once set, is its priority, in the sprint and its snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  const tickets = [{ key: 'ABC-1', priority: 4, 'manual-priority': 1 }, { key: 'ABC-2', priority: 2, 'manual-priority': null }, { key: 'ABC-3', priority: 3 }];
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'sprints.json'), { list: [{ number: 10, 'is-active': true }] });
  write(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), { number: 10, features: tickets });
  write(join(dir, 'p', 'sprints', 'days', '2026-09-18.json'), { number: 10, bugs: tickets });
  const [project] = loadProjects(dir);
  assert.deepEqual(project.sprint.features.map(t => t.priority), [1, 2, 3]);
  assert.equal(project.sprint.features[0]['manual-priority'], 1);
  assert.deepEqual(project.days['2026-09-18'].bugs.map(t => t.priority), [1, 2, 3]);
});

test('watchFiles calls back once a watched file changes — renamed into place, as the agent-cli writes, or written — once per burst; not for files beside it; not after close', async t => {
  // Events arrive when the OS sends them, seconds late on a busy machine
  // (ASS-109): each case watches folders of its own, so no late event of
  // another case reaches it; it waits for a call rather than a fixed time, and
  // for quiet before counting. A burst's events can arrive spread out, so its
  // case waits longer for quiet before calling back.
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const watching = async (delay = 50) => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-'));
    mkdirSync(join(dir, 'days'));
    const files = { sprint: join(dir, 'sprint.json'), assignments: join(dir, 'assignments.json'), shown: join(dir, 'days', '2026-09-20.json'), other: join(dir, 'days', '2026-09-21.json') };
    const w = { ...files, calls: 0 };
    const watcher = watchFiles([files.sprint, files.assignments, files.shown], () => { w.calls++; }, { delay });
    t.after(() => watcher.close());                                 // even when an assertion fails
    await wait(500);                                                 // macOS can report the folders' making late
    return Object.assign(w, { calls: 0, close: () => watcher.close() });
  };
  const called = w => until(() => w.calls > 0);

  const renamed = await watching();
  writeFileSync(`${renamed.sprint}.tmp`, '{}');
  renameSync(`${renamed.sprint}.tmp`, renamed.sprint);
  assert.ok(await called(renamed), 'renamed into place');

  const written = await watching();
  writeFileSync(written.shown, '{}');
  assert.ok(await called(written), 'written');

  const burst = await watching(500);
  for (let i = 0; i < 3; i++) writeFileSync(burst.assignments, JSON.stringify({ i }));
  assert.ok(await called(burst));
  await wait(1000);
  assert.equal(burst.calls, 1, 'a burst is one call');

  const beside = await watching();
  writeFileSync(beside.other, '{}');                                 // a snapshot not on show
  writeFileSync(`${beside.assignments}.lock`, '');
  await wait(1000);
  assert.equal(beside.calls, 0, 'files beside them');

  const closed = await watching();
  closed.close();
  writeFileSync(closed.assignments, '{"a":1}');
  await wait(1000);
  assert.equal(closed.calls, 0, 'after close');
});

test('each ticket\'s chat (work/<KEY>/collaboration.json, ASS-35) comes with its project, by ticket folder; none without the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'work', 'ABC-1', 'collaboration.json'), { 'session-id': 's', briefed: null, turns: [] });
  write(join(dir, 'p', 'work', 'ABC-2', 'questions-and-answers.json'), { list: [] });
  assert.deepEqual(loadProjects(dir)[0].collaborations, { 'ABC-1': { 'session-id': 's', briefed: null, turns: [] } });
});

test('ASS-271: the project\'s chat-screen turns (chat-spend.json) come with it as chatSpend; null without the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'q', 'project.json'), { name: 'Q' });
  write(join(dir, 'p', 'chat-spend.json'), { turns: [{ timestamp: '2026-10-30T12:00:00Z', chat: 'c', billing: 'api', 'cost-usd': 0.5 }] });
  assert.deepEqual(loadProjects(dir).map(p => p.chatSpend), [{ turns: [{ timestamp: '2026-10-30T12:00:00Z', chat: 'c', billing: 'api', 'cost-usd': 0.5 }] }, null]);
});

test('each variation\'s demo plan (work/<KEY>/demo-plan-<variation>.json, ASS-76) comes with its project, by ticket folder and variation; none without the file, nothing for one not JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  write(join(dir, 'p', 'work', 'ABC-1', 'demo-plan-A.json'), { demo: false, why: 'nothing to see' });
  write(join(dir, 'p', 'work', 'ABC-1', 'demo-plan-B.json'), { demo: true, 'look-at': ['x'] });
  write(join(dir, 'p', 'work', 'ABC-2', 'questions-and-answers.json'), { list: [] });
  mkdirSync(join(dir, 'p', 'work', 'ABC-3'), { recursive: true });
  writeFileSync(join(dir, 'p', 'work', 'ABC-3', 'demo-plan-A.json'), '{ half written');
  assert.deepEqual(loadProjects(dir)[0].demoPlans, { 'ABC-1': { A: { demo: false, why: 'nothing to see' }, B: { demo: true, 'look-at': ['x'] } } });
});

test('loadChats reads chats.json\'s chats (ASS-33); none without the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chats-'));
  assert.deepEqual(loadChats(join(dir, 'chats.json')), []);
  write(join(dir, 'chats.json'), { chats: [{ id: 'c1', project: 'p', title: 'T', created: 'c', 'session-id': null }] });
  assert.deepEqual(loadChats(join(dir, 'chats.json')).map(c => c.id), ['c1']);
});

test('dataFiles: every file the dashboard reads (ASS-307: push-account.json too; ASS-333: vms.json; ASS-355: outside-tickets.json), with one sprint file — the selected project\'s active sprint.json, or the snapshot of the past day on show', () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-'));
  const p = name => join(root, 'data', 'projects', name);
  write(join(p('a'), 'sprints.json'), { list: [{ number: 9 }, { number: 10, 'is-active': true }] });
  mkdirSync(join(p('a'), 'work', 'abc-1'), { recursive: true });
  mkdirSync(p('b'), { recursive: true });
  const state = { projects: [{ id: 'a' }, { id: 'b' }], workflows: [{ name: 'standard' }], project: 0, day: null };
  const common = [
    join(root, 'data', 'assignments.json'), join(root, 'data', 'chats.json'), join(root, 'data', 'api-cost.json'), join(root, 'data', 'context-windows.json'), join(root, 'data', 'harness.json'), join(root, 'data', 'disk-space.json'), join(root, 'engines', 'standard', 'state-engine.json'),
    join(p('a'), 'project.json'), join(p('a'), 'gcloud-requires-reauthentication'), join(p('a'), 'glab-requires-reauthentication'), join(p('a'), 'rate-limit.json'), join(p('a'), 'claude-usage.json'), join(p('a'), 'push-account.json'), join(p('a'), 'api-cost.json'), join(p('a'), 'memory-spend.json'), join(p('a'), 'sprints.json'), join(p('a'), 'backlog.json'), join(p('a'), 'global-questions-and-answers.json'), join(p('a'), 'chat-spend.json'), join(p('a'), 'vms.json'), join(p('a'), 'outside-tickets.json'), join(p('a'), 'work', 'abc-1', 'questions-and-answers.json'), join(p('a'), 'work', 'abc-1', 'collaboration.json'),
    join(p('b'), 'project.json'), join(p('b'), 'gcloud-requires-reauthentication'), join(p('b'), 'glab-requires-reauthentication'), join(p('b'), 'rate-limit.json'), join(p('b'), 'claude-usage.json'), join(p('b'), 'push-account.json'), join(p('b'), 'api-cost.json'), join(p('b'), 'memory-spend.json'), join(p('b'), 'sprints.json'), join(p('b'), 'backlog.json'), join(p('b'), 'global-questions-and-answers.json'), join(p('b'), 'chat-spend.json'), join(p('b'), 'vms.json'), join(p('b'), 'outside-tickets.json'),
  ];
  assert.deepEqual(dataFiles(root, state), [...common, join(p('a'), 'sprints', 'sprint-10', 'sprint.json')]);
  assert.deepEqual(dataFiles(root, { ...state, day: '2026-09-20' }), [...common, join(p('a'), 'sprints', 'days', '2026-09-20.json')]);
  assert.deepEqual(dataFiles(root, { ...state, project: 1 }), common);   // no active sprint
});

test('keepSame keeps every part of the old value still equal to the new, so only what changed is new', () => {
  const prev = { a: { b: [1, { c: 2 }] }, d: { e: 3 }, f: 'x' };
  assert.equal(keepSame(prev, structuredClone(prev)), prev);           // nothing changed: the very same value
  const next = keepSame(prev, { a: { b: [1, { c: 2 }] }, d: { e: 4 }, f: 'x' });
  assert.deepEqual(next, { a: { b: [1, { c: 2 }] }, d: { e: 4 }, f: 'x' });
  assert.notEqual(next, prev);
  assert.equal(next.a, prev.a);                                       // untouched branches are kept
  assert.notEqual(next.d, prev.d);
  assert.notEqual(keepSame(prev, { ...prev, g: 1 }), prev);            // a key added
  assert.notEqual(keepSame([1, 2], [1]), [1, 2]);                      // an item gone
  assert.deepEqual(keepSame({ a: 1 }, null), null);
});

test('a file read again unchanged is not parsed again: the same objects come back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'assignments.json'), { status: 'Running', assignments: [{ 'agent-name': 'A' }] });
  assert.equal(loadAssignments(join(dir, 'assignments.json')), loadAssignments(join(dir, 'assignments.json')));
});

test('the transient state engines are read from assignments.json; none without the key', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tui-')), 'assignments.json');
  const engines = [{ id: 'a2c1a0e1', project: 'example', 'state-engine': 'self-healing', state: 'init', 'start-time': '2024-06-06T00:02:00Z' }];
  write(file, { status: 'Running', assignments: [], 'transient-state-engines': engines });
  assert.deepEqual(loadTransientEngines(file), engines);
  write(file, { status: 'Running', assignments: [] });
  assert.deepEqual(loadTransientEngines(file), []);
});

test('projectsChanged: the projects whose own data changed — their files, or their records and runs in assignments.json — never another project\'s (ASS-10)', () => {
  const before = {
    projects: [{ id: 'a', name: 'A', sprint: { number: 1 } }, { id: 'b', name: 'B', sprint: null }],
    assignments: [{ 'agent-name': 'X', project: 'a', status: 'Running' }, { 'agent-name': 'Y', project: 'b', status: 'Running' }],
    transientEngines: [{ id: 'r', project: 'b', state: 's1' }],
  };
  assert.deepEqual(projectsChanged(before, before), []);
  assert.deepEqual(projectsChanged(before, { ...before, projects: [{ ...before.projects[0], sprint: { number: 2 } }, before.projects[1]] }), ['a']);
  assert.deepEqual(projectsChanged(before, { ...before, assignments: [before.assignments[0], { ...before.assignments[1], status: 'Ended' }] }), ['b']);
  assert.deepEqual(projectsChanged(before, { ...before, transientEngines: [{ ...before.transientEngines[0], state: 's2' }] }), ['b']);
  assert.deepEqual(projectsChanged(before, { ...before, assignments: [...before.assignments, { 'agent-name': 'Z', project: 'a' }] }), ['a']);
});

test('loadWorkflows: each engine\'s steps in sequence order, and its *-steps lists, for the sub-flowcharts (ASS-7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'e', 'state-engine.json'), { steps: [{ id: 'b', sequence: 2 }, { id: 'a', sequence: 1 }], 'check-health-steps': [{ id: 'check-health', sequence: 1 }], 'shut-down-prompt': 'x' });
  assert.deepEqual(loadWorkflows(dir), [{ name: 'e', steps: [{ id: 'a', sequence: 1 }, { id: 'b', sequence: 2 }], lists: { 'check-health-steps': [{ id: 'check-health', sequence: 1 }] } }]);
});

test('ASS-277: loadWorkflows with the projects folder sees each project\'s own engines (data/projects/<id>/engines, ASS-276), ahead of engines/\'s, each with its project and file — as control\'s loadState does; dataFiles watches each at that file; projectWorkflows keeps the selected project\'s own alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-'));
  const engines = join(root, 'engines'), projects = join(root, 'data', 'projects');
  write(join(engines, 'shared', 'state-engine.json'), { steps: [{ id: 's', sequence: 1 }] });
  write(join(projects, 'a', 'engines', 'a-flow', 'state-engine.json'), { steps: [{ id: 'own', sequence: 1 }] });
  write(join(projects, 'b', 'engines', 'shared', 'state-engine.json'), { steps: [{ id: 'b-only', sequence: 1 }] });
  mkdirSync(join(projects, 'c'), { recursive: true });   // no engines of its own
  const workflows = loadWorkflows(engines, projects);
  assert.deepEqual(workflows.map(w => [w.name, w.project, w.file, w.steps[0].id]), [
    ['a-flow', 'a', join(projects, 'a', 'engines', 'a-flow', 'state-engine.json'), 'own'],
    ['shared', 'b', join(projects, 'b', 'engines', 'shared', 'state-engine.json'), 'b-only'],
    ['shared', undefined, undefined, 's'],
  ]);
  assert.deepEqual(loadWorkflows(engines).map(w => w.name), ['shared']);   // without the projects folder, engines/'s alone
  const files = dataFiles(root, { projects: [], workflows, project: 0, day: null });
  for (const f of [join(projects, 'a', 'engines', 'a-flow', 'state-engine.json'), join(projects, 'b', 'engines', 'shared', 'state-engine.json'), join(engines, 'shared', 'state-engine.json')]) assert.ok(files.includes(f), f);
  const { projectWorkflows } = await import('../../src/tui/screens/shared.js');
  const seen = id => projectWorkflows({ projects: [{ id }], project: 0, workflows }).map(w => `${w.name}:${w.steps[0].id}`);
  assert.deepEqual(seen('a'), ['a-flow:own', 'shared:s']);
  assert.deepEqual(seen('b'), ['shared:b-only', 'shared:s']);   // its own first: a lookup by name finds it
  assert.deepEqual(seen('c'), ['shared:s']);
});

// ASS-118: what Human Review shows, from the ticket's folder.
const RESULTS = `# Automated test results — ABC-1 A, 2026-10-24T10:00:00Z

## ✓ npm test (exit 1: every failure is one master has too)

Pre-existing failures, failing on master too:
- suite a > slow clock
- db: V173 leaves sync disabled

\`\`\`
output
\`\`\`

## ✓ npm run lint (exit 0)
`;

test('ASS-118: each ticket\'s review comes with its project — each variation\'s explanation, risk profile (its own, else the ticket\'s risk-assessment.md) and pre-existing test failures, and the screenshots by merge request id ("" the ticket\'s own), as file paths; and (ASS-261) its plans, root cause analysis and risk assessments by file name, as paths, a review of one not among them; none for a folder with none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'p', 'project.json'), { name: 'P' });
  const folder = join(dir, 'p', 'work', 'ABC-1');
  mkdirSync(join(folder, 'screenshots', '2'), { recursive: true });
  writeFileSync(join(folder, 'explanation-A.md'), 'Cites the reporter.\n');
  writeFileSync(join(folder, 'risk-assessment-A.md'), 'Low risk.\n');
  writeFileSync(join(folder, 'risk-assessment.md'), 'Old shared.\n');
  writeFileSync(join(folder, 'execution-plan-A.md'), '# Plan\n');
  writeFileSync(join(folder, 'root-cause-analysis-review-A.md'), '# Review\n');
  writeFileSync(join(folder, 'automated-test-results-A.md'), RESULTS);
  writeFileSync(join(folder, 'automated-test-results-B.md'), '# Automated test results — ABC-1 B\n\n## ✓ npm test (exit 0)\n');
  writeFileSync(join(folder, 'screenshots', 'criterion-1.png'), '');
  writeFileSync(join(folder, 'screenshots', 'notes.txt'), '');
  writeFileSync(join(folder, 'screenshots', '2', 'criterion-2.png'), '');
  write(join(dir, 'p', 'work', 'ABC-2', 'questions-and-answers.json'), { list: [] });
  assert.deepEqual(loadProjects(dir)[0].reviews, { 'ABC-1': {
    explanations: { A: 'Cites the reporter.\n' },
    risks: { A: 'Low risk.\n', '': 'Old shared.\n' },
    preExisting: { A: ['suite a > slow clock', 'db: V173 leaves sync disabled'], B: [] },
    screenshots: { '': [join(folder, 'screenshots', 'criterion-1.png')], 2: [join(folder, 'screenshots', '2', 'criterion-2.png')] },
    documents: Object.fromEntries(['execution-plan-A.md', 'risk-assessment-A.md', 'risk-assessment.md'].map(file => [file, join(folder, file)])),
  } });
});

// ASS-190 AC3: the TUI reads model prices and context windows for contextLabel/
// costLabel. loadModelUsage takes the projects folder (like loadHarness, unlike
// loadApiCost's data folder): prices from harness.json's model-prices, windows
// the learned context-windows.json merged with harness.json's own
// context-windows (the latter winning per model).
test('ASS-190 AC3: loadModelUsage reads prices and the merged windows, harness.json\'s context-windows winning per model; {} for each when absent', () => {
  const data = mkdtempSync(join(tmpdir(), 'tui-')), dir = join(data, 'projects');
  assert.deepEqual(load.loadModelUsage(dir), { prices: {}, windows: {} });                        // neither file
  write(join(data, 'harness.json'), { 'model-prices': { m: { input: 3 } }, 'context-windows': { m: 100 } });
  write(join(data, 'context-windows.json'), { m: 50, n: 200 });
  assert.deepEqual(load.loadModelUsage(dir), { prices: { m: { input: 3 } }, windows: { m: 100, n: 200 } });
});

test('ASS-190 AC3: loadModelUsage gives { prices: {}, windows: {} } with a harness.json that has neither key, no throw', () => {
  const data = mkdtempSync(join(tmpdir(), 'tui-')), dir = join(data, 'projects');
  write(join(data, 'harness.json'), { 'max-agents': null });
  assert.deepEqual(load.loadModelUsage(dir), { prices: {}, windows: {} });
});

test('loadApiCost: data/api-cost.json (ASS-153) with harness.json\'s api-monthly-budget-usd as budget (null without); null without the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  write(join(dir, 'harness.json'), { 'max-agents': null });
  assert.equal(loadApiCost(dir), null);
  write(join(dir, 'api-cost.json'), { month: '2026-10', usd: 12.34, 'as-of': '2026-10-26T13:00:00Z' });
  assert.deepEqual(loadApiCost(dir), { month: '2026-10', usd: 12.34, 'as-of': '2026-10-26T13:00:00Z', budget: null });
  write(join(dir, 'harness.json'), { 'api-monthly-budget-usd': 50 });
  assert.equal(loadApiCost(dir).budget, 50);
});

test('ASS-288 AC2: loadDiskSpace: the data folder\'s disk-space.json (control\'s last reading of the disk); null without it, or caught half-written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-'));
  assert.equal(loadDiskSpace(dir), null);
  write(join(dir, 'disk-space.json'), { level: 'warn', 'free-bytes': 42e9, 'warn-bytes': 50e9, 'hold-bytes': 15e9 });
  assert.deepEqual(loadDiskSpace(dir), { level: 'warn', 'free-bytes': 42e9, 'warn-bytes': 50e9, 'hold-bytes': 15e9 });
  writeFileSync(join(dir, 'disk-space.json'), '{"level": "wa');
  assert.equal(loadDiskSpace(dir), null);
});

test('ASS-292: a project\'s golden image is the Lima instance golden-<id> in the Lima folder, with when its golden-image.json says it was built; not built without one; none without a golden-image in project.json', () => {
  const lima = mkdtempSync(join(tmpdir(), 'lima-'));
  assert.equal(load.loadGolden('p', {}, lima), null);
  assert.deepEqual(load.loadGolden('p', { 'golden-image': { folder: 'projects/p/golden-image' } }, lima), { name: 'golden-p', 'built-at': null });
  mkdirSync(join(lima, 'golden-p'));
  writeFileSync(join(lima, 'golden-p', 'golden-image.json'), JSON.stringify({ project: 'p', hash: 'h', 'built-at': '2026-11-01T05:42:33Z' }));
  assert.deepEqual(load.loadGolden('p', { 'golden-image': { folder: 'projects/p/golden-image' } }, lima), { name: 'golden-p', 'built-at': '2026-11-01T05:42:33Z' });
  writeFileSync(join(lima, 'golden-p', 'golden-image.json'), '{ half');   // caught half-written
  assert.deepEqual(load.loadGolden('p', { 'golden-image': {} }, lima), { name: 'golden-p', 'built-at': null });
});

test('ASS-292: dataFiles watches each project\'s golden image in the Lima folder, as its golden-<id> entry there — the folder vm:build-golden swaps in by rename; a project without one adds nothing', () => {
  const root = '/r', lima = '/lima';
  const state = { projects: [{ id: 'a', golden: { name: 'golden-a', 'built-at': null } }, { id: 'b', golden: null }], workflows: [], project: 0, day: null };
  const files = dataFiles(root, state, lima);
  assert.ok(files.includes(join(lima, 'golden-a')));
  assert.ok(!files.some(f => f.includes('golden-b')));
  assert.deepEqual(dataFiles(root, { ...state, projects: [{ id: 'b', golden: null }] }, lima).filter(f => f.startsWith(lima)), []);
});

test('ASS-292: a golden image rebuilt as vm:build-golden does it — built beside as golden-<id>-build, the old one deleted, the build renamed over it — wakes the dashboard\'s watcher; the build folder\'s own writes do not', async t => {
  const lima = mkdtempSync(join(tmpdir(), 'lima-'));
  const golden = join(lima, 'golden-p'), build = join(lima, 'golden-p-build');
  mkdirSync(golden);
  writeFileSync(join(golden, 'golden-image.json'), JSON.stringify({ 'built-at': '2026-11-01T05:42:33Z' }));
  let calls = 0;
  const watcher = watchFiles([golden], () => { calls++; });
  t.after(() => watcher.close());
  await new Promise(resolve => setTimeout(resolve, 500));          // macOS can report the folder's making late
  calls = 0;
  mkdirSync(build);
  writeFileSync(join(build, 'golden-image.json'), JSON.stringify({ 'built-at': '2026-11-07T12:00:00Z' }));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(calls, 0, 'the build folder is not watched');
  rmSync(golden, { recursive: true });
  renameSync(build, golden);
  await until(() => calls > 0, 10_000);
  assert.equal(load.loadGolden('p', { 'golden-image': {} }, lima)['built-at'], '2026-11-07T12:00:00Z');
});
