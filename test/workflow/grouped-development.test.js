// The grouped development engines (ASS-68): harness-development-grouped and
// example-development-grouped, each top-level step a high-level state whose
// sub-engine holds the steps of the current engines — which stay as they
// are, for the rollback. A ticket is walked through them here with control's
// own reading of an engine (src/control/engine.js nextState), each step's
// facts faked: a sub-engine step runs its run to a done step first, as
// control does, and its exits read which one (sub-engine-ended-at).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stepOf, nextState } from '../../src/control/engine.js';
import { firstStepId } from '../../src/control/moves.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { working, inOrder, engineDir, engineNames, EXAMPLE_ENGINES } from '../support/engine-walk.js';

const ROOT = join(import.meta.dirname, '..', '..');
const engines = Object.fromEntries(engineNames().filter(d => existsSync(join(engineDir(d), 'state-engine.json')))
  .map(d => [d, JSON.parse(readFileSync(join(engineDir(d), 'state-engine.json'), 'utf8'))]));
const prompt = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');
const ids = name => engines[name].steps.map(s => s.id);
const subEngineOf = (top, id) => stepOf(engines[top], id).action.engine;
// ASS-258: steps listed in order, others between them allowed — an engine may gain a step without breaking these.
const hasInOrder = (actual, expected, message = '') => assert.ok(inOrder(actual, expected), `${message}: ${actual.join(' ')} has not ${expected.join(' ')} in order`);

const GROUPS = {
  setup: ['check-setup-complete', 'create-vm', 'mark-setup-complete'],
  plan: ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan'],
  build: ['refresh-repositories', 'generate-automated-tests', 'generate-solution', 'await-dependencies', 'refresh-before-testing', 'automated-testing', 'ci-checks', 'code-review', 'security-review'],
  test: ['local-testing', 'steps-to-test'],
  document: ['update-documentation', 'update-merge-request-details', 'check-merge-request-details', 'add-screenshots-to-merge-request'],
  review: ['explain-the-change', 'risk-assessment', 'token-expense-check', 'payment-gate', 'variation-selection'],   // ASS-314: Human Review gone, risk-assessment straight on to the token expense check
};
const RELEASE = {
  'harness-development-grouped': ['merge-pull-request', 'update-workspace', 'request-restart', 'await-restart'],
  'example-development-grouped': ['take-out-of-draft-mode', 'team-code-review', 'address-merge-request-feedback', 'ensure-auto-merge'],
};
const EXCEPTIONS = ['blocked-for-human', 'blocked', 'self-healing'];
// ASS-79's detour, the grouped engines' own (test/workflow/requirements-changed.test.js): the current engines have none.
const DETOURS = ['requirements-changed'];
const REMOVED = ['create-branch', 'create-worktree', 'create-merge-request'];
const ENDS = ['done', 'blocked', 'blocked-for-human', 'rebuild', 'replan'];
const CURRENT = { 'harness-development-grouped': 'harness-development', 'example-development-grouped': 'example-development' };
const groupsOf = top => ({ ...GROUPS, release: RELEASE[top], ...(top.startsWith('example') ? { qa: ['qa-testing'] } : {}) });
// A group's work: its steps but its done steps (ASS-228: grouped-review's write-test-plan and generate-solution are done steps — unreached since ASS-314 removed grouped-review's Human Review, kept because the parent Review step reads them).
const work = name => engines[name].steps.filter(s => !ENDS.includes(s.id) && !s['is-done']);

test('AC1: each grouped engine is the seq-0 exception states, Backlog and Committed, a step per high-level state in order, and Done', () => {
  for (const top of Object.keys(CURRENT)) {
    hasInOrder(ids(top), [...EXCEPTIONS, ...DETOURS, 'backlog', 'committed', ...Object.keys(groupsOf(top)), 'done'], top);
    for (const [group, steps] of Object.entries(groupsOf(top))) {
      assert.equal(stepOf(engines[top], group).action.type, 'state-engine', `${top} ${group}`);
      hasInOrder(work(subEngineOf(top, group)).map(s => s.id), steps, `${top} ${group}`);
    }
    // Both share every group up to and including Review; Release differs.
    for (const group of Object.keys(GROUPS)) assert.equal(subEngineOf(top, group), subEngineOf('harness-development-grouped', group), group);
  }
  assert.notEqual(subEngineOf('example-development-grouped', 'release'), subEngineOf('harness-development-grouped', 'release'));
});

