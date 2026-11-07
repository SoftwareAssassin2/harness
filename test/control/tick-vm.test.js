// run-location (ASS-74): a step marked vm runs inside its ticket variation's
// VM — a prompt's agent and a script alike, through limactl shell (here
// test/support/fake-limactl.js, which runs it locally) — and is told where it
// is there; a step without one runs on the host, as before.
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

// The control fixture with plan (a prompt), build (a script) and the test engine's steps at run-location vm (or as `where` says),
// two repositories on p, ABC-3 A's VM recorded (unless vm is null), and limactl a fake.
function vmFixture({ where = 'vm', vm = VM, devContainer = false } = {}) {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, ...rest);
  const located = s => (where ? { ...s, 'run-location': where } : s);
  edit(at('engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? located({ ...s, action: { ...s.action, 'run-in-dev-container': devContainer } }) : s.id === 'build' ? located(s) : s)); });
  edit(at('engines', 'test', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.action.type === 'prompt' ? located(s) : s)); });
  edit(at('projects', 'p', 'project.json'), p => {
    p.repositories = [{ url: 'https://github.com/o/harness', description: 'The harness itself.' }, { url: 'https://gitlab.com/g/example-corpus.git', description: 'The corpus.' }];
    if (devContainer) p['dev-container'] = 'devc';
  });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { if (vm) s.features[0].variations[0].vm = vm; });
  writeFileSync(at('prompts', 'review-plan', 'prompt.txt'), 'Review {ticket} in {folder}; files in {ticket-folder}; run {agent-sh} ticket:questions-answered {project} {ticket}.\nCode: {project-code-folder}.\n{where}\n');
  const lima = fakeVm(f.env);
  const v = { ...lima, calls: () => lima.calls().filter(c => c.argv[0] !== 'list') };   // not control's VM phase reading their status (ASS-75)
  v.inVm('agent.sh', 'echo "{}"');   // the VM's agent.sh: the forwarder's client
  f.ctx.env = v.env;
  const inbox = name => { const dir = readdirSync(at('agents')).find(d => d.startsWith(`${name}-`)); return readFileSync(at('agents', dir, 'inbox.jsonl'), 'utf8'); };
  return { ...f, v, inbox, at: () => f.variation()['harness-status'].state };
}

test('a vm prompt step\'s agent runs in the variation\'s VM, in /repos/, told each repository, /mnt/ticket and the VM\'s agent.sh; a vm script step runs there too', async () => {
  const f = vmFixture();
  f.ctx.env.FAKE_OUTPUT = '{"is-approved":true}';   // a VM's agent has control's env (its own, in a real VM)
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    assert.equal(record.state, 'plan', f.lines.join('\n'));
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => f.v.calls().length));
    const [call] = f.v.calls();
    assert.equal(call.vm, 'abc-3-a');
    assert.equal(call.workdir, '/repos/');
    assert.deepEqual(call.argv.slice(3, 6), [live.agent.marker, 'node', join(import.meta.dirname, '..', 'support', 'fake-agent.js')]);
    const prompt = JSON.parse(f.inbox(record['agent-name']).trim().split('\n')[0]).prompt;
    assert.ok(prompt.includes('Review ABC-3 in /repos/; files in /mnt/ticket; run agent.sh ticket:questions-answered p ABC-3.'), prompt);
    assert.ok(prompt.includes(`update: agent.sh assignments:status-update ${record['agent-name']} "<your update>"`), prompt);   // the template's commands are the VM's too
    assert.ok(prompt.includes('Where you are: in this ticket variation\'s own VM, abc-3-a.'), prompt);
    assert.ok(prompt.includes('- harness (https://github.com/o/harness), in /repos/harness/: The harness itself.'), prompt);
    assert.ok(prompt.includes('- example-corpus (https://gitlab.com/g/example-corpus.git), in /repos/example-corpus/: The corpus.'), prompt);
    assert.ok(prompt.includes('/mnt/ticket'), prompt);
    assert.ok(prompt.includes('Code: /repos/harness/, /repos/example-corpus/.'), prompt);   // the project's code, each repository's checkout (ASS-106)
    assert.ok(f.lines.some(l => new RegExp(`^dispatch ${record['agent-name']} .* in /repos/ \\(VM abc-3-a\\)$`).test(l)), f.lines.join('\n'));

    assert.ok(await until(() => live.result));
    // finished: plan → build, whose script runs in the VM → local-testing, whose test engine's run — a vm
    // prompt step of a run — gets its agent in the same VM, this same tick. No tick more: it would finish
    // that agent too once its turn had ended, as under load it had, and none would be at test (ASS-267).
    await tick(f.ctx);
    assert.ok(f.v.calls().some(c => c.vm === 'abc-3-a' && c.workdir === '/repos/' && c.argv.join(' ') === 'agent.sh ticket:set-paused p ABC-3 A false'), f.lines.join('\n'));
    assert.equal(f.at(), 'local-testing', f.lines.join('\n'));
    const runAgent = f.assignments().assignments.find(a => a.state === 'test');
    assert.ok(runAgent, f.lines.join('\n'));
    assert.ok(await until(() => f.v.calls().some(c => c.vm === 'abc-3-a' && c.argv[3] === f.ctx.agents.get(runAgent['agent-name']).agent.marker)));
  } finally {
    f.ctx.stopAgents();
  }
});

test('a vm step whose variation has no VM yet is not started: held and logged, never run on the host instead', async () => {
  const f = vmFixture({ vm: null });
  try {
    await tick(f.ctx);
    assert.equal(f.ctx.agents.size, 0);
    assert.deepEqual(f.v.calls(), []);
    assert.ok(f.lines.some(l => /^error dispatch ABC-3 A: ABC-3 A plan runs in its VM, and the variation has none: its Create VM step \(vm:create\) has not run; tried again in/.test(l)), f.lines.join('\n'));
  } finally { f.ctx.stopAgents(); }
});

test('steps without run-location (the current engines) run on the host exactly as before, VM or not: nothing runs in a VM', async () => {
  const f = vmFixture({ where: null });
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    // On the host; with no worktree it is not on the ticket's code, so confined in the harness's folder (ASS-108).
    assert.ok(f.lines.some(l => new RegExp(`^dispatch ${record['agent-name']} .* in ${join(f.dir, 'projects', 'p')}$`).test(l)), f.lines.join('\n'));
    assert.ok(await until(() => f.ctx.agents.get(record['agent-name']).result));
    await tick(f.ctx);
    assert.equal(f.at(), 'local-testing');
    assert.deepEqual(f.v.calls(), []);
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('in a project with a dev container (example), a vm step that asks for it works in the VM instead: the workspace is never checked out, nor the container named', async () => {
  const f = vmFixture({ devContainer: true });
  try {
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    assert.equal(record['working-in-dev-container'], false);
    assert.ok(!f.lines.some(l => /code:checkout-in-workspace|docker exec|devc/.test(l)), f.lines.join('\n'));
    assert.ok(await until(() => f.v.calls()[0]?.vm === 'abc-3-a'));
  } finally { f.ctx.stopAgents(); }
});
