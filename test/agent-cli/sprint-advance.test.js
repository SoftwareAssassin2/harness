// sprint:advance — an off-board project's sprint ends by itself after its last
// day and the next begins, its unfinished tickets carried over (ASS-142).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');

// A variation in every field the harness keeps, at <state> of <engine>.
const variation = (name, state, engine = 'dev') => ({
  name, 'harness-status': { state, 'state-engine': engine, ...(state === 'build' ? { 'sub-status': { state: 'coding', 'state-engine': 'sub' } } : {}) },
  'ai-feedback-short': 'ok', 'ai-feedback-long': 'fine', build: { branch: `change/${name}`, worktree: '/w' },
  'local-testing': { vm: 'ticket-vm' }, 'acceptance-criteria': [{ id: 1 }], 'merge-request': [{ key: '!3', url: 'u3' }],
  'gate-when-leaving-state': ['build'], 'is-paused': false, 'human-review': null, 'ai-variation-feedback': null,
  'state-changes': [{ 'state-engine': engine, 'from-state': 'plan', 'to-state': state, timestamp: '2026-10-20T10:00:00Z', 'agent-dispatch-log': [{ agent: 'Blue' }], 'work-is-done': false }],
});
const ticket = (key, ...variations) => ({ key, title: key, 'ticket-system-status': 'In Progress', priority: 3, 'manual-priority': 1, qa: { status: null }, variations });

