// ASS-556: a ticket variation's work mode in control. AC1: Choose Where to Work and Record Where to Work exist in the
// shipped grouped and v2 plans after Review Plan, validated, `stack` validated. AC2: the project's forced rules
// override the AI (decideWorkMode, forcedRules, globs). AC3: in worktree mode the build steps run on the project's
// worktree targets and a `stack: required` step is skipped — no seat, no agent, passed and recorded as skipped, not
// failed — at the top level and in a run; in full mode, or with none recorded, nothing changes. AC4: a change of mode
// (an escalation) is logged by control once. AC6: the metrics by mode (the flow screen's), and the ticket screen's
// Details; AC5's key (w) asks for ticket:set-work-mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { runSteps } from '../../src/control/steps.js';
import { planFor, planDispatch, slotKind } from '../../src/control/plan.js';
import { projectRunTargets, candidates } from '../../src/control/run-targets.js';
import { decideWorkMode, forcedRules, globMatches, planFiles, projectWorkModeErrors, stepWorkModeErrors, workModeOf, skipsForStack, workModeNews, worktreeCapable } from '../../src/control/work-mode.js';
import { validateStateEngine } from '../../src/workflow/validate.js';
import { readEngine, engineFileIn } from '../../src/workflow/engine-file.js';
import { workModeMetrics, workModeLines } from '../../src/tui/metrics.js';
import { workModeFields } from '../../src/tui/ticket.js';
import { workModeChoice } from '../../src/tui/screens/ticket.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };
const to = (target, condition = { 'turn-complete': true }) => ({ condition, 'move-to-state': target });
const prompt = (id, extra = {}) => ({ id, sequence: 2, name: id, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [to('done')], ...extra });
const engineOf = (...steps) => ({ steps: [{ id: 'committed', sequence: 1, 'is-planning-stage': true, action: { type: 'none' } }, ...steps, { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } }] });
const json = d => ({ name: 'p', 'dev-environments': d });
const MAC = json({ 'run-targets': ['local-substrate', 'local-worktree'], substrate: { clusters: [{ machine: 'mac' }] } });
const ws = { id: 'ws-1', 'gcp-project': 'g', region: 'r', cluster: 'c', config: 'k' };
const REMOTE = json({ 'run-targets': ['workstation-substrate', 'workstation-worktree', 'local-worktree'], workstations: [ws], substrate: { clusters: [{ machine: 'ws-1' }] } });
const worktree = { 'work-mode': { mode: 'worktree', by: 'ai', reasons: ['small'], history: [{ mode: 'worktree', by: 'ai', at: '2026-11-23T10:00:00Z' }] } };
const full = { 'work-mode': { mode: 'full', by: 'ai', reasons: ['risky'], history: [{ mode: 'full', by: 'ai', at: '2026-11-23T10:00:00Z' }] } };

