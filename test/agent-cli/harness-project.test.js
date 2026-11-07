// The harness as a project of its own: its off-board tickets (ASS-n) live in
// its sprint and its work folders, wherever the problem was found. A fix
// ticket raised by project p's self-healing joins h's sprint; the tickets it
// pauses are p's, paused and unpaused in p.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { fixture, run, SELF_HEALING_ENGINE } from './harness-fixture.js';

const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4)); };

// The fixture with a second project, h — the harness's own: only an off-board
// work source (folder h), sprint 1 active and empty — and the Self Healing and
// Blocked for Human steps in the execution engine; one off-board ticket, ASS-1,
// raised from p (which has no off-board source).
async function withHarness() {
  const f = fixture();
  f.env.OFF_BOARD_DIR = join(f.dir, 'off-board');
  const at = (...rest) => join(f.dir, ...rest);
  write(at('projects', 'h', 'project.json'), { name: 'Harness', 'execution-state-engine': 'example-development', 'work-sources': [{ name: 'Harness Ticket', type: 'off-board', folder: 'h', 'key-prefix': 'ASS' }] });
  write(at('projects', 'h', 'sprints.json'), { list: [{ number: 1, 'is-active': true }] });
  write(at('projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), { number: 1, features: [], bugs: [], spikes: [] });
  write(at('projects', 'q', 'project.json'), { name: 'Q', 'execution-state-engine': 'example-development', 'work-sources': [] });
  write(at('harness.json'), { ...JSON.parse(readFileSync(at('harness.json'), 'utf8')), 'harness-project': 'h' });   // h is named the harness project
  const engine = JSON.parse(readFileSync(at('engines', 'example-development', 'state-engine.json'), 'utf8'));
  engine.steps.unshift(
    { id: 'self-healing', sequence: 0, area: 'quarantine', 'paired-ticket-system-status': 'In Progress', action: { type: 'state-engine', engine: 'self-healing-fix' } },
    { id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'paired-ticket-system-status': 'In Progress', action: { type: 'human' } },
    { id: 'backlog', sequence: 0, 'paired-ticket-system-status': 'Backlog', action: { type: 'none' } },
  );
  write(at('engines', 'example-development', 'state-engine.json'), engine);
  await run(OFF_BOARD, ['ticket:create', 'p', 'Bug', 'Raised from p'], { env: f.env });
  const sprint = project => JSON.parse(readFileSync(at('projects', project, 'sprints', project === 'h' ? 'sprint-1' : 'sprint-10', 'sprint.json'), 'utf8'));
  const keys = project => Object.values(sprint(project)).filter(Array.isArray).flat().map(t => t.key);
  const ass1 = () => sprint('h').bugs.find(t => t.key === 'ASS-1');
  return { ...f, at, sprint, keys, ass1 };
}

test('the fix ticket raised from p goes to the harness project: off-board in h\'s folder, joined to h\'s sprint, never p\'s', async () => {
  const f = await withHarness();
  assert.ok(existsSync(f.at('off-board', 'h', 'ASS-1.md')));
  await f.agent('ticket:join-sprint', 'p', 'ASS-1', 'self-healing');
  assert.equal(f.ass1().variations[0]['harness-status'].state, 'self-healing');
  assert.ok(!f.keys('p').includes('ASS-1'));
  await f.agent('self-healing:hand-to-human', 'p', 'ASS-1', 'Broken', 'Add the token');
  assert.deepEqual([f.ass1().variations[0]['harness-status'].state, f.ass1().variations[0]['ai-feedback-short']], ['blocked-for-human', 'Add the token']);
});

test('ticket:join-sprint renumbers the backlog: the joined ticket keeps its backlog entry and last priority, the rest close up; it arrives with manual-priority null (ASS-84, ASS-100 AC3)', async () => {
  const f = await withHarness();
  write(f.at('projects', 'h', 'backlog.json'), { tickets: [
    { key: 'ASS-1', priority: 4, 'manual-backlog-priority': 1, dependencies: [] },
    { key: 'ASS-7', priority: 9, 'manual-backlog-priority': null, dependencies: [] },
  ] });
  await f.agent('ticket:join-sprint', 'p', 'ASS-1', 'self-healing');
  assert.deepEqual(f.ass1()['manual-priority'], null);
  assert.equal('manual-backlog-priority' in f.ass1(), false);
  const backlog = JSON.parse(readFileSync(f.at('projects', 'h', 'backlog.json'), 'utf8')).tickets;
  assert.deepEqual(backlog.map(t => [t.key, t.priority, t['manual-backlog-priority']]), [['ASS-1', 4, 1], ['ASS-7', 1, null]]);
});

test('take-on records the plan on h\'s ticket; start, run in h, pauses p\'s tickets in p and records where each is; stop unpauses them there', async () => {
  const f = await withHarness();
  await f.agent('self-healing:take-on', 'p', 'ASS-1', 'Dev container broken', '-', 'ABC-3');
  assert.deepEqual(f.ass1()['self-healing-plan'], { summary: 'Dev container broken', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  await f.agent('self-healing:start', 'h', 'ASS-1');                     // self-healing-fix runs on the ticket, in h
  const record = f.assignments()['self-healing']['ASS-1'];
  assert.equal(record.project, 'h');
  assert.deepEqual(record.paused, [{ project: 'p', ticket: 'ABC-3', variation: 'A' }, { project: 'p', ticket: 'ABC-3', variation: 'B' }, { project: 'p', ticket: 'ABC-3', variation: 'C' }]);
  assert.deepEqual(f.sprint('p').features[0].variations.map(v => v['is-paused'] ?? false), [true, true, true, false]);
  await f.agent('self-healing:stop', 'h', 'ASS-1');
  assert.deepEqual(f.sprint('p').features[0].variations.map(v => v['is-paused'] ?? false), [false, false, false, false]);
});

test('a run in p files its reports in the fix ticket\'s folder in h; an agent working for ASS-1 gets h\'s folder and ticket.json, whatever project its record names', async () => {
  const f = await withHarness();
  write(f.at('projects', 'p', 'work', `run-${SELF_HEALING_ENGINE}`, 'harness.md'), 'H');
  await f.agent('ticket:adopt-run-folder', 'p', 'ASS-1', SELF_HEALING_ENGINE);
  assert.deepEqual(readdirSync(f.at('projects', 'h', 'work', 'ASS-1')), ['harness.md']);
  await f.agent('ticket:join-sprint', 'p', 'ASS-1', 'self-healing');
  const file = f.at('assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(data.assignments.find(a => a['agent-name'] === 'Leia'), { 'work-item': 'ASS-1', variation: null });   // a self-healing run's agent, record in p
  writeFileSync(file, JSON.stringify(data, null, 4));
  writeFileSync(f.at('prompts', 'find-existing-ticket', 'prompt.txt'), 'Folder {ticket-folder}\n');
  await f.agent('agent:dispatch', 'Leia');
  assert.match(f.inbox('Leia', '20261008T000000Z')[0], new RegExp(`Folder ${f.at('projects', 'h', 'work', 'ASS-1')}$`));
  assert.equal(JSON.parse(readFileSync(f.at('projects', 'h', 'work', 'ASS-1', 'ticket.json'), 'utf8')).key, 'ASS-1');
});

test('ticket:move takes a ticket, history and all, from one project to another — its sprint entry to the other sprint, its backlog entry to the other backlog, a stale backlog copy of a sprint ticket dropped — and its work folder with it', async () => {
  const f = await withHarness();
  const backlog = project => f.at('projects', project, 'backlog.json');
  write(backlog('p'), { tickets: [{ key: 'ABC-3', title: 'stale copy' }, { key: 'ABC-8', title: 'waiting', 'manual-backlog-priority': 3, variations: [] }] });
  write(f.at('projects', 'p', 'work', 'ABC-3', 'change-log.md'), 'notes');
  const before = f.sprint('p').features.find(t => t.key === 'ABC-3');
  const { stdout } = await f.agent('ticket:move', 'p', 'h', 'abc-3');
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-3', from: 'p', to: 'h', sprint: true, backlog: false, folder: true });
  assert.deepEqual(f.sprint('h').features.find(t => t.key === 'ABC-3'), before);       // every field kept: state, history, health
  assert.ok(!f.keys('p').includes('ABC-3'));
  assert.deepEqual(JSON.parse(readFileSync(backlog('p'), 'utf8')).tickets.map(t => t.key), ['ABC-8']);   // the stale copy gone
  assert.equal(readFileSync(f.at('projects', 'h', 'work', 'ABC-3', 'change-log.md'), 'utf8'), 'notes');
  assert.ok(!existsSync(f.at('projects', 'p', 'work', 'ABC-3')));
  await f.agent('ticket:move', 'p', 'h', 'ABC-8');                       // a backlog ticket goes to the other backlog
  assert.deepEqual(JSON.parse(readFileSync(backlog('h'), 'utf8')).tickets.map(t => [t.key, t['manual-backlog-priority']]), [['ABC-8', 3]]);   // its backlog rank kept as it is (ASS-100)
  await assert.rejects(f.agent('ticket:move', 'p', 'h', 'ABC-77'), e => /no ABC-77 in p/.test(e.stderr));
});

test('ticket:move loses no write made to the ticket while it moves: each one that succeeds is on the ticket it lands with (ASS-172)', async () => {
  const f = await withHarness();
  const writes = Array.from({ length: 30 }, (_, n) => f.agent('ticket:record-output', 'p', 'ABC-3', 'A', 'probe', JSON.stringify({ n }), 'append').then(() => n, () => null));
  const move = f.agent('ticket:move', 'p', 'h', 'ABC-3');
  const landed = (await Promise.all(writes)).filter(n => n !== null);
  await move;
  const kept = f.sprint('h').features.find(t => t.key === 'ABC-3').variations.find(v => v.name === 'A').probe ?? [];
  assert.deepEqual(kept.map(o => o.n).sort((a, b) => a - b), landed.sort((a, b) => a - b));
  assert.ok(!f.keys('p').includes('ABC-3'));
});

test('ticket:move that fails after the copy undoes it — the ticket left in one project only — and runs again cleanly (ASS-172)', async () => {
  const f = await withHarness();
  const from = f.at('projects', 'p', 'sprints', 'sprint-10');
  const before = readFileSync(f.at('projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), 'utf8');
  chmodSync(from, 0o555);                                                 // the copy to h can be written, the removal from p cannot
  try { await assert.rejects(f.agent('ticket:move', 'p', 'h', 'ABC-3')); } finally { chmodSync(from, 0o755); }
  assert.equal(readFileSync(f.at('projects', 'h', 'sprints', 'sprint-1', 'sprint.json'), 'utf8'), before);
  assert.ok(f.keys('p').includes('ABC-3'));
  await f.agent('ticket:move', 'p', 'h', 'ABC-3');
  assert.deepEqual([f.keys('p').includes('ABC-3'), f.keys('h').includes('ABC-3')], [false, true]);
});

test('is_harness_project (harness-project.bash) answers whether a project is the one harness.json\'s harness-project names; harness_project prints that name, nothing when none is named', async () => {
  const f = fixture();
  const helper = join(import.meta.dirname, '..', '..', 'src', 'agent-cli', 'harness-project.bash');
  const ask = script => run('bash', ['-c', `source "${helper}" && ${script}`], { env: f.env }).then(r => r.stdout, () => 'no');
  assert.equal(await ask('harness_project'), '');
  assert.equal(await ask('is_harness_project p && echo yes'), 'no');
  write(join(f.dir, 'harness.json'), { ...JSON.parse(readFileSync(join(f.dir, 'harness.json'), 'utf8')), 'harness-project': 'h' });
  assert.equal(await ask('harness_project'), 'h\n');
  assert.equal(await ask('is_harness_project h && echo yes'), 'yes\n');
  assert.equal(await ask('is_harness_project p && echo yes'), 'no');
  assert.equal(await ask('is_harness_project "" && echo yes'), 'no');
});

// The pen-holder's wrapper with the shared preamble ({code-scope}) first, as prompts/receive-dispatch has it; no persona before it.
const withScope = f => {
  writeFileSync(join(f.dir, 'prompts', 'receive-dispatch', 'prompt.txt'), '{code-scope}\n\nLEAD\n{assignment}\n');
  writeFileSync(join(f.dir, 'personas', 'developer.md'), '');
};
const harnessFolder = join(import.meta.dirname, '..', '..');

test('a ticket of any other project: the preamble names its code location ({project-code-folder}, as control passes it), the harness and the harness\'s data folder for it, and says the harness is read-only context — changes go only in the project\'s code', async () => {
  const f = fixture();
  withScope(f);
  writeFileSync(join(f.dir, 'prompts', 'generate-solution', 'prompt.txt'), 'Code {project-code-folder}; harness {harness-folder}; data {project-folder}.\n');
  const { stdout } = await f.agent('agent:dispatch', 'Daredevil', 'project-code-folder=/repos/example/');
  const [scope, , lead, assignment] = stdout.split('\n');
  assert.equal(lead, 'LEAD');
  assert.equal(assignment, `Code /repos/example/; harness ${harnessFolder}; data ${join(f.dir, 'projects', 'p')}.`);
  assert.match(scope, /ABC-3 is p's ticket, not the harness's/);
  assert.ok(scope.includes('Its code is /repos/example/: every code change belongs there and nowhere else.'), scope);
  assert.ok(scope.includes(`The harness that runs you, at ${harnessFolder} on the host, is read-only context`), scope);
  // ASS-182 AC3: the harness's data, the ticket's folder among it, changes only through agent.sh — never "beyond the ticket's folder".
  assert.ok(scope.includes(`The harness's data folder for p — its project.json, sprints and reports — is ${join(f.dir, 'projects', 'p')}: read it, and the ticket's folder ${join(f.dir, 'projects', 'p', 'work', 'ABC-3')}, as you need; change either only through the agent.sh commands you are given, the content on stdin.`), scope);
  assert.doesNotMatch(scope, /beyond the ticket's folder/);
  assert.doesNotMatch(scope, /changing the harness itself/);
});

test('a ticket of the harness project — its own or, for a fix ticket, its home project\'s: the preamble says outright that the agent is changing the harness itself, in {project-code-folder}, not in the harness that runs it', async () => {
  const f = await withHarness();
  withScope(f);
  write(f.at('harness.json'), { ...JSON.parse(readFileSync(f.at('harness.json'), 'utf8')), 'harness-project': 'p' });   // p's own ticket, ABC-3
  let [scope] = (await f.agent('agent:dispatch', 'Daredevil', 'project-code-folder=/wt/ABC-3')).stdout.split('\n');
  assert.ok(scope.includes('ABC-3 is a harness ticket: you are changing the harness itself. Its code for this ticket is /wt/ABC-3: make every change there.'), scope);
  assert.ok(scope.includes(`The harness that runs you is at ${harnessFolder} on the host: never change that copy`), scope);
  assert.doesNotMatch(scope, /read-only context/);
  write(f.at('harness.json'), { ...JSON.parse(readFileSync(f.at('harness.json'), 'utf8')), 'harness-project': 'h' });   // ASS-1, h's, on a record of p
  const file = f.at('assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(data.assignments.find(a => a['agent-name'] === 'Leia'), { 'work-item': 'ASS-1', variation: null });
  writeFileSync(file, JSON.stringify(data, null, 4));
  [scope] = (await f.agent('agent:dispatch', 'Leia', `project-code-folder=${harnessFolder}`)).stdout.split('\n');
  assert.ok(scope.includes('ASS-1 is a harness ticket: you are changing the harness itself.'), scope);
  assert.ok(scope.includes(`The harness that runs you is this same checkout, ${harnessFolder}.`), scope);   // no worktree: the running copy is the one changed
});

test('the preamble is left out, cleanly, for work without a ticket or without a code location', async () => {
  const f = fixture();
  withScope(f);
  assert.equal((await f.agent('agent:dispatch', 'Leia', 'project-code-folder=/repos/')).stdout, 'LEAD\nFind a ticket in p for: the build is red\n');
  assert.match((await f.agent('agent:dispatch', 'Daredevil')).stdout, /^LEAD\n/);
});

test('the preamble is shared: both wrappers every dispatched prompt goes in, receive-dispatch and receive-pair-dispatch, open with {code-scope}', () => {
  for (const wrapper of ['receive-dispatch', 'receive-pair-dispatch']) assert.match(readFileSync(join(harnessFolder, 'prompts', wrapper, 'prompt.txt'), 'utf8'), /^\{code-scope\}\n\n/);
});
