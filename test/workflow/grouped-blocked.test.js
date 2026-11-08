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
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { problemOf, runValues } from '../../src/control/facts.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { inOrder, engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
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
  'create-fix-ticket': { structuredOutput: { key: 'ASS-1' } },
  'add-repository': { exitCode: 2 },   // no missing repository named: nothing added
  'check-on-master': { exitCode: 0, scriptOutput: { 'on-master': 'present', 'master-evidence': 'E' } },   // ASS-163: failing on the latest master
  'plan-obstacle-fix': { exitCode: 0, scriptOutput: { 'plan-revised': 'execution-plan.md', 'obstacle-fix': 'repair the environment' } },
};
const issue = value => ({ classify: { structuredOutput: { issue: value, reasoning: 'R' } } });
const steps = run => run.trail.filter(id => !['find-where'].includes(id));

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
    assert.deepEqual(steps(walk(name)), ['count-attempts', 'troubleshoot', 'classify', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'done'], name);
    assert.equal(stepOf(engines[name], 'troubleshoot-on-host').action.prompt, 'troubleshoot-block-on-host-grouped', 'its own copy: the current engines keep troubleshoot-block as it was');
    assert.equal(stepOf(engines[name], 'classify').action.prompt, 'classify-issue-grouped', 'its own copy (ASS-163): the current engines keep classify-issue as it was');
  }
  const schema = JSON.parse(readFileSync(join(ROOT, 'prompts', 'classify-issue-grouped', 'prompt.json'), 'utf8')).output;
  assert.deepEqual(schema.properties.issue.enum, ['harness', 'project', 'environment']);
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
      assert.deepEqual(steps(run).slice(2).filter(id => id !== 'check-on-master'), ['classify', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'done'], `${name} ${value}`);
      resumes(name, run);
      assert.equal(raisedIn(run.output, 'example'), `Raise the fix ticket in: ${example}`, `${name} ${value}`);
      assert.equal(raisedIn(run.output, 'harness'), 'Raise the fix ticket in: project harness — the harness project\'s backlog', `${name} ${value} on the harness project`);
    }
    assert.equal(stepOf(engines[name], 'create-fix-ticket').action.engine, 'create-ticket-grouped', 'its own copy: Jira bugs raised through ticket:raise-bug (ASS-164); the flat engines keep create-ticket');
    assert.equal(stepOf(engines[name], 'wait-on').action.command, './agent.sh ticket:wait-on {project} {work-item} {variation} {ticket}');
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
    // create-fix-ticket now leads to it, and whatever it does it reaches wait-on.
    assert.equal(stepOf(engines[name], 'create-fix-ticket')['exit-events'][0]['move-to-state'], 'fast-track-fix', name);
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
    assert.deepEqual([0, 3, 4].map(code => nextState(wait, engines[name], { exitCode: code }, []).to), ['done', 'retry', 'blocked-for-human'], name);
    assert.deepEqual(validateStateEngine(engines[name], ROOT, undefined, EXAMPLE_ENGINES), [], name);
  }
  assert.equal(stepOf(engines.blocked, 'await-fix').action['waiting-exit-code'], undefined, 'the flat blocked stays as it was');
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

test('AC7: when no fix ticket can be raised or waited on, the ticket never resumes as if fixed — Blocked for Human, saying why', () => {
  for (const name of BLOCKED) {
    // No ticket raised: the run hands wait-on the blocked ticket's own key, which it refuses (exit 3).
    const none = walk(name, { 'create-fix-ticket': { structuredOutput: { key: '' } }, 'wait-on': { exitCode: 3, scriptOutput: { 'ai-feedback-short': 'No fix ticket was raised' } } });
    assert.deepEqual(steps(none).slice(3), ['create-fix-ticket', 'fast-track-fix', 'wait-on', 'blocked-for-human'], name);
    toHuman(name, none, /No fix ticket was raised/);
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
  assert.deepEqual(vm, [['count-attempts', 'running'], ['find-where', 'running'], ['troubleshoot', 'running'], ['classify', 'running'], ['check-on-master', 'running'], ['plan-obstacle-fix', 'running'], ['add-repository', 'running'], ['repair-environment', 'running']]);
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
  assert.deepEqual(run.trail.slice(-7), ['classify', 'check-on-master', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'done']);
  resumes('grouped-blocked', run);
  const text = problem(run.output);
  assert.match(text, /^On the latest master: present — https:\/\/gitlab\.com\/example\/identity master: job test:keycloak failed — j, pipeline p at s$/m, 'the bug carries the evidence (create-ticket\'s {problem})');
  assert.match(text, /^Raise the fix ticket in: project example — its own ticket system$/m);
  // The harness project's project issues are its own backlog: not checked (exit 2), raised as before.
  const home = walk('grouped-blocked', project({ exitCode: 2, scriptOutput: { 'on-master': 'not-checked', 'master-evidence': 'harness project' } }));
  assert.deepEqual(home.trail.slice(-6), ['check-on-master', 'create-fix-ticket', 'fast-track-fix', 'wait-on', 'await-fix', 'done']);
});

test('ASS-163 AC3: absent on the latest master — nothing raised in the project; the ticket\'s plan grows by the local obstacle\'s fix (ticket:plan-obstacle-fix), Blocked\'s repair makes it (a missing repository added, the environment repaired, else the operator\'s step through Blocked for Human) and the ticket resumes its own work', () => {
  const plan = stepOf(engines['grouped-blocked'], 'plan-obstacle-fix');
  assert.deepEqual([plan.action.type, plan.action.command, plan['record-script-output']], ['script', './agent.sh ticket:plan-obstacle-fix {project} {work-item} {variation} {run}', true]);
  const repaired = walk('grouped-blocked', project(NOT_ON_MASTER));
  assert.deepEqual(repaired.trail.slice(-6), ['classify', 'check-on-master', 'plan-obstacle-fix', 'add-repository', 'repair-environment', 'done']);
  resumes('grouped-blocked', repaired);
  const added = walk('grouped-blocked', project(NOT_ON_MASTER, { 'add-repository': { exitCode: 0 } }));
  assert.deepEqual(added.trail.slice(-3), ['plan-obstacle-fix', 'add-repository', 'done']);
  const operator = walk('grouped-blocked', project(NOT_ON_MASTER, { 'repair-environment': { structuredOutput: { remediated: false, evidence: [], 'ai-feedback-short': 'Re-login to the registry', 'ai-feedback-long': 'L' } } }));
  toHuman('grouped-blocked', operator, /Re-login/);
  for (const run of [repaired, added, operator]) assert.ok(!run.trail.includes('create-fix-ticket'), 'no project bug');
  // Repair is told it is a local obstacle, not to raise the project's fix ticket.
  const text = problem(repaired.output);
  assert.match(text, /^Not on the latest master: https:\/\/gitlab\.com\/example\/identity master: job test:keycloak success .* — our environment or access, not the project's code: no project bug; fix the obstacle here$/m);
  assert.doesNotMatch(text, /^Raise the fix ticket in/m);
});

test('ASS-163 AC5: missing master evidence is not proven — no bug raised; Blocked for Human asks the operator what to check (Have AI Try Again repeats the check)', () => {
  const run = walk('grouped-blocked', project(UNKNOWN));
  assert.deepEqual(run.trail.slice(-3), ['classify', 'check-on-master', 'blocked-for-human']);
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
