// ticket:repair-environment (ASS-124) — an environment issue the grouped
// ticket health check found is repaired as Blocked repairs one: the sampled
// ticket goes to its own Blocked, entering Blocked's sub-engine at its repair
// step (in the VM once Setup is complete, else on the host — as Blocked's
// Classify chooses), its run given what the check found; where its engine's
// Blocked has no such repair, the ticket goes to Blocked for Human with what
// was found and what to do. Never while an agent works on the ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, run, AGENT } from './harness-fixture.js';

const HEALTH = 'cccccccc-0000-4000-8000-000000000001', CHECK = 'cccccccc-0000-4000-8000-000000000002';
const FOUND = { 'is-healthy': false, summary: 'node_modules predates the lockfile', issue: 'environment', reasoning: 'stale install in the VM', 'human-action': 'Reinstall dependencies in the ticket\'s VM' };
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The fixture with p on engine g-dev (work, done, and a Blocked whose sub-engine `blocked` names — g-blocked repairs, g-plain does not),
// and a grouped ticket health check of the harness project h about ABC-3 `variation`, at its repair step with what it found.
function sampled({ variation = 'C', blocked = 'g-blocked', vm } = {}) {
  const f = fixture();
  const at = (...rest) => join(f.dir, ...rest);
  const write = (path, json) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(json)); };
  const done = { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } };
  write(at('engines', 'g-dev', 'state-engine.json'), { steps: [
    { id: 'blocked-for-human', sequence: 0, 'is-blocked-state': true, action: { type: 'human' } },
    { id: 'blocked', sequence: 0, action: { type: 'state-engine', engine: blocked } },
    { id: 'work', sequence: 1, action: { type: 'prompt', prompt: 'generate-solution' } }, done] });
  write(at('engines', 'g-blocked', 'state-engine.json'), { steps: [
    { id: 'troubleshoot', sequence: 1, action: { type: 'prompt', prompt: 'troubleshoot-block-grouped' } },
    { id: 'repair-environment', sequence: 2, action: { type: 'prompt', prompt: 'repair-environment-grouped' } },
    { id: 'repair-environment-on-host', sequence: 3, action: { type: 'prompt', prompt: 'repair-environment-on-host-grouped' } }, done] });
  write(at('engines', 'g-plain', 'state-engine.json'), { steps: [{ id: 'troubleshoot', sequence: 1, action: { type: 'prompt', prompt: 'troubleshoot-block' } }, done] });
  edit(at('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = 'g-dev'; });
  edit(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    for (const v of s.features[0].variations) v['harness-status'] = { state: 'work', 'state-engine': 'g-dev' };
    if (vm) s.features[0].variations.find(v => v.name === variation).vm = { name: vm };
  });
  edit(at('assignments.json'), a => a['transient-state-engines'].push(
    { id: HEALTH, project: 'h', 'state-engine': 'harness-development-grouped/check-ticket-health-steps', state: 'check-ticket-health', parent: { trigger: 'check-ticket-health', 'work-item': 'ABC-3', variation, 'ticket-project': 'p' }, 'is-done': false, 'structured-output': null },
    { id: CHECK, project: 'h', 'state-engine': 'check-ticket-health-grouped', state: 'repair-environment', parent: { 'transient-state-engine': HEALTH, 'state-engine': 'harness-development-grouped/check-ticket-health-steps', state: 'check-ticket-health' }, 'is-done': false, 'structured-output': FOUND },
  ));
  // A Lima whose every VM runs and holds the setup-complete marker.
  const bin = mkdtempSync(join(tmpdir(), 'lima-'));
  writeFileSync(join(bin, 'limactl'), '#!/bin/sh\ncase "$1" in list) echo Running;; shell) exit 0;; esac\n');
  chmodSync(join(bin, 'limactl'), 0o755);
  const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` };
  const repair = id => run(AGENT, ['ticket:repair-environment', id], { env });
  return { ...f, repair };
}
const exitOf = promise => promise.then(() => 0, e => e.code);
const where = v => [v['harness-status'].state, v['harness-status']['sub-status'] ?? null];

test('AC1: the sampled ticket goes to its own Blocked at the repair step — on the host while its Setup is not complete — and its Blocked run is given what the check found', async () => {
  const f = sampled();
  const out = JSON.parse((await f.repair(CHECK)).stdout);
  assert.deepEqual(out, { project: 'p', ticket: 'ABC-3', variation: 'C', 'handed-to': 'blocked', at: 'repair-environment-on-host' });
  const c = f.variation('C');
  assert.deepEqual(where(c), ['blocked', { state: 'repair-environment-on-host', 'state-engine': 'g-blocked', output: { summary: FOUND.summary, issue: 'environment', reasoning: FOUND.reasoning, 'human-action': FOUND['human-action'] } }]);
  assert.deepEqual(c['state-changes'].at(-2)['from-state'], 'work', 'from where it was: Blocked returns it there, repaired');
});

test('AC1: in the ticket\'s VM once its Setup is complete', async () => {
  const f = sampled({ vm: 'p-abc-3-c' });
  assert.equal(JSON.parse((await f.repair(CHECK)).stdout).at, 'repair-environment');
  assert.equal(f.variation('C')['harness-status']['sub-status'].state, 'repair-environment');
});

test('AC2: where the ticket\'s Blocked makes no such repair it may not be repaired: Blocked for Human, with what was found and what to do', async () => {
  const f = sampled({ blocked: 'g-plain' });
  assert.deepEqual(JSON.parse((await f.repair(CHECK)).stdout), { project: 'p', ticket: 'ABC-3', variation: 'C', 'handed-to': 'blocked-for-human' });
  const c = f.variation('C');
  assert.deepEqual(where(c), ['blocked-for-human', null]);
  assert.equal(c['ai-feedback-short'], FOUND['human-action']);
  assert.match(c['ai-feedback-long'], /ticket health check.*node_modules predates the lockfile.*stale install in the VM.*g-plain.*Reinstall dependencies/s);
});

test('held while an agent works on the ticket (exit 2), nothing written; a ticket already Blocked, for Human or done is left as it is', async () => {
  const f = sampled({ variation: 'A' });
  const before = f.snapshot();
  assert.equal(await exitOf(f.repair(CHECK)), 2);
  assert.equal(f.snapshot(), before);
  for (const state of ['blocked', 'blocked-for-human', 'done']) {
    const g = sampled();
    edit(join(g.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations.find(v => v.name === 'C')['harness-status'].state = state; });
    const was = g.snapshot();
    assert.match((await g.repair(CHECK)).stdout, /left as it is/, state);
    assert.equal(g.snapshot(), was, state);
  }
});

test('fails (exit 1) on a run it does not know, or one about no ticket', async () => {
  const f = sampled();
  await assert.rejects(f.repair('nope'), e => e.code === 1 && /no run nope/.test(e.stderr));
  edit(join(f.dir, 'assignments.json'), a => { a['transient-state-engines'].find(r => r.id === HEALTH).parent = { trigger: 'check-health' }; });
  await assert.rejects(f.repair(CHECK), e => e.code === 1 && /about no ticket/.test(e.stderr));
});
