// team:update (ASS-409): data/projects/<project>/team.json kept from the
// analytics data through agent.sh, under team.json's lock, a status's meaning
// from the engines the project runs. Invented people and repositories only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const today = () => new Date().toLocaleDateString('sv');   // YYYY-MM-DD, local, as `date +%F`

const ADA = { id: 'a1', name: 'Ada Lovelace' }, LIN = { id: 'q1', name: 'Lin Tester' };
const at = d => `2026-11-0${d}T10:00:00.000Z`;
const change = (d, from, to, by) => ({ at: at(d), from, to, by });

// fixture({ engine, own }) — a project p running engine `main` (engines/'s, or its own when own), which runs `sub`
// through a state-engine step; sub pairs Checking with an is-qa step and Finished with an is-done one.
function fixture({ own = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'team-update-'));
  const projects = join(dir, 'projects'), engines = join(dir, 'engines'), p = join(projects, 'p');
  mkdirSync(join(p, 'analytics'), { recursive: true });
  writeFileSync(join(p, 'project.json'), JSON.stringify({ 'execution-state-engine': 'main' }));
  const main = { steps: [{ id: 'build', 'paired-ticket-system-status': 'Working' }, { id: 'go', action: { type: 'state-engine', engine: 'sub' } }] };
  const sub = { steps: [{ id: 'check', 'paired-ticket-system-status': 'Checking', 'is-qa': true }, { id: 'done', 'paired-ticket-system-status': 'Finished', 'is-done': true }] };
  for (const [base, name, engine] of [[engines, 'main', main], [own ? join(p, 'engines') : engines, 'sub', sub], [engines, 'unused', { steps: [{ id: 'x', 'paired-ticket-system-status': 'Working', 'is-qa': true }] }]]) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, 'state-engine.json'), JSON.stringify(engine));
  }
  const file = join(p, 'team.json');
  const write = (name, value) => writeFileSync(join(p, name), typeof value === 'string' ? value : JSON.stringify(value));
  const cli = (project = 'p', env = {}) => run(AGENT, ['team:update', project], { env: { ...process.env, PROJECTS_DIR: projects, ENGINES_DIR: engines, ...env } });
  return { dir, file, write, cli, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

// Ada builds PROJ-1 and hands it to Lin in Checking, who moves it to Finished; Ada merges two merge requests as "ada".
const TICKETS = { 'fetched-through': at(9), tickets: { 'PROJ-1': {
  key: 'PROJ-1', title: 'Login', type: 'Story', created: at(1), points: 2, assignee: LIN, status: 'Finished', sprints: [],
  'status-changes': [change(2, 'Ready', 'Working', ADA), change(3, 'Working', 'Checking', ADA), change(4, 'Checking', 'Finished', LIN)],
  'assignee-changes': [{ at: at(1), from: null, to: ADA }, { at: at(3), from: ADA, to: LIN }],
} } };
const MRS = { 'fetched-through': {}, 'merge-requests': {
  'group/app!1': { repo: 'group/app', host: 'gitlab', iid: 1, title: 'PROJ-1 login', branch: 'proj-1', author: { username: 'ada', name: 'Ada Lovelace' }, 'merged-at': at(3) },
  'group/app!2': { repo: 'group/app', host: 'gitlab', iid: 2, title: 'Bump', branch: 'deps', author: { username: 'deps-bot', name: 'Dependency Bot' }, 'merged-at': at(4) },
} };

test('ASS-409 AC1/AC2/AC7: team:update writes team.json through agent.sh, printing a line naming each member added', async () => {
  const f = fixture();
  f.write('analytics/tickets.json', TICKETS);
  f.write('analytics/merge-requests.json', MRS);
  const { stdout } = await f.cli();
  assert.deepEqual(stdout.trim().split('\n'), [
    'team: added Ada Lovelace (developer, git ada, linked by name)',
    'team: added Dependency Bot (bot, git deps-bot)',
  ]);
  assert.deepEqual(f.read(), { members: [
    { 'ticket-system-id': 'a1', 'ticket-system-name': 'Ada Lovelace', 'git-username': 'ada', 'git-name': 'Ada Lovelace', role: 'developer', 'matched-by': 'name', 'first-seen': today(), 'set-by-operator': [] },
    { 'ticket-system-id': null, 'ticket-system-name': null, 'git-username': 'deps-bot', 'git-name': 'Dependency Bot', role: 'bot', 'matched-by': null, 'first-seen': today(), 'set-by-operator': [] },
  ] });
  assert.ok(existsSync(`${f.file}.lock`));   // update_json's lock file, held across the read and the write
  // Nothing new: nothing printed, the file not rewritten.
  const before = statSync(f.file).mtimeMs;
  const again = await f.cli();
  assert.equal(again.stdout, '');
  assert.equal(statSync(f.file).mtimeMs, before);
});

test('ASS-409 AC4: QA comes from the engines the project runs — a project\'s own engine reached through its execution engine — never a status name', async () => {
  // Lin is credited on PROJ-2 (so she is a member) and moves PROJ-1 out of Checking: 1 of 2 changes, half: qa.
  const tickets = structuredClone(TICKETS);
  tickets.tickets['PROJ-2'] = { key: 'PROJ-2', title: 'Search', type: 'Story', created: at(1), points: 1, assignee: LIN, status: 'Finished', sprints: [],
    'status-changes': [change(5, 'Ready', 'Finished', LIN)], 'assignee-changes': [] };
  const f = fixture({ own: true });
  f.write('analytics/tickets.json', tickets);
  await f.cli();
  assert.equal(f.read().members.find(m => m['ticket-system-id'] === 'q1').role, 'qa');
  // engines/unused, which the project does not run, would make Working a QA status and Ada (1 of 2 out of Working) qa.
  assert.equal(f.read().members.find(m => m['ticket-system-id'] === 'a1').role, 'developer');
  // With no engine, no status is QA or done: no one is credited.
  const bare = fixture();
  bare.write('project.json', {});
  bare.write('analytics/tickets.json', tickets);
  await bare.cli();
  assert.deepEqual(bare.read().members, []);
});

test('ASS-409 AC6: a prototype-shaped team.json on disk is rewritten in the new shape, saying so', async () => {
  const f = fixture();
  f.write('team.json', { members: [
    { 'jira-account-id': 'p1', 'jira-name': 'Pat Product', 'gitlab-username': 'pat', 'gitlab-name': 'Pat', role: 'product', 'matched-by': 'operator', 'first-seen': '2026-10-01', 'set-by-operator': ['gitlab-name'] },
  ] });
  const { stdout } = await f.cli();
  assert.match(stdout, /rewritten from the earlier/);
  assert.deepEqual(f.read(), { members: [
    { 'ticket-system-id': 'p1', 'ticket-system-name': 'Pat Product', 'git-username': 'pat', 'git-name': 'Pat', role: 'product', 'matched-by': 'operator', 'first-seen': '2026-10-01', 'set-by-operator': ['git-name'] },
  ] });
});

test('ASS-409: team:update fails, writing nothing, on a bad project, a team.json not JSON or without a members list', async () => {
  const f = fixture();
  await assert.rejects(f.cli('../x'), /invalid project/);
  await assert.rejects(f.cli('nope'), /no project nope/);
  f.write('team.json', '{ not json');
  await assert.rejects(f.cli(), /team.json is not JSON/);
  assert.equal(readFileSync(f.file, 'utf8'), '{ not json');
  f.write('team.json', '{"people": []}');
  await assert.rejects(f.cli(), /not \{ members/);
  f.write('team.json', '{"members": []}');
  f.write('analytics/tickets.json', '{ broken');
  await assert.rejects(f.cli(), /analytics\/tickets.json is not JSON/);
  assert.equal(readFileSync(f.file, 'utf8'), '{"members": []}');
});
