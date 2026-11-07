// The workspace: a step that runs in the dev container has the project's
// local-pc checkout to itself, on the ticket's branch, and gives it back when
// its agent ends; the next such step waits for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hs } from '../agent-cli/harness-fixture.js';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };

// The control fixture whose plan step runs in the dev container, two tickets at backlog (ABC-3, ABC-4), each with a branch and a worktree in a workspace.
function workspaceFixture() {
  const f = controlFixture();
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  execFileSync('git', ['init', '-q', '--initial-branch=master', ws]);
  git(ws, 'config', 'user.email', 't@example.com'); git(ws, 'config', 'user.name', 'T');
  writeFileSync(join(ws, 'README.md'), 'hi\n'); git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'first');
  for (const key of ['ABC-3', 'ABC-4']) { git(ws, 'branch', `change/${key}`); git(ws, 'worktree', 'add', '-q', join(ws, '.worktrees', key), `change/${key}`); }
  git(ws, 'checkout', '-q', '--detach');
  const build = key => ({ branch: `change/${key}`, 'branch-url': null, worktree: key, 'worktree-folder': join(ws, '.worktrees', key) });
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? { ...s, action: { ...s.action, 'run-in-dev-container': true } } : s)); });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['local-environments'] = [{ name: 'local-pc', type: 'local-pc', folder: ws, 'active-branch': null }]; });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0].variations[0].build = build('ABC-3');
    s.features.push({ key: 'ABC-4', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [], build: build('ABC-4') }] });
  });
  return { ...f, ws, active: () => JSON.parse(readFileSync(join(f.dir, 'projects', 'p', 'project.json'), 'utf8'))['local-environments'][0]['active-branch'], at: key => f.sprint().features.find(t => t.key === key).variations[0]['harness-status'].state };
}

test('tick: one agent at a time in the workspace, on its ticket\'s branch, told the dev container and its folder there; the next waits, logged once, and takes it when the first ends', async () => {
  const f = workspaceFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['dev-container'] = 'devc'; });
  f.ctx.mounts = () => [{ Source: f.ws, Destination: '/workspace' }];
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  // ABC-3's agent holds its turn until the test lets it end, so the waiting ticks see it still working.
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try {
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments.map(a => [a['work-item'], a.state, a['working-in-dev-container']]), [['ABC-3', 'plan', true]], f.lines.join('\n'));
    assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(f.ws, 'rev-parse', 'change/ABC-3'));   // the workspace sits at the branch, detached
    assert.equal(git(join(f.ws, '.worktrees', 'ABC-3'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'change/ABC-3');
    assert.equal(f.active(), 'change/ABC-3');
    assert.ok(f.lines.some(l => new RegExp(`^dispatch \\S+ \\(\\S+\\) on ABC-3 A plan, pid \\d+, in ${join(f.ws, '.worktrees', 'ABC-3')} \\(devc:/workspace/\\.worktrees/ABC-3\\)$`).test(l)), f.lines.join('\n'));
    const told = f.lines.find(l => l.startsWith(`cli agent.sh agent:dispatch ${f.assignments().assignments.find(a => a['work-item'] === 'ABC-3')['agent-name']} `));
    assert.ok(told.includes(`folder=${join(f.ws, '.worktrees', 'ABC-3')} "where=Where you are: this checkout is ${join(f.ws, '.worktrees', 'ABC-3')} on the host.`), told);   // told, explicitly, where it is on both sides
    assert.ok(told.includes('docker exec -w /workspace/.worktrees/ABC-3 devc <command>'), told);
    assert.equal(f.at('ABC-4'), 'plan');
    assert.deepEqual(f.lines.filter(l => /waits for the workspace/.test(l)), [`dispatch ABC-4 A plan waits for the workspace (${f.assignments().assignments.find(a => a['work-item'] === 'ABC-3')['agent-name']} has it for ABC-3)`]);
    await tick(f.ctx);                                                   // still waiting: not logged again
    assert.equal(f.lines.filter(l => /waits for the workspace/.test(l)).length, 1);
    rmSync(process.env.FAKE_HOLD);
    assert.ok(await turnsEnd(f.ctx));
    await tick(f.ctx);                                                   // ABC-3 moves on, the workspace is released, ABC-4 takes it
    assert.ok(f.lines.some(l => l === 'finish ABC-3 A: the workspace is released'), f.lines.join('\n'));
    assert.deepEqual(f.assignments().assignments.map(a => [a['work-item'], a.state, a['working-in-dev-container']]).toSorted(), [['ABC-3', 'test', false], ['ABC-4', 'plan', true]]);   // ABC-3 went on to local testing, outside the workspace
    assert.equal(git(f.ws, 'rev-parse', 'HEAD'), git(f.ws, 'rev-parse', 'change/ABC-4'));
    assert.equal(f.active(), 'change/ABC-4');
  } finally {
    delete process.env.FAKE_HOLD;
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});