test('ASS-556 AC1: the shipped grouped and v2 plans run Choose Where to Work after Review Plan approves, then Record Where to Work (ticket:choose-work-mode on the host), then done; validated', () => {
  for (const name of ['grouped-plan', 'v2-plan']) {
    const e = readEngine(engineFileIn(join(ROOT, 'engines'), name));
    const step = id => e.steps.find(s => s.id === id);
    const approved = step('review-plan')['exit-events'].find(x => JSON.stringify(x.condition).includes('"is-approved":true'));
    assert.equal(approved['move-to-state'], 'choose-work-mode', name);
    const choose = step('choose-work-mode');
    assert.deepEqual([choose.action.type, choose.action.prompt, choose.worktree, choose['is-planning-stage']], ['prompt', 'choose-work-mode-grouped', true, true], name);
    assert.equal(choose['exit-events'][0]['move-to-state'], 'record-work-mode');
    const record = step('record-work-mode');
    assert.equal(record.action.command, './agent.sh ticket:choose-work-mode {project} {ticket} {variation} {run}');
    assert.deepEqual(record['exit-events'].map(x => x['move-to-state']), ['done', 'blocked']);
    assert.ok(step('done').sequence > record.sequence && record.sequence > choose.sequence && choose.sequence > step('review-plan').sequence);
  }
  // The prompt asks for the inputs the ticket names and answers the fields Record Where to Work reads.
  const text = readFileSync(join(ROOT, 'prompts', 'choose-work-mode-grouped', 'prompt.txt'), 'utf8');
  for (const input of [/points/, /files and roughly how many lines/, /migrations/, /authentication/, /billing/, /infrastructure/, /security-sensitive/, /run without the stack/, /Contracts/, /recall from the project's memory/, /CI/]) assert.match(text, input);
  const schema = JSON.parse(readFileSync(join(ROOT, 'prompts', 'choose-work-mode-grouped', 'prompt.json'), 'utf8')).output;
  assert.deepEqual(schema.properties['work-mode'].enum, ['worktree', 'full']);
  assert.deepEqual(schema.required, ['work-mode', 'work-mode-reasons']);
});

test('ASS-556 AC1, AC3: `stack` is validated — required only, never on a worktree step — and the shipped local testing flags its screenshots', () => {
  const errorsOf = step => validateStateEngine(engineOf(step), ROOT, 'e').filter(e => /stack/.test(e));
  assert.deepEqual(errorsOf(prompt('shots', { stack: 'required' })), []);
  assert.deepEqual(errorsOf(prompt('shots', { stack: 'yes' })), ['engines/e/workflow.yaml: step "shots" stack "yes" is not one of required']);
  assert.deepEqual(errorsOf(prompt('shots', { stack: 'required', worktree: true })), ['engines/e/workflow.yaml: step "shots" stack: required is set on a worktree step (worktree: true), which never has the running stack']);
  assert.deepEqual(stepWorkModeErrors({}), []);
  for (const name of ['grouped-local-testing', 'v2-local-testing']) {
    const e = readEngine(engineFileIn(join(ROOT, 'engines'), name));
    assert.deepEqual(e.steps.filter(s => s.stack === 'required').map(s => s.id), ['take-screenshots'], name);
  }
});

test('ASS-556 AC2: forced rules — path globs over the files the plan touches, a points floor — override the AI; force beats the AI, a full-forcing rule beats force; config errors named', () => {
  assert.ok(globMatches('db/migrations/**', 'db/migrations/2026/0001.sql'));
  assert.ok(globMatches('**/*.tf', 'main.tf') && globMatches('**/*.tf', 'infra/a/b.tf'));
  assert.ok(globMatches('src/auth/*', './src/auth/login.js'));
  assert.ok(!globMatches('src/auth/*', 'src/auth/deep/login.js'));
  assert.ok(!globMatches('src/?.js', 'src/ab.js'));
  assert.deepEqual(planFiles('Edit `src/a.js`, test/a.test.js and README.md (see https://x.y/z); ABC-3\'s plan-review-A.md; v1.2.3.'), ['src/a.js', 'test/a.test.js', 'README.md']);
  const rules = { 'work-mode': { 'force-full': [{ paths: ['src/billing/**'], why: 'billing' }, { 'min-points': 5 }], force: 'worktree' } };
  const project = { ...MAC, ...rules };
  const ai = { mode: 'worktree', reasons: ['tiny'] };
  assert.deepEqual(forcedRules(project, { files: ['src/billing/x.js'], points: 1 }), ['billing (src/billing/x.js matches src/billing/**)']);
  assert.deepEqual(decideWorkMode({ ai, files: ['src/billing/x.js'], points: 1, json: project }), { mode: 'full', by: 'rule', reasons: ['billing (src/billing/x.js matches src/billing/**)'], forced: ['billing (src/billing/x.js matches src/billing/**)'] });
  assert.equal(decideWorkMode({ ai, files: [], points: 5, json: project }).mode, 'full');
  assert.deepEqual(decideWorkMode({ ai: { mode: 'full', reasons: ['risky'] }, files: ['src/a.js'], points: 2, json: project }).by, 'rule', 'force: worktree beats the AI');
  assert.deepEqual(decideWorkMode({ ai, files: ['src/a.js'], points: 2, json: MAC }), { mode: 'worktree', by: 'ai', reasons: ['tiny'], forced: [] });
  // A project that can build in no worktree: full whatever the AI says; one still on its mode too.
  assert.equal(worktreeCapable(MAC), true);
  assert.equal(worktreeCapable(json({ mode: 'vm' })), false);
  assert.equal(decideWorkMode({ ai, json: json({ 'run-targets': ['local-vm'] }) }).mode, 'full');
  // Config errors, each naming the field.
  assert.deepEqual(projectWorkModeErrors({}), []);
  assert.deepEqual(projectWorkModeErrors({ 'work-mode': { force: 'half', 'force-full': [{ paths: [] }, { 'min-points': -1, why: 3 }, 'x', {}] } }), [
    'work-mode.force "half" is not one of worktree, full', 'work-mode.force-full[0].paths is not a list of globs', 'work-mode.force-full[1].min-points is not a positive number',
    'work-mode.force-full[1].why is not text', 'work-mode.force-full[2] is not an object', 'work-mode.force-full[3] has neither paths nor min-points']);
});

test('ASS-556 AC3: in worktree mode the build steps run on the project\'s worktree targets (remote first by pool); full mode, or none recorded, keeps ASS-554\'s placement', () => {
  const build = prompt('generate-solution'), review = prompt('code-review', { worktree: true }), shots = prompt('take-screenshots', { stack: 'required' });
  const mac = projectRunTargets(MAC), remote = projectRunTargets(REMOTE);
  assert.deepEqual(candidates(build, mac, 'progress', 'worktree'), ['local-worktree']);
  assert.deepEqual(candidates(build, mac, 'progress', 'full'), ['local-substrate']);
  assert.deepEqual(candidates(build, mac, 'progress', null), ['local-substrate']);
  assert.deepEqual(candidates(review, mac, 'progress', 'full'), ['local-worktree'], 'a worktree step stays on worktrees in full mode');
  assert.deepEqual(candidates(shots, mac, 'progress', 'worktree'), ['local-substrate'], 'a stack step keeps its machine (it is skipped, never placed)');
  assert.deepEqual(candidates(build, remote, 'progress', 'worktree'), ['workstation-worktree', 'local-worktree']);
  assert.deepEqual(candidates(build, projectRunTargets(json({ 'run-targets': ['local-substrate'], substrate: { clusters: [{ machine: 'mac' }] } })), 'progress', 'worktree'), ['local-substrate'], 'no worktree target: unchanged');
  assert.deepEqual(candidates(build, projectRunTargets(json({ mode: 'vm' })), 'progress', 'worktree'), ['local-vm'], 'a derived project: unchanged');

  // The planner: two tickets at Build, one built in a worktree, one full, one sandbox seat: each where its mode says.
  const flow = engineOf(build);
  const at = (key, extra) => ({ key, variations: [{ name: 'A', 'harness-status': { state: 'generate-solution', 'state-engine': 'e' }, ...extra }] });
  const p = planDispatch({ ranked: [at('T-1', worktree), at('T-2', full), at('T-3', {})], engine: flow, harness: {}, seats: { mac: 2, remote: 0, byKind: { workstation: 0, 'cloud-vm': 0 } }, runTargets: mac });
  assert.deepEqual(p.targets.map(t => [t.key, t.target]), [['T-1', 'local-worktree'], ['T-2', 'local-substrate'], ['T-3', 'local-substrate']]);
  // On the remote machines: the worktree ticket goes remote first.
  const headroom = t => ({ room: t === 'workstation-worktree' ? 1 : 5, ...(t === 'workstation-worktree' ? { machine: 'ws-1' } : {}) });
  const q = planDispatch({ ranked: [at('T-1', worktree)], engine: flow, harness: {}, seats: { mac: 1, remote: 1, byKind: { workstation: 1, 'cloud-vm': 0 } }, runTargets: remote, headroom });
  assert.deepEqual(q.targets.map(t => [t.target, t.choice]), [['workstation-worktree', 'remote-first']]);
});

test('ASS-556 AC3: a stack step in worktree mode takes no seat and gets no agent; in full mode it does', () => {
  const shots = prompt('take-screenshots', { stack: 'required' });
  const flow = engineOf(shots);
  const v = extra => ({ name: 'A', 'harness-status': { state: 'take-screenshots', 'state-engine': 'e' }, ...extra });
  assert.equal(skipsForStack(shots, v(worktree)), true);
  assert.equal(skipsForStack(shots, v(full)), false);
  assert.equal(slotKind(shots, undefined, v(worktree)), null);
  assert.equal(slotKind(shots, undefined, v(full)), 'progress');
  const dispatched = extra => planDispatch({ ranked: [{ key: 'T-1', variations: [v(extra)] }], engine: flow, harness: {}, seats: { mac: 1, remote: 0 }, runTargets: projectRunTargets(MAC) }).dispatch.length;
  assert.equal(dispatched(worktree), 0);
  assert.equal(dispatched(full), 1);
  assert.equal(workModeOf(v({})), null);
});

// A control fixture: start → shots (a top-level stack step) → testing (local testing's run: test → screenshots, a stack
// step → end) → done; T-1 A at start in `mode`.
function stackFixture(extra) {
  const f = controlFixture();
  f.seats(Infinity);
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => { e.steps = [
    { id: 'start', sequence: 1, action: { type: 'none' }, 'exit-events': [to('shots', { always: true })] },
    { id: 'shots', sequence: 2, stack: 'required', 'run-location': 'vm', action: { type: 'prompt', prompt: 'test' }, 'exit-events': [to('testing')] },
    { id: 'testing', sequence: 3, action: { type: 'state-engine', engine: 'local' }, 'exit-events': [to('done', { 'is-done': true })] },
    { id: 'done', sequence: 4, 'is-done': true, action: { type: 'none' } },
  ]; });
  mkdirSync(join(f.dir, 'engines', 'local'));
  writeFileSync(join(f.dir, 'engines', 'local', 'workflow.yaml'), JSON.stringify({ steps: [
    { id: 'begin', sequence: 1, action: { type: 'none' }, 'exit-events': [to('screenshots', { always: true })] },
    { id: 'screenshots', sequence: 2, stack: 'required', 'run-location': 'vm', action: { type: 'prompt', prompt: 'test' }, 'exit-events': [to('end')] },
    { id: 'end', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] }));
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features = [{ key: 'T-1', variations: [{ name: 'A', 'harness-status': hs('start'), 'state-changes': [], ...extra }] }];
  });
  return { ...f, v: () => f.sprint().features[0].variations[0] };
}

