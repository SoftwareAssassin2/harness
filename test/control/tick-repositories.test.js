// run-in-repository (ASS-119): a prompt step runs in one named repository of
// its project, or once in each repository the ticket's planned merge requests
// touch, one after another, the step passing only when every run passes; a
// step that declares neither runs where it always has (tick-vm.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeVm } from '../support/fake-vm.js';
import { until } from '../support/until.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const VM = { name: 'abc-3-a', ip: '192.168.64.9', 'created-at': '2026-10-19T00:00:00Z' };
const HARNESS = 'https://github.com/o/harness', CORPUS = 'https://gitlab.com/g/example-corpus.git';
const planned = (id, repository) => ({ id, repository, branch: `change/ABC-3-${id}`, contents: 'x', 'depends-on': [], status: 'Not Created', key: null, url: null, 'build-status': null });

// The control fixture with its plan step (a prompt: approved → build, not → plan) at run-in-repository `repo`,
// in the VM (or on the host, where: 'host'); p's two repositories; ABC-3 A's VM and its planned merge requests `plan`.
function repoFixture({ repo, where = 'vm', plan = [] }) {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  edit(at('engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? { ...s, 'run-location': where, ...(repo ? { 'run-in-repository': repo } : {}) } : s)); });
  edit(at('projects', 'p', 'project.json'), p => { p.repositories = [{ url: HARNESS, description: 'The harness itself.' }, { url: CORPUS, description: 'The corpus.' }]; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { Object.assign(s.features[0].variations[0], { vm: VM, 'merge-request': plan }); });
  writeFileSync(at('prompts', 'review-plan', 'prompt.txt'), 'Review {ticket} in {folder}.\nCode: {project-code-folder}.\n{where}\n');
  const lima = fakeVm(f.env);
  const v = { ...lima, calls: () => lima.calls().filter(c => c.argv[0] !== 'list') };
  v.inVm('agent.sh', 'echo "{}"');
  f.ctx.env = v.env;
  const prompt = name => { const dir = readdirSync(at('agents')).find(d => d.startsWith(`${name}-`)); return JSON.parse(readFileSync(at('agents', dir, 'inbox.jsonl'), 'utf8').trim().split('\n')[0]).prompt; };
  // agent() — the one live agent, once its turn has ended: { record, live, prompt, workdir (in the VM) }.
  const agent = async () => {
    const [record] = f.assignments().assignments;
    assert.ok(record, f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => live.result), f.lines.join('\n'));
    return { record, live, prompt: prompt(record['agent-name']), workdir: f.v?.calls().findLast(c => c.argv[3] === live.agent.marker)?.workdir };
  };
  f.v = v;
  return { ...f, agent, at: () => f.variation()['harness-status'].state };
}

test('a step in one named repository starts its VM agent in /repos/<repo>/, its prompt naming that repository alone as where it works', async () => {
  const f = repoFixture({ repo: 'example-corpus' });
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);
  const { prompt, workdir } = await f.agent();
  assert.equal(workdir, '/repos/example-corpus/');
  assert.ok(prompt.includes('Review ABC-3 in /repos/example-corpus/.'), prompt);
  assert.ok(prompt.includes('Code: /repos/example-corpus/.'), prompt);
  assert.ok(prompt.includes('You are in /repos/example-corpus/, the checkout of example-corpus (https://gitlab.com/g/example-corpus.git); this step works in that repository alone. example-corpus: The corpus.'), prompt);
  assert.ok(!prompt.includes('/repos/harness/'), prompt);
  await tick(f.ctx);
  assert.equal(f.at(), 'local-testing', f.lines.join('\n'));   // approved: plan → build, whose script runs on
});

test('on the host, a step in one named repository starts in its checkout there — the worktree, or the workspace — its prompt naming the repository', async () => {
  const f = repoFixture({ repo: 'harness', where: 'host' });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    const { prompt, record } = await f.agent();
    assert.ok(prompt.includes(`Review ABC-3 in ${join(f.dir, 'workspace')}.`), prompt);
    assert.ok(prompt.includes('This step works in the repository harness alone: this checkout is where you work.'), prompt);
    assert.ok(f.lines.some(l => l.startsWith(`dispatch ${record['agent-name']} `) && l.endsWith(`in ${join(f.dir, 'workspace')} for harness`)), f.lines.join('\n'));
    assert.deepEqual(f.v.calls(), []);
  } finally { delete process.env.FAKE_OUTPUT; }
});