test('tick: a workspace that cannot take the branch (uncommitted changes) is logged under error and nothing is dispatched to it', async () => {
  const f = workspaceFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['dev-container'] = 'devc'; });
  f.ctx.mounts = () => [{ Source: f.ws, Destination: '/workspace' }];
  writeFileSync(join(f.ws, 'README.md'), 'dirty\n');
  try {
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);
    assert.ok(f.lines.some(l => /^error dispatch ABC-3 A: .*uncommitted changes/.test(l)), f.lines.join('\n'));
    assert.equal(git(f.ws, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a workspace another branch holds, with no assignment to show for it, refuses the branch (ASS-173): logged under error, nothing dispatched, the claim kept', async () => {
  const f = workspaceFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['dev-container'] = 'devc'; p['local-environments'][0]['active-branch'] = 'change/OTHER'; });
  f.ctx.mounts = () => [{ Source: f.ws, Destination: '/workspace' }];
  const head = git(f.ws, 'rev-parse', 'HEAD');
  try {
    await tick(f.ctx);
    assert.deepEqual(f.assignments().assignments, []);
    assert.ok(f.lines.some(l => /^error dispatch ABC-3 A: .*the workspace is held by change\/OTHER; tried again in /.test(l)), f.lines.join('\n'));
    assert.equal(git(f.ws, 'rev-parse', 'HEAD'), head);
    assert.equal(f.active(), 'change/OTHER');
  } finally {
    f.ctx.stopAgents();
  }
});

test('tick: a project with no dev container never has its workspace checked out: a step meant for the container runs in its worktree on the host, told so, and holds no workspace', async () => {
  const f = workspaceFixture();                                         // no dev-container in project.json: as the harness's own project
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  try {
    const head = git(f.ws, 'rev-parse', 'HEAD');
    await tick(f.ctx);
    assert.equal(git(f.ws, 'rev-parse', 'HEAD'), head);                  // the workspace never moved
    assert.equal(f.active(), null);
    assert.deepEqual(f.assignments().assignments.map(a => [a['work-item'], a.state, a['working-in-dev-container']]).toSorted(), [['ABC-3', 'plan', false], ['ABC-4', 'plan', false]], f.lines.join('\n'));   // both at once: no workspace to wait for
    const told = f.lines.find(l => l.startsWith(`cli agent.sh agent:dispatch ${f.assignments().assignments.find(a => a['work-item'] === 'ABC-3')['agent-name']} `));
    assert.ok(told.includes(`folder=${join(f.ws, '.worktrees', 'ABC-3')} "where=Where you are: this checkout is ${join(f.ws, '.worktrees', 'ABC-3')}, on the host, with everything this project needs: run every command here."`), told);
    assert.ok(told.includes(`project-code-folder=${join(f.ws, '.worktrees', 'ABC-3')}`), told);   // on the host the project's code is the worktree (ASS-106)
    assert.ok(!f.lines.some(l => /checkout-in-workspace|waits for the workspace/.test(l)), f.lines.join('\n'));
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
});