// projects/ and engines/ folders: project p (off-board only, or with a jira
// source too) has sprint 1 active, 2026-10-12 to 2026-10-25, holding a ticket
// in progress, a Done one, one with a Done and an unfinished variation, and a
// Done bug; engine dev has build and done (is-done).
function fixture({ jira = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'advance-'));
  const p = join(dir, 'projects', 'p');
  mkdirSync(join(p, 'sprints', 'sprint-1'), { recursive: true });
  mkdirSync(join(dir, 'engines', 'dev'), { recursive: true });
  writeFileSync(join(dir, 'engines', 'dev', 'state-engine.json'), JSON.stringify({ steps: [{ id: 'build' }, { id: 'done', 'is-done': true }] }));
  writeFileSync(join(p, 'project.json'), JSON.stringify({ 'execution-state-engine': 'dev', 'work-sources': [
    { name: 'Off', type: 'off-board', folder: 'p' }, ...jira ? [{ name: 'J', type: 'jira', url: 'https://x.atlassian.net/jira/software/c/projects/EX/boards/5' }] : []] }));
  writeFileSync(join(p, 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(join(p, 'sprints', 'sprint-1', 'sprint.json'), JSON.stringify({
    number: 1, name: 'Harness Sprint 1', start: '2026-10-12', end: '2026-10-25', 'connected-flows': [{ name: 'dev', 'run-count': 4 }],
    features: [ticket('ASS-1', variation('A', 'build')), ticket('ASS-2', variation('A', 'done')), ticket('ASS-3', variation('A', 'done'), variation('B', 'build'))],
    bugs: [ticket('ASS-4', variation('A', 'done'))],
    spikes: [],
  }));
  return dir;
}
const env = dir => ({ ...process.env, PROJECTS_DIR: join(dir, 'projects'), ENGINES_DIR: join(dir, 'engines') });
const advance = (dir, ...args) => run(AGENT, ['sprint:advance', 'p', ...args], { env: env(dir) });
const read = (dir, file) => JSON.parse(readFileSync(join(dir, 'projects', 'p', file), 'utf8'));
const keys = sprint => ['features', 'bugs', 'spikes'].flatMap(a => sprint[a].map(t => t.key));

test('sprint:advance, the day after the last, makes the next sprint the only active one and carries every unfinished ticket into it intact; Done ones stay', async () => {
  const dir = fixture();
  const before = read(dir, 'sprints/sprint-1/sprint.json');
  const { stdout } = await advance(dir, '2026-10-26');
  assert.match(stdout, /sprint 1 → 2: 2 tickets carried, 2 left/);
  assert.deepEqual(read(dir, 'sprints.json'), { list: [{ number: 1, 'is-active': false }, { number: 2, 'is-active': true }] });
  const next = read(dir, 'sprints/sprint-2/sprint.json');
  assert.deepEqual({ number: next.number, name: next.name, start: next.start, end: next.end }, { number: 2, name: 'Harness Sprint 2', start: '2026-10-26', end: '2026-11-08' });
  // every field as it stood but the priorities, renumbered from 1
  assert.deepEqual(next.features, [{ ...before.features[0], priority: 1, 'manual-priority': 1 }, { ...before.features[2], priority: 2, 'manual-priority': 2 }]);
  assert.deepEqual([next.bugs, next.spikes], [[], []]);
  const old = read(dir, 'sprints/sprint-1/sprint.json');
  assert.deepEqual(keys(old), ['ASS-2', 'ASS-4']);
  assert.deepEqual(old['connected-flows'], before['connected-flows']);
});

test('sprint:advance on the sprint\'s last day itself, or before it, changes nothing', async () => {
  const dir = fixture();
  const before = [read(dir, 'sprints.json'), read(dir, 'sprints/sprint-1/sprint.json')];
  for (const today of ['2026-10-25', '2026-10-20']) assert.equal((await advance(dir, today)).stdout, '');
  assert.deepEqual([read(dir, 'sprints.json'), read(dir, 'sprints/sprint-1/sprint.json')], before);
  assert.ok(!existsSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2')));
});

test('sprint:advance after two missed ends catches up to the sprint holding today, the skipped one created empty and inactive', async () => {
  const dir = fixture();
  const before = read(dir, 'sprints/sprint-1/sprint.json');
  const { stdout } = await advance(dir, '2026-11-12');
  assert.match(stdout, /sprint 1 → 3/);
  assert.deepEqual(read(dir, 'sprints.json').list, [{ number: 1, 'is-active': false }, { number: 2, 'is-active': false }, { number: 3, 'is-active': true }]);
  assert.deepEqual(read(dir, 'sprints/sprint-2/sprint.json'), { number: 2, name: 'Harness Sprint 2', start: '2026-10-26', end: '2026-11-08', features: [], bugs: [], spikes: [] });
  const third = read(dir, 'sprints/sprint-3/sprint.json');
  assert.deepEqual({ name: third.name, start: third.start, end: third.end }, { name: 'Harness Sprint 3', start: '2026-11-09', end: '2026-11-22' });
  assert.deepEqual(third.features.map(t => t.priority), [1, 2]);
});

test('sprint:advance renumbers the carried tickets\' priorities from 1 across features, bugs and spikes, in their old order; a manual priority follows its ticket\'s, a ticket without one goes last', async () => {
  const dir = fixture();
  const file = join(dir, 'projects', 'p', 'sprints', 'sprint-1', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  const set = (t, priority, manual) => Object.assign(t, { priority, 'manual-priority': manual });
  set(sprint.features[0], 84, null);
  set(sprint.features[2], 90, 90);
  sprint.bugs.push(set(ticket('ASS-5', variation('A', 'build')), 41, null));
  sprint.spikes.push(set(ticket('ASS-6', variation('A', 'build')), null, null));
  writeFileSync(file, JSON.stringify(sprint));
  await advance(dir, '2026-10-26');
  const next = read(dir, 'sprints/sprint-2/sprint.json');
  const ranks = ['features', 'bugs', 'spikes'].flatMap(a => next[a].map(t => [t.key, t.priority, t['manual-priority']]));
  assert.deepEqual(ranks, [['ASS-1', 2, null], ['ASS-3', 3, 3], ['ASS-5', 1, null], ['ASS-6', 4, null]]);
});

test('sprint:advance run twice changes nothing the second time', async () => {
  const dir = fixture();
  await advance(dir, '2026-10-26');
  const files = ['sprints.json', 'sprints/sprint-1/sprint.json', 'sprints/sprint-2/sprint.json'];
  const after = files.map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8'));
  assert.equal((await advance(dir, '2026-10-26')).stdout, '');
  assert.equal((await advance(dir, '2026-10-30')).stdout, '');
  assert.deepEqual(files.map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8')), after);
});

test('sprint:advance refuses a Jira-backed project, changing nothing', async () => {
  const dir = fixture({ jira: true });
  const before = read(dir, 'sprints.json');
  await assert.rejects(advance(dir, '2026-10-26'), /Jira-backed/);
  assert.deepEqual(read(dir, 'sprints.json'), before);
  assert.ok(!existsSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2')));
});

test('sprint:advance waits for the lock the sprint\'s other writes take, and gives up after its timeout, changing nothing', async t => {
  const dir = fixture();
  const file = join(dir, 'projects', 'p', 'sprints', 'sprint-1', 'sprint.json');
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${file}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  await assert.rejects(run(AGENT, ['sprint:advance', 'p', '2026-10-26'], { env: { ...env(dir), JSON_LOCK_TIMEOUT: '1' } }), /timed out/);
  assert.deepEqual(read(dir, 'sprints.json').list, [{ number: 1, 'is-active': true }]);
  assert.ok(!existsSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2')));
});

test('sprint:advance fails on a bad date, project or usage', async () => {
  const dir = fixture();
  await assert.rejects(advance(dir, '26/10/2026'), /YYYY-MM-DD/);
  await assert.rejects(run(AGENT, ['sprint:advance'], { env: env(dir) }), /usage/);
  await assert.rejects(run(AGENT, ['sprint:advance', '../p', '2026-10-26'], { env: env(dir) }), /invalid project/);
});

// ASS-165: a Jira project's sprint follows the board's active sprint — the downloader passes the new one.
const jiraAdvance = (dir, ...args) => run(AGENT, ['sprint:advance', 'p', '2026-10-27', '--jira-sprint', ...args], { env: env(dir) });

test('sprint:advance --jira-sprint <id> <name> on a Jira project begins the next sprint today with that id and name, as long as the last, carrying the unfinished tickets as an off-board advance does (ASS-165)', async () => {
  const dir = fixture({ jira: true });
  const list = read(dir, 'sprints.json');
  list.list[0]['jira-sprint-id'] = 13422;
  writeFileSync(join(dir, 'projects', 'p', 'sprints.json'), JSON.stringify(list));
  const before = read(dir, 'sprints/sprint-1/sprint.json');
  const { stdout } = await jiraAdvance(dir, '13423', 'EX Sprint 12');
  assert.match(stdout, /sprint 1 → 2: 2 tickets carried, 2 left/);
  assert.deepEqual(read(dir, 'sprints.json'), { list: [{ number: 1, 'is-active': false, 'jira-sprint-id': 13422 }, { number: 2, 'is-active': true, 'jira-sprint-id': 13423 }] });
  const next = read(dir, 'sprints/sprint-2/sprint.json');
  assert.deepEqual({ number: next.number, name: next.name, start: next.start, end: next.end, id: next['jira-sprint-id'] }, { number: 2, name: 'EX Sprint 12', start: '2026-10-27', end: '2026-11-09', id: undefined });
  assert.deepEqual(next.features, [{ ...before.features[0], priority: 1, 'manual-priority': 1 }, { ...before.features[2], priority: 2, 'manual-priority': 2 }]);
  assert.deepEqual(keys(read(dir, 'sprints/sprint-1/sprint.json')), ['ASS-2', 'ASS-4']);
  // the same sprint again: nothing
  const files = ['sprints.json', 'sprints/sprint-1/sprint.json', 'sprints/sprint-2/sprint.json'].map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8'));
  assert.equal((await jiraAdvance(dir, '13423', 'EX Sprint 12')).stdout, '');
  assert.deepEqual(['sprints.json', 'sprints/sprint-1/sprint.json', 'sprints/sprint-2/sprint.json'].map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8')), files);
});

test('sprint:advance --jira-sprint refuses a project without a jira work source, and a bad id or name (ASS-165)', async () => {
  await assert.rejects(jiraAdvance(fixture(), '13423', 'EX Sprint 12'), /no jira work source/);
  const dir = fixture({ jira: true });
  await assert.rejects(jiraAdvance(dir, 'x1', 'EX Sprint 12'), /sprint id/);
  await assert.rejects(jiraAdvance(dir, '13423', ''), /name/);
  assert.ok(!existsSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2')));
});

test('sprint:advance --jira-sprint <id> <name> <start> <end> takes the new sprint\'s dates from Jira; given the active sprint, brings its dates to Jira\'s when they differ, else nothing (ASS-165)', async () => {
  const dir = fixture({ jira: true });
  const { stdout } = await jiraAdvance(dir, '13423', 'EX Sprint 12', '2026-10-17', '2026-10-31');
  assert.match(stdout, /sprint 1 → 2/);
  const dates = () => { const s = read(dir, 'sprints/sprint-2/sprint.json'); return [s.start, s.end]; };
  assert.deepEqual(dates(), ['2026-10-17', '2026-10-31']);
  assert.equal((await jiraAdvance(dir, '13423', 'EX Sprint 12', '2026-10-17', '2026-10-31')).stdout, '');
  const moved = await jiraAdvance(dir, '13423', 'EX Sprint 12', '2026-10-17', '2026-11-03');
  assert.equal(moved.stdout, 'p sprint 2: 2026-10-17 to 2026-11-03, as in Jira\n');
  assert.deepEqual(dates(), ['2026-10-17', '2026-11-03']);
  assert.deepEqual(read(dir, 'sprints/sprint-2/sprint.json').features.map(t => t.key), ['ASS-1', 'ASS-3']);
  assert.equal(read(dir, 'sprints.json').list.length, 2);
  await assert.rejects(jiraAdvance(dir, '13423', 'EX Sprint 12', '17/10/2026', '2026-11-03'), /YYYY-MM-DD/);
});

test('the TUI counts the days of a sprint advanced to Jira\'s by its Jira dates: on 2026-10-27, Oct 17 to 31 is day 11 of 15 (ASS-165)', async () => {
  const { initialState, render } = await import('../../src/tui/app.js');
  const dir = fixture({ jira: true });
  await jiraAdvance(dir, '13423', 'EX Sprint 12', '2026-10-17', '2026-10-31');
  const sprint = read(dir, 'sprints/sprint-2/sprint.json');
  const state = initialState({ projects: [{ id: 'p', name: 'P', stateEngine: 'dev', sprint }], workflows: [{ name: 'dev', steps: [] }] });
  const screen = render(state, { columns: 200, rows: 44, now: new Date('2026-10-27T15:00:00Z') }).join('\n');
  assert.match(screen, /day 11 of 15/);
  assert.match(screen, /sprint ends in 4 days/);
});

// ASS-174: the choice of file — active sprint or backlog — is made inside the
// project's tickets.lock, which every such writer and sprint:advance take.
// hold(dir) takes it as another holder would; release() lets it go.
async function hold(t, dir) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', join(dir, 'projects', 'p', 'tickets.lock')]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return () => new Promise(resolve => { holder.once('exit', resolve); holder.kill('SIGKILL'); });
}
const edit = (dir, file, change) => { const path = join(dir, 'projects', 'p', file); const json = JSON.parse(readFileSync(path, 'utf8')); change(json); writeFileSync(path, JSON.stringify(json)); };
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

test('a write to a ticket that joins the sprint while the writer waits lands on its sprint copy, not its stale backlog one (ASS-174)', async t => {
  const dir = fixture();
  writeFileSync(join(dir, 'projects', 'p', 'backlog.json'), JSON.stringify({ tickets: [ticket('ASS-9', variation('A', 'build'))] }));
  const release = await hold(t, dir);
  const write = run(AGENT, ['ticket:set-manual', 'p', 'ASS-9', 'on'], { env: env(dir) });
  await settle();
  edit(dir, 'sprints/sprint-1/sprint.json', s => s.features.push(ticket('ASS-9', variation('A', 'build'))));   // joins, its backlog copy kept
  await release();
  await write;
  assert.ok(read(dir, 'sprints/sprint-1/sprint.json').features.find(x => x.key === 'ASS-9')['worked-manually']);
  assert.equal(read(dir, 'backlog.json').tickets[0]['worked-manually'], undefined);
});

test('ticket:sync racing sprint:advance merges into the sprint active once it holds the lock, never the one just closed (ASS-174)', async t => {
  const dir = fixture();
  const fetched = join(dir, 'fetched.json');
  writeFileSync(fetched, JSON.stringify({ tickets: [{ key: 'ASS-7', title: 'new', description: '', 'ticket-system-status': 'To Do', 'issue-type': 'Story' }] }));
  const release = await hold(t, dir);
  const sync = run(AGENT, ['ticket:sync', 'p', 'sprint', fetched], { env: env(dir) });
  await settle();
  // the advance the holder makes: sprint 2 begins, sprint 1 closes
  mkdirSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2'));
  writeFileSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2', 'sprint.json'), JSON.stringify({ number: 2, name: 'Harness Sprint 2', features: [], bugs: [], spikes: [] }));
  writeFileSync(join(dir, 'projects', 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': false }, { number: 2, 'is-active': true }] }));
  await release();
  await sync;
  assert.deepEqual([keys(read(dir, 'sprints/sprint-1/sprint.json')).includes('ASS-7'), keys(read(dir, 'sprints/sprint-2/sprint.json'))], [false, ['ASS-7']]);
});

test('sprint:advance takes the tickets lock too: held elsewhere, it waits, then gives up, changing nothing (ASS-174)', async t => {
  const dir = fixture();
  await hold(t, dir);
  await assert.rejects(run(AGENT, ['sprint:advance', 'p', '2026-10-26'], { env: { ...env(dir), JSON_LOCK_TIMEOUT: '1' } }), /timed out/);
  assert.deepEqual(read(dir, 'sprints.json').list, [{ number: 1, 'is-active': true }]);
  assert.ok(!existsSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2')));
});

// ASS-178: an advance stopped between its writes. Each stop is simulated by
// running the advance, then putting back the files it had not yet written.
test('sprint:advance stopped after the new sprint files, before sprints.json, does the whole advance when run again (ASS-178)', async () => {
  const dir = fixture();
  const files = ['sprints.json', 'sprints/sprint-1/sprint.json'];
  const before = files.map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8'));
  await advance(dir, '2026-10-26');
  const after = [...files, 'sprints/sprint-2/sprint.json'].map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8'));
  files.forEach((f, i) => writeFileSync(join(dir, 'projects', 'p', f), before[i]));
  assert.match((await advance(dir, '2026-10-26')).stdout, /sprint 1 → 2: 2 tickets carried, 2 left/);
  assert.deepEqual([...files, 'sprints/sprint-2/sprint.json'].map(f => readFileSync(join(dir, 'projects', 'p', f), 'utf8')), after);
});

test('sprint:advance stopped after sprints.json, the carried tickets still in the old sprint too, takes them out of it when run again; then changes nothing (ASS-178)', async () => {
  const dir = fixture();
  const old = join(dir, 'projects', 'p', 'sprints', 'sprint-1', 'sprint.json');
  const before = readFileSync(old, 'utf8');
  await advance(dir, '2026-10-26');
  writeFileSync(old, before);                                                     // the old sprint's trim never happened
  edit(dir, 'sprints/sprint-2/sprint.json', s => { s.features[0].variations[0]['harness-status'].state = 'done'; });   // ASS-1 finished since, in the new sprint
  const next = readFileSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2', 'sprint.json'), 'utf8');
  assert.equal((await advance(dir, '2026-10-27')).stdout, 'p sprint 1: 2 tickets taken out, carried into sprint 2\n');
  assert.deepEqual(keys(read(dir, 'sprints/sprint-1/sprint.json')), ['ASS-2', 'ASS-4']);
  assert.deepEqual(read(dir, 'sprints/sprint-1/sprint.json')['connected-flows'], JSON.parse(before)['connected-flows']);
  assert.equal(readFileSync(join(dir, 'projects', 'p', 'sprints', 'sprint-2', 'sprint.json'), 'utf8'), next);
  assert.deepEqual(read(dir, 'sprints.json').list, [{ number: 1, 'is-active': false }, { number: 2, 'is-active': true }]);
  assert.equal((await advance(dir, '2026-10-27')).stdout, '');
});
