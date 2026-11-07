// ASS-149 AC2: vm:raise-golden-rebuilds, check-health-v2's golden-image
// check — every project's golden image read with vm:golden-stale, and a stale
// one raising an off-board "Rebuild golden-<project>" ticket from a fixed
// template, fast-tracked and joined to the sprint at Committed (ASS-83), one
// open ticket per image. No VM and no build: an image is its label alone
// (golden-image.json under LIMA_HOME), its inputs a tiny definition and
// shared steps, hashed here as golden.bash hashes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { fixture, run, hs } from './harness-fixture.js';
import { controlFixture } from '../control/control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';
import { engineDir } from '../support/engine-walk.js';

const OFF_BOARD = join(import.meta.dirname, '..', '..', 'off-board.sh');
const sha = text => createHash('sha256').update(text).digest('hex');
const FILES = { definition: { 'provision.sh': '#!/bin/bash\necho provision\n', 'template.yaml': 'vmType: vz\n' }, shared: { 'git.sh': '#!/bin/bash\necho git\n' } };

// The fixture with p the harness project (harness.json harness-project), its
// off-board work source (prefix HD), backlog and committed steps, and p and q
// each with a golden-image definition of FILES and one repository.
function setup() {
  const f = fixture();
  const at = (...p) => join(f.dir, ...p);
  const edit = (path, change) => { const file = at(...path); const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
  Object.assign(f.env, { OFF_BOARD_DIR: at('off-board'), LIMA_HOME: at('lima'), GOLDEN_IMAGE_SHARED: at('shared') });
  edit(['harness.json'], h => { h['harness-project'] = 'p'; });
  edit(['engines', 'example-development', 'state-engine.json'], e => {
    e.steps.unshift({ id: 'committed', sequence: 0, 'paired-ticket-system-status': 'Committed', action: { type: 'none' } });
    e.steps.unshift({ id: 'backlog', sequence: 0, 'paired-ticket-system-status': 'Backlog', action: { type: 'none' } });
  });
  for (const [name, content] of Object.entries(FILES.shared)) { mkdirSync(at('shared'), { recursive: true }); writeFileSync(at('shared', name), content); }
  for (const p of ['p', 'q']) {
    edit(['projects', p, 'project.json'], j => {
      j['golden-image'] = { folder: `projects/${p}/golden-image` };
      j.repositories = [{ url: `https://github.com/o/${p}` }];
      if (p === 'p') j['work-sources'].push({ name: 'Harness', type: 'off-board', folder: 'p', 'key-prefix': 'HD' });
    });
    mkdirSync(at('projects', p, 'golden-image'), { recursive: true });
    for (const [name, content] of Object.entries(FILES.definition)) writeFileSync(at('projects', p, 'golden-image', name), content);
  }
  // inputs(p) — golden-<p>'s input lines now, as golden.bash lists them (no registry: one empty line for the mirror).
  const inputs = p => [
    ...Object.entries(FILES.definition).map(([n]) => `${sha(readFileSync(at('projects', p, 'golden-image', n)))}  definition/${n}`),
    ...Object.entries(FILES.shared).map(([n, c]) => `${sha(c)}  shared/${n}`),
    ...JSON.parse(readFileSync(at('projects', p, 'project.json'), 'utf8')).repositories.map(r => `repository ${r.url}`), ''];
  const hashOf = lines => sha(`${lines.join('\n')}\n`);
  // built(p, lines, extra) — golden-<p>'s label: built from those input lines.
  const built = (p, lines, extra = {}) => {
    mkdirSync(at('lima', `golden-${p}`), { recursive: true });
    writeFileSync(at('lima', `golden-${p}`, 'golden-image.json'), JSON.stringify({ project: p, hash: hashOf(lines), 'built-at': '2026-10-20T12:00:00Z', inputs: lines, ...extra }));
  };
  const raise = async () => JSON.parse((await run(join(import.meta.dirname, '..', '..', 'agent.sh'), ['vm:raise-golden-rebuilds'], { env: f.env })).stdout);
  const tickets = async () => JSON.parse((await run(OFF_BOARD, ['ticket:list', 'p'], { env: f.env })).stdout);
  return { ...f, at, edit, inputs, hashOf, built, raise, tickets, sprintTicket: key => f.sprint().features.concat(f.sprint().bugs ?? []).find(t => t.key === key) };
}

test('ASS-149 AC2: a stale image raises one off-board "Rebuild golden-<project>" ticket from the fixed template — fast-tracked, 1 point, joined to the sprint at Committed; a current image is left alone', async () => {
  const s = setup();
  s.built('q', s.inputs('q'));                                                       // current
  const old = s.inputs('p').filter(l => l !== 'repository https://github.com/o/p');   // p's repository added since, and its provision.sh changed
  old[0] = `${sha('older')}  definition/provision.sh`;
  old.splice(3, 0, 'repository https://github.com/o/gone');
  s.built('p', old);
  const out = await s.raise();
  const now = s.hashOf(s.inputs('p')), was = s.hashOf(old);
  assert.deepEqual(out, [
    { project: 'p', image: 'golden-p', stale: true, ticket: 'HD-1', raised: true, joined: true },
    { project: 'q', image: 'golden-q', stale: false },
  ]);
  const [ticket] = await s.tickets();
  assert.deepEqual([ticket.key, ticket.type, ticket.title, ticket.points, ticket['fast-track']], ['HD-1', 'Story', 'Rebuild golden-p', 1, true]);
  const body = readFileSync(ticket.file, 'utf8').replace(/^(created|updated): .*$/gm, '$1: <stamp>');
  assert.equal(body, `---
key: HD-1
type: Story
status: Committed
points: 1
fast-track: true
created: <stamp>
updated: <stamp>
---
# Rebuild golden-p

## User story

As the operator, I want golden-p rebuilt from its current inputs, so that a new VM of p starts with every repository it lists, without cloning one.

## Context

Raised by the health check (check-health-v2, ASS-149): golden-p is stale. Complete as raised: no questions.

- Project: p
- Image: golden-p
- What changed:
  - added repository https://github.com/o/p
  - removed repository https://github.com/o/gone
  - changed definition/provision.sh
- Built: 2026-10-20T12:00:00Z, inputs ${was}
- Inputs now: ${now}
- Command: \`./agent.sh vm:build-golden p\`

## Acceptance criteria

1. golden-p is rebuilt with the current inputs hash, ${now}: \`./agent.sh vm:golden-stale p\` reports it not stale.
2. A new VM of p has every repository project.json lists without cloning one.
3. Ticket VMs already running are untouched by the rebuild.
`);
  const joined = s.sprintTicket('HD-1');
  assert.equal(joined['fast-track'], true);
  assert.equal(joined.variations[0]['harness-status'].state, 'committed');
});

test('ASS-149 AC2: while one is open for the image no other is raised; once it is Done, a still-stale image raises a new one', async () => {
  const s = setup();
  s.built('q', s.inputs('q'));
  s.built('p', s.inputs('p'), { hash: 'f'.repeat(64) });
  await s.raise();
  const again = await s.raise();
  assert.deepEqual(again[0], { project: 'p', image: 'golden-p', stale: true, ticket: 'HD-1', raised: false, joined: false });
  assert.equal((await s.tickets()).length, 1);
  await run(OFF_BOARD, ['ticket:update-status', 'p', 'HD-1', 'Done'], { env: s.env });
  assert.equal((await s.raise())[0].ticket, 'HD-2');
});

test('ASS-149 AC2: an image built before the input list was recorded raises a ticket saying its inputs changed since then; a never-built one says so', async () => {
  const s = setup();
  s.built('p', s.inputs('p'), { hash: 'f'.repeat(64), inputs: undefined });
  await s.raise();
  const [p, q] = await s.tickets();
  assert.match(readFileSync(p.file, 'utf8'), /- What changed:\n {2}- inputs changed since 2026-10-20T12:00:00Z; this build recorded no input list\n- Built: 2026-10-20T12:00:00Z, inputs f{64}\n/);
  assert.equal(q.title, 'Rebuild golden-q');
  assert.match(readFileSync(q.file, 'utf8'), /- What changed:\n {2}- golden-q has not been built\n- Built: never, inputs none\n/);
});

test('ASS-149 AC2 (ASS-83): a ticket whose join failed — no sprint tracking work — stays off-board, and the next run joins it rather than raise another', async () => {
  const s = setup();
  s.built('q', s.inputs('q'));
  s.built('p', s.inputs('p'), { hash: 'f'.repeat(64) });
  s.edit(['projects', 'p', 'sprints.json'], j => { j.list[0]['is-active'] = false; });
  await assert.rejects(s.raise(), e => {
    assert.deepEqual(JSON.parse(e.stdout)[0], { project: 'p', image: 'golden-p', stale: true, ticket: 'HD-1', raised: true, joined: false });
    assert.match(e.stderr, /no active sprint/);
    return true;
  });
  s.edit(['projects', 'p', 'sprints.json'], j => { j.list[0]['is-active'] = true; });
  assert.deepEqual((await s.raise())[0], { project: 'p', image: 'golden-p', stale: true, ticket: 'HD-1', raised: false, joined: true });
  assert.equal((await s.tickets()).length, 1);
  assert.equal(s.sprintTicket('HD-1').variations[0]['harness-status'].state, 'committed');
});

// ASS-157: vm:golden-ready <project> <ticket-key>, the check v2's Await the
// Golden Build step polls before Test — a ticket of <project>'s active sprint
// that is a golden rebuild (fast-tracked, titled "Rebuild golden-<image's
// project>") reads that image's vm:golden-status; any other ticket is let
// through. building(p) holds golden-<p>'s build as a detached one running
// (its process alive, no exit code yet); ended(p, code) ends it — 0 built
// from the inputs now, else failed.
const building = (s, p) => writeFileSync(s.at('projects', p, 'golden-build-run.json'), JSON.stringify({ pid: process.pid, 'started-at': '2026-10-26T14:41:00Z' }));
const ended = (s, p, code) => { writeFileSync(s.at('projects', p, 'golden-build-run.exit'), `${code}\n`); if (code === 0) s.built(p, s.inputs(p)); };
// rebuild(s, key, title, fast) — a ticket of p's active sprint at test.
const rebuild = (s, key, title, fast = true) => s.edit(['projects', 'p', 'sprints', 'sprint-10', 'sprint.json'], j => {
  j.features.push({ key, title, ...(fast ? { 'fast-track': true } : {}), variations: [{ name: 'A', 'harness-status': { state: 'test', 'state-engine': 'harness-development-v2' } }] });
});
const ready = async (s, key) => run(join(import.meta.dirname, '..', '..', 'agent.sh'), ['vm:golden-ready', 'p', key], { env: s.env }).then(r => ({ code: 0, out: JSON.parse(r.stdout) }), e => ({ code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, err: e.stderr }));

test('ASS-157: vm:golden-ready — a golden rebuild ticket\'s image building exits 0 (wait), current 2, failed 3, each printing vm:golden-status\'s reading; a ticket that is no golden rebuild exits 4 at once', async () => {
  const s = setup();
  rebuild(s, 'HD-1', 'Rebuild golden-q');
  rebuild(s, 'HD-2', 'Rebuild golden-q', false);                        // titled so, but not fast-tracked
  rebuild(s, 'HD-3', 'Fix the dashboard');                              // fast-tracked, but no rebuild
  for (const key of ['ABC-3', 'HD-2', 'HD-3']) assert.deepEqual((await ready(s, key)).code, 4, key);
  assert.deepEqual((await ready(s, 'ABC-3')).out, { 'golden-rebuild': false });
  building(s, 'q');
  const wait = await ready(s, 'hd-1');
  assert.deepEqual([wait.code, wait.out.image, wait.out.status], [0, 'golden-q', 'building']);
  ended(s, 'q', 0);
  const current = await ready(s, 'HD-1');
  assert.deepEqual([current.code, current.out.status, current.out['exit-code']], [2, 'current', 0]);
  ended(s, 'q', 1);
  s.built('q', s.inputs('q'), { hash: 'f'.repeat(64) });
  const failed = await ready(s, 'HD-1');
  assert.deepEqual([failed.code, failed.out.status, failed.out['exit-code']], [3, 'failed', 1]);
  const missing = await ready(s, 'HD-9');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /HD-9/);
});

