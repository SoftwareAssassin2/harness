// The grouped engines' Blocked (ASS-107, ASS-97; grouped-blocked — the
// current engines' blocked stays as it was, their reference): an AI
// troubleshoots, learning from the ticket's earlier blocks, then classifies the
// block — a harness, project or environment issue — and each goes its own
// way: a harness issue to a fix ticket in the harness project's backlog, a
// project issue to one in the ticket's own project's ticket system (on the
// harness project, the same backlog), each waited on until it lands; an
// environment issue repaired in place, in the ticket's own VM or worktree
// and the project's containers, or else handed to a human. Blocked for Human
// comes only after 3 failed fix attempts in one stay, or when no fix can be
// raised or waited on — never a resume as if fixed. Walked here with
// control's own reading of an engine (src/control/engine.js nextState), each
// step's facts faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState, resumeSubAt, clearCause } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { problemOf, runValues, blockHistory } from '../../src/control/facts.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { inOrder, engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const FIX_MR = 'https://gitlab.com/example/api/-/merge_requests/41';
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8'))]));
const BLOCKED = ['grouped-blocked'];
const TOPS = { 'grouped-blocked': ['example-development-grouped', 'harness-development-grouped'] };

// walk(name, answers) — a Blocked run walked from its first step to a done
// step: each step's facts are these defaults (a real problem, a harness
// issue, its fix ticket raised, waited on and landed, a repair made, the VM
// set up), overridden by answers[<step>] — an object, or a list by visit.
// Its output merged as control merges it (moveRun: prompts', sub-engines'
// and record-script-output scripts'). Returns { trail, end, output }.
function walk(name, answers = {}) {
  const engine = engines[name], trail = [], changes = [], visits = new Map();
  let output = {};
  for (let at = firstStepId(engine), i = 0; i < 100; i++) {
    trail.push(at);
    const step = stepOf(engine, at);
    if (step['is-done']) return { trail, end: at, output };
    const n = visits.get(at) ?? 0;
    visits.set(at, n + 1);
    const answer = Array.isArray(answers[at]) ? answers[at][Math.min(n, answers[at].length - 1)] : answers[at];
    const f = {
      turnComplete: true, exitCode: 0, scriptSucceeds: () => true, subEngineDone: true, subEngineState: 'done',
      ...defaults[at], ...answer,
    };
    if (['prompt', 'state-engine'].includes(step.action.type)) output = { ...output, ...f.structuredOutput };
    if (step['record-script-output'] && f.scriptOutput) output = { ...output, ...f.scriptOutput };
    const next = nextState(step, engine, { ...f, structuredOutput: step.action.type === 'script' ? output : f.structuredOutput }, changes);
    assert.ok(next?.to, `${name}/${at}: no exit`);
    changes.push({ 'from-state': at, 'to-state': next.to });
    at = next.to;
  }
  throw new Error(`${name} ran away: ${trail.slice(-10).join(' ')}`);
}
const defaults = {
  troubleshoot: { structuredOutput: { 'needs-fix': true, summary: 'S', 'root-cause': 'C', evidence: [] } },
  'troubleshoot-on-host': { structuredOutput: { 'needs-fix': true, summary: 'S', 'root-cause': 'C', evidence: [] } },
  classify: { structuredOutput: { issue: 'harness', reasoning: 'R' } },
  'repair-environment': { structuredOutput: { remediated: true, evidence: ['pnpm install → ok'], 'ai-feedback-short': 'Repaired', 'ai-feedback-long': 'node_modules reinstalled' } },
  'repair-environment-on-host': { structuredOutput: { remediated: true, evidence: [], 'ai-feedback-short': 'Repaired', 'ai-feedback-long': 'L' } },
  // ASS-316: the reason and why are the empty key's; a run that raised one carries them blank (the contract requires both).
  'create-fix-ticket': { structuredOutput: { key: 'ASS-1', 'no-ticket-reason': '', why: '' } },
  'add-repository': { exitCode: 2 },   // no missing repository named: nothing added
  'check-on-master': { exitCode: 0, scriptOutput: { 'on-master': 'present', 'master-evidence': 'E' } },   // ASS-163: failing on the latest master
  'plan-obstacle-fix': { exitCode: 0, scriptOutput: { 'plan-revised': 'execution-plan.md', 'obstacle-fix': 'repair the environment' } },
  // ASS-384: not shown to be the ticket's own branch — the paths after check-on-master as before.
  'own-branch-or-obstacle': { exitCode: 3, scriptOutput: { 'own-branch-fix': false, 'own-branch-why': 'Classify did not put the cause in the ticket\'s own branch' } },
  'own-branch-or-human': { exitCode: 3, scriptOutput: { 'own-branch-fix': false, 'own-branch-why': 'Classify did not put the cause in the ticket\'s own branch' } },
  // ASS-390: the blocked step still fails on re-check (Check First), so Troubleshoot goes on as before.
  'check-first': { exitCode: 3, scriptOutput: { rechecked: true, recheck: { at: 'build/automated-testing', command: './agent.sh automated-tests:verify-success p X-1 A', exit: 1, output: 'F' } } },
  // ASS-390 AC2/AC6: Repair Project's fix merge request opened, waited on and merged.
  'repair-project': { structuredOutput: { fixed: true, 'fix-merge-request': FIX_MR, evidence: ['pnpm test → ok'], 'ai-feedback-short': `Opened ${FIX_MR}`, 'ai-feedback-long': 'L' } },
  'repair-project-on-host': { structuredOutput: { fixed: true, 'fix-merge-request': FIX_MR, evidence: [], 'ai-feedback-short': `Opened ${FIX_MR}`, 'ai-feedback-long': 'L' } },
  'wait-on-fix-merge-request': { exitCode: 0, scriptOutput: { ticket: 'X-1', variation: 'A', 'waits-on': { 'merge-request': FIX_MR } } },
  'await-fix-merge-request': { exitCode: 0, scriptOutput: { status: 'Merged', landed: true, 'fix-merge-request': FIX_MR, 'ai-feedback-short': null, 'ai-feedback-long': null } },
  // ASS-392: no golden build running; Repair Image fixes it; verified on a VM from the repaired image.
  'await-golden-build': { exitCode: 0, scriptOutput: { project: 'p', image: 'golden-p', status: 'failed', 'built-at': '2026-11-01T10:00:00Z', generation: 'g1', fix: null } },
  'repair-image': { structuredOutput: { 'golden-building': false, fixed: true, evidence: ['vm:golden-write p images.txt → ok'], 'ai-feedback-short': 'Pinned the arm64 image', 'ai-feedback-long': 'L' } },
  'verify-image': { exitCode: 0, scriptOutput: { 'needs-fix': false, rechecked: true, 'recheck-passed': true, summary: 'Passed on re-check; nothing to fix', recheck: { at: 'build/automated-testing', command: 'c', exit: 0 }, 'image-verified': true } },
};
const issue = value => ({ classify: { structuredOutput: { issue: value, reasoning: 'R' } } });
const steps = run => run.trail.filter(id => !['find-where', 'check-first'].includes(id));

// Where the ticket goes once its Blocked run ends there: its return-to-state (build), or Blocked for Human.
const parent = (top, run) => {
  const changes = [{ 'from-state': 'build', 'to-state': 'blocked' }];
  return nextState(stepOf(engines[top], 'blocked'), engines[top], { subEngineDone: true, subEngineState: run.end, structuredOutput: run.output }, changes).to;
};
const resumes = (name, run) => { for (const top of TOPS[name]) assert.equal(parent(top, run), 'build', `${top}: resumes at its return-to-state`); };
const toHuman = (name, run, why) => {
  assert.equal(run.end, 'blocked-for-human', run.trail.join(' '));
  for (const top of TOPS[name]) assert.equal(parent(top, run), 'blocked-for-human', top);
  assert.match(run.output['ai-feedback-short'] ?? '', why, 'why it is handed to a human, kept as the variation\'s ai-feedback');
};

test('the Blocked engines and the development engines using them are valid', () => {
  for (const name of [...BLOCKED, ...Object.values(TOPS).flat()]) assert.deepEqual(validateStateEngine(engines[name], ROOT, undefined, EXAMPLE_ENGINES), [], name);
  for (const [name, tops] of Object.entries(TOPS)) for (const top of tops) assert.equal(stepOf(engines[top], 'blocked').action.engine, name, top);
});

test('AC1: Troubleshoot, then Classify — its structured output the issue (harness, project or environment) and its reasoning', () => {
  for (const name of BLOCKED) {
    assert.deepEqual(steps(walk(name)), ['count-attempts', 'troubleshoot', 'classify', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'resume-step', 'done'], name);
    assert.equal(stepOf(engines[name], 'troubleshoot-on-host').action.prompt, 'troubleshoot-block-on-host-grouped', 'its own copy: the current engines keep troubleshoot-block as it was');
    assert.equal(stepOf(engines[name], 'classify').action.prompt, 'classify-issue-grouped', 'its own copy (ASS-163): the current engines keep classify-issue as it was');
  }
  const schema = JSON.parse(readFileSync(join(ROOT, 'prompts', 'classify-issue-grouped', 'prompt.json'), 'utf8')).output;
  assert.deepEqual(schema.properties.issue.enum.slice(0, 4), ['harness', 'project', 'environment', 'dependency'], 'ASS-390: dependency');
  for (const added of ['rate-limit', 'credentials', 'image']) assert.ok(schema.properties.issue.enum.includes(added), `ASS-391, ASS-395, ASS-392: ${added}`);
  assert.deepEqual(schema.required, ['issue', 'reasoning']);
  // The troubleshooter finds the cause; where the fix goes is Classify's alone.
  for (const p of ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped']) assert.equal(JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8')).output.properties['cause-in'], undefined, p);
});

test('AC2/AC3: a harness issue and a project issue each raise a fix ticket — the harness project\'s backlog, the ticket\'s own project\'s ticket system; on the harness project both the harness backlog — and the ticket waits on it the same way until it lands, then resumes', () => {
  const harness = { 'harness-project': 'harness' };
  const raisedIn = (output, project) => problemOf({ id: 'r', project, parent: { 'work-item': 'X-1', variation: 'A' }, 'structured-output': output }, [], { harness }).split('\n').find(l => l.startsWith('Raise'));
  for (const name of BLOCKED) {
    for (const [value, example] of [['harness', 'project harness — the harness project\'s backlog'], ['project', 'project example — its own ticket system']]) {
      const run = walk(name, issue(value));
      // A project issue is checked against the latest master first (ASS-163): here, failing there.
      assert.deepEqual(steps(run).slice(2).filter(id => id !== 'check-on-master'), ['classify', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'resume-step', 'done'], `${name} ${value}`);
      resumes(name, run);
      assert.equal(raisedIn(run.output, 'example'), `Raise the fix ticket in: ${example}`, `${name} ${value}`);
      assert.equal(raisedIn(run.output, 'harness'), 'Raise the fix ticket in: project harness — the harness project\'s backlog', `${name} ${value} on the harness project`);
    }
    assert.equal(stepOf(engines[name], 'create-fix-ticket').action.engine, 'create-ticket-grouped', 'its own copy: Jira bugs raised through ticket:raise-bug (ASS-164); the flat engines keep create-ticket');
    // ASS-316: wait-on also takes the reason no fix ticket was raised, and why, for its ai-feedback.
    assert.equal(stepOf(engines[name], 'wait-on').action.command, './agent.sh ticket:wait-on {project} {work-item} {variation} {ticket} {no-ticket-reason} {no-ticket-why}');
    const wait = stepOf(engines[name], 'await-fix');
    assert.deepEqual([wait.action.command, wait.action.mode, wait['record-script-output']], ['./agent.sh ticket:fix-landed {project} {work-item} {variation}', 'timer', true]);
  }
});

