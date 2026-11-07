// Which of the real engines' steps a confined host agent runs (ASS-108), and
// that a confined one keeps out of every project's checkout on the Mac (AC6,
// AC7): every host prompt step not on a ticket's code is confined; the
// current engines' code steps all run in the ticket's worktree; the grouped
// engines' code steps — root-cause analysis among them — run in the VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { worksOnCode, confinedWhereText, vmWhereText } from '../../src/control/dispatch.js';
import { runsInVm } from '../../src/control/vm.js';
import { hostAgentSettings } from '../../src/agents/confinement.js';
import { editAllowed, bashWriteAllowed } from '../support/claude-rules.js';
import { engineDir, engineNames } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8'))]));
const hostPrompts = Object.entries(engines).flatMap(([engine, e]) => e.steps.filter(s => s.action?.type === 'prompt' && !runsInVm(s)).map(step => ({ engine, step })));

test('every host prompt step without a worktree is confined but the fix ticket\'s Apply Fix, which changes the repo its ticket names, and grouped Blocked\'s host repair, which repairs the ticket\'s own environment; the VM repair runs in the VM', () => {
  const record = { 'working-in-dev-container': false };
  const unconfined = hostPrompts.filter(({ step }) => worksOnCode(step, { name: 'A' }, record)).map(({ engine, step }) => `${engine}/${step.id}`);
  assert.deepEqual(unconfined.toSorted(), ['grouped-blocked/repair-environment-on-host', 'self-healing-fix/apply-fix']);
  assert.ok(runsInVm(engines['grouped-blocked'].steps.find(s => s.id === 'repair-environment')));
  assert.ok(hostPrompts.length > 20);
  assert.equal(worksOnCode(hostPrompts[0].step, { build: { 'worktree-folder': '/w' } }, record), true);   // in a worktree: the ticket's code
  assert.equal(worksOnCode(hostPrompts[0].step, {}, { 'working-in-dev-container': true }), true);        // the workspace, through the dev container
});

test('the current engines run every code step in the ticket\'s worktree (created before any but Extract Acceptance Criteria), so confinement leaves them as they were', () => {
  for (const name of ['harness-development', 'example-development']) {
    const steps = engines[name].steps;
    const created = steps.find(s => s.id === 'create-worktree').sequence;
    assert.deepEqual(steps.filter(s => s.action.type === 'prompt' && s.sequence < created).map(s => s.id), ['enrich-ac'], name);
  }
});

test('the grouped engines\' code steps — Plan (root-cause analysis among them), Build, Document — run in the ticket variation\'s VM, never on the Mac', () => {
  for (const name of ['grouped-plan', 'grouped-build', 'grouped-document']) {
    const prompts = engines[name].steps.filter(s => s.action.type === 'prompt');
    assert.ok(prompts.length > 0, name);
    for (const step of prompts) assert.ok(runsInVm(step), `${name}/${step.id}`);
  }
  assert.ok(runsInVm(engines['grouped-plan'].steps.find(s => s.id === 'root-cause-analysis')));
});

// The live projects' folders: project.json is untracked, so a fresh clone (a VM's) has none and skips.
test('a confined host agent can change no project\'s checkout on the Mac — each project.json\'s local-pc folder — beyond the harness\'s own data in its own', t => {
  if (!['harness', 'example'].every(p => existsSync(join(ROOT, 'data', 'projects', p, 'project.json')))) return t.skip('no live project.json files');
  const settings = hostAgentSettings(ROOT);
  const tmp = realpathSync(tmpdir());
  const folders = readdirSync(join(ROOT, 'data', 'projects')).filter(p => existsSync(join(ROOT, 'data', 'projects', p, 'project.json')))
    .flatMap(p => (JSON.parse(readFileSync(join(ROOT, 'data', 'projects', p, 'project.json'), 'utf8'))['local-environments'] ?? []).filter(e => e.type === 'local-pc').map(e => e.folder));
  assert.ok(folders.length >= 2, folders.join(', '));
  for (const folder of folders) {
    for (const file of [join(folder, 'todo.md'), join(folder, 'libs', 'users', 'ada', 'docs', 'todo.md'), join(folder, 'src', 'x.js'), join(folder, '.git', 'index')]) {
      assert.equal(editAllowed(settings, file), false, file);
      assert.equal(bashWriteAllowed(settings, file, { cwd: join(ROOT, 'data', 'projects', 'p'), tmp }), false, file);
    }
  }
});

test('a host step in a named repository (run-in-repository, ASS-119) works on that repository\'s code: not confined', () => {
  assert.equal(worksOnCode({ 'run-in-repository': 'harness', action: { type: 'prompt' } }, {}, {}), true);
  assert.equal(worksOnCode({ action: { type: 'prompt' } }, {}, {}), false);
});

// ASS-182 AC3: what each agent is told matches its rules — a confined host agent writes only temp, a VM agent's /mnt/ticket is read-only — and both write the harness's data only through agent.sh, its content on stdin, never piped.
test('ASS-182 AC3: a confined host agent is told it writes only temp and the harness\'s data only through agent.sh, never piping a write; a VM agent that /mnt/ticket is read-only and every write goes through agent.sh on stdin', () => {
  const host = confinedWhereText('/h/data/projects/p', '/code');
  assert.match(host, /You may write only temp; Claude Code refuses any other write\./);
  assert.match(host, /only through the agent\.sh commands you are given/);
  assert.match(host, /never pipe/);
  assert.doesNotMatch(host, /data folders/);
  const vm = vmWhereText({ id: 'p', json: { repositories: [{ url: 'https://github.com/o/app', description: 'The app.' }] } }, 'abc-3-a');
  assert.match(vm, /The ticket's folder is \/mnt\/ticket, read-only: read the ticket's files there; write them only through agent\.sh, the content on stdin\./);
  assert.doesNotMatch(vm, /read and write/);
});

// ASS-229 AC2: a project's VM agents are told how to run its full checks there, from project.json's "vm-full-checks"; none, nothing.
test('ASS-229 AC2: vmWhereText adds project.json\'s vm-full-checks line to {where}, for the whole VM and for one repository; a project without one gets none', () => {
  const repositories = [{ url: 'https://github.com/o/app', description: 'The app.' }];
  const line = 'Full checks: bash scripts/validate.sh in the repository.';
  for (const repository of [undefined, 'app']) {
    const lines = vmWhereText({ id: 'p', json: { repositories, 'vm-full-checks': line } }, 'abc-3-a', repository).split('\n');
    assert.equal(lines.at(-1), line, repository);
    assert.match(vmWhereText({ id: 'p', json: { repositories } }, 'abc-3-a', repository).split('\n').at(-1), /^The ticket's folder is .* Run every other command here, in the VM\.$/, repository);
  }
});

// ASS-238 AC3: the forge token in a VM is for git and package installs only; every VM agent is told so, and to read
// and update merge requests through the host, never calling a forge or Jira API itself.
test('ASS-238 AC3: vmWhereText says the forge token is for git and package installs only, merge requests go through agent.sh merge-request:*, and no forge or Jira API is called from the VM', () => {
  for (const repository of [undefined, 'app']) {
    const vm = vmWhereText({ id: 'p', json: { repositories: [{ url: 'https://github.com/o/app' }] } }, 'abc-3-a', repository);
    assert.ok(vm.includes('The forge token in your environment is for git and package installs only. Read and update merge requests only through agent.sh merge-request:view, merge-request:update, merge-request:upload-image, merge-request:reply and merge-request:resolve; never call a forge or Jira API yourself.'), vm);
  }
});