// ASS-157 AC2-AC4, through control: the control fixture with its Local
// Testing step running v2's own v2-local-testing engine (Await the Golden
// Build, then Test and Take Screenshots in the VM, fake limactl and agent),
// ABC-3 A a golden rebuild of p ("Rebuild golden-p", fast-tracked) at build,
// golden-p's definition FILES' and its build a detached one, running; time
// is control's clock, set by the test. at() is where the ticket and its run
// are; moves() the ticket's top-level moves.
function rebuildControl() {
  const f = controlFixture();
  const at = (...p) => join(f.dir, ...p);
  const edit = (path, change) => { const file = at(...path); const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
  Object.assign(f.env, { LIMA_HOME: at('lima'), GOLDEN_IMAGE_SHARED: at('shared') });
  cpSync(join(import.meta.dirname, '..', '..', 'engines', 'v2-local-testing'), at('engines', 'v2-local-testing'), { recursive: true });
  edit(['engines', 'example-development', 'state-engine.json'], e => { e.steps.find(s => s.id === 'local-testing').action.engine = 'v2-local-testing'; });
  for (const prompt of ['test-grouped', 'take-screenshots-grouped']) { mkdirSync(at('prompts', prompt), { recursive: true }); writeFileSync(at('prompts', prompt, 'prompt.txt'), `${prompt} {ticket}\n`); }
  edit(['projects', 'p', 'project.json'], j => { j['golden-image'] = { folder: 'projects/p/golden-image' }; j.repositories = [{ url: 'https://github.com/o/p' }]; });
  mkdirSync(at('projects', 'p', 'golden-image'), { recursive: true });
  mkdirSync(at('shared'), { recursive: true });
  for (const [name, content] of Object.entries(FILES.definition)) writeFileSync(at('projects', 'p', 'golden-image', name), content);
  for (const [name, content] of Object.entries(FILES.shared)) writeFileSync(at('shared', name), content);
  edit(['projects', 'p', 'sprints', 'sprint-10', 'sprint.json'], s => Object.assign(s.features[0], {
    title: 'Rebuild golden-p', 'fast-track': true, 'ticket-system-status': 'In Progress',
    variations: [{ name: 'A', 'harness-status': hs('build'), 'state-changes': [], vm: { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-26T14:00:00Z' } }],
  }));
  writeFileSync(at('projects', 'p', 'golden-build-run.json'), JSON.stringify({ pid: process.pid, 'started-at': '2026-10-26T14:41:00Z' }));
  const v = fakeVm(f.env);
  v.inVm('agent.sh', 'echo "{}"');
  f.ctx.env = v.env;
  let now = Date.parse('2026-10-26T15:00:00Z');
  f.ctx.now = () => new Date(now);
  return {
    ...f,
    later: seconds => { now += seconds * 1000; },
    // The build ends: 0 built from the inputs now (its label the hash vm:golden-stale reads), else failed.
    end: async code => {
      writeFileSync(at('projects', 'p', 'golden-build-run.exit'), `${code}\n`);
      if (code !== 0) return;
      const { hash } = JSON.parse((await run(join(import.meta.dirname, '..', '..', 'agent.sh'), ['vm:golden-stale', 'p'], { env: f.env })).stdout);
      mkdirSync(at('lima', 'golden-p'), { recursive: true });
      writeFileSync(at('lima', 'golden-p', 'golden-image.json'), JSON.stringify({ project: 'p', hash, 'built-at': '2026-10-26T15:30:00Z' }));
    },
    // ABC-3 made an ordinary ticket: neither fast-tracked nor a rebuild.
    plain: () => edit(['projects', 'p', 'sprints', 'sprint-10', 'sprint.json'], s => { delete s.features[0]['fast-track']; s.features[0].title = 'Fix the dashboard'; }),
    at: () => { const v = f.variation(); return [v['harness-status'].state, v['harness-status']['sub-status']?.state ?? null]; },
    moves: () => f.variation()['state-changes'].filter(c => !c['sub-state-change']).map(c => `${c['from-state']}->${c['to-state']}`),
  };
}

test('ASS-157 AC2: while golden-p builds, Test\'s run waits at Await the Golden Build, a timer step polling vm:golden-ready about every 10 seconds — no agent, no move to Build, no failure counted — and the build ending is seen at the next poll, seconds later', async () => {
  const f = rebuildControl();
  const step = JSON.parse(readFileSync(join(engineDir('v2-local-testing'), 'state-engine.json'), 'utf8')).steps[0];
  assert.deepEqual([step.id, step.action.command, step.action.mode], ['await-golden-build', './agent.sh vm:golden-ready {project} {work-item}', 'timer']);
  assert.ok(Math.abs(step.action['timer-minutes'] * 60 - 10) < 1, 'about 10 seconds');
  const polls = () => f.lines.filter(l => /await-golden-build: script exited/.test(l)).length;
  await tick(f.ctx);                                                   // build -> local-testing, its run started
  await tick(f.ctx);                                                   // first poll: building
  assert.deepEqual(f.at(), ['local-testing', 'await-golden-build'], f.lines.join('\n'));
  // Five minutes of building, a tick every 2 seconds (control's default): polled every ~10, never failing, never moving.
  const before = polls();
  for (let i = 0; i < 150; i++) { f.later(2); await tick(f.ctx); }
  assert.deepEqual(f.at(), ['local-testing', 'await-golden-build']);
  assert.deepEqual(f.moves(), ['build->local-testing']);
  assert.deepEqual(f.assignments().assignments, []);
  assert.ok(polls() - before >= 28 && polls() - before <= 31, `${polls() - before} polls in 300 seconds`);
  assert.ok(!f.lines.some(l => /tried again in|blocked/i.test(l)), f.lines.join('\n'));
  // The build ends; the next poll, within ~10 seconds, takes the run on to Test.
  await f.end(0);
  let waited = 0;
  while (f.at()[1] === 'await-golden-build' && waited < 60) { f.later(2); waited += 2; await tick(f.ctx); }
  assert.ok(waited <= 10, `seen ${waited} seconds after the build ended`);
  assert.equal(f.at()[1], 'test', f.lines.join('\n'));
  // AC4: Test judges the settled image once, and the ticket is done — never sent back to Build (here, the fixture's plan).
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true,"summary":"golden-p current"}';
  for (let i = 0; i < 20 && f.at()[0] !== 'done'; i++) { await until(() => [...f.ctx.agents.values()].every(a => a.result)); f.later(2); await tick(f.ctx); }
  assert.deepEqual(f.moves(), ['build->local-testing', 'local-testing->done'], f.lines.join('\n'));
  assert.deepEqual(f.variation()['state-changes'].filter(c => c['sub-state-change']).map(c => c['sub-state-change']['to-state']), ['await-golden-build', 'test', 'take-screenshots', 'done']);
});

test('ASS-157 AC3: a golden-p build that failed, or one current already, is seen at the first poll and goes on to Test once; a ticket that is no golden rebuild goes straight through to Test', async () => {
  for (const [ticket, settle] of [['failed', f => f.end(1)], ['current', f => f.end(0)], ['no rebuild', f => f.plain()]]) {
    const f = rebuildControl();
    await settle(f);
    await tick(f.ctx);
    await tick(f.ctx);
    assert.deepEqual(f.at(), ['local-testing', 'test'], `${ticket}\n${f.lines.join('\n')}`);
    assert.equal(f.lines.filter(l => /await-golden-build: script exited/.test(l)).length, 1, ticket);
  }
});