// ASS-306 AC1/AC2: the grouped blocked flow fast-tracks its fix ticket — a
// host-side script step between create-fix-ticket and wait-on that marks the
// fix ticket fast-track and joins it to the active sprint at committed, then
// always reaches wait-on so the blocked ticket is recorded as before.
test('ASS-306 AC1: fast-track-fix runs ticket:fast-track host-side between create-fix-ticket and wait-on, keeping {ticket} for wait-on, both exits to wait-on', () => {
  for (const name of BLOCKED) {
    const step = stepOf(engines[name], 'fast-track-fix');
    assert.ok(step, `${name}: has a fast-track-fix step`);
    assert.equal(step.action.type, 'script', name);
    assert.equal(step.action.command, './agent.sh ticket:fast-track {project} {work-item} {ticket}', name);
    assert.equal(step.vm, undefined, `${name}: host-side, runs no VM`);
    assert.equal(step['run-location'], undefined, `${name}: host-side`);
    assert.equal(step['record-script-output'], undefined, `${name}: no record-script-output, so the run's {ticket} is kept for wait-on`);
    // ASS-316: an empty key skips it, straight to wait-on; a ticket raised still reaches it — either way wait-on is next.
    const create = stepOf(engines[name], 'create-fix-ticket');
    assert.deepEqual(create['exit-events'][0], { condition: { all: [{ 'is-done': true }, { 'structured-output': { key: '' } }] }, 'move-to-state': 'wait-on' }, name);
    assert.deepEqual(create['exit-events'][1], { condition: { 'is-done': true }, 'move-to-state': 'fast-track-fix' }, name);
    assert.deepEqual([0, 1].map(code => nextState(step, engines[name], { exitCode: code }, []).to), ['wait-on', 'wait-on'], `${name}: both exits reach wait-on`);
    assert.deepEqual(validateStateEngine(engines[name], ROOT, undefined, EXAMPLE_ENGINES), [], name);
  }
});

// ASS-253 AC1: ticket:fix-landed's "not landed yet" (exit 1) is the step's waiting exit — polled again on
// its timer, no failure (steps.js); every other exit it defines moves on, and any it does not is a failure.
test('ASS-253: await-fix waits on exit 1 (not landed yet) — no exit takes it, landed / failed fix / nothing to wait on each have one', () => {
  for (const name of BLOCKED) {
    const wait = stepOf(engines[name], 'await-fix');
    assert.equal(wait.action['waiting-exit-code'], 1, name);
    assert.equal(nextState(wait, engines[name], { exitCode: 1, scriptOutput: { landed: false } }, []), null, `${name}: not landed stays`);
    assert.deepEqual([0, 3, 4].map(code => nextState(wait, engines[name], { exitCode: code }, []).to), ['resume-step', 'retry', 'blocked-for-human'], name);
    assert.deepEqual(validateStateEngine(engines[name], ROOT, undefined, EXAMPLE_ENGINES), [], name);
  }
  assert.equal(stepOf(engines.blocked, 'await-fix').action['waiting-exit-code'], undefined, 'the flat blocked stays as it was');
});

// ASS-343: once the fix lands, resume-step records where the ticket resumes (ticket:fix-resume-step's
// resume-at) in the run's output, whatever its exit, and the run is done; the parent's return takes it
// when it is a work step at or before the blocked one (AC1), else goes back to the blocked step (AC3).
test('ASS-343: a landed fix\'s resume-step records the run\'s resume-at, and the parent resumes there — upstream of the blocked step; else at the blocked step', () => {
  for (const name of BLOCKED) {
    const step = stepOf(engines[name], 'resume-step');
    assert.deepEqual([step.action.command, step['record-script-output'], step.vm, step['run-location']], ['./agent.sh ticket:fix-resume-step {project} {work-item} {variation}', true, undefined, undefined], name);
    assert.deepEqual([0, 1, 2].map(code => nextState(step, engines[name], { exitCode: code }, []).to), ['done', 'done', 'done'], name);
    const landedAt = resume => walk(name, { 'await-fix': { scriptOutput: { landed: true } }, 'resume-step': { scriptOutput: { 'resume-at': resume, 'resume-source': 'commits', 'resume-why': 'W' } } });
    for (const top of TOPS[name]) {
      const back = (run, from) => nextState(stepOf(engines[top], 'blocked'), engines[top], { subEngineDone: true, subEngineState: run.end, structuredOutput: run.output }, [{ 'from-state': 'review', 'to-state': from }, { 'from-state': from, 'to-state': 'blocked' }]).to;
      assert.equal(back(landedAt('plan'), 'release'), 'plan', `${top}: AC1, upstream of release`);
      assert.equal(back(landedAt('build'), 'release'), 'build', `${top}: AC1`);
      assert.equal(back(landedAt('release'), 'release'), 'release', `${top}: AC3, the blocked step itself`);
      assert.equal(back(landedAt('release'), 'build'), 'build', `${top}: AC3, a step after the blocked one`);
      assert.equal(back(landedAt('committed'), 'release'), 'release', `${top}: AC3, no work step`);
      assert.equal(back(landedAt('requirements-changed'), 'release'), 'release', `${top}: AC3, a detour`);
    }
  }
  // AC2: a resume at plan regenerates its artifacts — the plan group's run starts afresh at its first step, and
  // Write Execution Plan leaves only once its plan file was written in that turn — then Build's generate-solution runs again.
  const plan = engines['grouped-plan'], write = stepOf(plan, 'write-execution-plan');
  const updated = { 'file-updated': { file: 'execution-plan.md', since: 'turn-start' } };
  assert.equal(firstStepId(plan), 'enrich-ac');
  assert.notEqual(nextState(write, plan, { turnComplete: true, fileUpdated: () => false }, []).to, nextState(write, plan, { turnComplete: true, fileUpdated: () => true }, []).to, 'an unwritten plan does not move on');
  assert.deepEqual(write['exit-events'][0].condition, { all: [{ 'turn-complete': true }, updated] });
  assert.ok(stepOf(engines['grouped-build'], 'generate-solution'));
});

test('nothing wrong any more: no fix, no classification — the ticket resumes', () => {
  for (const name of BLOCKED) {
    const run = walk(name, { troubleshoot: { structuredOutput: { 'needs-fix': false } } });
    assert.deepEqual(steps(run), ['count-attempts', 'troubleshoot', 'done'], name);
    resumes(name, run);
  }
});

test('ASS-97 / AC2: an environment issue is repaired in place — in the ticket\'s VM (on the host only while it has none, in its worktree, never the dev container\'s shared checkout) — and, repaired, the ticket resumes; not repaired (it failed, or wasn\'t allowed) it goes to Blocked for Human with what was found and what to do', () => {
  for (const name of BLOCKED) {
    const repaired = walk(name, issue('environment'));
    assert.deepEqual(steps(repaired).slice(2), ['classify', 'add-repository', 'repair-environment', 'done'], name);
    resumes(name, repaired);
    const failed = walk(name, { ...issue('environment'), 'repair-environment': { structuredOutput: { remediated: false, evidence: [], 'ai-feedback-short': 'Re-login to the registry', 'ai-feedback-long': 'Token expired: a credential' } } });
    assert.deepEqual(steps(failed).slice(2), ['classify', 'add-repository', 'repair-environment', 'blocked-for-human'], name);
    toHuman(name, failed, /Re-login/);
  }
  const grouped = engines['grouped-blocked'];
  assert.deepEqual([stepOf(grouped, 'repair-environment')['run-location'], stepOf(grouped, 'repair-environment').action.prompt], ['vm', 'repair-environment-grouped']);
  const noVm = walk('grouped-blocked', { ...issue('environment'), 'find-where': { scriptSucceeds: () => false }, classify: { scriptSucceeds: () => false, structuredOutput: { issue: 'environment', reasoning: 'R' } }, 'add-repository': { exitCode: 2, scriptSucceeds: () => false } });
  assert.deepEqual(steps(noVm).slice(1), ['troubleshoot-on-host', 'classify', 'add-repository', 'repair-environment-on-host', 'done']);
  assert.deepEqual([stepOf(grouped, 'repair-environment-on-host').action.prompt, stepOf(grouped, 'repair-environment-on-host').action['run-in-dev-container']], ['repair-environment-on-host-grouped', false], 'the dev container works in the project\'s shared checkout: never repaired there');
});

// ASS-121: a block whose cause is a repository the project lacks.
const URL = 'https://gitlab.com/g/legal-search';
const missing = (troubleshoot = 'troubleshoot') => ({ [troubleshoot]: { structuredOutput: { 'needs-fix': true, summary: 'S', 'root-cause': 'C', evidence: [], 'missing-repository': URL } }, ...issue('environment') });