test('ASS-556 AC3: in worktree mode a stack step is passed at the top level and inside a run, each recorded as skipped (not failed) and logged; the change of mode logged once', async () => {
  const f = stackFixture(worktree);
  for (let i = 0; i < 4; i++) await runSteps(f.ctx, f.ctx.load());
  assert.equal(f.v()['harness-status'].state, 'done');
  const changes = f.v()['state-changes'];
  assert.deepEqual(changes.filter(c => !c['sub-state-change']).map(c => [c['from-state'], c['to-state'], c.cause ?? null, c.reason ?? null]),
    [['start', 'shots', null, null], ['shots', 'testing', 'skipped', 'needs the running stack; built in a worktree'], ['testing', 'done', null, null]]);
  assert.deepEqual(changes.filter(c => c['sub-state-change'] && c['sub-state-change']['from-state'] === 'screenshots').map(c => [c.cause, c.reason]), [['skipped', 'needs the running stack; built in a worktree']]);
  assert.deepEqual(f.lines.filter(l => /running stack/.test(l)), [
    'steps T-1 A shots: needs the running stack, built in a worktree: skipped (→ testing)',
    'steps T-1 A local/screenshots: needs the running stack, built in a worktree: skipped (→ end)',
  ]);
  assert.equal(f.lines.filter(l => /work mode worktree \(by ai\)/.test(l)).length, 1, f.lines.join('\n'));
  assert.deepEqual(f.assignments().assignments, [], 'no agent');
});