test('a step in each repository runs once per repository the ticket\'s planned merge requests touch, one after another in one agent slot; it passes once every run has', async () => {
  const f = repoFixture({ repo: 'each', plan: [planned(1, CORPUS), planned(2, HARNESS), planned(3, CORPUS)] });
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);
  const first = await f.agent();
  assert.equal(first.workdir, '/repos/example-corpus/');
  assert.ok(first.prompt.includes('Code: /repos/example-corpus/.'), first.prompt);
  await tick(f.ctx);   // corpus passed: the step stays, and its next run, in harness, starts
  assert.equal(f.at(), 'plan', f.lines.join('\n'));
  assert.deepEqual(f.variation()['state-changes'].map(c => c['to-state']), ['committed', 'plan']);
  assert.equal(f.assignments().assignments.length, 1, 'one agent at a time');
  const second = await f.agent();
  assert.notEqual(second.record['agent-name'] + second.record['start-time'], first.record['agent-name'] + first.record['start-time']);
  assert.equal(second.workdir, '/repos/harness/');
  assert.ok(second.prompt.includes('Code: /repos/harness/.'), second.prompt);
  await tick(f.ctx);   // harness passed too, the last: plan → build → local-testing
  assert.equal(f.at(), 'local-testing', f.lines.join('\n'));
  assert.ok(f.lines.some(l => /example-corpus passed; harness next/.test(l)), f.lines.join('\n'));
});

test('a step in each repository fails when any repository\'s run does: it takes that run\'s exit, and its next visit starts again at the first repository', async () => {
  const f = repoFixture({ repo: 'each', plan: [planned(1, CORPUS), planned(2, HARNESS)] });
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);
  assert.equal((await f.agent()).workdir, '/repos/example-corpus/');
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":false}';   // the harness run's agent rejects
  await tick(f.ctx);
  assert.equal((await f.agent()).workdir, '/repos/harness/');
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);   // rejected: plan → plan, a new visit, whose first run is corpus's again
  assert.deepEqual(f.variation()['state-changes'].map(c => c['to-state']), ['committed', 'plan', 'plan'], f.lines.join('\n'));
  assert.equal((await f.agent()).workdir, '/repos/example-corpus/');
});

test('a step in each repository is passed over, by its first exit, when the ticket touches no repository: no agent runs', async () => {
  const f = repoFixture({ repo: 'each' });
  await tick(f.ctx);
  assert.equal(f.ctx.agents.size, 0);
  assert.deepEqual(f.variation()['state-changes'].map(c => c['to-state']), ['committed', 'plan', 'build'], f.lines.join('\n'));
  assert.ok(f.lines.some(l => l === 'dispatch ABC-3 A plan: the ticket touches no repository; the step is passed over to build'), f.lines.join('\n'));
});

test('ASS-126 AC1: a step passed over waits, as any move, for a slot in the step it would pass to', async () => {
  const f = repoFixture({ repo: 'each' });
  edit(join(f.dir, 'harness.json'), h => { h['max-tickets-in-progress'] = 0; });
  await tick(f.ctx);
  assert.deepEqual(f.variation()['state-changes'].map(c => c['to-state']), ['committed', 'plan'], f.lines.join('\n'));
  assert.ok(f.lines.some(l => l === 'dispatch ABC-3 A plan: waits for an in-progress slot to move to build'), f.lines.join('\n'));
});

test('a step that declares no repository runs as before: its VM agent in /repos/, told every repository', async () => {
  const f = repoFixture({ plan: [planned(1, CORPUS)] });
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);
  const { workdir, prompt } = await f.agent();
  assert.equal(workdir, '/repos/');
  assert.ok(prompt.includes('Code: /repos/harness/, /repos/example-corpus/.'), prompt);
  assert.ok(prompt.includes('which holds a checkout of each of the project\'s repositories'), prompt);
});

test('a sub-engine run\'s step in each repository runs once per repository too, before the run moves on', async () => {
  const f = repoFixture({ plan: [planned(1, HARNESS), planned(2, CORPUS)] });
  edit(join(f.dir, 'engines', 'test', 'state-engine.json'), e => { e.steps[0] = { ...e.steps[0], 'run-location': 'vm', 'run-in-repository': 'each' }; });
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';
  await tick(f.ctx);
  await f.agent();
  // plan → build → local-testing: its test run, whose test step gets its first agent in this same tick. No tick
  // follows until that agent's turn has ended (f.agent): one more here finished it too whenever its turn had
  // ended by then — under load it had — and its second run, in example-corpus, was the first seen (ASS-267).
  await tick(f.ctx);
  const run = () => f.assignments()['transient-state-engines'][0];
  assert.equal(run().state, 'test', f.lines.join('\n'));
  assert.equal((await f.agent()).workdir, '/repos/harness/');
  await tick(f.ctx);
  assert.equal(run().state, 'test', f.lines.join('\n'));
  assert.equal((await f.agent()).workdir, '/repos/example-corpus/');
  await tick(f.ctx);
  assert.equal(run().state, 'take-screenshots', f.lines.join('\n'));
});