test('ASS-121 AC1: Troubleshoot — in the VM or on the host — can conclude a repository the project lacks, naming its forge url (missing-repository), from the ticket\'s own work', () => {
  for (const p of ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped']) {
    const json = JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8'));
    assert.equal(json.output.properties['missing-repository'].type, 'string', p);
    assert.ok(!json.output.required.includes('missing-repository'), `${p}: only when that is the cause`);
    const text = readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
    // Checked against the repositories the project lists: in the VM, the ones at /repos/ (project.json is on the Mac); on the host, project.json.
    assert.match(text, p.includes('on-host') ? /\{project-folder\}\/project\.json/ : /not under \/repos\//, p);
    assert.match(text, /"missing-repository": "<its forge url/, p);
  }
  for (const troubleshoot of ['troubleshoot', 'troubleshoot-on-host']) {
    const run = walk('grouped-blocked', { ...missing(troubleshoot), 'find-where': { scriptSucceeds: () => troubleshoot === 'troubleshoot' }, 'add-repository': { exitCode: 0 } });
    assert.equal(run.output['missing-repository'], URL, 'kept by the run for Repair, and for Classify in its {problem} (facts.js problemOf)');
  }
});

test('ASS-121 AC2: Classify routes it, an environment issue, to Repair Environment\'s first step, Add the Missing Repository — the url the run kept, on the host, the VM kept running for its download — and, added and downloaded, the ticket resumes (retries the group it was blocked in)', () => {
  const add = stepOf(engines['grouped-blocked'], 'add-repository');
  assert.deepEqual([add.action.type, add.action.command, add['record-script-output'], add['run-location']], ['script', './agent.sh project:add-repository {project} {work-item} {variation} {missing-repository}', true, undefined]);
  for (const vm of [true, false]) {
    const run = walk('grouped-blocked', { ...missing(vm ? 'troubleshoot' : 'troubleshoot-on-host'), 'find-where': { scriptSucceeds: () => vm }, 'add-repository': { exitCode: 0, scriptOutput: { repository: URL, added: true, downloaded: vm } } });
    assert.deepEqual(run.trail.slice(-3), ['classify', 'add-repository', 'done'], `VM set up: ${vm}`);
    resumes('grouped-blocked', run);
  }
});

test('ASS-121 AC3: one the harness cannot access is not added — Blocked for Human, naming it and why; a failed download goes there too', () => {
  const denied = walk('grouped-blocked', { ...missing(), 'add-repository': { exitCode: 3, scriptOutput: { 'ai-feedback-short': `Needs ${URL}, which the harness cannot access`, 'ai-feedback-long': 'glab repo view said: 404' } } });
  assert.deepEqual(denied.trail.slice(-3), ['classify', 'add-repository', 'blocked-for-human']);
  toHuman('grouped-blocked', denied, /legal-search, which the harness cannot access/);
  const failed = walk('grouped-blocked', { ...missing(), 'add-repository': { exitCode: 1, scriptOutput: { 'ai-feedback-short': `Added ${URL} to p, but could not download it` } } });
  toHuman('grouped-blocked', failed, /could not download it/);
});

test('ASS-160 AC2: a repository another project lists (project:add-repository exit 4) goes to Blocked for Human, saying the ticket needs that project\'s access, not that the repository is missing', () => {
  const run = walk('grouped-blocked', { ...missing(), 'add-repository': { exitCode: 4, scriptOutput: { 'ai-feedback-short': `Needs example's access: ${URL} is example's repository`, 'ai-feedback-long': 'ABC-3 needs it: the ticket belongs in example, or must be done on the Mac' } } });
  assert.deepEqual(run.trail.slice(-3), ['classify', 'add-repository', 'blocked-for-human']);
  toHuman('grouped-blocked', run, /^Needs example's access/);
  assert.match(run.output['ai-feedback-long'], /belongs in example, or must be done on the Mac/);
});

test('ASS-121 AC4/AC5: nothing else adds a repository — a block with another cause never reaches the step, or passes it adding nothing (none named: exit 2) to the repair it had; no other step of any engine runs project:add-repository', () => {
  for (const value of ['harness', 'project']) assert.ok(!walk('grouped-blocked', { ...missing(), ...issue(value) }).trail.includes('add-repository'), value);
  const other = walk('grouped-blocked', issue('environment'));
  assert.deepEqual(other.trail.slice(-4), ['classify', 'add-repository', 'repair-environment', 'done']);
  assert.equal(other.output['missing-repository'], undefined);
  const calls = Object.entries(engines).flatMap(([name, engine]) => Object.values(engine).filter(Array.isArray).flat()
    .filter(s => /project:add-repository/.test(s?.action?.command ?? '')).map(s => `${name}/${s.id}`));
  assert.deepEqual(calls, ['grouped-blocked/add-repository']);
});

test('AC6: Blocked for Human only after 3 failed fix attempts in one stay — counted (ticket:fix-attempts, afresh each time the ticket enters Blocked anew) as each Blocked run starts, a fix closed unmerged going round Blocked again within the stay; a fix that landed ends the stay, the step it returns to its proof; so the grouped engines\' Blocked has no visit cap', () => {
  for (const name of BLOCKED) {
    const count = stepOf(engines[name], 'count-attempts');
    assert.deepEqual([count.action.command, count['record-script-output']], ['./agent.sh ticket:fix-attempts {project} {work-item} {variation}', true]);
    assert.equal(firstStepId(engines[name]), 'count-attempts', name);
    const three = walk(name, { 'count-attempts': { exitCode: 3, scriptOutput: { 'fix-attempts': 3, 'ai-feedback-short': '3 fix attempts failed', 'ai-feedback-long': 'L' } } });
    assert.deepEqual(three.trail, ['count-attempts', 'blocked-for-human'], name);
    toHuman(name, three, /3 fix attempts failed/);
    // A fix closed without its fix merged is a failed attempt: the ticket goes round Blocked again, a fresh run counting it.
    const unmerged = walk(name, { 'await-fix': { exitCode: 3 } });
    assert.deepEqual(unmerged.trail.slice(-2), ['await-fix', 'retry'], name);
    for (const top of TOPS[name]) assert.equal(parent(top, unmerged), 'blocked', top);
    for (const top of TOPS[name]) {
      const b = stepOf(engines[top], 'blocked');
      assert.deepEqual([b['max-visits'], b['on-max-visits']], [undefined, undefined], top);
      const often = Array.from({ length: 5 }, () => [{ 'from-state': 'build', 'to-state': 'blocked' }, { 'from-state': 'blocked', 'to-state': 'build' }]).flat();
      const failing = { id: 'build', 'exit-events': [{ condition: { always: true }, 'move-to-state': 'blocked' }] };
      assert.equal(nextState(failing, engines[top], {}, often).to, 'blocked', `${top}: a sixth entry is still Blocked`);
    }
  }
});

// ASS-316 — a write-ticket turn that raised no ticket says why in its output:
// analysis-did-not-hold (nothing to raise) or create-failed (the create command's
// error as it printed), each with a one-line why; an agent that gave none is as before.
const NO_TICKET = { key: '', 'no-ticket-reason': 'create-failed', why: 'ticket:create: the ticket store is locked by another run' };
const DID_NOT_HOLD = { key: '', 'no-ticket-reason': 'analysis-did-not-hold', why: 'the failing job passes on the latest master: nothing to raise' };
const NO_REASON = { key: '' };
// wroteTicket(retries) — a create-ticket-grouped run's own history, as control counts
// write-ticket's visits (engine.js visitsInto): check-existing → write-ticket is visit 1,
// each retry one more.
const wroteTicket = (retries = 0) => [{ 'from-state': 'check-existing', 'to-state': 'write-ticket' },
  ...Array.from({ length: retries }, () => ({ 'from-state': 'write-ticket', 'to-state': 'write-ticket' }))];

test('ASS-316 AC1: the reason and why a run ends with reach the block entry', () => {
  for (const name of BLOCKED) {
    const run = walk(name, { 'create-fix-ticket': { structuredOutput: NO_TICKET }, 'wait-on': { exitCode: 3, scriptOutput: { 'ai-feedback-short': 'No fix ticket: ticket:create failed', 'ai-feedback-long': NO_TICKET.why } } });
    assert.equal(run.output['no-ticket-reason'], NO_TICKET['no-ticket-reason'], name);
    assert.equal(run.output.why, NO_TICKET.why, name);
    // Edge (stale reason): a run that did raise a ticket carries the blank reason/why the contract requires on a key, not the first attempt's — and fast-track-fix still runs (only an empty key skips it).
    const raised = walk(name, { 'create-fix-ticket': { structuredOutput: { key: 'ASS-1', 'no-ticket-reason': '', why: '' } } });
    assert.deepEqual([raised.output['no-ticket-reason'], raised.output.why], ['', ''], name);
    assert.ok(steps(raised).includes('fast-track-fix'), name);
  }
});

test('ASS-316 AC2: write-ticket re-runs once on an empty key with create-failed or no reason; analysis-did-not-hold and a second empty key are done', () => {
  const engine = engines['create-ticket-grouped'];
  const write = stepOf(engine, 'write-ticket');
  assert.deepEqual([write['max-visits'], write['on-max-visits']], [2, 'done']);
  const at = (output, history) => nextState(write, engine, { turnComplete: true, structuredOutput: output }, history);
  for (const output of [NO_TICKET, NO_REASON, { key: '', 'no-ticket-reason': '' }]) {
    assert.equal(at(output, wroteTicket()).to, 'write-ticket', JSON.stringify(output));
    const again = at(output, wroteTicket(1));
    assert.equal(again.to, 'done', JSON.stringify(output));
    assert.equal(again.reason, 'max-visits', JSON.stringify(output));
  }
  assert.equal(at(DID_NOT_HOLD, wroteTicket()).to, 'done', 'no retry: nothing to raise');
  assert.equal(at({ key: 'ASS-9', 'no-ticket-reason': '', why: '' }, wroteTicket()).to, 'done', 'a key raised');
  // Error paths: no key field at all (strict equality, undefined !== '') never loops; a non-empty key with a stale create-failed is done, not a retry (exit order); a turn not complete takes no exit.
  assert.equal(at({}, wroteTicket()).to, 'done', 'no key field at all');
  assert.equal(at({ key: 'ASS-9', 'no-ticket-reason': 'create-failed', why: 'x' }, wroteTicket()).to, 'done', 'a stale reason on a raised key');
  assert.equal(nextState(write, engine, { turnComplete: false, structuredOutput: NO_TICKET }, wroteTicket()), null);
  // The exits in order: analysis-did-not-hold before the bare {key: ""} one, the turn-complete catch-all last.
  const exits = write['exit-events'];
  assert.equal(exits.length, 3, JSON.stringify(exits));
  assert.deepEqual(exits[0], { condition: { all: [{ 'turn-complete': true }, { 'structured-output': { key: '', 'no-ticket-reason': 'analysis-did-not-hold' } }] }, 'move-to-state': 'done' });
  assert.deepEqual(exits[1], { condition: { all: [{ 'turn-complete': true }, { 'structured-output': { key: '' } }] }, 'move-to-state': 'write-ticket' });
  assert.deepEqual(exits[2], { condition: { 'turn-complete': true }, 'move-to-state': 'done' });
});

test('ASS-316 AC2: the retry inside the shared create-ticket-grouped engine changes nothing for check-ticket-health-grouped\'s create-ticket step', () => {
  const health = engines['check-ticket-health-grouped'];
  const create = stepOf(health, 'create-ticket');
  assert.equal(nextState(create, health, { subEngineDone: true, structuredOutput: NO_REASON }, []).to, 'done');
});

test('AC7: when no fix ticket can be raised or waited on, the ticket never resumes as if fixed — Blocked for Human, saying why', () => {
  for (const name of BLOCKED) {
    // ASS-316: no ticket raised skips fast-track-fix, straight to wait-on, which refuses the blocked ticket's own key (exit 3) with the reason-named feedback.
    const none = walk(name, { 'create-fix-ticket': { structuredOutput: NO_TICKET }, 'wait-on': { exitCode: 3, scriptOutput: { 'ai-feedback-short': 'No fix ticket: ticket:create failed' } } });
    assert.deepEqual(steps(none).slice(3), ['create-fix-ticket', 'wait-on', 'blocked-for-human'], name);
    toHuman(name, none, /No fix ticket: ticket:create failed/);
    // Edge: an empty key from check-existing itself (a malformed find) — no reason given — skips fast-track-fix too, with the generic feedback.
    const malformed = walk(name, { 'create-fix-ticket': { structuredOutput: NO_REASON }, 'wait-on': { exitCode: 3, scriptOutput: { 'ai-feedback-short': 'No fix ticket was raised' } } });
    assert.deepEqual(steps(malformed).slice(3), ['create-fix-ticket', 'wait-on', 'blocked-for-human'], name);
    toHuman(name, malformed, /No fix ticket was raised/);
    const unclaimed = walk(name, { 'wait-on': { exitCode: 1, scriptOutput: { 'ai-feedback-short': 'The fix ticket cannot be waited on' } } });
    toHuman(name, unclaimed, /cannot be waited on/);
    const nothing = walk(name, { 'await-fix': { exitCode: 4, scriptOutput: { 'ai-feedback-short': 'The fix ticket cannot be waited on' } } });
    assert.deepEqual(steps(nothing).slice(-2), ['await-fix', 'blocked-for-human'], name);
    toHuman(name, nothing, /cannot be waited on/);
    assert.ok(['wait-on', 'await-fix'].every(id => stepOf(engines[name], id)['record-script-output'] === true), 'their why kept by the run');
    // Only the done step resumes; every other way out of a Blocked run is a human's, or Blocked again (a fix closed unmerged).
    assert.deepEqual(engines[name].steps.filter(s => s['is-done']).map(s => s.id), ['done', 'retry', 'blocked-for-human'], name);
  }
});

// ASS-240 AC2: count-attempts too — without it, it inherits the top engine's Blocked `vm: stopped`, so entering
// Blocked stopped the VM and find-where started it again, troubleshoot dispatched into a stopping VM.
test('ASS-75, ASS-240 AC2: the grouped Blocked runs its VM where it works in it — from its first step (count-attempts), troubleshooting, classifying and repairing', () => {
  const vm = engines['grouped-blocked'].steps.filter(s => s.vm).map(s => [s.id, s.vm]);
  assert.deepEqual(vm, [['count-attempts', 'running'], ['check-first', 'running'], ['find-where', 'running'], ['troubleshoot', 'running'], ['classify', 'running'], ['check-on-master', 'running'], ['own-branch-or-obstacle', 'running'], ['own-branch-or-human', 'running'], ['plan-obstacle-fix', 'running'],
    ['find-where-to-repair-project', 'running'], ['repair-project', 'running'], ['add-repository', 'running'], ['repair-environment', 'running'],
    ['verify-image', 'running']]);   // ASS-392: the failing check re-run on the ticket's VM from the repaired image
});

test('learning (operator, 2026-10-24): every Blocked run is kept on the ticket (append-output-to: blocks), and troubleshooting and classifying are given those earlier blocks ({problem}: facts.js blockHistory) to take into account', () => {
  for (const top of TOPS['grouped-blocked']) assert.equal(stepOf(engines[top], 'blocked')['append-output-to'], 'blocks', top);
  const text = p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
  for (const p of ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped']) {
    assert.match(text(p), /Earlier blocks \(none: -\):\n\{problem\}/, p);
    assert.match(text(p), /a fix that landed and did not hold, or a failure at the same step again, means the cause is deeper/, p);
  }
  assert.match(text('classify-issue-grouped'), /\{problem\}[\s\S]*Earlier blocks, when listed/);
});

test('the current engines\' Blocked stays as it was — their reference: troubleshoot-block keeps cause-in, blocked keeps its visit cap and landed exit', () => {
  assert.ok(JSON.parse(readFileSync(join(ROOT, 'prompts', 'troubleshoot-block', 'prompt.json'), 'utf8')).output.properties['cause-in']);
  assert.ok(inOrder(engines.blocked.steps.map(s => s.id), ['troubleshoot', 'create-fix-ticket', 'wait-on', 'await-fix', 'done']));
  for (const top of ['example-development', 'harness-development']) {
    const b = stepOf(engines[top], 'blocked');
    assert.deepEqual([b['max-visits'], b['append-output-to'], b['exit-events'][0].condition], [3, undefined, { all: [{ 'is-done': true }, { 'structured-output': { landed: false } }] }], top);
  }
});

// ASS-163 — the operator's decision box (2026-10-27): is the failure a
// problem on the latest master? Yes: a blocking bug in the project's ticket
// system, waited on. No: nothing raised; the ticket's plan grows by the fix of
// the local obstacle, the fix is made, the work carries on. Not proven
// (no master evidence): no bug — the operator asked, Have AI Try Again
// repeating the check.
const project = (check, rest = {}) => ({ ...issue('project'), 'check-on-master': check, ...rest });
const ON_MASTER = { exitCode: 0, scriptOutput: { 'on-master': 'present', 'master-evidence': 'https://gitlab.com/example/identity master: job test:keycloak failed — j, pipeline p at s' } };
const NOT_ON_MASTER = { exitCode: 3, scriptOutput: { 'on-master': 'absent', 'master-evidence': 'https://gitlab.com/example/identity master: job test:keycloak success — j, pipeline p at s' } };
const UNKNOWN = { exitCode: 4, scriptOutput: { 'on-master': 'unknown', 'master-evidence': 'no finished master pipeline of the last 20 ran job test:keycloak', 'ai-feedback-short': 'Not proven on master: no project bug raised', 'ai-feedback-long': 'Check job test:keycloak on …\'s master' } };
const problem = (output, project = 'example') => problemOf({ id: 'r', project, parent: { 'work-item': 'X-1', variation: 'A' }, 'structured-output': { summary: 'S', ...output } }, [], { harness: { 'harness-project': 'harness' } });

test('ASS-163 AC1: a cause in the project\'s own code is checked against the latest master by a script — project:check-on-master with the failing repository and CI job Troubleshoot named, on the host — before anything is raised; its answer and evidence kept by the run', () => {
  const check = stepOf(engines['grouped-blocked'], 'check-on-master');
  assert.deepEqual([check.action.type, check.action.command, check['record-script-output'], check['run-location']], ['script', './agent.sh project:check-on-master {project} {failing-repository} {failing-job}', true, undefined]);
  const into = engines['grouped-blocked'].steps.flatMap(s => (s['exit-events'] ?? []).filter(e => e['move-to-state'] === 'check-on-master').map(() => s.id));
  assert.deepEqual(into, ['classify'], 'only Classify leads there');
  for (const value of ['harness', 'environment']) assert.ok(!walk('grouped-blocked', issue(value)).trail.includes('check-on-master'), `${value}: not the project's code, not checked`);
  const run = walk('grouped-blocked', project(ON_MASTER));
  assert.deepEqual([run.output['on-master'], run.output['master-evidence']], ['present', ON_MASTER.scriptOutput['master-evidence']]);
  // The failing check reaches the script as placeholders from the run's output ('-' when Troubleshoot named none).
  const values = out => runValues({ id: 'r', project: 'p', 'structured-output': out }, { workItem: 'X-1', variation: 'A' });
  assert.deepEqual([values({ 'failing-repository': 'https://gitlab.com/example/identity', 'failing-job': 'test: keycloak' })['failing-repository'], values({ 'failing-job': 'test: keycloak' })['failing-job']], ['https://gitlab.com/example/identity', 'test: keycloak']);
  assert.deepEqual([values({})['failing-repository'], values({})['failing-job']], ['-', '-']);
});

test('ASS-163 AC2: present on the latest master — a bug raised in the project\'s ticket system with the master evidence, the ticket waiting on it until it lands, then resuming', () => {
  const run = walk('grouped-blocked', project(ON_MASTER));
  assert.deepEqual(run.trail.slice(-8), ['classify', 'check-on-master', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'resume-step', 'done']);
  resumes('grouped-blocked', run);
  const text = problem(run.output);
  assert.match(text, /^On the latest master: present — https:\/\/gitlab\.com\/example\/identity master: job test:keycloak failed — j, pipeline p at s$/m, 'the bug carries the evidence (create-ticket\'s {problem})');
  assert.match(text, /^Raise the fix ticket in: project example — its own ticket system$/m);
  // The harness project's project issues are its own backlog: not checked (exit 2), raised as before.
  const home = walk('grouped-blocked', project({ exitCode: 2, scriptOutput: { 'on-master': 'not-checked', 'master-evidence': 'harness project' } }));
  assert.deepEqual(home.trail.slice(-7), ['check-on-master', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'resume-step', 'done']);
});

test('ASS-163 AC3, ASS-390 AC2: absent on the latest master — nothing raised in the project; the ticket\'s plan records the obstacle (ticket:plan-obstacle-fix), Repair Project fixes it in a separate fix merge request the ticket waits on (a missing repository still added first; not shown to work, the operator\'s step through Blocked for Human) and the ticket resumes its own work', () => {
  const plan = stepOf(engines['grouped-blocked'], 'plan-obstacle-fix');
  assert.deepEqual([plan.action.type, plan.action.command, plan['record-script-output']], ['script', './agent.sh ticket:plan-obstacle-fix {project} {work-item} {variation} {run}', true]);
  const repaired = walk('grouped-blocked', project(NOT_ON_MASTER));
  assert.deepEqual(repaired.trail.slice(-9), ['classify', 'check-on-master', 'own-branch-or-obstacle', 'plan-obstacle-fix', 'find-where-to-repair-project', 'repair-project', 'wait-on-fix-merge-request', 'await-fix-merge-request', 'done']);
  assert.ok(!repaired.trail.includes('repair-environment'), 'ASS-390: Repair Environment no longer on this path');
  resumes('grouped-blocked', repaired);
  const added = walk('grouped-blocked', project(NOT_ON_MASTER, { 'plan-obstacle-fix': { exitCode: 0, scriptOutput: { 'plan-revised': 'execution-plan-A.md', 'obstacle-repair': 'add-repository' } }, 'add-repository': { exitCode: 0 } }));
  assert.deepEqual(added.trail.slice(-3), ['plan-obstacle-fix', 'add-repository', 'done']);
  const operator = walk('grouped-blocked', project(NOT_ON_MASTER, { 'repair-project': { structuredOutput: { fixed: false, evidence: [], 'ai-feedback-short': 'Could not show the fix works', 'ai-feedback-long': 'L' } } }));
  assert.deepEqual(operator.trail.slice(-2), ['repair-project', 'blocked-for-human']);
  toHuman('grouped-blocked', operator, /Could not show the fix works/);
  for (const run of [repaired, added, operator]) assert.ok(!run.trail.includes('create-fix-ticket'), 'no project bug');
  // Repair is told it is not a project bug, and that its fix goes in a separate merge request.
  const text = problem(repaired.output);
  assert.match(text, /^Not on the latest master: https:\/\/gitlab\.com\/example\/identity master: job test:keycloak success .* — no project bug; fix the obstacle here, in a separate fix merge request \(Repair Project\), never the ticket's own branch$/m);
  assert.doesNotMatch(text, /^Raise the fix ticket in/m);
});

test('ASS-163 AC5: missing master evidence is not proven — no bug raised; Blocked for Human asks the operator what to check (Have AI Try Again repeats the check)', () => {
  const run = walk('grouped-blocked', project(UNKNOWN));
  assert.deepEqual(run.trail.slice(-4), ['classify', 'check-on-master', 'own-branch-or-human', 'blocked-for-human']);
  toHuman('grouped-blocked', run, /^Not proven on master/);
  assert.doesNotMatch(problem(run.output), /^Raise the fix ticket in/m);
  assert.match(problem(run.output), /^Not proven on the latest master: no finished master pipeline/m);
  const failed = walk('grouped-blocked', project({ exitCode: 1 }));
  assert.equal(failed.end, 'blocked-for-human', 'a check that fails is not proven either');
  for (const top of TOPS['grouped-blocked']) {
    const again = stepOf(engines[top], 'blocked-for-human')['exit-events'].find(e => e['move-to-state'] === 'blocked');
    assert.equal(again.condition['human-review'], 'Have AI Try Again to Unblock this Ticket', top);
  }
});

test('ASS-163 AC4: Troubleshoot names the failing check, and Troubleshoot and Classify state the rule — a project bug only for a failure on the latest master, never one seen only in a VM or on a branch, the check the harness\'s; the current engines\' classify-issue unchanged', () => {
  const read = (p, f) => readFileSync(join(ROOT, 'prompts', p, f), 'utf8');
  for (const p of ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped']) {
    const out = JSON.parse(read(p, 'prompt.json')).output;
    for (const field of ['failing-repository', 'failing-job', 'failing-assertion']) assert.equal(out.properties[field]?.type, 'string', `${p} ${field}`);
    assert.ok(!out.required.includes('failing-job'), p);
    assert.match(read(p, 'prompt.txt'), /latest master/, p);
    assert.match(read(p, 'prompt.txt'), /never raise/i, p);
  }
  const classify = read('classify-issue-grouped', 'prompt.txt');
  assert.match(classify, /only for a failure on the latest master/);
  assert.match(classify, /never .*a failure seen only in (this|a) VM or on a branch/i);
  assert.match(classify, /check(ed)? against the latest master/);
  assert.doesNotMatch(read('classify-issue', 'prompt.txt'), /latest master/, 'the current engines\' classify-issue as it was');
});

// ASS-384: a project-code failure that is not on the latest master but in a file the ticket's own branch adds or
// changes (Classify's own-branch, ticket:own-branch-fix's check of the branch in the VM) goes back to Generate
// Solution, its finding in the plan — not to the obstacle fix, not to the operator.
const OWN_BRANCH = { exitCode: 0, scriptOutput: { 'own-branch-fix': true, 'own-branch-why': 'db/V27__x.sql is one the branch change/EX-1 in api adds or changes', 'plan-revised': 'execution-plan-A.md',
  'resume-at': 'build', 'resume-source': 'declared', 'resume-why': 'W', 'resume-ignored': [], 'ai-feedback-short': null, 'ai-feedback-long': null } };
const ownBranch = check => ({ classify: { structuredOutput: { issue: 'project', reasoning: 'R', 'own-branch': true } }, 'check-on-master': check,
  'own-branch-or-obstacle': OWN_BRANCH, 'own-branch-or-human': OWN_BRANCH });

test('ASS-384 AC1: not on the latest master (passed there, or not proven) and in the ticket\'s own branch — the finding recorded in the plan, the run done with Generate Solution\'s group as its resume-at, the ticket resuming there, never Blocked for Human', () => {
  for (const id of ['own-branch-or-obstacle', 'own-branch-or-human']) {
    const step = stepOf(engines['grouped-blocked'], id);
    assert.deepEqual([step.action.type, step.action.command, step['record-script-output'], step.vm, step['run-location']],
      ['script', './agent.sh ticket:own-branch-fix {project} {work-item} {variation} {run}', true, 'running', undefined], id);
  }
  assert.deepEqual([0, 3, 4, 1].map(code => nextState(stepOf(engines['grouped-blocked'], 'check-on-master'), engines['grouped-blocked'], { exitCode: code }, []).to),
    ['create-fix-ticket', 'own-branch-or-obstacle', 'own-branch-or-human', 'blocked-for-human'], 'exit 1 (a failed check) as before');
  for (const [check, via] of [[NOT_ON_MASTER, 'own-branch-or-obstacle'], [UNKNOWN, 'own-branch-or-human']]) {
    const run = walk('grouped-blocked', ownBranch(check));
    assert.deepEqual(run.trail.slice(-4), ['classify', 'check-on-master', via, 'done'], via);
    assert.equal(run.output['own-branch-fix'], true);
    assert.equal(run.output['ai-feedback-short'], null, `${via}: check-on-master's not-proven feedback cleared, the ticket not shown as the operator's`);
    for (const top of TOPS['grouped-blocked']) {
      const changes = [{ 'from-state': 'build', 'to-state': 'test' }, { 'from-state': 'test', 'to-state': 'blocked' }];
      const facts = { subEngineDone: true, subEngineState: run.end, structuredOutput: run.output };
      assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], facts, changes).to, 'build', `${top}: back to Build, upstream of the blocked Test`);
      // Build at its max-visits (5): the own-branch return restarts the counts, as a landed fix's does.
      const often = [...Array.from({ length: 5 }, () => ({ 'from-state': 'plan', 'to-state': 'build' })), { 'from-state': 'build', 'to-state': 'blocked' }];
      assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], facts, often).to, 'build', `${top}: not redirected to Blocked by Build's count`);
      assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], { ...facts, structuredOutput: { ...run.output, 'own-branch-fix': false } }, often).to, 'blocked', `${top}: without it, the count holds`);
    }
  }
  assert.ok(stepOf(engines['grouped-build'], 'generate-solution') && stepOf(engines['v2-build'], 'generate-solution'), 'Build runs Generate Solution');
});