test('ASS-556 AC3: in full mode, or none recorded, a stack step runs as before — its agent planned, nothing skipped', async () => {
  for (const extra of [full, {}]) {
    const f = stackFixture(extra);
    await runSteps(f.ctx, f.ctx.load());
    assert.equal(f.v()['harness-status'].state, 'shots');
    const state = f.ctx.load();
    assert.deepEqual(planFor(state, state.projects[0]).dispatch.map(d => d.state), ['shots']);
    assert.ok(!f.lines.some(l => /running stack/.test(l)));
  }
});

test('ASS-556 AC4: control logs each change of work mode once — an escalation with its trigger', () => {
  const v = { 'work-mode': { ...worktree['work-mode'], mode: 'full', by: 'escalation', history: [...worktree['work-mode'].history, { mode: 'full', by: 'escalation', reasons: ['ci: needs the queue'], trigger: 'ci', at: '2026-11-23T11:00:00Z' }] } };
  assert.deepEqual(workModeNews(v), { key: '2026-11-23T11:00:00Z/2', text: 'escalated to full (ci): ci: needs the queue' });
  assert.equal(workModeNews({}), null);
});

test('ASS-556 AC6: the metrics by mode — tickets, escalations by trigger, CI pass rate, rounds per merge, time to merge — and the ticket screen\'s Details', () => {
  const ci = (result, mr, at, mode = 'worktree') => ({ mr, key: `!${mr}`, head: `h${at}`, result, at, mode });
  const variations = [
    { 'work-mode': { mode: 'worktree', by: 'ai', history: [{ at: '2026-11-23T10:00:00Z' }] }, 'ci-results': [ci('passed', 1, '2026-11-23T12:00:00Z')] },
    { 'work-mode': { mode: 'worktree', by: 'ai', history: [{ at: '2026-11-23T10:00:00Z' }] }, 'ci-results': [ci('failed', 1, '2026-11-23T11:00:00Z'), ci('passed', 1, '2026-11-23T14:00:00Z')] },
    { 'work-mode': { mode: 'full', by: 'escalation', escalations: [{ trigger: 'ci', why: 'e2e' }], history: [{ at: '2026-11-23T10:00:00Z' }] }, 'ci-results': [ci('failed', 1, '2026-11-23T11:00:00Z'), ci('passed', 1, '2026-11-23T13:00:00Z', 'full')] },
    { 'work-mode': { mode: 'full', by: 'rule', history: [{ at: '2026-11-23T10:00:00Z' }] } },
    { name: 'none chosen' },
  ];
  const m = workModeMetrics(variations);
  assert.deepEqual(m.worktree, { tickets: 2, escalated: {}, ciRuns: 3, ciPassRate: 2 / 3, rounds: 1.5, time: 3 * 3600_000 });
  assert.deepEqual(m.escalated, { tickets: 1, escalated: { ci: 1 }, ciRuns: 2, ciPassRate: 0.5, rounds: 2, time: 3 * 3600_000 });
  assert.deepEqual(m.full, { tickets: 1, escalated: {}, ciRuns: 0, ciPassRate: null, rounds: null, time: null });
  const lines = workModeLines(m);
  assert.match(lines[0], /By work mode/);
  assert.deepEqual(lines.slice(1), [
    '  worktree    2 · CI 67% of 3 · 1.5 rounds · 3h 0m',
    '  escalated   1 · CI 50% of 2 · 2 rounds · 3h 0m · escalated: ci 1',
    '  full        1 · CI — of 0 · — rounds · —',
  ]);
  assert.deepEqual(workModeLines(workModeMetrics([{}])), []);
  // The ticket screen: the mode, who and why, the AI's own choice when overridden, each escalation, the CI on its MRs.
  assert.deepEqual(workModeFields(variations[2]), [
    ['Work mode', 'full, escalated'], ['Escalated', 'ci: e2e'], ['CI on MR', '1 failed, 1 passed — 2 rounds, last in full mode']]);
  assert.deepEqual(workModeFields({ 'work-mode': { mode: 'full', by: 'rule', reasons: ['billing'], ai: { mode: 'worktree' } } }), [['Work mode', 'full, forced by a project rule (the AI chose worktree): billing']]);
  assert.deepEqual(workModeFields({}), []);
});

test('ASS-556 AC5: the ticket screen offers building the other way, asking first: ticket:set-work-mode to full from a worktree, else to worktree', () => {
  const state = { projects: [{ id: 'p' }], project: 0, ticket: { key: 'T-1', variation: 'A' } };
  const t = extra => ({ key: 'T-1', shownKey: 'T-1', variation: { name: 'A', ...extra } });
  assert.deepEqual(workModeChoice(state, t(worktree)), [{ decision: 'Build on a full machine', confirm: 'Build T-1 A on a full machine?', decide: ['ticket:set-work-mode', 'p', 'T-1', 'A', 'full'] }]);
  assert.deepEqual(workModeChoice(state, t(full))[0].decide, ['ticket:set-work-mode', 'p', 'T-1', 'A', 'worktree']);
  assert.deepEqual(workModeChoice({ ...state, ticket: { ...state.ticket, backlog: true } }, t({})), []);
});