test('AC1: every step of the current engines is mirrored in its group — action, max-visits and exit conditions — but Create Branch, Create Worktree and Create Merge Request; the current engines keep them', () => {
  for (const [top, current] of Object.entries(CURRENT)) {
    const inGroups = Object.keys(groupsOf(top)).flatMap(g => work(subEngineOf(top, g)));
    for (const old of engines[current].steps) {
      if ([...EXCEPTIONS, 'backlog', 'committed', 'done', ...REMOVED].includes(old.id)) continue;
      // Which steps each group holds: the test above (GROUPS). A step the current engines alone have is theirs (ASS-258: either may gain one).
      const now = inGroups.filter(s => s.id === old.id);
      if (now.length !== 1) continue;
      const [s] = now;
      const action = { ...old.action, ...(old.action.prompt && s.action.prompt !== old.action.prompt ? { prompt: `${old.action.prompt}-grouped` } : {}) };
      // ASS-255: Await the Restart's waiting-exit-code is the grouped engine's own; the flat one's stays as it was.
      const waits = old.id === 'await-restart' ? { 'waiting-exit-code': s.action['waiting-exit-code'] } : {};
      assert.deepEqual(s.action, ['local-testing', 'steps-to-test'].includes(old.id) ? { ...action, engine: s.action.engine } : { ...action, ...waits }, old.id);
      assert.equal(s['max-visits'], old['max-visits'], old.id);
      // ASS-118 AC4: Risk Assessment always goes on, its shortcut past the gate gone; ASS-314: on to the Token Expense Check, grouped-review's Human Review removed.
      if (old.id === 'risk-assessment') assert.deepEqual(s['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'turn-complete': true }, 'token-expense-check']]);
      // ASS-151: a human step's fast-tracked exit is the grouped engines' own; ASS-162: so is Automated Testing's exit 4 (the tests list missing) back to Generate Automated Tests; ASS-224: so is Team Code Review's merged one, ASS-351: and its approval-wait-expired one; ASS-282: so is QA Testing's to blocked on a status QA parks the ticket at.
      else assert.deepEqual(s['exit-events'].filter(e => !Object.hasOwn(e.condition, 'fast-tracked') && !(old.id === 'automated-testing' && e.condition['exit-code'] === 4) && !(old.id === 'team-code-review' && /"(merged|approval-wait-expired)"/.test(JSON.stringify(e.condition))) && !(old.id === 'qa-testing' && e['move-to-state'] === 'blocked')).map(e => e.condition), old['exit-events'].map(e => e.condition), old.id);
      assert.equal(s['paired-ticket-system-status'], undefined, `${old.id}: only the top level pairs (ASS-67)`);
    }
    for (const id of REMOVED) assert.ok(stepOf(engines[current], id), `${current} still has ${id}`);
    for (const id of [...EXCEPTIONS, 'backlog', 'committed', 'done']) {
      const { action, sequence, vm, ...rest } = stepOf(engines[top], id), { action: was, sequence: _, ...before } = stepOf(engines[current], id);   // vm: ASS-75's own
      // Blocked is ASS-107's own in the grouped engines (test/workflow/grouped-blocked.test.js); the current engines' stays as it was.
      if (id === 'blocked') { assert.deepEqual([action, rest['paired-ticket-system-status']], [{ ...was, engine: 'grouped-blocked' }, before['paired-ticket-system-status']]); continue; }
      assert.deepEqual(working(rest), working(id === 'committed' ? { ...before, 'exit-events': [{ ...before['exit-events'][0], 'move-to-state': 'setup' }] } : before), id);
      assert.deepEqual(action, was, id);
    }
    // ASS-124: the grouped health check is its own copy (test/workflow/check-ticket-health.test.js); the current engines' stays as it was.
    // ASS-62: so are its dispatch wrappers, the current ones with memory (test/agent-cli/memory-prompts.test.js).
    const own = (key, list) => (key === 'check-ticket-health-steps' ? list.map(s => ({ ...s, action: { ...s.action, engine: s.action.engine.replace(/-grouped$/, '') } }))
      : /^receive-(pair-)?dispatch-prompt$/.test(key) ? list.replace(/-grouped$/, '') : list);
    const asWorking = value => (Array.isArray(value) ? value.map(working) : value);
    for (const key of Object.keys(engines[current]).filter(k => k !== 'steps')) assert.deepEqual(asWorking(own(key, engines[top][key])), asWorking(engines[current][key]), key);
  }
});

// The steps that review code or need awareness of the code or product run in the VM (ASS-68 Q2); every other runs on the host.
const VM = ['enrich-ac', 'root-cause-analysis', 'review-root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'review-plan',
  'generate-automated-tests', 'generate-solution', 'automated-testing', 'ci-checks', 'code-review', 'security-review', 'test', 'take-screenshots', 'write-steps-to-test',
  'update-documentation', 'update-merge-request-details', 'add-screenshots-to-merge-request', 'explain-the-change', 'risk-assessment', 'token-expense-check', 'address-merge-request-feedback', 'troubleshoot', 'repair-environment',
  'revise-acceptance-criteria', 'judge'];

test('AC2: in the grouped engines and the sub-engines beneath them the code-aware steps run in the VM; human, none and harness- or forge-driving steps, and every state-engine step, on the host', () => {
  const reach = (name, seen = new Set()) => { if (seen.has(name)) return seen; seen.add(name); for (const s of engines[name].steps) if (s.action.type === 'state-engine') reach(s.action.engine, seen); return seen; };
  const all = new Set(Object.keys(CURRENT).flatMap(top => [...reach(top)]));
  for (const shared of ['self-healing-fix', 'create-ticket']) all.delete(shared);   // shared engines, unchanged (no run-location)
  const located = [...all].flatMap(name => engines[name].steps.map(s => [name, s]));
  assert.deepEqual([...new Set(located.filter(([, s]) => s['run-location'] === 'vm').map(([, s]) => s.id))].toSorted(), VM.toSorted());
  for (const [name, s] of located) {
    if (s.action.type === 'state-engine') assert.equal(s['run-location'], undefined, `${name}/${s.id}: a state-engine step runs on the host`);
    else if (!VM.includes(s.id)) assert.equal(s['run-location'], undefined, `${name}/${s.id}: missing means host`);
  }
});

// walk(top, answers) — a ticket walked from committed: each step's facts are
// fact(path, visit) over these defaults (every check passes, every review
// approves, the human approves, no variations), overridden by
// answers["<engine>/<step>"] — an object, or a list by visit. Returns the
// trail of "<engine>/<step>", sub-engines' steps nested in their group's
// visit, stopping at the top level's done or blocked.
function walk(top, answers = {}) {
  const trail = [], visits = new Map();
  const facts = (name, at) => {
    const key = `${name}/${at}`, n = visits.get(key) ?? 0;
    visits.set(key, n + 1);
    const answer = Array.isArray(answers[key]) ? answers[key][Math.min(n, answers[key].length - 1)] : answers[key];
    return {
      turnComplete: true, exitCode: 0, fileUpdated: () => true, scriptSucceeds: () => true, variation: { 'acceptance-criteria': [{}] }, variationCount: 1,
      humanReview: { state: at, decision: 'Approved' }, ticketSystemStatus: 'In Review', scriptOutput: { 'needs-attention': false, 'auto-merge': false, status: 'passed' },
      structuredOutput: { 'is-approved': true, 'flagged-for-human-review': false, 'will-spend-tokens': false }, agentNeedsWork: true,
      ...answer,
    };
  };
  // A run's output is what its prompts and sub-engines returned, merged as control merges it (moveRun).
  const run = (name, start, stop) => {
    const engine = engines[name], changes = [];
    let output = {};
    for (let at = start, startAt, i = 0; i < 200; i++) {
      trail.push(`${name}/${at}`);
      const step = stepOf(engine, at);
      if (step['is-done'] || stop?.includes(at)) return { end: at, output };
      let f = facts(name, at);
      if (step.action.type === 'state-engine') {
        const child = run(step.action.engine, startAt ?? firstStepId(engines[step.action.engine]));
        f = { ...f, subEngineDone: true, subEngineState: child.end, structuredOutput: { ...output, ...child.output } };
      }
      if (['prompt', 'state-engine'].includes(step.action.type)) output = { ...output, ...f.structuredOutput };
      const next = nextState(step, engine, f, changes);
      assert.ok(next?.to, `${name}/${at}: no exit`);
      changes.push({ 'from-state': at, 'to-state': next.to });
      startAt = next.reason === 'exit' ? next.exit['start-sub-engine-at'] : undefined;
      at = next.to;
    }
    throw new Error(`${name} ran away: ${trail.slice(-10).join(' ')}`);
  };
  run(top, 'committed', ['blocked', 'blocked-for-human']);
  return trail;
}
const tops = trail => trail.filter(p => /^(harness|example)-development-grouped\//.test(p)).map(p => p.split('/')[1]);
const after = (trail, path) => trail.slice(trail.indexOf(path) + 1);
const NOT_SET_UP = { 'grouped-setup/check-setup-complete': { scriptSucceeds: () => false } };
// ASS-224: merge-request:check finding every merge request not Closed Merged — all Team Code Review needs to finish; the ticket system is left at In Review.
const MERGED = { scriptOutput: { 'needs-attention': false, 'auto-merge': true, merged: true } };

test('AC1: a ticket goes through every group in order — harness-development-grouped to its own release and Done', () => {
  const trail = walk('harness-development-grouped', NOT_SET_UP);
  assert.deepEqual(tops(trail), ['committed', 'setup', 'plan', 'build', 'test', 'document', 'review', 'release', 'done']);
  assert.deepEqual(trail.slice(2, 7), ['grouped-setup/check-setup-complete', 'grouped-setup/create-vm', 'grouped-setup/mark-setup-complete', 'grouped-setup/done', 'harness-development-grouped/plan']);
  for (const [group, steps] of Object.entries(groupsOf('harness-development-grouped'))) {
    const name = subEngineOf('harness-development-grouped', group);
    if (group === 'review') assert.deepEqual(trail.filter(p => p.startsWith(`${name}/`)), ['explain-the-change', 'risk-assessment', 'token-expense-check', 'variation-selection', 'done'].map(s => `${name}/${s}`));   // the Payment Gate only when it will spend tokens; no Human Review (ASS-314)
    else assert.deepEqual(trail.filter(p => p.startsWith(`${name}/`)), [...steps, 'done'].map(s => `${name}/${s}`), group);
  }
  assert.ok(trail.includes('grouped-local-testing/take-screenshots') && trail.includes('grouped-steps-to-test/write-steps-to-test'), 'Test\'s sub-engines run inside it');
});

test('AC1: example goes on from Review to its own Release — out of draft, team review and its feedback — then QA until the ticket system says Done', () => {
  const trail = walk('example-development-grouped', { ...NOT_SET_UP,
    'grouped-release-example/team-code-review': [{ scriptOutput: { 'needs-attention': true } }, MERGED],
    'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } });
  assert.deepEqual(tops(trail), ['committed', 'setup', 'plan', 'build', 'test', 'document', 'review', 'release', 'qa', 'done']);
  assert.deepEqual(trail.filter(p => p.startsWith('grouped-release-example/')).map(p => p.split('/')[1]), ['take-out-of-draft-mode', 'team-code-review', 'address-merge-request-feedback', 'team-code-review', 'done']);
});

// ASS-314: Human Review's half of this is v2-review's own now (test/workflow/v2-development.test.js, ASS-116 AC2 pair 2): grouped-review has no such gate to reject at.
test('AC3: the Payment Gate\'s Rejected re-enters Plan at Write Execution Plan', () => {
  const trail = walk('harness-development-grouped', {
    'grouped-review/token-expense-check': [{ structuredOutput: { 'will-spend-tokens': true } }, {}],
    'grouped-review/payment-gate': [{ humanReview: { state: 'payment-gate', decision: 'Rejected' } }, {}] });
  assert.deepEqual(after(trail, 'grouped-review/payment-gate').slice(0, 3), ['grouped-review/replan', 'harness-development-grouped/plan', 'grouped-plan/write-execution-plan']);
  assert.equal(tops(trail).at(-1), 'done');
});

test('AC3: Local Testing\'s Rejected re-enters Build at Generate Solution; in example so does Team Code Review sending the ticket back In Progress', () => {
  const tested = walk('harness-development-grouped', { 'grouped-local-testing/test': [{ structuredOutput: { 'is-approved': false } }, {}] });
  assert.deepEqual(after(tested, 'grouped-local-testing/done').slice(0, 6), ['grouped-test/rebuild', 'harness-development-grouped/build', 'grouped-build/generate-solution', 'grouped-build/await-dependencies', 'grouped-build/refresh-before-testing', 'grouped-build/automated-testing']);
  assert.equal(tops(tested).at(-1), 'done');
  const reviewed = walk('example-development-grouped', {
    'grouped-release-example/team-code-review': [{ ticketSystemStatus: 'In Progress' }, MERGED], 'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } });
  assert.deepEqual(after(reviewed, 'grouped-release-example/team-code-review').slice(0, 3), ['grouped-release-example/rebuild', 'example-development-grouped/build', 'grouped-build/generate-solution']);
  assert.equal(tops(reviewed).at(-1), 'done');
});

test('AC3: loops within a group stay in it — a rejected code review rebuilds there; a step looping past its max-visits ends the group at Blocked, and the group step sends the ticket to the top level\'s Blocked', () => {
  const reviewed = walk('harness-development-grouped', { 'grouped-build/code-review': [{ structuredOutput: { 'is-approved': false } }, {}] });
  assert.deepEqual(after(reviewed, 'grouped-build/code-review').slice(0, 4), ['grouped-build/generate-solution', 'grouped-build/await-dependencies', 'grouped-build/refresh-before-testing', 'grouped-build/automated-testing']);
  const looping = walk('harness-development-grouped', { 'grouped-plan/write-execution-plan': { fileUpdated: () => false } });
  assert.deepEqual(looping.slice(-5), ['grouped-plan/write-execution-plan', 'grouped-plan/write-execution-plan', 'grouped-plan/write-execution-plan', 'grouped-plan/blocked', 'harness-development-grouped/blocked']);
  const failing = walk('example-development-grouped', { 'grouped-build/automated-testing': { exitCode: 3 } });
  assert.deepEqual(failing.slice(-3), ['grouped-build/automated-testing', 'grouped-build/blocked', 'example-development-grouped/blocked']);
  // Blocked hands the ticket back to the group it came from (its return-to-state), which starts again.
  for (const top of Object.keys(CURRENT)) for (const group of Object.keys(groupsOf(top))) assert.equal(stepOf(engines[top], group)['return-to-state'], group, `${top} ${group}`);
});

test('AC7: Setup leaves at once when the VM holds its setup-complete marker; without it — a first setup, or one that stopped part way — it runs from the start, and only its last step writes the marker', () => {
  const done = walk('harness-development-grouped');
  assert.deepEqual(done.slice(0, 4), ['harness-development-grouped/committed', 'harness-development-grouped/setup', 'grouped-setup/check-setup-complete', 'grouped-setup/done']);
  const setup = engines['grouped-setup'];
  assert.equal(firstStepId(setup), 'check-setup-complete');
  assert.deepEqual(stepOf(setup, 'check-setup-complete')['exit-events'].map(e => [e.condition, e['move-to-state']]), [
    [{ 'script-succeeds': './agent.sh vm:setup-complete {project} {ticket} {variation}' }, 'done'],
    [{ not: { 'script-succeeds': './agent.sh vm:setup-complete {project} {ticket} {variation}' } }, 'create-vm']]);
  assert.equal(stepOf(setup, 'create-vm').action.command, './agent.sh vm:create {project} {ticket} {variation}');
  const setUp = walk('harness-development-grouped', NOT_SET_UP), last = setUp[setUp.indexOf('grouped-setup/done') - 1];
  assert.deepEqual([last, stepOf(setup, 'mark-setup-complete').action.command], ['grouped-setup/mark-setup-complete', './agent.sh vm:mark-setup-complete {project} {ticket} {variation}']);
  // On the way through Setup, only the check and the marker go on to done.
  const passed = [...done, ...setUp].filter(p => p.startsWith('grouped-setup/')).map(p => stepOf(setup, p.split('/')[1]));
  assert.ok(passed.every(s => s['is-done'] || s['exit-events'].find(e => e['move-to-state'] === 'done') == null || ['check-setup-complete', 'mark-setup-complete'].includes(s.id)), 'only the check and the marker reach done');
  // A VM failing to come up: Create VM's third failure ends Setup at Blocked.
  const failing = walk('harness-development-grouped', { ...NOT_SET_UP, 'grouped-setup/create-vm': { exitCode: 1 } });
  assert.deepEqual(failing.slice(-5), ['grouped-setup/create-vm', 'grouped-setup/create-vm', 'grouped-setup/create-vm', 'grouped-setup/blocked', 'harness-development-grouped/blocked']);
  assert.ok(!failing.includes('grouped-setup/mark-setup-complete'), 'no marker for a setup that failed');
});

// ASS-75: a step's `vm` — running, or stopped (kept) — says whether the variation's VM runs there, the deepest level that sets it deciding.
test('ASS-75: the VM runs from Setup through Review and in Self Healing, and stops at Blocked and Blocked for Human, kept; elsewhere it is not needed — but for the steps beneath that run in it: Blocked\'s troubleshooting, classifying and repair, and example\'s Address Merge Request Feedback', () => {
  const RUNNING = ['self-healing', ...DETOURS, ...Object.keys(GROUPS)];
  for (const top of Object.keys(CURRENT)) {
    assert.deepEqual(engines[top].steps.filter(s => s.vm).map(s => [s.id, s.vm]), [['blocked-for-human', 'stopped'], ['blocked', 'stopped'], ...RUNNING.map(id => [id, 'running'])], top);
    // Every step that runs in the VM does so where the VM runs: its own vm, or the nearest above it that has one.
    const check = (name, inherited) => {
      for (const s of engines[name].steps) {
        const vm = s.vm ?? inherited;
        if (s['run-location'] === 'vm') assert.equal(vm, 'running', `${name}/${s.id} runs in the VM, which is ${vm ?? 'not needed'} there`);
        if (s.action.type === 'state-engine') check(s.action.engine, vm);
      }
    };
    check(top);
  }
  const beneath = Object.keys(engines).filter(n => n.startsWith('grouped-')).flatMap(n => engines[n].steps.filter(s => s.vm).map(s => `${n}/${s.id}=${s.vm}`));
  // ASS-365: grouped-merge's agents run in the VM wherever it runs — Build's, or a project Release's where the VM is not otherwise needed.
  assert.deepEqual(beneath.sort(), ['grouped-blocked/add-repository=running', 'grouped-blocked/check-on-master=running', 'grouped-blocked/classify=running', 'grouped-blocked/count-attempts=running', 'grouped-blocked/find-where=running', 'grouped-blocked/own-branch-or-human=running', 'grouped-blocked/own-branch-or-obstacle=running', 'grouped-blocked/plan-obstacle-fix=running', 'grouped-blocked/repair-environment=running', 'grouped-blocked/troubleshoot=running',
    'grouped-merge/address-merge-request-feedback=running', 'grouped-merge/code-review=running', 'grouped-merge/security-review=running', 'grouped-release-example/address-merge-request-feedback=running']);
});

test('ASS-75: Create VM that cannot fit within the project\'s VM disk limit (vm:create exits 3) ends Setup at Blocked for Human, its output — the ai-feedback — kept by the run', () => {
  for (const top of Object.keys(CURRENT)) {
    const full = walk(top, { ...NOT_SET_UP, 'grouped-setup/create-vm': { exitCode: 3 } });
    assert.deepEqual(full.slice(-3), ['grouped-setup/create-vm', 'grouped-setup/blocked-for-human', `${top}/blocked-for-human`], top);
  }
  assert.equal(stepOf(engines['grouped-setup'], 'create-vm')['record-script-output'], true);
});

// AC4 and AC5 are prompts: the grouped engines' copies; the current engines keep the originals, unchanged in behaviour.
const REVISED = ['root-cause-analysis', 'write-execution-plan', 'write-test-plan', 'enrich-automated-test-data', 'generate-automated-tests', 'generate-solution', 'update-documentation'];

test('AC5: the seven steps that write the plan, the tests, the code and the docs revise what is there, never starting from scratch, and say what changed and why — in the grouped engines only', () => {
  const grouped = Object.fromEntries(['grouped-plan', 'grouped-build', 'grouped-document'].flatMap(n => engines[n].steps).map(s => [s.id, s.action.prompt]));
  for (const id of REVISED) {
    assert.equal(grouped[id], `${id}-grouped`, id);
    const text = prompt(`${id}-grouped`);
    assert.match(text, /Revise, don't restart/, id);
    assert.match(text, /Never (start|rewrite) (it|them) from scratch/, id);
    assert.match(text, /what changed|which (tests|fixtures) changed/i, id);
    assert.match(text, /why/, id);
    assert.doesNotMatch(prompt(id), /Revise, don't restart/, `${id}: the current engines' prompt is unchanged`);
    for (const current of Object.values(CURRENT)) assert.equal(stepOf(engines[current], id).action.prompt, id, `${current} ${id}`);
  }
});

test('AC4: Write Execution Plan researches before it writes the plan, which holds no spikes, investigations or research steps, and follows what the research found', () => {
  const text = prompt('write-execution-plan-grouped');
  assert.ok(text.indexOf('Research first') < text.indexOf('Write {ticket-folder}/execution-plan-{variation}.md'));
  assert.match(text, /no spikes, investigations or research steps/);
  assert.match(text, /If what you learn changes the approach, plan the new approach/);
});

test('ASS-80: Write Execution Plan plans the merge requests — reads those recorded, then records each one\'s id, repository, contents and depends-on through agent.sh; in the grouped engines only', () => {
  const text = prompt('write-execution-plan-grouped');
  assert.match(text, /\{where\}/);   // the repositories: name, url, description, VM folder
  const read = text.indexOf('{agent-sh} ticket:merge-request-plan {project} {ticket} {variation}');
  const record = text.indexOf('{agent-sh} ticket:set-merge-request-plan {project} {ticket} {variation} -`, the JSON on stdin');   // ASS-182: /mnt/ticket is read-only
  assert.ok(read > 0 && record > read, text);
  for (const field of ['"id"', '"repository"', '"contents"', '"depends-on"']) assert.ok(text.includes(field), field);
  assert.match(text, /never reuse/i);
  assert.match(text, /harness names (each|the) branch/);
  assert.doesNotMatch(prompt('write-execution-plan'), /merge-request-plan/, 'the current engines\' prompt is unchanged');
});

test('the grouped engines have their own Blocked: its troubleshooting and repair run in the variation\'s VM once it is set up, on the host before; the shared blocked engine is the current engines\'', () => {
  const blocked = engines['grouped-blocked'];
  // ASS-107: its own steps — counting, classifying, repairing — finding where to troubleshoot and repair: in the VM once set up, on the host before.
  hasInOrder(ids('grouped-blocked'), ['count-attempts', 'find-where', 'troubleshoot', 'troubleshoot-on-host', 'classify', 'check-on-master', 'plan-obstacle-fix', 'add-repository', 'repair-environment', 'repair-environment-on-host', 'create-fix-ticket', 'wait-on', 'await-fix', 'done', 'retry', 'blocked-for-human']);
  assert.deepEqual([stepOf(blocked, 'troubleshoot')['run-location'], stepOf(blocked, 'troubleshoot').action.prompt], ['vm', 'troubleshoot-block-grouped']);
  assert.deepEqual([stepOf(blocked, 'troubleshoot-on-host')['run-location'], stepOf(blocked, 'troubleshoot-on-host').action.prompt], [undefined, 'troubleshoot-block-on-host-grouped']);
  assert.equal(stepOf(engines.blocked, 'troubleshoot')['run-location'], undefined);
  assert.equal(stepOf(engines.blocked, 'troubleshoot').action.prompt, 'troubleshoot-block');
  for (const current of Object.values(CURRENT)) assert.equal(stepOf(engines[current], 'blocked').action.engine, 'blocked');
});

test('AC6: a project is switched with project:set-execution-engine', () => {
  assert.match(readFileSync(engineDir('grouped-engines.md'), 'utf8'), /project:set-execution-engine harness harness-development-grouped/);
});

// ASS-81: the steps after Generate Solution handle every merge request, through copies of the current engines' prompts.
const PER_MR = { 'code-review': 'grouped-build', 'security-review': 'grouped-build', 'risk-assessment': 'grouped-review', 'token-expense-check': 'grouped-review',
  'update-merge-request-details': 'grouped-document', 'add-screenshots-to-merge-request': 'grouped-document', 'take-screenshots': 'grouped-local-testing',
  'address-merge-request-feedback': 'grouped-release-example' };
const PLAN = '{agent-sh} ticket:merge-request-plan {project} {ticket} {variation}';
const promptOf = (engine, id) => stepOf(engines[engine], id).action.prompt;

test('ASS-81 AC1/AC2: Generate Solution builds the planned MRs one at a time in depends-on order — control reads them all first, the agent builds and pushes each branch on its base, then control opens its draft (or closes it)', () => {
  const text = prompt('generate-solution-grouped');
  const at = s => { const i = text.indexOf(s); assert.ok(i >= 0, `${s}\n${text}`); return i; };
  assert.match(text, /one at a time, each after those it depends on/);
  const read = at('{agent-sh} merge-request:check {project} {ticket} {variation}'), plan = at(PLAN);
  const branch = at('origin/<base>'), push = at('git push'), create = at('{agent-sh} merge-request:create {project} {ticket} {variation} <id>');
  assert.ok(read < plan && plan < branch && branch < push && push < create, text);
  assert.match(text, /Skip one Merged or Closed/);
  assert.match(text, /rebase it onto origin\/<base>/);
  assert.match(text, /even when it holds no changes/);
  assert.match(text, /Don't open, close or retarget a merge request yourself/);
  assert.doesNotMatch(prompt('generate-solution'), /merge-request:create/, 'the current engines\' prompt is unchanged');
});

test('ASS-81 AC3-AC5: the reviews, Update Merge Request Details, Add Screenshots, Take Screenshots and Address Merge Request Feedback each cover every merge request, through a grouped copy of their prompt; the current engines keep theirs', () => {
  for (const [id, engine] of Object.entries(PER_MR)) {
    const name = promptOf(engine, id), original = name.replace(/-grouped$/, '');
    assert.equal(name, `${original}-grouped`, id);
    const text = prompt(name);
    assert.ok(text.includes(PLAN), `${id} reads the merge requests\n${text}`);
    assert.match(text, /every (merge request|one)/i, id);
    assert.match(text, /\{where\}/, id);
    assert.ok(!prompt(original).includes('merge-request-plan'), `${original}: the current engines' prompt is unchanged`);
    for (const current of Object.values(CURRENT)) { const s = engines[current].steps.find(x => x.id === id); if (s) assert.equal(s.action.prompt, original, `${current} ${id}`); }
  }
  // AC3: one pass and one verdict over every MR's diff against its base, findings named per MR, file and line.
  for (const id of ['code-review', 'security-review', 'risk-assessment', 'token-expense-check']) {
    const text = prompt(promptOf(PER_MR[id], id));
    assert.ok(text.includes('git diff origin/<base>...origin/<branch>'), id);
    assert.match(text, /each finding names its merge request, file and line/, id);
    assert.match(text, /one verdict for them all/, id);
  }
  // AC4: screenshots per MR, falling back to the ticket's, the note only when there are none at all.
  const take = prompt(promptOf('grouped-local-testing', 'take-screenshots'));
  assert.ok(take.includes('{ticket-folder}/screenshots/<id>/') && take.includes('{ticket-folder}/screenshots/'), take);
  const add = prompt(promptOf('grouped-document', 'add-screenshots-to-merge-request'));
  const own = add.indexOf('{ticket-folder}/screenshots/<id>/'), ticket = add.indexOf('the ticket\'s own, in {ticket-folder}/screenshots/'), none = add.indexOf('no visible UI');
  assert.ok(own > 0 && own < ticket && ticket < none, add);
  assert.match(add, /Only when neither has any/);
  assert.match(prompt(promptOf('grouped-document', 'update-merge-request-details')), /each one's own changes/);
});

test('ASS-81: the merge-request commands Generate Solution calls from the VM are on the forwarder\'s allowlist, bound to its ticket variation', () => {
  const allow = JSON.parse(readFileSync(join(ROOT, 'src', 'control', 'forwarder-allowlist.json'), 'utf8'));
  for (const command of ['merge-request:check', 'merge-request:create']) assert.deepEqual(allow[command], { project: 0, ticket: 1, variation: 2 }, command);
});

// ASS-118: Review opens with a step that explains the change in plain words, per variation, and posts it as each MR's Summary.
// walked(top) — a plain walk of the engine, through Review and on (ASS-314: no Human Review to answer on the way).
const walked = top => walk(top, top.startsWith('example') ? {
  'grouped-release-example/team-code-review': MERGED, 'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } } : {});

test('ASS-118 AC1/AC5: Review opens with Explain the Change, in the VM, before Risk Assessment; it goes on only once it has written explanation-<variation>.md in the ticket\'s folder, else writes it again', () => {
  const review = engines['grouped-review'];
  assert.equal(firstStepId(review), 'explain-the-change');
  const explain = stepOf(review, 'explain-the-change');
  assert.deepEqual([explain.action.type, explain.action.prompt, explain['run-location']], ['prompt', 'explain-the-change', 'vm']);
  const written = { 'file-updated': { file: 'explanation-{variation}.md', since: 'turn-start' } };
  assert.deepEqual(explain['exit-events'].map(e => [e.condition, e['move-to-state']]), [
    [{ all: [{ 'turn-complete': true }, written] }, 'risk-assessment'],
    [{ all: [{ 'turn-complete': true }, { not: written }] }, 'explain-the-change']]);
  const unwritten = walk('harness-development-grouped', { 'grouped-review/explain-the-change': { fileUpdated: () => false } });
  assert.deepEqual(unwritten.slice(-5), ['grouped-review/explain-the-change', 'grouped-review/explain-the-change', 'grouped-review/explain-the-change', 'grouped-review/blocked', 'harness-development-grouped/blocked']);
});

test('ASS-118 AC5: in both grouped engines the order is the MRs\' details and screenshots, the explanation, the risk profile, then out of draft (example) or merged (harness) — with no Human Review between the risk profile and Release (ASS-314)', () => {
  const ORDER = ['grouped-document/update-merge-request-details', 'grouped-document/add-screenshots-to-merge-request', 'grouped-review/explain-the-change', 'grouped-review/risk-assessment'];
  for (const [top, release] of [['harness-development-grouped', 'grouped-release-harness/merge-pull-request'], ['example-development-grouped', 'grouped-release-example/take-out-of-draft-mode']]) {
    const trail = walked(top);
    assert.deepEqual(trail.filter(p => [...ORDER, release].includes(p)), [...ORDER, release], top);
    assert.equal(tops(trail).at(-1), 'done', top);
  }
});

// ASS-314: case-law's Review no longer stops at the Human Review gate. The
// shared grouped-review has no such step: Risk Assessment's finished turn goes
// straight on to the AI Token Expense Check, whether or not it flagged the
// change (the flag was never read by its exits), and nothing in grouped-review
// or the engines that run it sends a ticket to a human-review step any more.
// v2-review's Human Review (harness, software-assassin) is untouched: test/workflow/v2-development.test.js.
test('ASS-314 AC1/AC2: grouped-review has no Human Review — Risk Assessment goes on to the AI Token Expense Check, and a variation walked through Review passes from one straight to the other, flagged or not', () => {
  const review = engines['grouped-review'];
  assert.equal(stepOf(review, 'human-review'), undefined, 'grouped-review still has a Human Review step');
  assert.deepEqual(stepOf(review, 'risk-assessment')['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'turn-complete': true }, 'token-expense-check']]);
  // Nor does any exit of grouped-review, or of the engines that run it, still name one as its target.
  for (const name of ['grouped-review', ...Object.keys(CURRENT)]) {
    const targets = Object.values(engines[name]).filter(Array.isArray).flat().flatMap(s => (s['exit-events'] ?? []).map(e => e['move-to-state']));
    assert.ok(!targets.includes('human-review'), `${name} still moves a ticket to human-review`);
  }
  for (const flagged of [true, false]) {
    const trail = walk('harness-development-grouped', { 'grouped-review/risk-assessment': { structuredOutput: { 'flagged-for-human-review': flagged } } });
    assert.equal(after(trail, 'grouped-review/risk-assessment')[0], 'grouped-review/token-expense-check', `flagged ${flagged}`);
    assert.ok(!trail.includes('grouped-review/human-review'), `flagged ${flagged}: the ticket waited at Human Review`);
    assert.equal(tops(trail).at(-1), 'done', `flagged ${flagged}`);
  }
});

// ASS-314: a rejection at Human Review sending the ticket round again is v2-review's
// alone now (test/workflow/v2-development.test.js, ASS-116 AC2 pair 2); grouped-review has no such gate.

// Every step that takes a merge request out of draft or merges one: its action names the command.
const RELEASING = /merge-request:merge|merge-request:ensure-auto-merge|take-out-of-draft-mode/;
const releasing = name => engines[name].steps.filter(s => RELEASING.test(s.action.command ?? '')).map(s => s.id);

test('ASS-118 AC4: no merge request leaves draft and nothing merges before Release — however low the risk; and Release is entered from Review alone (ASS-314: no Human Review waits in between)', () => {
  // The only steps that ready or merge one are in Release — and in grouped-merge (ASS-365), which grouped-build runs
  // only from Await Sequential Merge's exit 5, which merge-request:await-dependencies gives only where a step of the
  // variation's status chain says merges-awaited (MERGES_AWAITED): none of these engines does (the ASS-365 tests below).
  const reach = (name, seen = new Set()) => { if (seen.has(name)) return seen; seen.add(name); for (const s of engines[name].steps) if (s.action.type === 'state-engine') reach(s.action.engine, seen); return seen; };
  for (const top of Object.keys(CURRENT)) {
    const found = [...reach(top)].filter(n => releasing(n).length).toSorted();
    assert.deepEqual(found, ['grouped-merge', subEngineOf(top, 'release')].toSorted(), top);
    assert.ok(!JSON.stringify(engines[top]).includes('merges-awaited'), top);
  }
  // At the top level Release is entered from Review alone, once it is done (and from Blocked, returning a ticket already there).
  for (const top of Object.keys(CURRENT)) {
    const into = engines[top].steps.filter(s => s.id !== 'release' && (s['exit-events'] ?? []).some(e => e['move-to-state'] === 'release')).map(s => s.id);
    assert.deepEqual(into, ['review'], top);
    // Walked with the risk not flagged, the ticket still goes through the whole of Review before Release.
    const trail = walked(top);
    assert.ok(trail.includes('grouped-review/variation-selection') && trail.includes(`${top}/release`), top);
    assert.ok(trail.indexOf('grouped-review/variation-selection') < trail.indexOf(`${top}/release`), top);
  }
});

test('ASS-118 AC1: Explain the Change writes explanation-{variation}.md — what it changes and why, in plain language — and puts it at the top of every Open MR\'s description as a short Summary, leaving each a draft; a rejection\'s reason is answered', () => {
  const text = prompt('explain-the-change');
  const file = text.indexOf('{ticket-folder}/explanation-{variation}.md'), summary = text.indexOf('"## Summary"');
  assert.ok(file > 0 && summary > file, text);
  assert.match(text, /plain language/);
  assert.match(text, /what it changes and why/i);
  assert.ok(text.includes(PLAN), 'reads the merge requests');
  assert.match(text, /every one that is Open/);
  assert.match(text, /replacing any Summary already there/);
  assert.match(text, /Leave every merge request a draft/);
  assert.match(text, /rejection-reason/);
  assert.match(text, /\{where\}/);
  const json = JSON.parse(readFileSync(join(ROOT, 'prompts', 'explain-the-change', 'prompt.json'), 'utf8'));
  assert.deepEqual(json['input-arguments'].map(a => a.name), ['project', 'ticket', 'variation']);
});

test('ASS-118 AC2: the grouped Risk Assessment writes the variation\'s own risk profile, risk-assessment-{variation}.md, its verdict in it; since ASS-181 the current engines\' prompt writes the variation\'s own too', () => {
  const text = prompt('risk-assessment-grouped');
  assert.ok(text.includes('{ticket-folder}/risk-assessment-{variation}.md'), text);
  assert.match(text, /verdict at its top/);
  assert.ok(prompt('risk-assessment').includes('{ticket-folder}/risk-assessment-{variation}.md'));
});

// ASS-219 AC2: after Update Merge Request Details, Check Merge Request Details
// (merge-request:check-details, on the host, on a timer) — passed goes on to
// Add Screenshots; failed back to Update Merge Request Details, which reads
// its report; waiting (a .pre job unfinished) stays. In grouped-document and
// v2-document alike; the flat engines keep no such step.
test('ASS-219 AC2: Check Merge Request Details follows Update Merge Request Details in grouped-document and v2-document — passed on to Add Screenshots, failed back to Update Merge Request Details, waiting stays — and the flat engines have none', () => {
  for (const name of ['grouped-document', 'v2-document']) {
    const engine = engines[name], step = stepOf(engine, 'check-merge-request-details');
    assert.equal(nextState(stepOf(engine, 'update-merge-request-details'), engine, { turnComplete: true }).to, 'check-merge-request-details', name);
    assert.deepEqual(step.action, { type: 'script', command: './agent.sh merge-request:check-details {project} {ticket} {variation}', mode: 'timer', 'timer-minutes': 1 }, name);
    assert.equal(step['run-location'], undefined, `${name}: on the host, where glab is`);
    const at = status => nextState(step, engine, { exitCode: 0, scriptOutput: { status } })?.to;
    assert.deepEqual([at('passed'), at('failed'), at('waiting')], ['add-screenshots-to-merge-request', 'update-merge-request-details', undefined], name);
    assert.equal(nextState(step, engine, { exitCode: 1 })?.to, undefined, `${name}: a forge failure is retried, then blocks (backoff)`);
    const thrice = Array(3).fill({ 'from-state': 'update-merge-request-details', 'to-state': 'check-merge-request-details' });
    assert.equal(nextState(stepOf(engine, 'update-merge-request-details'), engine, { turnComplete: true }, thrice).to, 'blocked', `${name}: a fourth check blocks`);
  }
  // AC1/AC3: the prompt takes the project's title format and accounts for every commit, change-log revision and code-review note.
  const details = prompt('update-merge-request-details-grouped');
  for (const said of ['{ticket-folder}/merge-request-details-check-{variation}.md', 'Title: {merge-request-title}', 'Every commit on its branch', 'each subject verbatim', 'Every revision in {ticket-folder}/change-log-{variation}.md', 'code-review-{variation}.md marks for the merge request description', 'start a new merge request pipeline'])
    assert.ok(details.includes(said), said);
  assert.doesNotMatch(details, /ABC-1234: Fix the search timeout/);
  assert.ok(prompt('code-review-grouped').includes('"## For the merge request description"'));
  for (const flat of Object.values(CURRENT)) assert.ok(!JSON.stringify(engines[flat]).includes('check-details'), flat);
});

// ASS-224: example's Release finished waiting on Jira "In Testing", which only QA sets. Team Code Review now polls
// merge-request:check until every merge request not Closed is Merged, then ends Release; QA sets In Testing itself.
test('ASS-224 AC1/AC4: Team Code Review polls merge-request:check on its timer — no agent — until every merge request is merged, then Release goes on to QA without the ticket system saying In Testing', () => {
  const release = engines['grouped-release-example'], review = stepOf(release, 'team-code-review');
  assert.deepEqual(review.action, { type: 'script', command: './agent.sh merge-request:check {project} {ticket} {variation}', mode: 'timer', 'timer-minutes': 5 });
  const at = (scriptOutput, extra = {}) => nextState(review, release, { exitCode: 0, ticketSystemStatus: 'In Review', scriptOutput, ...extra })?.to;
  assert.equal(at({ 'needs-attention': false, 'auto-merge': true, merged: false }), undefined, 'set to auto-merge, not yet merged: it waits for the next poll');
  assert.equal(at({ 'needs-attention': false, 'auto-merge': false, merged: false }), 'ensure-auto-merge');
  assert.equal(at(MERGED.scriptOutput), 'done');
  assert.equal(nextState(review, release, { exitCode: 1, ticketSystemStatus: 'In Review', scriptOutput: MERGED.scriptOutput })?.to, undefined, 'a failed check is not a merge');
  const merged = review['exit-events'].findIndex(e => e['move-to-state'] === 'done' && !e.condition['ticket-system-status']);
  assert.ok(merged >= 0 && merged < review['exit-events'].findIndex(e => e['move-to-state'] === 'ensure-auto-merge'), 'merged is read ahead of ensure-auto-merge');
  // Walked with only merged: the ticket system never fed In Testing.
  const trail = walk('example-development-grouped', { ...NOT_SET_UP, 'grouped-release-example/team-code-review': MERGED, 'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } });
  assert.deepEqual(trail.slice(trail.indexOf('example-development-grouped/release')), ['example-development-grouped/release', 'grouped-release-example/take-out-of-draft-mode', 'grouped-release-example/team-code-review', 'grouped-release-example/done', 'example-development-grouped/qa', 'grouped-qa/qa-testing', 'grouped-qa/done', 'example-development-grouped/done']);
  assert.equal(stepOf(engines['example-development-grouped'], 'qa')['paired-ticket-system-status'], 'In Testing', 'entering QA sets In Testing');
});

test('ASS-224 AC2: the flat example-development\'s Team Code Review keeps its exits — In Testing on to QA Testing, no merged exit', () => {
  const flat = stepOf(engines['example-development'], 'team-code-review');
  assert.deepEqual(flat['exit-events'].slice(0, 2).map(e => [e.condition, e['move-to-state']]), [[{ 'ticket-system-status': 'In Testing' }, 'qa-testing'], [{ 'ticket-system-status': 'In Progress' }, 'generate-solution']]);
  assert.ok(!JSON.stringify(flat).includes('"merged"'));
});

// ASS-249: CI Checks runs the project's declared merge-request CI checks
// (ci-checks:verify) in the VM between Automated Testing and Code Review: 0
// goes on, 3 (could not run, or the declaration malformed) to Blocked, any
// other (a new failure) back to Generate Solution. grouped-build is shared,
// so a project declaring none passes it with nothing run (the command's own
// tests: test/agent-cli/ci-checks.test.js); the flat engines have no such step.
const CI_CHECKS = './agent.sh ci-checks:verify {project} {ticket} {variation}';

test('ASS-249 AC4: grouped-build\'s CI Checks step — the ci-checks:verify script, in the VM, max-visits 3 then Blocked — sits between Automated Testing and Code Review: 0 to Code Review, 3 to Blocked, any other to Generate Solution; the flat engines have none', () => {
  const build = engines['grouped-build'], step = stepOf(build, 'ci-checks');
  assert.deepEqual([step.action, step['run-location'], step['max-visits'], step['on-max-visits']], [{ type: 'script', command: CI_CHECKS }, 'vm', 3, 'blocked']);
  assert.equal(nextState(stepOf(build, 'automated-testing'), build, { exitCode: 0 }).to, 'ci-checks');
  assert.equal(nextState(step, build, { exitCode: 0 }).to, 'code-review');
  assert.equal(nextState(step, build, { exitCode: 3 }).to, 'blocked');
  for (const exitCode of [1, 2, 4, 127]) assert.equal(nextState(step, build, { exitCode }).to, 'generate-solution', String(exitCode));
  const seq = id => stepOf(build, id).sequence;
  assert.ok(seq('automated-testing') < seq('ci-checks') && seq('ci-checks') < seq('code-review'));
  for (const top of Object.keys(CURRENT)) {
    // A new failure once: back round Generate Solution, then on; always failing: Blocked; could not run: Blocked.
    let runs = 0;
    const released = top.startsWith('example') ? { 'grouped-release-example/team-code-review': MERGED, 'grouped-qa/qa-testing': { ticketSystemStatus: 'Done' } } : {};
    const once = walk(top, { ...released, 'grouped-build/ci-checks': { get exitCode() { return runs++ === 0 ? 1 : 0; } } });
    assert.deepEqual(after(once, 'grouped-build/automated-testing').slice(0, 7), ['grouped-build/ci-checks', 'grouped-build/generate-solution', 'grouped-build/await-dependencies', 'grouped-build/refresh-before-testing', 'grouped-build/automated-testing', 'grouped-build/ci-checks', 'grouped-build/code-review'], top);
    assert.equal(tops(once).at(-1), 'done', top);
    const blocked = walk(top, { 'grouped-build/ci-checks': { exitCode: 3 } });
    assert.deepEqual(blocked.slice(-3), ['grouped-build/ci-checks', 'grouped-build/blocked', `${top}/blocked`], top);
    const red = walk(top, { 'grouped-build/ci-checks': { exitCode: 1 } });
    assert.equal(red.filter(p => p === 'grouped-build/ci-checks').length, 3, top);
    assert.equal(red.at(-1), `${top}/blocked`, top);
  }
  for (const flat of [...Object.values(CURRENT), 'blocked']) assert.ok(!engines[flat].steps.some(s => s.id === 'ci-checks' || JSON.stringify(s.action).includes('ci-checks')), flat);
});

// ASS-255: harness:restarted's "not yet" (exit 1) is Await the Restart's waiting exit — polled again on its timer,
// no failure (steps.js); exit 0 moves on, and any other exit is a failure, as before. v2-release is its copy.
test('ASS-255: grouped-release-harness\'s await-restart waits on exit 1 (the restart pending) — no exit takes it, exit 0 is done; the flat harness-development\'s stays as it was', () => {
  for (const name of ['grouped-release-harness', 'v2-release']) {
    const engine = engines[name], wait = stepOf(engine, 'await-restart');
    assert.equal(wait.action['waiting-exit-code'], 1, name);
    assert.equal(nextState(wait, engine, { exitCode: 1 }, []), null, `${name}: pending stays`);
    assert.equal(nextState(wait, engine, { exitCode: 0 }, []).to, 'done', name);
    assert.equal(nextState(wait, engine, { exitCode: 2 }, []), null, `${name}: an error matches no exit, so it fails where it is`);
    assert.deepEqual(validateStateEngine(engine, ROOT, name, EXAMPLE_ENGINES), [], name);
  }
  assert.equal(stepOf(engines['harness-development'], 'await-restart').action['waiting-exit-code'], undefined, 'the flat harness-development stays as it was');
});

// ASS-335: a merge request depending on one in another repository is tested
// only once that one is merged. grouped-build's Await Sequential Merge
// (ASS-363; was Await Dependencies in Other Repositories) (merge-request:await-dependencies, on the host, a timer) sits
// between Generate Solution and the refresh before Automated Testing: 0 (none
// waits) goes on, 2 (one waits) is its waiting exit — the ticket stays there,
// polled, never sent back to Generate Solution — and an error matches no exit,
// so it is tried again where it is. The command's own tests:
// test/agent-cli/merge-requests.test.js.
const AWAIT_DEPENDENCIES = './agent.sh merge-request:await-dependencies {project} {ticket} {variation}';

test('ASS-335 AC1/AC2: grouped-build waits at Await Sequential Merge before every Automated Testing — waiting (exit 2) stays, never to Generate Solution; none waiting (exit 0) goes on to the refresh and the tests; the flat engines have none', () => {
  const build = engines['grouped-build'], step = stepOf(build, 'await-dependencies');
  assert.deepEqual([step.action, step['run-location'], step['record-script-output']],
    [{ type: 'script', command: AWAIT_DEPENDENCIES, mode: 'timer', 'timer-minutes': 5, 'waiting-exit-code': 2 }, undefined, true]);
  assert.equal(nextState(stepOf(build, 'generate-solution'), build, { turnComplete: true }).to, 'await-dependencies');
  // Every way into Automated Testing passes the gate: only the refresh moves there, and only the gate moves to the refresh.
  const into = id => build.steps.filter(s => (s['exit-events'] ?? []).some(e => e['move-to-state'] === id)).map(s => s.id);
  // ASS-361: Address Merge Request Feedback, reached only from the gate, comes back to it; so does Merge the Awaited (ASS-365).
  assert.deepEqual([into('automated-testing'), into('refresh-before-testing'), into('await-dependencies')], [['refresh-before-testing'], ['await-dependencies'], ['generate-solution', 'address-merge-request-feedback', 'merge-awaited']]);
  // AC1: a dependency in another repository not merged — the tests are not run, and nothing sends the ticket back to Generate Solution.
  assert.equal(nextState(step, build, { exitCode: 2 }, []), null, 'waiting stays');
  assert.equal(nextState(step, build, { exitCode: 1 }, []), null, 'an error matches no exit, so it is tried again where it is');
  // AC2: merged — on to the refresh and Automated Testing.
  assert.equal(nextState(step, build, { exitCode: 0 }, []).to, 'refresh-before-testing');
  const seq = id => stepOf(build, id).sequence;
  assert.ok(seq('generate-solution') < seq('await-dependencies') && seq('await-dependencies') < seq('refresh-before-testing'));
  assert.deepEqual(validateStateEngine(build, ROOT, 'grouped-build', EXAMPLE_ENGINES), []);
  for (const top of Object.keys(CURRENT)) {
    const trail = walk(top, NOT_SET_UP);
    assert.deepEqual(after(trail, 'grouped-build/generate-solution').slice(0, 3), ['grouped-build/await-dependencies', 'grouped-build/refresh-before-testing', 'grouped-build/automated-testing'], top);
  }
  for (const flat of [...Object.values(CURRENT), 'blocked']) assert.ok(!JSON.stringify(engines[flat]).includes('await-dependencies'), flat);
});

// ASS-359 AC3: a dependency that is one of the ticket's own planned merge
// requests, never created, is not waited on: merge-request:await-dependencies
// exits 3, and grouped-build sends that back to Generate Solution — counted
// as a visit there, so at its max-visits (5) the run ends at Blocked instead.
test('ASS-359 AC3: Await Sequential Merge\'s exit 3 (a planned merge request never created) goes back to Generate Solution, within its max-visits, then Blocked; waiting (2) still stays', () => {
  const build = engines['grouped-build'], step = stepOf(build, 'await-dependencies'), solve = stepOf(build, 'generate-solution');
  assert.deepEqual(step['exit-events'].map(e => [e.condition, e['move-to-state']]).slice(0, 2), [[{ 'exit-code': 0 }, 'refresh-before-testing'], [{ 'exit-code': 3 }, 'generate-solution']]);
  assert.equal(step.action['waiting-exit-code'], 2);
  assert.deepEqual([solve['max-visits'], solve['on-max-visits']], [5, 'blocked']);
  const visits = n => Array.from({ length: n }, (_, i) => [
    { 'from-state': i ? 'await-dependencies' : 'generate-automated-tests', 'to-state': 'generate-solution' },
    { 'from-state': 'generate-solution', 'to-state': 'await-dependencies' }]).flat();
  assert.deepEqual(nextState(step, build, { exitCode: 3 }, visits(1)), { to: 'generate-solution', exit: step['exit-events'][1], reason: 'exit' });
  assert.equal(nextState(step, build, { exitCode: 3 }, visits(4)).to, 'generate-solution');
  assert.deepEqual(nextState(step, build, { exitCode: 3 }, visits(5)), { to: 'blocked', exit: step['exit-events'][1], reason: 'max-visits' });
  assert.equal(nextState(step, build, { exitCode: 2 }, visits(5)), null, 'waiting stays, whatever the visits');
  assert.equal(nextState(step, build, { exitCode: 1 }, []), null, 'an error still matches no exit');
  assert.deepEqual(validateStateEngine(build, ROOT, 'grouped-build', EXAMPLE_ENGINES), []);
});

// ASS-361 AC3: a waiting dependency is always the variation's own merge
// request, and one with feedback of its own to act on (open threads, review
// comments, a failed pipeline, a needed rebase) makes
// merge-request:await-dependencies exit 4: grouped-build sends that to its own
// Address Merge Request Feedback (check-on-merge-request-build-grouped, a
// variant of Release's prompt, in the VM), which comes back to Await Sequential Merge once its turn is
// complete, under its own max-visits (3), then Blocked. A draft or an approval
// alone is still 2, waiting.
test('ASS-361 AC3: Await Sequential Merge\'s exit 4 goes to Build\'s own Address Merge Request Feedback, which returns to Await Sequential Merge on turn complete, under its max-visits (3), then Blocked; 2 still waits, 3 still goes to Generate Solution', () => {
  const build = engines['grouped-build'], step = stepOf(build, 'await-dependencies'), address = stepOf(build, 'address-merge-request-feedback');
  // ASS-365: exit 5, after them, to Merge the Awaited — given only where merges-awaited is set (below).
  assert.deepEqual(step['exit-events'].map(e => [e.condition, e['move-to-state']]), [[{ 'exit-code': 0 }, 'refresh-before-testing'], [{ 'exit-code': 3 }, 'generate-solution'], [{ 'exit-code': 4 }, 'address-merge-request-feedback'], [{ 'exit-code': 5 }, 'merge-awaited']]);
  assert.deepEqual([address.name, address.action, address['run-location'], address['max-visits'], address['on-max-visits']],
    ['Address Merge Request Feedback', { type: 'prompt', prompt: 'check-on-merge-request-build-grouped', 'agent-count': 1, 'run-in-dev-container': true }, 'vm', 3, 'blocked']);
  assert.deepEqual(address['exit-events'], [{ condition: { 'turn-complete': true }, 'move-to-state': 'await-dependencies' }]);
  // Only the gate sends a run there.
  assert.deepEqual(build.steps.filter(s => (s['exit-events'] ?? []).some(e => e['move-to-state'] === 'address-merge-request-feedback')).map(s => s.id), ['await-dependencies']);
  const visits = n => Array.from({ length: n }, () => [
    { 'from-state': 'await-dependencies', 'to-state': 'address-merge-request-feedback' },
    { 'from-state': 'address-merge-request-feedback', 'to-state': 'await-dependencies' }]).flat();
  assert.deepEqual(nextState(step, build, { exitCode: 4 }, []), { to: 'address-merge-request-feedback', exit: step['exit-events'][2], reason: 'exit' });
  assert.equal(nextState(step, build, { exitCode: 4 }, visits(2)).to, 'address-merge-request-feedback');
  assert.deepEqual(nextState(step, build, { exitCode: 4 }, visits(3)), { to: 'blocked', exit: step['exit-events'][2], reason: 'max-visits' });
  assert.equal(nextState(address, build, { turnComplete: true }, visits(1)).to, 'await-dependencies');
  assert.equal(nextState(step, build, { exitCode: 2 }, visits(3)), null, 'a draft or an approval alone: waiting stays');
  assert.equal(nextState(step, build, { exitCode: 3 }, []).to, 'generate-solution');
  assert.deepEqual(validateStateEngine(build, ROOT, 'grouped-build', EXAMPLE_ENGINES), []);
});

// ASS-261: the grouped Risk Assessment writes a fixed risk line the ticket
// screen's panel shows; the flat prompt (pinned in
// fixtures/unchanged-engines-and-prompts.json) keeps none.
test('ASS-261 AC2: the grouped Risk Assessment writes **Risk: Low**, **Risk: Medium** or **Risk: High** as the file\'s first line after its title, then the verdict; the flat one does not', () => {
  const text = prompt('risk-assessment-grouped');
  for (const level of ['Low', 'Medium', 'High']) assert.ok(text.includes(`**Risk: ${level}**`), level);
  assert.match(text, /first line after its title/);
  assert.match(text, /verdict/);
  assert.ok(!prompt('risk-assessment').includes('**Risk:'));
});