test('ASS-384 AC3/AC4: a failure on the latest master still raises a project bug; an environment or harness issue takes its own path; not shown to be the branch\'s (nothing named, Classify not saying so) is as before — the obstacle fix, or Blocked for Human with check-on-master\'s feedback', () => {
  const present = walk('grouped-blocked', ownBranch(ON_MASTER));
  assert.deepEqual(present.trail.slice(-8), ['classify', 'check-on-master', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'resume-step', 'done']);
  for (const value of ['environment', 'harness']) {
    const run = walk('grouped-blocked', { ...ownBranch(NOT_ON_MASTER), classify: { structuredOutput: { issue: value, reasoning: 'R', 'own-branch': true } } });
    assert.ok(!run.trail.some(id => id.startsWith('own-branch')), value);
  }
  const notShown = { exitCode: 3, scriptOutput: { 'own-branch-fix': false, 'own-branch-why': 'Troubleshoot named no failing repository, file and job or assertion' } };
  const obstacle = walk('grouped-blocked', { ...ownBranch(NOT_ON_MASTER), 'own-branch-or-obstacle': notShown });
  assert.deepEqual(obstacle.trail.slice(-7), ['own-branch-or-obstacle', 'plan-obstacle-fix', 'find-where-to-repair-project', 'repair-project', 'wait-on-fix-merge-request', 'await-fix-merge-request', 'done']);
  const human = walk('grouped-blocked', { ...ownBranch(UNKNOWN), 'own-branch-or-human': notShown });
  assert.deepEqual(human.trail.slice(-2), ['own-branch-or-human', 'blocked-for-human']);
  toHuman('grouped-blocked', human, /^Not proven on master/);
  // A command that fails is no own-branch fix either.
  assert.deepEqual(walk('grouped-blocked', { ...ownBranch(UNKNOWN), 'own-branch-or-human': { exitCode: 1 } }).trail.slice(-1), ['blocked-for-human']);
  assert.deepEqual(walk('grouped-blocked', { ...ownBranch(NOT_ON_MASTER), 'own-branch-or-obstacle': { exitCode: 1 } }).trail.slice(-7, -5), ['own-branch-or-obstacle', 'plan-obstacle-fix']);
});

