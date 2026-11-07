// self-healing:start and :stop — the self-healing banner and the tickets a fix
// pauses, one by one, while it goes in; self-healing:hand-to-human — a fix
// only the operator can make, its ticket brought into the sprint at Blocked
// for Human.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fixture, STAMP, run } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const paused = f => f.sprint().features[0].variations.map(v => [v.name, v['is-paused'] ?? false]);

// The fixture with a fix ticket, ABC-9, in the sprint carrying the plan self-healing:take-on records.
function withFix(plan) {
  const f = fixture();
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.bugs.push({ key: 'ABC-9', title: 'The build is red', url: 'https://x/ABC-9', variations: [{ name: 'A', 'harness-status': { state: 'self-healing', 'state-engine': 'example-development' } }], ...(plan ? { 'self-healing-plan': plan } : {}) });
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  return f;
}

test('self-healing:start records the fix under way from the plan on its ticket and pauses just the tickets the plan names, each live variation; :stop unpauses exactly those', async () => {
  const f = withFix({ summary: 'The dev container is broken', 'ticket-url': 'https://x/ABC-9', 'pause-tickets': ['abc-3'] });
  await f.agent('ticket:set-paused', 'p', 'ABC-3', 'C', 'true');               // paused by hand before the fix
  await f.agent('self-healing:start', 'p', 'ABC-9');
  let data = f.assignments();
  const since = data['self-healing']['ABC-9'].since;
  assert.match(since, STAMP);
  assert.deepEqual(data['self-healing']['ABC-9'], {
    since, ticket: 'ABC-9', summary: 'The dev container is broken', 'ticket-url': 'https://x/ABC-9', project: 'p',
    paused: [{ project: 'p', ticket: 'ABC-3', variation: 'A' }, { project: 'p', ticket: 'ABC-3', variation: 'B' }],   // not C (already paused) nor D (deleted)
  });
  assert.deepEqual([data.pauses, data.status], [{}, 'Running']);               // no pause holds the other work
  assert.deepEqual(paused(f), [['A', true], ['B', true], ['C', true], ['D', false]]);
  await f.agent('self-healing:stop', 'p', 'ABC-9');
  data = f.assignments();
  assert.deepEqual(data['self-healing'], {});
  assert.deepEqual(paused(f), [['A', false], ['B', false], ['C', true], ['D', false]]);   // the hand-paused one stays paused
  await f.agent('self-healing:start', 'p', 'ABC-9');                             // every attempt pauses its tickets again
  assert.deepEqual(paused(f), [['A', true], ['B', true], ['C', true], ['D', false]]);
  await f.agent('self-healing:stop', 'p', 'ABC-9');
  await f.agent('self-healing:stop', 'p', 'ABC-9');                             // nothing to stop: fine
});

// Holds <file>.lock (update_json's) from another process until killed: a write to <file> waits.
async function hold(t, file) {
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${realpathSync(file)}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  return holder;
}
const settle = () => new Promise(r => setTimeout(r, 1000));

