// ticket:plan-obstacle-fix (ASS-163 AC3) — a failure Blocked put in the
// project's code but the latest master does not show (project:check-on-master
// absent) is our environment or access: nothing is raised in the project, and
// the ticket's plan grows to fix what stands in the way. The Blocked run's
// findings (its structured-output: summary, root cause, the master evidence,
// a missing repository) are appended to the ticket's execution-plan.md as an
// obstacle-fix step, no scope added; Blocked's repair then makes it and the
// ticket's own work carries on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

const RUN = '33333333-3333-4333-8333-333333333333';
const FOUND = {
  'needs-fix': true, summary: 'Keycloak parity test fails in the VM', 'root-cause': 'Keycloak container cold start exceeds the test timeout under emulation', evidence: ['pnpm test → timeout'],
  'failing-repository': 'https://gitlab.com/example/identity', 'failing-job': 'test:keycloak', issue: 'project', reasoning: 'R',
  'on-master': 'absent', 'master-evidence': 'https://gitlab.com/example/identity master: job test:keycloak success — u, pipeline p at s',
};

function blocked(output = FOUND) {
  const f = fixture();
  const file = join(f.dir, 'assignments.json'), a = JSON.parse(readFileSync(file, 'utf8'));
  a['transient-state-engines'].push({ id: RUN, project: 'p', 'state-engine': 'grouped-blocked', state: 'plan-obstacle-fix', parent: { 'work-item': 'ABC-3', variation: 'A', 'state-engine': 'example-development-grouped', state: 'blocked' }, 'is-done': false, 'structured-output': output });
  writeFileSync(file, JSON.stringify(a));
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3'), plan = join(folder, 'execution-plan-A.md');
  const revise = (...args) => run(AGENT, ['ticket:plan-obstacle-fix', 'p', 'ABC-3', 'A', ...args], { env: f.env });
  return { ...f, folder, plan, revise, read: () => readFileSync(plan, 'utf8') };
}

test('AC3: the obstacle-fix is appended to the ticket\'s execution plan — what stands in the way, the master evidence it is not the project\'s, the fix, and that no scope is added; the plan before it kept', async () => {
  const f = blocked();
  mkdirSync(f.folder, { recursive: true });
  writeFileSync(f.plan, '# Plan\n\n## Approach\nDo the thing.\n\n## What changed\n- 2026-10-26: first\n');
  const out = JSON.parse((await f.revise(RUN)).stdout);
  const text = f.read();
  assert.ok(text.startsWith('# Plan\n\n## Approach\nDo the thing.\n\n## What changed\n- 2026-10-26: first\n'), 'nothing of the plan lost');
  const added = text.slice(text.indexOf('## Obstacle fix'));
  assert.match(added, /^## Obstacle fix \(\d{4}-\d\d-\d\d, Blocked, variation A\)\n/);
  assert.match(added, /Keycloak parity test fails in the VM/);
  assert.match(added, /Keycloak container cold start exceeds the test timeout/);
  assert.match(added, /Not on the latest master: https:\/\/gitlab\.com\/example\/identity master: job test:keycloak success/);
  assert.match(added, /no project bug raised, no ticket scope added/);
  assert.match(added, /Step added: repair the environment/);
  assert.match(added, /then carry on with this plan's own work/);
  assert.equal(out['plan-revised'], 'execution-plan-A.md');
  assert.match(out['obstacle-fix'], /^repair the environment/);
});

test('AC3: a missing repository is the step named; a ticket with no plan yet gets one holding just the step, for its planning to take in', async () => {
  const f = blocked({ ...FOUND, 'missing-repository': 'https://gitlab.com/g/legal-search' });
  assert.ok(!existsSync(f.plan));
  await f.revise(RUN);
  assert.match(f.read(), /^## Obstacle fix .*\n[\s\S]*Step added: add https:\/\/gitlab\.com\/g\/legal-search to project p and download it/);
});

test('an unknown run, or a bad variation, fails (exit 1) and writes no plan', async () => {
  const f = blocked();
  for (const args of [['44444444-4444-4444-8444-444444444444'], []]) {
    const e = await f.revise(...args).then(() => null, e => e);
    assert.equal(e?.code, 1, args.join(' '));
  }
  const e = await run(AGENT, ['ticket:plan-obstacle-fix', 'p', 'ABC-3', 'Z', RUN], { env: f.env }).then(() => null, e => e);
  assert.equal(e?.code, 1);
  assert.ok(!existsSync(f.plan));
});