test('ASS-384 AC2: own-branch fixes count toward the fix-attempt budget — at 3, count-attempts sends the ticket to Blocked for Human saying the own-branch fix was tried', () => {
  const three = walk('grouped-blocked', { 'count-attempts': { exitCode: 3, scriptOutput: { 'fix-attempts': 3, 'own-branch-fixes': 3, 'ai-feedback-short': '3 fix attempts failed', 'ai-feedback-long': 'The own-branch fix was tried 3 times …' } } });
  assert.deepEqual(three.trail, ['count-attempts', 'blocked-for-human']);
  toHuman('grouped-blocked', three, /3 fix attempts failed/);
  assert.match(three.output['ai-feedback-long'], /own-branch fix was tried 3 times/);
});

test('ASS-384: Troubleshoot names the failing file, Classify says own-branch; the flat engines\' prompts unchanged', () => {
  const read = (p, f) => readFileSync(join(ROOT, 'prompts', p, f), 'utf8');
  for (const p of ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped']) {
    assert.equal(JSON.parse(read(p, 'prompt.json')).output.properties['failing-file']?.type, 'string', p);
    assert.match(read(p, 'prompt.txt'), /"failing-file"/, p);
  }
  const classify = JSON.parse(read('classify-issue-grouped', 'prompt.json')).output;
  assert.equal(classify.properties['own-branch']?.type, 'boolean');
  assert.deepEqual(classify.required, ['issue', 'reasoning']);
  assert.match(read('classify-issue-grouped', 'prompt.txt'), /own-branch: true/);
  assert.doesNotMatch(read('classify-issue', 'prompt.txt'), /own-branch/);
  assert.doesNotMatch(read('troubleshoot-block', 'prompt.txt'), /failing-file/);
});

// ASS-390 — Blocked fixes whatever blocks a ticket in its scope, adds Repair
// Project, checks first, and logs everything.
const BLOCKED_PROMPTS = ['troubleshoot-block-grouped', 'troubleshoot-block-on-host-grouped', 'classify-issue-grouped', 'repair-environment-grouped', 'repair-environment-on-host-grouped', 'repair-project-grouped', 'repair-project-on-host-grouped',
  'repair-image-on-host-grouped'];   // ASS-392
const promptText = p => readFileSync(join(ROOT, 'prompts', p, 'prompt.txt'), 'utf8');
const promptJson = p => JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8'));

test('ASS-390: every prompt grouped-blocked runs is one of its own, listed here — so the prompt assertions below cover them all', () => {
  const used = engines['grouped-blocked'].steps.filter(s => s.action.type === 'prompt').map(s => s.action.prompt);
  assert.deepEqual([...new Set(used)].toSorted(), BLOCKED_PROMPTS.toSorted());
});