test('self-healing:start records what it will pause before it pauses anything, so a start cut short leaves a record :stop unpauses from (ASS-179 AC3)', async t => {
  const f = withFix({ summary: 'Fix', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  const holder = await hold(t, join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'));
  const starting = f.agent('self-healing:start', 'p', 'ABC-9');
  await settle();                                                              // waiting to pause the first variation
  assert.deepEqual(f.assignments()['self-healing']?.['ABC-9']?.paused.map(p => p.variation), ['A', 'B', 'C']);
  holder.kill('SIGKILL');
  await starting;
  assert.deepEqual(paused(f), [['A', true], ['B', true], ['C', true], ['D', false]]);
});

test('self-healing:stop unpauses what a start added while it ran too, removing the record only once nothing it lists is left paused (ASS-179 AC3)', async t => {
  const f = withFix({ summary: 'Fix', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  await f.agent('self-healing:start', 'p', 'ABC-9');
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const holder = await hold(t, file);
  const stopping = f.agent('self-healing:stop', 'p', 'ABC-9');
  await settle();                                                              // it has read the record, and waits to unpause
  // Meanwhile another attempt at the fix pauses one more and records it (as start does).
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.features[0].variations.find(v => v.name === 'D')['is-deleted'] = false;
  sprint.features[0].variations.find(v => v.name === 'D')['is-paused'] = true;
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  const assignments = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(assignments, 'utf8'));
  data['self-healing']['ABC-9'].paused.push({ project: 'p', ticket: 'ABC-3', variation: 'D' });
  writeFileSync(assignments, JSON.stringify(data, null, 4));
  holder.kill('SIGKILL');
  await stopping;
  assert.deepEqual(f.assignments()['self-healing'], {});
  assert.deepEqual(paused(f), [['A', false], ['B', false], ['C', false], ['D', false]]);
});

test('two fixes under way at once each keep their own record and paused tickets; stopping one releases only its own (the old single slot let the second overwrite the first)', async () => {
  const f = withFix({ summary: 'Fix one', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  const file = join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
  const sprint = JSON.parse(readFileSync(file, 'utf8'));
  sprint.bugs.push({ key: 'ABC-8', title: 'Second', url: null, variations: [{ name: 'A', 'harness-status': { state: 'self-healing', 'state-engine': 'example-development' } }], 'self-healing-plan': { summary: 'Fix two', 'ticket-url': null, 'pause-tickets': [] } });
  sprint.bugs.push({ key: 'ABC-7', title: 'Third', url: null, variations: [{ name: 'A', 'harness-status': { state: 'self-healing', 'state-engine': 'example-development' } }], 'self-healing-plan': { summary: 'Fix three', 'ticket-url': null, 'pause-tickets': ['ABC-9'] } });
  writeFileSync(file, JSON.stringify(sprint, null, 4));
  await f.agent('self-healing:start', 'p', 'ABC-9');
  await f.agent('self-healing:start', 'p', 'ABC-7');
  await f.agent('self-healing:start', 'p', 'ABC-8');
  assert.deepEqual(Object.keys(f.assignments()['self-healing']).toSorted(), ['ABC-7', 'ABC-8', 'ABC-9']);
  assert.deepEqual(f.assignments()['self-healing']['ABC-9'].paused.map(p => `${p.ticket} ${p.variation}`), ['ABC-3 A', 'ABC-3 B', 'ABC-3 C']);
  await f.agent('self-healing:stop', 'p', 'ABC-9');                              // the first: not refused, and only its own released
  assert.deepEqual(Object.keys(f.assignments()['self-healing']).toSorted(), ['ABC-7', 'ABC-8']);
  assert.deepEqual(paused(f), [['A', false], ['B', false], ['C', false], ['D', false]]);
  assert.equal(f.sprint().bugs.find(b => b.key === 'ABC-9').variations[0]['is-paused'], true);   // ABC-7's pause on it stands
});

test('self-healing:start finds each ticket to pause by its key\'s project, never another sprint\'s; a key no project claims is refused, writing nothing', async () => {
  const f = withFix({ summary: 'S', 'ticket-url': null, 'pause-tickets': ['ZZZ-1'] });
  const before = f.snapshot();
  await fails(f.agent('self-healing:start', 'p', 'ABC-9'), /ZZZ-1 names no project/);
  assert.equal(f.snapshot(), before);
});

test('self-healing:start again for the same fix, SELF HEALING still held (an attempt handed to the operator, then resolved), keeps what the first attempt paused, so the last stop unpauses it all', async () => {
  const f = withFix({ summary: 'The dev container is broken', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  await f.agent('self-healing:start', 'p', 'ABC-9');
  await f.agent('self-healing:start', 'p', 'ABC-9');                             // the second attempt: A and B are paused already
  assert.deepEqual(f.assignments()['self-healing']['ABC-9'].paused, [{ project: 'p', ticket: 'ABC-3', variation: 'A' }, { project: 'p', ticket: 'ABC-3', variation: 'B' }, { project: 'p', ticket: 'ABC-3', variation: 'C' }]);
  await f.agent('self-healing:stop', 'p', 'ABC-9');
  assert.deepEqual(paused(f), [['A', false], ['B', false], ['C', false], ['D', false]]);
});

test('self-healing:start without a plan on the ticket (a fix handed to the operator first) takes its title and url and pauses nothing', async () => {
  const f = withFix();
  await f.agent('self-healing:start', 'p', 'ABC-9');
  const { since, ...rest } = f.assignments()['self-healing']['ABC-9'];
  assert.deepEqual(rest, { ticket: 'ABC-9', summary: 'The build is red', 'ticket-url': 'https://x/ABC-9', project: 'p', paused: [] });
});

test('self-healing:start and :stop fail, writing nothing, on a fix ticket not in the sprint, a ticket to pause that is not in its project\'s, or bad arguments; stopping a fix not under way changes nothing', async () => {
  const f = withFix({ summary: 'Red', 'ticket-url': null, 'pause-tickets': ['ABC-3', 'ABC-77'] });
  let before = f.snapshot();
  await fails(f.agent('self-healing:start', 'p', 'ABC-8'), /no ABC-8 in the active sprint/);
  await fails(f.agent('self-healing:start', 'p', 'ABC-9'), /no ABC-77 in p's active sprint/);
  await fails(f.agent('self-healing:start', 'p'), /usage/);
  await fails(f.agent('self-healing:stop', 'p'), /usage/);
  assert.equal(f.snapshot(), before);
  const g = withFix({ summary: 'Red', 'ticket-url': null, 'pause-tickets': ['ABC-3'] });
  await g.agent('self-healing:start', 'p', 'ABC-9');
  before = g.snapshot();
  await g.agent('self-healing:stop', 'p', 'ABC-8');                            // ABC-9's fix is not ABC-8's to close
  assert.equal(g.snapshot(), before);
});

// The fixture with project p given an off-board work source (folder p, key
// prefix HD) and a Blocked for Human step paired with On Hold, plus one
// off-board ticket, HD-1, at Backlog.
async function offBoard() {
  const f = fixture();
  f.env.OFF_BOARD_DIR = join(f.dir, 'off-board');
  const edit = (path, change) => { const file = join(f.dir, ...path); const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
  edit(['projects', 'p', 'project.json'], p => p['work-sources'].push({ name: 'Harness', type: 'off-board', folder: 'p', 'key-prefix': 'HD' }));
  edit(['engines', 'example-development', 'state-engine.json'], e => {
    e.steps.unshift({ id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, 'paired-ticket-system-status': 'In Progress', action: { type: 'human' } });
    e.steps.unshift({ id: 'backlog', sequence: 0, 'paired-ticket-system-status': 'Backlog', action: { type: 'none' } });
    e.steps.unshift({ id: 'self-healing', sequence: 0, 'paired-ticket-system-status': 'In Progress', action: { type: 'state-engine', engine: 'self-healing-fix' } });
  });
  await run(join(import.meta.dirname, '..', '..', 'off-board.sh'), ['ticket:create', 'p', 'Bug', 'Local workspace unrunnable'], { env: f.env });
  return { ...f, ticket: key => f.sprint().bugs.find(t => t.key === key), file: key => readFileSync(join(f.dir, 'off-board', 'p', `${key}.md`), 'utf8') };
}

test('self-healing:hand-to-human brings the fix ticket into the sprint at Blocked for Human (In Progress, as the harness pairs it), with what the operator must do as its health', async () => {
  const f = await offBoard();
  await f.agent('self-healing:hand-to-human', 'p', 'hd-1', 'Workspace dirty; npm token missing', 'Commit todo.md; add the GitLab npm token');
  const t = f.ticket('HD-1');
  assert.equal(t['ticket-system-status'], 'In Progress');
  const [v] = t.variations;
  assert.equal(v['harness-status'].state, 'blocked-for-human');
  assert.equal(v['ai-feedback-short'], 'Commit todo.md; add the GitLab npm token');
  assert.equal(v['ai-feedback-long'], 'Workspace dirty; npm token missing. Needs the operator: Commit todo.md; add the GitLab npm token');
  assert.match(f.file('HD-1'), /^status: In Progress$/m);
  await f.agent('self-healing:hand-to-human', 'p', 'HD-1', 'Still dirty', 'Commit todo.md');   // again: already there, only the health changes
  assert.equal(f.ticket('HD-1').variations[0]['ai-feedback-short'], 'Commit todo.md');
  assert.equal(f.ticket('HD-1').variations[0]['state-changes'].length, 1);
});

test('self-healing:hand-to-human moves a sprint ticket from where it is; fails on a ticket in no ticket system the harness can bring in, or bad arguments', async () => {
  const f = await offBoard();
  await f.agent('self-healing:hand-to-human', 'p', 'ABC-3', 'Red', 'Re-authenticate glab');   // a Jira ticket already in the sprint
  const v = f.sprint().features[0].variations.find(x => x.name === 'A');
  assert.equal(v['harness-status'].state, 'blocked-for-human');
  assert.equal(v['ai-feedback-short'], 'Re-authenticate glab');
  const before = f.snapshot();
  await fails(f.agent('self-healing:hand-to-human', 'p', 'ABC-77', 'Red', 'Log in'), /ABC-77 is not in p's active sprint/);
  await fails(f.agent('self-healing:hand-to-human', 'p', 'HD-1', 'Red'), /usage/);
  await fails(f.agent('self-healing:hand-to-human', 'p', 'HD-1', 'Red', '  '), /what the operator must do is empty/);
  assert.equal(f.snapshot(), before);
});

// An AI pause on all agents, as a health check would take it (assignments:pause ai needs one).
const aiPause = (f, reason) => {
  const file = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.pauses = { ...data.pauses, all: { ...data.pauses?.all, ai: { since: '2026-10-08T00:00:00Z', reason, eta: '2099-01-01T00:00:00Z', agent: 'Ripley', project: 'q', run: 'hc' } } };
  data.status = 'Paused';
  writeFileSync(file, JSON.stringify(data));
};

test('self-healing:stop releases the AI pause the fix set (its reason the fix\'s summary), as a fix begun before per-ticket pausing holds one; another AI\'s pause stays', async () => {
  const f = withFix({ summary: 'Local env broken', 'ticket-url': null, 'pause-tickets': [] });
  await f.agent('self-healing:start', 'p', 'ABC-9');
  aiPause(f, 'Local env broken');
  await f.agent('self-healing:stop', 'p', 'ABC-9');
  assert.deepEqual([f.assignments().pauses, f.assignments().status], [{}, 'Running']);
  await f.agent('self-healing:start', 'p', 'ABC-9');
  aiPause(f, 'Rotating a token');
  await f.agent('assignments:pause', 'all', 'human');
  await f.agent('self-healing:stop', 'p', 'ABC-9');
  assert.deepEqual([Object.keys(f.assignments().pauses).toSorted(), f.assignments().status], [['all'], 'Paused']);
  assert.deepEqual(Object.keys(f.assignments().pauses.all).toSorted(), ['ai', 'human']);
});

test('self-healing:take-on makes the fix ticket sprint work at Self Healing and records its plan on it — summary, url, the tickets to pause — for every attempt; nothing is paused yet', async () => {
  const f = await offBoard();
  await f.agent('self-healing:take-on', 'p', 'hd-1', 'Dev container broken', '-', 'ABC-3,abc-4');
  const t = f.ticket('HD-1');
  assert.equal(t.variations[0]['harness-status'].state, 'self-healing');
  assert.deepEqual(t['self-healing-plan'], { summary: 'Dev container broken', 'ticket-url': null, 'pause-tickets': ['ABC-3', 'ABC-4'] });
  assert.deepEqual(f.sprint().features[0].variations.map(v => v['is-paused'] ?? false), [false, false, false, false]);
  await f.agent('self-healing:take-on', 'p', 'HD-1', 'Again', 'https://x', '-');     // again: the plan replaced
  assert.deepEqual(f.ticket('HD-1')['self-healing-plan'], { summary: 'Again', 'ticket-url': 'https://x', 'pause-tickets': [] });
  await fails(f.agent('self-healing:take-on', 'p', 'HD-1', ' ', '-', '-'), /the summary is empty/);
  await fails(f.agent('self-healing:take-on', 'p', 'ABC-77', 'S', '-', '-'), /ABC-77 is not in p's active sprint/);
});

test('ticket:join-sprint brings an off-board ticket into the sprint and moves each live variation to the state, setting its paired status; a sprint ticket just moves; prints where each went', async () => {
  const f = await offBoard();
  await run(join(import.meta.dirname, '..', '..', 'off-board.sh'), ['ticket:update-points', 'p', 'HD-1', '2'], { env: f.env });
  await run(join(import.meta.dirname, '..', '..', 'off-board.sh'), ['ticket:update-priority', 'p', 'HD-1', 'Critical'], { env: f.env });
  const { stdout } = await f.agent('ticket:join-sprint', 'p', 'hd-1', 'self-healing');
  assert.deepEqual(JSON.parse(stdout), { key: 'HD-1', state: 'self-healing', moved: ['A'] });
  assert.equal(f.ticket('HD-1').points, 2);                                                 // its estimate comes with it
  assert.equal(f.ticket('HD-1')['ticket-system-priority'], 'Critical');                     // and its priority
  const [v] = f.ticket('HD-1').variations;
  assert.deepEqual([v['harness-status'].state, f.ticket('HD-1')['ticket-system-status']], ['self-healing', 'In Progress']);
  assert.deepEqual(v['state-changes'].map(c => [c['from-state'], c['to-state']]), [['backlog', 'self-healing']]);
  assert.match(f.file('HD-1'), /^status: In Progress$/m);
  assert.deepEqual(JSON.parse((await f.agent('ticket:join-sprint', 'p', 'HD-1', 'self-healing')).stdout).moved, []);   // already there
  await f.agent('ticket:join-sprint', 'p', 'ABC-3', 'blocked-for-human');                    // a sprint ticket: each live variation moves
  assert.deepEqual(f.sprint().features[0].variations.map(x => x['harness-status'].state), ['blocked-for-human', 'blocked-for-human', 'blocked-for-human', 'generate-solution']);   // D is deleted
});

test('ticket:join-sprint fails, writing nothing, on a ticket neither in the sprint nor off-board, or bad arguments', async () => {
  const f = await offBoard();
  const before = f.snapshot();
  await fails(f.agent('ticket:join-sprint', 'p', 'ABC-77', 'self-healing'), /ABC-77 is not in p's active sprint/);
  await fails(f.agent('ticket:join-sprint', 'p', 'HD-1'), /usage/);
  assert.equal(f.snapshot(), before);
});
