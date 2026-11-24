// ASS-551 AC3: engine:validate <project> makes control's project check too (run-targets.js projectRunTargetProblems):
// a machine step the project's tickets can reach that can run on none of its run targets fails it, naming the engine
// and the step; with the shipped engines and the run targets the live projects now have (local-substrate alone; the
// client project's cloud-vm-substrate and workstation-substrate) it passes — Build's CI Checks aside until ASS-552
// takes it out (it is the one Docker step left), so the shipped engines are checked here with that step switched off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEngine, engineFileIn, engineNamesIn } from '../../src/workflow/engine-file.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const cvm = { id: 'vm-1', 'gcp-project': 'g', zone: 'z' };
// CI Checks, wherever the shipped engines still have it (ASS-552 removes it), switched off as a project switches a step off.
const ciOff = Object.fromEntries(engineNamesIn(join(ROOT, 'engines')).flatMap(name => (readEngine(engineFileIn(join(ROOT, 'engines'), name)).steps ?? []).filter(s => s.action?.command?.includes('ci-checks:verify')).map(s => [name, s.id])));
const switchedOff = Object.entries(ciOff).map(([engine, id]) => `${engine}/${id}`);

// validate(json) — engine:validate run for a project p holding `json` (its own engines none), as { status, stdout }.
function validate(json, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'projects-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ name: 'p', ...json }));
  return spawnSync(join(ROOT, 'agent.sh'), ['engine:validate', 'p', ...args], { env: { ...process.env, PROJECTS_DIR: dir }, encoding: 'utf8' });
}

test('ASS-551 AC3: engine:validate <project> fails, naming engine and step, on a machine step the project\'s run targets leave none for; passes with the live projects\' run targets', () => {
  // A project on substrate targets alone whose Docker step (CI Checks) is still on: that step is named.
  const sub = { 'execution-state-engine': 'harness-development-grouped', 'dev-environments': { 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } } };
  if (Object.keys(ciOff).length) {
    const r = validate(sub);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^grouped-build: step "ci-checks" can run on none of project p's run targets: its run-targets \(local-vm, workstation, cloud-vm\) and the project's \(local-substrate\) share none$/m);
    assert.doesNotMatch(r.stdout, /create-vm|add-repository/, 'Setup and Add the Missing Repository have a target now');
    // With <engine>: only that engine's.
    assert.equal(validate(sub, 'grouped-setup').status, 0);
  }
  // A step stranded for sure: a project on the Mac's worktree alone has no target for the machine-only scripts.
  const mac = validate({ 'execution-state-engine': 'harness-development-v2', 'dev-environments': { 'run-targets': ['local-worktree'] } });
  assert.equal(mac.status, 1);
  assert.match(mac.stdout, /^v2-setup: step "create-vm" can run on none of project p's run targets: .* and the project's \(local-worktree\) share none$/m);
  // ASS-554: a project on sandboxes alone leaves its worktree steps (worktree: true) no target — each named.
  const noWorktree = validate({ 'execution-state-engine': 'harness-development-v2', 'dev-environments': { 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } } });
  assert.equal(noWorktree.status, 1);
  assert.match(noWorktree.stdout, /^v2-plan: step "write-execution-plan" can run on none of project p's run targets: it runs in a worktree \(worktree: true\), and the project's run targets \(local-substrate\) include no worktree target/m);
  assert.match(noWorktree.stdout, /^v2-build: step "code-review" can run on none/m);
  assert.doesNotMatch(noWorktree.stdout, /generate-solution/);
  // The live projects' run targets (ASS-554: with the worktree targets each can use), with every shipped execution engine: valid.
  const tops = ['harness-development-v2', 'harness-development-grouped', 'harness-development'].filter(n => engineNamesIn(join(ROOT, 'engines')).includes(n));
  for (const top of tops) for (const d of [
    { 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [{ machine: 'mac' }] } },
    { 'run-targets': ['cloud-vm-substrate', 'workstation-substrate', 'workstation-worktree', 'cloud-vm-worktree'], workstations: [ws], 'cloud-vms': [cvm], substrate: { clusters: [{ machine: 'ws-1' }, { machine: 'vm-1' }] } },
    {},
  ]) {
    const r = validate({ 'execution-state-engine': top, 'dev-environments': d, 'switched-off-steps': switchedOff });
    assert.equal(r.status, 0, `${top} ${JSON.stringify(d['run-targets'] ?? 'unset')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^\d+ engines valid\n$/);
  }
  // A project that is not there is said, not passed.
  const none = spawnSync(join(ROOT, 'agent.sh'), ['engine:validate', 'nope'], { env: { ...process.env, PROJECTS_DIR: mkdtempSync(join(tmpdir(), 'projects-')) }, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no project nope/);
});