test('ASS-390 AC4: Check First re-runs the blocked step\'s failing check before Troubleshoot dispatches an agent — passing now, the run is done (needs-fix false, nothing to fix) and the ticket resumes; still failing, or nothing to re-run, Troubleshoot goes on', () => {
  const step = stepOf(engines['grouped-blocked'], 'check-first');
  assert.deepEqual([step.action.type, step.action.command, step['record-script-output'], step.vm, step['run-location']],
    ['script', './agent.sh ticket:recheck-block {project} {work-item} {variation}', true, 'running', undefined], 'on the host, its VM kept running for a check that runs there');
  const passed = walk('grouped-blocked', { 'check-first': { exitCode: 0, scriptOutput: { 'needs-fix': false, rechecked: true, 'recheck-passed': true, summary: 'Passed on re-check; nothing to fix', recheck: { at: 'build/automated-testing', command: 'c', exit: 0 } } } });
  assert.deepEqual(passed.trail, ['count-attempts', 'check-first', 'done'], 'no agent dispatched');
  assert.equal(passed.output.summary, 'Passed on re-check; nothing to fix');
  resumes('grouped-blocked', passed);
  assert.match(blockHistory({ blocks: [{ ...passed.output, 'ended-at': 'done' }] }), /Ended: passed on re-check, nothing to fix, resumed — blocked again\./, 'the next stay learns it');
  for (const code of [3, 1]) assert.deepEqual(walk('grouped-blocked', { 'check-first': { exitCode: code } }).trail.slice(0, 4), ['count-attempts', 'check-first', 'find-where', 'troubleshoot'], `exit ${code}`);
  // At 3 fix attempts it never re-checks: the operator first.
  assert.deepEqual(walk('grouped-blocked', { 'count-attempts': { exitCode: 3, scriptOutput: { 'ai-feedback-short': '3 fix attempts failed' } } }).trail, ['count-attempts', 'blocked-for-human']);
});

test('ASS-390 AC2: a project issue not on the latest master and not the ticket\'s own branch goes to Repair Project — in the VM, or on the host before it is set up — not to Repair Environment; fixed, it waits on the fix merge request; not shown to work, Blocked for Human with what it tried', () => {
  const grouped = engines['grouped-blocked'];
  const vm = stepOf(grouped, 'repair-project'), host = stepOf(grouped, 'repair-project-on-host');
  assert.deepEqual([vm.action.prompt, vm['run-location'], vm.vm, vm.action['run-in-dev-container']], ['repair-project-grouped', 'vm', 'running', false]);
  assert.deepEqual([host.action.prompt, host['run-location'], host.action['works-on-code'], host.action['run-in-dev-container']], ['repair-project-on-host-grouped', undefined, true, false]);
  for (const check of [NOT_ON_MASTER]) {
    const inVm = walk('grouped-blocked', project(check));
    assert.deepEqual(inVm.trail.slice(-6), ['plan-obstacle-fix', 'find-where-to-repair-project', 'repair-project', 'wait-on-fix-merge-request', 'await-fix-merge-request', 'done']);
    const onHost = walk('grouped-blocked', project(check, { 'find-where-to-repair-project': { scriptSucceeds: () => false } }));
    assert.deepEqual(onHost.trail.slice(-5), ['find-where-to-repair-project', 'repair-project-on-host', 'wait-on-fix-merge-request', 'await-fix-merge-request', 'done']);
    for (const id of ['repair-project', 'repair-project-on-host']) {
      const notShown = walk('grouped-blocked', project(check, { 'find-where-to-repair-project': { scriptSucceeds: () => id === 'repair-project' }, [id]: { structuredOutput: { fixed: false, evidence: ['pnpm test → still 1 failing'], 'ai-feedback-short': 'Tried a fix; the seed still fails', 'ai-feedback-long': 'Tried …' } } }));
      assert.deepEqual(notShown.trail.slice(-2), [id, 'blocked-for-human'], id);
      toHuman('grouped-blocked', notShown, /Tried a fix/);
    }
    assert.ok(!walk('grouped-blocked', project(check)).trail.some(id => id.startsWith('repair-environment')), 'Repair Environment is not on this path');
  }
  // Only a project issue reaches it: never a harness or environment issue, never one on master, never the ticket's own branch.
  for (const run of [walk('grouped-blocked', issue('harness')), walk('grouped-blocked', issue('environment')), walk('grouped-blocked', project(ON_MASTER)), walk('grouped-blocked', ownBranch(NOT_ON_MASTER))]) {
    assert.ok(!run.trail.includes('repair-project') && !run.trail.includes('repair-project-on-host'), run.trail.join(' '));
  }
  const into = grouped.steps.flatMap(s => (s['exit-events'] ?? []).filter(e => e['move-to-state'] === 'find-where-to-repair-project').map(() => s.id));
  assert.deepEqual(into, ['plan-obstacle-fix'], 'only after the obstacle is recorded');
  // The fix merge request is opened through the harness's merge-request command, from the VM through the forwarder.
  const allowed = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  assert.deepEqual(allowed['merge-request:create-fix'], { project: 0, ticket: 1, variation: 2 });
});

test('ASS-390 AC6: after Repair Project opens a fix merge request Blocked waits on it as on a fix ticket — ticket:wait-on --merge-request, then ticket:fix-landed on a timer, polling no failure; merged, the ticket resumes (its counts restarted as a landed fix\'s); closed unmerged, Blocked for Human', () => {
  const grouped = engines['grouped-blocked'];
  const wait = stepOf(grouped, 'wait-on-fix-merge-request'), poll = stepOf(grouped, 'await-fix-merge-request');
  assert.deepEqual([wait.action.command, wait['record-script-output']], ['./agent.sh ticket:wait-on {project} {work-item} {variation} --merge-request {fix-merge-request}', true]);
  assert.deepEqual([poll.action.command, poll.action.mode, poll.action['timer-minutes'], poll.action['waiting-exit-code'], poll['record-script-output']], ['./agent.sh ticket:fix-landed {project} {work-item} {variation}', 'timer', 5, 1, true]);
  assert.equal(nextState(poll, grouped, { exitCode: 1, scriptOutput: { landed: false } }, []), null, 'open: waits, no exit, no failure');
  assert.deepEqual([0, 3, 4].map(code => nextState(poll, grouped, { exitCode: code }, []).to), ['done', 'blocked-for-human', 'blocked-for-human']);
  // {fix-merge-request} is the url Repair Project named; - when none (wait-on refuses it).
  const values = out => runValues({ id: 'r', project: 'p', 'structured-output': out }, { workItem: 'X-1', variation: 'A' })['fix-merge-request'];
  assert.deepEqual([values({ 'fix-merge-request': FIX_MR }), values({})], [FIX_MR, '-']);
  const merged = walk('grouped-blocked', project(NOT_ON_MASTER));
  assert.equal(merged.output.landed, true);
  assert.equal(merged.output['ai-feedback-short'], null, 'the waiting Health cleared');
  for (const top of TOPS['grouped-blocked']) {
    const facts = { subEngineDone: true, subEngineState: merged.end, structuredOutput: merged.output };
    assert.equal(clearCause(facts)?.cause, 'fix-landed', top);
    const often = [...Array.from({ length: 5 }, () => ({ 'from-state': 'plan', 'to-state': 'build' })), { 'from-state': 'build', 'to-state': 'blocked' }];
    assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], facts, often).to, 'build', `${top}: resumed, not redirected by Build's count`);
  }
  assert.match(blockHistory({ blocks: [{ ...merged.output, 'ended-at': 'done' }] }), /its fix merge request https:\/\/gitlab\.com\/example\/api\/-\/merge_requests\/41 merged/);
  const closed = walk('grouped-blocked', project(NOT_ON_MASTER, { 'await-fix-merge-request': { exitCode: 3, scriptOutput: { status: 'Closed', landed: false, 'ai-feedback-short': 'Fix MR !41 in example/api was closed unmerged', 'ai-feedback-long': 'L' } } }));
  assert.deepEqual(closed.trail.slice(-2), ['await-fix-merge-request', 'blocked-for-human']);
  toHuman('grouped-blocked', closed, /closed unmerged/);
  const none = walk('grouped-blocked', project(NOT_ON_MASTER, { 'wait-on-fix-merge-request': { exitCode: 1, scriptOutput: { 'ai-feedback-short': 'No fix merge request to wait on' } } }));
  toHuman('grouped-blocked', none, /No fix merge request/);
});

test('ASS-390 AC5: Classify may say the block only waits for one of the ticket\'s own dependency merge requests — ticket:dependency-wait shows it and the run is done with Build as its resume-at and Await Sequential Merge as where Build starts, the visit counts restarted; not shown, Blocked for Human', () => {
  const grouped = engines['grouped-blocked'];
  const dep = stepOf(grouped, 'dependency-wait');
  assert.deepEqual([dep.action.command, dep['record-script-output'], dep.vm, dep['run-location']], ['./agent.sh ticket:dependency-wait {project} {work-item} {variation} {run}', true, undefined, undefined]);
  const SHOWN = { exitCode: 0, scriptOutput: { 'awaits-dependency': true, dependency: { id: 1, key: '!12', url: 'u' }, 'resume-at': 'build', 'resume-sub-at': 'await-dependencies', 'resume-source': 'declared', 'resume-why': 'W', 'resume-ignored': [], 'ai-feedback-short': null, 'ai-feedback-long': null } };
  const run = walk('grouped-blocked', { classify: { structuredOutput: { issue: 'dependency', reasoning: 'R', 'dependency-merge-request': '!12' } }, 'dependency-wait': SHOWN });
  assert.deepEqual(steps(run), ['count-attempts', 'troubleshoot', 'classify', 'dependency-wait', 'done']);
  for (const top of TOPS['grouped-blocked']) {
    const facts = { subEngineDone: true, subEngineState: run.end, structuredOutput: run.output };
    const changes = [{ 'from-state': 'build', 'to-state': 'test' }, { 'from-state': 'test', 'to-state': 'blocked' }];
    assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], facts, changes).to, 'build', `${top}: back to Build, upstream of the blocked Test`);
    assert.equal(resumeSubAt(facts), 'await-dependencies');
    assert.ok(stepOf(engines[stepOf(engines[top], 'build').action.engine], 'await-dependencies'), `${top}: Build runs Await Sequential Merge`);
    assert.equal(clearCause(facts)?.cause, 'dependency-wait');
    const often = [...Array.from({ length: 5 }, () => ({ 'from-state': 'plan', 'to-state': 'build' })), { 'from-state': 'build', 'to-state': 'blocked' }];
    assert.equal(nextState(stepOf(engines[top], 'blocked'), engines[top], facts, often).to, 'build', `${top}: not redirected by Build's count`);
  }
  assert.equal(resumeSubAt({ subEngineState: 'done', structuredOutput: { 'resume-sub-at': 'await-dependencies' } }), undefined, 'no resume-sub-at without a cleared resume');
  assert.ok(!run.trail.includes('create-fix-ticket'), 'nothing raised');
  assert.match(blockHistory({ blocks: [{ ...run.output, 'ended-at': 'done' }] }), /only waiting for its dependency merge request \(!12\): sent to Await Sequential Merge/);
  const notShown = walk('grouped-blocked', { classify: { structuredOutput: { issue: 'dependency', reasoning: 'R' } }, 'dependency-wait': { exitCode: 3, scriptOutput: { 'awaits-dependency': false, 'ai-feedback-short': 'Not shown to wait only for a dependency merge request' } } });
  assert.deepEqual(notShown.trail.slice(-2), ['dependency-wait', 'blocked-for-human']);
  toHuman('grouped-blocked', notShown, /Not shown to wait only/);
  assert.equal(problemOf({ id: 'r', project: 'example', parent: {}, 'structured-output': { summary: 'S', issue: 'dependency', reasoning: 'R' } }, [], { harness: { 'harness-project': 'harness' } }).includes('Raise the fix ticket in'), false, 'no fix ticket for a dependency');
});

test('ASS-390: Classify\'s outcomes are its enum, each with one exit of its own on its issue; an outcome with no exit is Blocked for Human, never a stuck run', () => {
  const grouped = engines['grouped-blocked'], classify = stepOf(grouped, 'classify');
  const outcomes = promptJson('classify-issue-grouped').output.properties.issue.enum;
  const routed = classify['exit-events'].map(e => e.condition.all?.find(c => c['structured-output'])?.['structured-output'].issue).filter(Boolean);
  assert.deepEqual(routed.toSorted(), outcomes.toSorted(), 'one exit per outcome');
  assert.deepEqual(classify['exit-events'].at(-1), { condition: { 'turn-complete': true }, 'move-to-state': 'blocked-for-human' }, 'the catch-all last');
  assert.deepEqual(walk('grouped-blocked', issue('something-new')).trail.slice(-2), ['classify', 'blocked-for-human']);
  for (const value of outcomes) assert.match(promptText('classify-issue-grouped'), new RegExp(`- "${value}": `), `${value}: the prompt says when`);
});

test('ASS-390 AC6: a fix merge request\'s wait, a recheck pass and a dependency wait count toward the fix-attempt budget (ticket:fix-attempts reads them)', () => {
  const sh = readFileSync(join(ROOT, 'src', 'agent-cli', 'ticket', 'fix-attempts.sh'), 'utf8');
  assert.match(sh, /IN\("await-fix", "await-fix-merge-request"\)/);
  assert.match(sh, /\$b\["recheck-passed"\] == true/);
  assert.match(sh, /\$b\["awaits-dependency"\] == true/);
});

test('ASS-390 AC1: Repair Environment fixes whatever in the ticket\'s VM (or its own host worktree) blocks the blocked step, the old list kept as known-fix examples; never a credential, uncommitted work saved aside first, nothing on the Mac or the shared checkout; done only when the failing thing re-runs and passes', () => {
  for (const p of ['repair-environment-grouped', 'repair-environment-on-host-grouped']) {
    const t = promptText(p);
    assert.match(t, /Fix whatever in (this VM|its own worktree) blocks the blocked step/, p);
    assert.match(t, /dependencies, containers, (checkouts|the worktree's checkout), caches, generated files, recorded test commands, stale branches/, p);
    assert.match(t, /Known fixes, examples only, not the only things allowed/, p);
    for (const known of [/reinstall dependencies where the step runs them/, /remove a stopped or stale compose stack/, /re-run a failed setup step/, /save an uncommitted edit aside \(git stash, or a copy in a temp folder: mktemp -d\), then clean it/]) assert.match(t, known, `${p}: ${known}`);
    assert.match(t, /record it again through `\{agent-sh\} automated-tests:record \{project\} \{ticket\} \{variation\}`/, p);
    assert.match(t, /reset to the base it should be on/, p);
    assert.match(t, /Never: [^\n]*change a credential, token or secret; discard work you have not saved aside first/, p);
    assert.match(t, p.includes('on-host') ? /Never the project's shared checkout/ : /Never anything on the Mac, nor the project's shared checkout/, p);
    assert.match(t, /Repaired only when the failing thing now passes/, p);
  }
});

test('ASS-390 AC2: Repair Project\'s prompts — a separate small merge request on change/<KEY>-fix-<n>, never the ticket\'s own branches, opened through merge-request:create-fix with what it unblocks and why, shown to work first, never a credential, the Mac or the shared checkout', () => {
  for (const p of ['repair-project-grouped', 'repair-project-on-host-grouped']) {
    const t = promptText(p), out = promptJson(p).output;
    assert.match(t, /change\/\{ticket\}-fix-<n>/, p);
    assert.match(t, /Never commit, rebase or push the ticket's own branches/, p);
    assert.match(t, /`\{agent-sh\} merge-request:create-fix \{project\} \{ticket\} \{variation\} <repository-url> <branch> "<title>"`, the description on stdin: what blocked \{ticket\}, why, and what the fix changes/, p);
    assert.match(t, /Fixed only when the failing thing now passes\. Not shown: push nothing, open nothing\./, p);
    assert.match(t, /Never: change a credential, token or secret/, p);
    assert.match(t, /nor the project's shared checkout|Never the project's shared checkout/, p);
    assert.doesNotMatch(t, /\b(glab|gh|curl)\b/, `${p}: the forge through the harness's command only`);
    assert.deepEqual([out.properties.fixed.type, out.properties['fix-merge-request'].type, out.required], ['boolean', 'string', ['fixed', 'evidence', 'ai-feedback-short', 'ai-feedback-long']], p);
  }
  assert.match(promptText('repair-project-grouped'), /Never anything on the Mac, nor the project's shared checkout/);
  assert.match(promptText('repair-project-on-host-grouped'), /only a fresh clone of the failing repository in a temp folder of your own/);
});

test('ASS-390 AC3: every Blocked prompt has its agent append to the change log, through work:append, what it found, what it changed (files, commands, merge requests) and why', () => {
  for (const p of BLOCKED_PROMPTS) {
    const t = promptText(p);
    assert.ok(t.includes('{ticket-folder}/change-log-{variation}.md (through `{agent-sh} work:append {project} {ticket} {variation} change-log.md`, the entry on stdin)'), p);
    assert.match(t, /change-log\.md`, the entry on stdin\) what you (found|checked and found)/, p);
    assert.match(t, /(and why|why)/, p);
    if (!p.startsWith('classify')) assert.match(t, /what you (ran or )?changed \((files, commands|files, commands, containers)/, p);
  }
  // Its own script steps log too (work.bash blocked_log).
  for (const sh of ['ticket/recheck-block.sh', 'ticket/dependency-wait.sh', 'merge-request/create-fix.sh', 'ticket/wait-on.sh', 'ticket/fix-landed.sh', 'ticket/plan-obstacle-fix.sh']) {
    assert.match(readFileSync(join(ROOT, 'src', 'agent-cli', sh), 'utf8'), /blocked_log "/, sh);
  }
});

test('ASS-390 AC7: every Blocked prompt says to quote or cite only files and output actually read in this run, never attributing a rule to a file not opened; the flat engines\' prompts unchanged', () => {
  const rule = 'Quote or cite only files and output you have actually read in this run; never attribute a rule to a file you haven\'t opened.';
  for (const p of BLOCKED_PROMPTS) assert.ok(promptText(p).includes(rule), p);
  for (const p of ['troubleshoot-block', 'classify-issue', 'unblock']) assert.ok(!promptText(p).includes(rule), `${p}: the flat engines' prompt as it was`);
});

test('ASS-391 AC1/AC2: Classify\'s rate-limit goes to Await Rate Limit — on the host, a timer whose waiting exit is no failure; on the API key fallback or after the reset the run is done and the ticket resumes where it was blocked, never Blocked for Human', () => {
  const grouped = engines['grouped-blocked'], wait = stepOf(grouped, 'await-rate-limit');
  assert.deepEqual([wait.action.command, wait.action.mode, wait.action['timer-minutes'], wait.action['waiting-exit-code'], wait['record-script-output'], wait.vm], ['./agent.sh ticket:await-rate-limit {project} {work-item} {variation}', 'timer', 5, 2, true, undefined]);
  assert.equal(nextState(wait, grouped, { exitCode: 2, scriptOutput: { 'api-fallback': false } }, []), null, 'waiting: no exit, no failure');
  assert.equal(nextState(wait, grouped, { exitCode: 1 }, []), null, 'a failure matches no exit: tried again');
  const fallback = walk('grouped-blocked', { ...issue('rate-limit'), 'await-rate-limit': { exitCode: 0, scriptOutput: { 'rate-limit': { kind: 'claude', type: 'five_hour', 'resets-at': '2026-11-12T14:00:00Z' }, 'api-fallback': true, 'ai-feedback-short': null, 'ai-feedback-long': null } } });
  assert.deepEqual(steps(fallback), ['count-attempts', 'troubleshoot', 'classify', 'await-rate-limit', 'done']);
  resumes('grouped-blocked', fallback);
  assert.match(blockHistory({ blocks: [{ ...fallback.output, 'ended-at': 'done' }] }), /rate limited \(claude\): resumed on the API key fallback/);
  const reset = walk('grouped-blocked', { ...issue('rate-limit'), 'await-rate-limit': { exitCode: 0, scriptOutput: { 'rate-limit-reset': true, 'rate-limit': { kind: 'claude', 'resets-at': '2026-11-12T14:00:00Z' }, 'ai-feedback-short': null, 'ai-feedback-long': null } } });
  resumes('grouped-blocked', reset);
  assert.equal(reset.output['ai-feedback-short'], null, 'the waiting Health cleared');
  assert.match(blockHistory({ blocks: [{ ...reset.output, 'ended-at': 'done' }] }), /waited for the reset at 2026-11-12T14:00:00Z/);
  assert.ok(!fallback.trail.includes('create-fix-ticket') && !reset.trail.includes('blocked-for-human'), 'nothing raised, never the operator');
  assert.equal(problemOf({ id: 'r', project: 'example', parent: {}, 'structured-output': { summary: 'S', issue: 'rate-limit', reasoning: 'R' } }, [], { harness: { 'harness-project': 'harness' } }).includes('Raise the fix ticket in'), false, 'no fix ticket for a rate limit');
  assert.match(promptText('classify-issue-grouped'), /- "rate-limit": .*HTTP 429, "usage limit reached".*an agent that died at 0 tokens on a limit/);
});

test('ASS-395 AC5: Classify\'s credentials runs a fresh credentials check, then reads the hold — held, the run is done and the ticket returns to its step (the hold stops new dispatch); not held, Blocked for Human with Classify\'s reason', () => {
  const grouped = engines['grouped-blocked'];
  const check = stepOf(grouped, 'check-credentials'), status = stepOf(grouped, 'credentials-status'), unseen = stepOf(grouped, 'credentials-unseen');
  assert.deepEqual([check.action.command, status.action.command, unseen.action.command], ['./agent.sh project:check-credentials {project}', './agent.sh project:credentials-status {project} --fail-when-held', './agent.sh ticket:credentials-unseen {project} {work-item} {variation} {run}']);
  assert.deepEqual([0, 1].map(code => nextState(check, grouped, { exitCode: code }, []).to), ['credentials-status', 'credentials-status'], 'whatever the check exits, the hold is read');
  const PROBLEMS = [{ credential: 'the glab login (gitlab.example.com)', problem: 'not authenticated', fix: 'glab auth login --hostname gitlab.example.com' }];
  const held = walk('grouped-blocked', { ...issue('credentials'), 'credentials-status': { exitCode: 3, scriptOutput: { held: true, since: '2026-11-12T09:00:00Z', problems: PROBLEMS } } });
  assert.deepEqual(steps(held), ['count-attempts', 'troubleshoot', 'classify', 'check-credentials', 'credentials-status', 'done']);
  resumes('grouped-blocked', held);
  assert.match(blockHistory({ blocks: [{ ...held.output, 'ended-at': 'done' }] }), /its project held by its credentials \(the glab login \(gitlab\.example\.com\)\)/);
  const unheld = walk('grouped-blocked', { classify: { structuredOutput: { issue: 'credentials', reasoning: 'R', 'human-action': 'H' } }, 'credentials-status': { exitCode: 0, scriptOutput: { held: false, since: null, problems: [] } },
    'credentials-unseen': { exitCode: 0, scriptOutput: { 'credentials-held': false, 'ai-feedback-short': 'A credential blocks it that the credentials check cannot see', 'ai-feedback-long': 'Blocked classified X-1\'s block as a missing or failing credential: R. …' } } });
  assert.deepEqual(unheld.trail.slice(-4), ['check-credentials', 'credentials-status', 'credentials-unseen', 'blocked-for-human']);
  toHuman('grouped-blocked', unheld, /credentials check cannot see/);
  assert.equal(nextState(unseen, grouped, { exitCode: 1 }, []).to, 'blocked-for-human', 'a failure there still reaches the operator');
  assert.match(promptText('classify-issue-grouped'), /- "credentials": a missing or failing credential — a keychain item, a token, a login/);
  assert.equal(promptJson('classify-issue-grouped').output.properties.issue.enum.includes('credentials'), true);
});

// ASS-392 — Blocked repairs a broken golden image, or the ticket's VM built
// from it, on the Mac (Repair Image), one golden rebuild at a time.
const IMAGE = { classify: { structuredOutput: { issue: 'image', reasoning: 'amd64-only image on arm64' } } };
const BUILDING = { exitCode: 1, scriptOutput: { status: 'building' } };

test('ASS-392 AC1/AC4: Classify\'s image outcome waits out any golden build, then Repair Image on the host; verified on a VM from the repaired image, the run is done and the ticket resumes, nothing raised', () => {
  const run = walk('grouped-blocked', IMAGE);
  assert.deepEqual(steps(run), ['count-attempts', 'troubleshoot', 'classify', 'await-golden-build', 'repair-image', 'verify-image', 'done']);
  resumes('grouped-blocked', run);
  assert.equal(run.output['image-verified'], true);
  assert.ok(!run.trail.includes('create-fix-ticket') && !run.trail.some(id => id.startsWith('repair-environment')), 'nothing raised, no other repair');
  assert.match(blockHistory({ blocks: [{ ...run.output, 'ended-at': 'done' }] }), /its image repaired \(Pinned the arm64 image\), verified on a VM from it/);
  const analysis = { id: 'r', project: 'example', parent: {}, 'structured-output': { summary: 'S', issue: 'image', reasoning: 'R' } };
  assert.equal(problemOf(analysis, [], { harness: { 'harness-project': 'harness' } }).includes('Raise the fix ticket in'), false, 'no fix ticket for an image issue');
  assert.match(problemOf(analysis, [], {}), /Classified: an image issue/);
  // Only an image issue reaches it.
  const into = engines['grouped-blocked'].steps.flatMap(s => (s['exit-events'] ?? []).filter(e => e['move-to-state'] === 'await-golden-build').map(() => s.id));
  assert.deepEqual([...new Set(into)].toSorted(), ['classify', 'repair-image']);
  for (const value of ['harness', 'project', 'environment', 'dependency']) assert.ok(!walk('grouped-blocked', issue(value)).trail.includes('repair-image'), value);
});

test('ASS-392 AC3: one golden rebuild at a time — Await the Golden Build polls vm:golden-wait on a timer while a build runs (exit 1, its waiting-exit-code: no failure counted); a build Repair Image finds or starts sends it back to wait, then Repair Image runs again to re-check first; bounded by max-visits', () => {
  const grouped = engines['grouped-blocked'], wait = stepOf(grouped, 'await-golden-build');
  assert.deepEqual([wait.action.type, wait.action.command, wait.action.mode, wait.action['timer-minutes'], wait.action['waiting-exit-code'], wait['record-script-output'], wait.vm],
    ['script', './agent.sh vm:golden-wait {project}', 'timer', 5, 1, true, undefined], 'on the host, its VM let stop while it waits');
  assert.equal(nextState(wait, grouped, BUILDING, []), null, 'building: waits, no exit, no failure');
  assert.deepEqual([0, 2].map(code => nextState(wait, grouped, { exitCode: code }, []).to), ['repair-image', 'blocked-for-human']);
  // Repair Image found a build running, or started one: back to wait, then again — its re-check finding the problem gone (no rebuild), verified.
  const again = walk('grouped-blocked', { ...IMAGE, 'repair-image': [
    { structuredOutput: { 'golden-building': true, fixed: false, evidence: ['vm:build-golden-start p → started'], 'ai-feedback-short': 'Started a golden rebuild', 'ai-feedback-long': 'L' } },
    { structuredOutput: { 'golden-building': false, fixed: true, 'problem-gone': true, evidence: ['vm:golden-wait p → current'], 'ai-feedback-short': 'Gone after the rebuild', 'ai-feedback-long': 'L' } },
  ] });
  assert.deepEqual(steps(again).slice(3), ['await-golden-build', 'repair-image', 'await-golden-build', 'repair-image', 'verify-image', 'done']);
  assert.equal(again.output['problem-gone'], true);
  // A repair that only ever waits on builds reaches the operator.
  const forever = walk('grouped-blocked', { ...IMAGE, 'repair-image': { structuredOutput: { 'golden-building': true, fixed: false, evidence: [], 'ai-feedback-short': 'Waiting on golden-p\'s build', 'ai-feedback-long': 'L' } } });
  assert.equal(forever.trail.filter(id => id === 'await-golden-build').length, wait['max-visits']);
  toHuman('grouped-blocked', forever, /Waiting on golden-p/);
  // The wait reads the lock and the started build the harness already uses (golden.bash golden_status), never a lock of its own.
  const sh = readFileSync(join(ROOT, 'src', 'agent-cli', 'vm', 'golden-wait.sh'), 'utf8');
  assert.match(sh, /golden_status "\$1"/);
  assert.doesNotMatch(sh, /lock_on|flock/);
});

test('ASS-392 AC4: Verify the Repaired Image — vm:image-recheck on the host, its VM running: passed (exit 0), or no check of the harness\'s own with the image current and the VM its clone (exit 2), done; still failing, not current, an old clone or the command failing, Blocked for Human with what was tried; Repair Image not fixed, Blocked for Human', () => {
  const grouped = engines['grouped-blocked'], verify = stepOf(grouped, 'verify-image');
  assert.deepEqual([verify.action.type, verify.action.command, verify['record-script-output'], verify.vm, verify['run-location']],
    ['script', './agent.sh vm:image-recheck {project} {work-item} {variation}', true, 'running', undefined]);
  assert.deepEqual([0, 2, 3, 1].map(code => nextState(verify, grouped, { exitCode: code }, []).to), ['done', 'done', 'blocked-for-human', 'blocked-for-human']);
  const still = walk('grouped-blocked', { ...IMAGE, 'verify-image': { exitCode: 3, scriptOutput: { 'image-verified': false, 'ai-feedback-short': 'Repair Image: the failing check still fails on a VM from the repaired image', 'ai-feedback-long': 'L' } } });
  assert.deepEqual(still.trail.slice(-2), ['verify-image', 'blocked-for-human']);
  toHuman('grouped-blocked', still, /still fails on a VM from the repaired image/);
  const notFixed = walk('grouped-blocked', { ...IMAGE, 'repair-image': { structuredOutput: { 'golden-building': false, fixed: false, evidence: [], 'ai-feedback-short': 'The Claude token is missing: the operator adds it', 'ai-feedback-long': 'L' } } });
  assert.deepEqual(notFixed.trail.slice(-2), ['repair-image', 'blocked-for-human']);
  toHuman('grouped-blocked', notFixed, /token is missing/);
});

test('ASS-392 AC2: Repair Image is a confined host prompt step — not the VM, not unconfined — and its prompt states its limits: re-check first, wait for a running build, registry:up, the image definition in the project\'s golden-image folder only through vm:golden-write, vm:build-golden-start, vm:recreate; nothing else on the Mac — no other project, the shared checkout or the operator\'s settings — and never a credential', () => {
  const step = stepOf(engines['grouped-blocked'], 'repair-image');
  assert.deepEqual([step.action.type, step.action.prompt, step['run-location'], step.vm, step.action['works-on-code'], step.action['run-in-dev-container']],
    ['prompt', 'repair-image-on-host-grouped', undefined, undefined, undefined, false], 'on the host, confined (confinement.test.js: not among the unconfined)');
  const t = promptText('repair-image-on-host-grouped'), out = promptJson('repair-image-on-host-grouped').output;
  assert.match(t, /First, re-check: is the original problem still there\?/);
  assert.match(t, /a build finished after the block may already have fixed it/);
  assert.match(t, /Gone: rebuild nothing/);
  assert.match(t, /One golden rebuild at a time\. If status is building [^\n]*golden-build\.lock held, or golden-build-run\.json's build still going[^\n]*start nothing and change nothing: finish at once with golden-building true/);
  assert.match(t, /never delete or touch golden-build\.lock, golden-build-run\.json or golden-build-start\.lock/);
  assert.ok(t.includes('`{agent-sh} vm:golden-wait {project}`'));
  assert.ok(t.includes('`{agent-sh} registry:up {project}`'));
  assert.match(t, /edit the project's image definition — only files in its golden-image folder \(\{project-folder\}\/project\.json's golden-image\.folder: provision\.sh, template\.yaml, images\.txt, warm\.sh, tests\.json, run-test\.sh\) — and only through `\{agent-sh\} vm:golden-write \{project\} <file in that folder>/);
  assert.ok(t.includes('`{agent-sh} vm:build-golden-start {project}`'));
  assert.ok(t.includes('`{agent-sh} vm:recreate {project} {ticket} {variation}`'));
  assert.match(t, /You may not touch anything else on this Mac: no other project's files, VMs, image or registry; not the project's shared checkout[^\n]*not the operator's settings[^\n]*nothing outside the project's golden-image folder but through the commands above\./);
  assert.match(t, /Never a credential, token or secret — never read, write, add or rotate one[^\n]*a missing or expired token is the operator's, as Setup's credential check reports it/);
  assert.match(t, /Fixed only when it passes\./);
  assert.doesNotMatch(t, /vm:build-golden [^s]|vm:delete|limactl (delete|stop|start)/, 'no other way to build or delete');
  assert.deepEqual([out.properties['golden-building'].type, out.properties.fixed.type, out.properties['problem-gone'].type, out.required], ['boolean', 'boolean', 'boolean', ['golden-building', 'fixed', 'evidence', 'ai-feedback-short', 'ai-feedback-long']]);
  // Its commands run on the Mac alone: a VM agent may not call them through the forwarder.
  const allowed = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  for (const c of ['vm:golden-wait', 'vm:golden-write', 'vm:recreate', 'vm:image-recheck', 'registry:up']) assert.equal(allowed[c], undefined, c);
});
