// ticket:add-variation (ASS-499) — a sprint ticket built another way: its next
// variation, fresh as ticket:sync makes A, at Committed or a step given, with
// an optional brief its grouped prompts read first; and what then takes it
// like any other variation — ticket:sync's round trip and merge-request scan,
// ticket:select-variation and the engine's has-variations / variation-selected
// exits, and agent:dispatch's ticket-<variation>.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExampleEngines, loadEngines, walk, ROOT } from '../support/engine-walk.js';
import { ticketFacts } from '../../src/control/facts.js';
import { fixture } from './harness-fixture.js';

const run = promisify(execFile);
const AGENT = join(import.meta.dirname, '..', '..', 'agent.sh');
const hs = state => ({ state, 'state-engine': 'example-development-grouped' });

// A as ticket:sync and control left it: at build, a merge request planned and opened, criteria, history.
const variationA = {
  name: 'A', 'ai-feedback-short': 'Building', 'ai-feedback-long': null, 'harness-status': hs('build'),
  build: { branch: null, 'branch-url': null, worktree: null, 'worktree-folder': null }, 'local-testing': {},
  'acceptance-criteria': [{ 'criteria-number': 1, description: 'A wall blocks a whole project' }],
  'merge-request': [{ id: 1, repository: 'https://gitlab.com/g/app', branch: 'change/ABC-1-1', contents: 'all', 'depends-on': [], status: 'Open', key: '!1', url: 'https://gitlab.com/g/app/-/merge_requests/1', 'build-status': 'Running' }],
  'gate-when-leaving-state': [], 'is-paused': false, 'human-review': null, 'ai-variation-feedback': null,
  vm: { name: 'abc-1-a' },
  'state-changes': [{ 'state-engine': 'example-development-grouped', 'from-state': 'plan', 'to-state': 'build', timestamp: '2026-11-17T10:00:00Z', 'agent-dispatch-log': [], 'work-is-done': false }],
};
const fetched = (key, extra = {}) => ({
  key, title: `Title ${key}`, description: `About ${key}`, url: `https://x.atlassian.net/browse/${key}`, 'ticket-system-status': 'In Progress',
  'ticket-system-priority': 'High', 'ticket-system-assignment': 'Ann', points: 3, 'issue-type': 'Story', dependencies: [], overlaps: [], 'sprint-tag': 'Sprint 10', ...extra,
});

// A projects/ folder: project p (the example project's grouped engine, its own) with sprint 10 active, holding
// ABC-1 (A at build, B deleted), ABC-2 (done), ABC-3 (deleted), ABC-4 (its status Done); ABC-9 only in the backlog.
function projects() {
  const dir = mkdtempSync(join(tmpdir(), 'add-variation-'));
  mkdirSync(join(dir, 'p', 'sprints', 'sprint-10'), { recursive: true });
  writeFileSync(join(dir, 'p', 'project.json'), JSON.stringify({ 'execution-state-engine': 'example-development-grouped', 'work-sources': [{ type: 'jira', url: 'https://x' }] }));
  writeFileSync(join(dir, 'p', 'sprints.json'), JSON.stringify({ list: [{ number: 10, 'is-active': true }] }));
  const ticket = (key, variations, extra = {}) => ({ ...fetched(key), priority: 1, 'manual-priority': null, qa: { status: null }, variations, ...extra });
  writeFileSync(join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json'), JSON.stringify({
    number: 10,
    features: [
      ticket('ABC-1', [variationA, { name: 'B', 'is-deleted': true, 'deleted-timestamp': '2026-11-16T00:00:00Z', 'harness-status': hs('plan') }]),
      ticket('ABC-2', [{ name: 'A', 'harness-status': hs('done') }]),
      ticket('ABC-3', [{ name: 'A', 'harness-status': hs('plan') }], { 'is-deleted': true }),
      ticket('ABC-4', [{ name: 'A', 'harness-status': hs('build') }], { 'ticket-system-status': 'Done' }),
    ],
    bugs: [], spikes: [],
  }, null, 4));
  writeFileSync(join(dir, 'p', 'backlog.json'), JSON.stringify({ tickets: [{ ...fetched('ABC-9'), variations: [{ name: 'A', 'harness-status': { state: 'ready', 'state-engine': 'example-backlog-refinement' } }] }] }));
  mkdirSync(join(dir, 'p', 'work', 'ABC-1'), { recursive: true });
  writeFileSync(join(dir, 'p', 'work', 'ABC-1', 'execution-plan-A.md'), 'A: block the whole project\n');
  writeFileSync(join(dir, 'brief.md'), 'A wall blocks team files only.\n');
  withExampleEngines(join(dir, 'p'));
  return dir;
}
const env = dir => ({ ...process.env, PROJECTS_DIR: dir, ACLI_DISABLED: '1' });
const agent = (dir, ...args) => run(AGENT, args, { env: env(dir) });
const add = (dir, ...args) => agent(dir, 'ticket:add-variation', 'p', ...args);
const sprintFile = dir => join(dir, 'p', 'sprints', 'sprint-10', 'sprint.json');
const sprint = dir => JSON.parse(readFileSync(sprintFile(dir), 'utf8'));
const abc1 = dir => sprint(dir).features[0];
const fresh = (name, state) => ({
  name, 'ai-feedback-short': null, 'ai-feedback-long': null, 'harness-status': hs(state),
  build: { branch: null, 'branch-url': null, worktree: null, 'worktree-folder': null }, 'local-testing': {}, 'acceptance-criteria': [], 'merge-request': [],
  'gate-when-leaving-state': [], 'is-paused': false, 'human-review': null, 'ai-variation-feedback': null, 'state-changes': [],
});

test('ASS-499 AC1: ticket:add-variation adds the next unused letter, fresh as sync\'s A, at Committed, and prints { key, variation, state }; a deleted name is skipped', async () => {
  const dir = projects();
  const { stdout } = await add(dir, 'abc-1');
  assert.deepEqual(JSON.parse(stdout), { key: 'ABC-1', variation: 'C', state: 'committed' });   // B was deleted: never reused
  const [a, b, c] = abc1(dir).variations;
  assert.deepEqual(a, variationA);
  assert.equal(b['is-deleted'], true);
  assert.deepEqual(c, fresh('C', 'committed'));
  const again = await add(dir, 'ABC-1', '--at', 'plan');
  assert.deepEqual(JSON.parse(again.stdout), { key: 'ABC-1', variation: 'D', state: 'plan' });
  assert.deepEqual(abc1(dir).variations[3], fresh('D', 'plan'));
  assert.equal(existsSync(join(dir, 'p', 'work', 'ABC-1', 'variation-brief-C.md')), false);   // no --brief, no brief
});

test('ASS-499 AC1: ticket:add-variation fails, writing nothing, for an unknown or backlog-only ticket, a done or deleted ticket, an unknown state, a missing or empty brief, or bad arguments', async () => {
  const dir = projects();
  const before = readFileSync(sprintFile(dir), 'utf8');
  writeFileSync(join(dir, 'empty.md'), '');
  const brief = join(dir, 'brief.md');
  await assert.rejects(add(dir, 'ABC-7', '--brief', brief), /no ABC-7 in p's active sprint/);
  await assert.rejects(add(dir, 'ABC-9', '--brief', brief), /ABC-9 is in p's backlog, not its active sprint/);
  await assert.rejects(add(dir, 'ABC-2', '--brief', brief), /ABC-2 is done/);
  await assert.rejects(add(dir, 'ABC-4', '--brief', brief), /ABC-4 is done/);
  await assert.rejects(add(dir, 'ABC-3', '--brief', brief), /ABC-3 is deleted/);
  await assert.rejects(add(dir, 'ABC-1', '--brief', brief, '--at', 'Plan'), /has no step Plan did you mean plan/);
  await assert.rejects(add(dir, 'ABC-1', '--at', 'nowhere'), /has no step nowhere/);
  await assert.rejects(add(dir, 'ABC-1', '--brief', join(dir, 'missing.md')), /no brief file/);
  await assert.rejects(add(dir, 'ABC-1', '--brief', join(dir, 'empty.md')), /is empty/);
  await assert.rejects(add(dir, 'ABC-1', '--at'), /usage/);
  await assert.rejects(add(dir, 'ABC-1', 'B'), /usage/);
  await assert.rejects(agent(dir, 'ticket:add-variation', 'p'), /usage/);
  assert.equal(readFileSync(sprintFile(dir), 'utf8'), before);
  for (const key of ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-7', 'ABC-9']) {
    const folder = join(dir, 'p', 'work', key);
    assert.deepEqual(existsSync(folder) ? readdirSync(folder).filter(f => f.startsWith('variation-brief')) : [], [], key);
  }
});

test('ASS-499 AC2/AC3: --brief writes work/<KEY>/variation-brief-<variation>.md, the operator\'s alone; A\'s state, merge requests, VM and files are untouched', async () => {
  const dir = projects();
  const folder = join(dir, 'p', 'work', 'ABC-1');
  const { stdout } = await add(dir, 'ABC-1', '--brief', join(dir, 'brief.md'));
  assert.equal(JSON.parse(stdout).variation, 'C');
  assert.equal(readFileSync(join(folder, 'variation-brief-C.md'), 'utf8'), 'A wall blocks team files only.\n');
  assert.deepEqual(abc1(dir).variations[0], variationA);
  assert.equal(readFileSync(join(folder, 'execution-plan-A.md'), 'utf8'), 'A: block the whole project\n');
  // An agent cannot write a brief, its own or another's (work.bash WORK_MANAGED).
  await assert.rejects(run(AGENT, ['work:write', 'p', 'ABC-1', 'C', 'variation-brief.md', join(dir, 'brief.md')], { env: env(dir) }), /harness's own/);
  await assert.rejects(run(AGENT, ['work:write', 'p', 'ABC-1', 'C', 'ticket.json', join(dir, 'brief.md')], { env: env(dir) }), /harness's own/);
});

// The grouped development prompts that read the ticket's questions and answers, and Requirements Changed's.
const BRIEFED = ['enrich-ac-grouped', 'root-cause-analysis-grouped', 'review-root-cause-analysis-grouped', 'write-execution-plan-grouped', 'write-test-plan-grouped', 'review-plan-grouped',
  'generate-solution-grouped', 'generate-automated-tests-grouped', 'code-review-grouped', 'security-review-grouped', 'test-grouped', 'judge-requirements-change', 'revise-acceptance-criteria'];
const prompt = name => readFileSync(join(ROOT, 'prompts', name, 'prompt.txt'), 'utf8');

test('ASS-499 AC3: every grouped development prompt reading the questions and answers reads its variation\'s brief first, the brief winning over the answers and description for that variation only', () => {
  const grouped = readdirSync(join(ROOT, 'prompts')).filter(p => p.endsWith('-grouped') && prompt(p).includes('questions-and-answers.json'));
  for (const name of grouped) assert.ok(BRIEFED.includes(name), `${name} reads the questions and answers but not the brief`);
  for (const name of BRIEFED) {
    const text = prompt(name);
    const [first, , brief] = text.split('\n');
    assert.ok(first.length > 0, name);
    assert.match(brief, /^Variation \{variation\}'s brief: if \{ticket-folder\}\/variation-brief-\{variation\}\.md exists, read it before anything else/, name);   // first, right after the task
    assert.match(brief, /Where it conflicts with the ticket's answered questions \(\{ticket-folder\}\/questions-and-answers\.json\) or its description, the brief wins, for variation \{variation\} only\./, name);
    assert.match(brief, /No brief: go by the ticket and its answers as they are\./, name);
  }
  assert.doesNotMatch(prompt('generate-solution'), /variation-brief/);   // the flat engines' prompts are unchanged
});

test('ASS-499: a variation\'s own criteria and rejection reason are read from ticket-{variation}.json, and the dispatch prompts say another variation\'s files are not the agent\'s', () => {
  assert.match(prompt('revise-acceptance-criteria'), /the variation's acceptance-criteria in \{ticket-folder\}\/ticket-\{variation\}\.json/);
  assert.match(prompt('judge-requirements-change'), /the variation's acceptance-criteria in \{ticket-folder\}\/ticket-\{variation\}\.json/);
  assert.match(prompt('explain-the-change'), /If the variation in ticket-\{variation\}\.json has a "rejection-reason"/);
  for (const name of ['receive-dispatch', 'receive-dispatch-grouped', 'receive-pair-dispatch', 'receive-pair-dispatch-grouped']) {
    assert.match(prompt(name), /ticket-\{variation\}\.json is the same with your variation, while ticket\.json holds whichever variation was dispatched last/, name);
    assert.match(prompt(name), /files named for another variation \(-<variation>\) are that variation's work, not yours/, name);
  }
});

test('ASS-499: agent:dispatch writes the ticket with the agent\'s variation to ticket-<variation>.json too, which another variation\'s dispatch leaves alone', async () => {
  const f = fixture();
  const folder = join(f.dir, 'projects', 'p', 'work', 'ABC-3');
  await f.agent('agent:dispatch', 'Daredevil');                                    // variation A
  const data = JSON.parse(readFileSync(join(f.dir, 'assignments.json'), 'utf8'));
  Object.assign(data.assignments.find(a => a['agent-name'] === 'Spock'), { variation: 'B' });
  writeFileSync(join(f.dir, 'assignments.json'), JSON.stringify(data, null, 4));
  await f.agent('agent:dispatch', 'Spock');                                         // variation B, last
  const read = name => JSON.parse(readFileSync(join(folder, name), 'utf8'));
  assert.equal(read('ticket.json').variation.name, 'B');
  assert.equal(read('ticket-A.json').variation.name, 'A');
  assert.equal(read('ticket-B.json').variation.name, 'B');
  assert.equal(read('ticket-A.json').variation['harness-status'].state, 'generate-solution');
});

test('ASS-499 AC5: ticket:sync keeps an added variation through later syncs, filing a merge request on its branch (change/<KEY>.<variation>-<id>) on it, and A\'s on A', async () => {
  const dir = projects();
  await add(dir, 'ABC-1', '--brief', join(dir, 'brief.md'));
  const scanned = (iid, branch) => ({ key: `!${iid}`, 'build-status': 'Running', url: `https://gitlab.com/g/app/-/merge_requests/${iid}`, status: 'Open', branch, ticket: 'ABC-1' });
  const payload = mrs => { const file = join(dir, `fetched-${mrs.length}.json`); writeFileSync(file, JSON.stringify({ tickets: [fetched('ABC-1')], 'merge-requests': mrs })); return file; };
  await agent(dir, 'ticket:sync', 'p', 'sprint', payload([]));
  assert.deepEqual(abc1(dir).variations.map(v => v.name), ['A', 'B', 'C']);
  assert.deepEqual(abc1(dir).variations[2], fresh('C', 'committed'));
  await agent(dir, 'ticket:sync', 'p', 'sprint', payload([scanned(5, 'change/ABC-1.C-1'), scanned(6, 'change/ABC-1-2'), scanned(7, 'change/abc-1.c-fix-1')]));
  const [a, , c] = abc1(dir).variations;
  assert.deepEqual(c['merge-request'].map(m => m.key), ['!5', '!7']);
  assert.deepEqual(a['merge-request'].map(m => m.key), ['!1', '!6']);
  assert.deepEqual({ ...a, 'merge-request': undefined }, { ...variationA, 'merge-request': undefined });
  assert.deepEqual({ ...c, 'merge-request': undefined }, { ...fresh('C', 'committed'), 'merge-request': undefined });
});

test('ASS-499 AC4: a ticket with an added variation rests at grouped-review\'s Variation Selection (has-variations), and ticket:select-variation picks either one, which then passes it', async () => {
  const engines = loadEngines();   // engines/'s and the example project's own
  const facts = (dir, name) => { const t = abc1(dir), v = t.variations.find(x => x.name === name); return ticketFacts(null, { id: 'p' }, t, v, 0); };
  // At the human step inside the Review run: <state> the detailed step, no <to-state> (control moves the run).
  const pick = (dir, chosen) => agent(dir, 'ticket:select-variation', 'p', 'ABC-1', 'A', 'variation-selection', chosen, '');
  for (const chosen of ['A', 'C']) {
    const dir = projects();
    await add(dir, 'ABC-1', '--at', 'review');
    // A at Review too, its sub-status at Variation Selection, as control leaves it there.
    const data = sprint(dir);
    for (const v of data.features[0].variations.filter(x => !x['is-deleted'])) v['harness-status'] = { ...hs('review'), 'sub-status': { state: 'variation-selection', 'state-engine': 'grouped-review' } };
    writeFileSync(sprintFile(dir), JSON.stringify(data, null, 4));
    for (const name of ['A', 'C']) {
      const { variationCount, selectedVariation } = facts(dir, name);
      assert.equal(variationCount, 2);
      const { trail, end, rests } = walk(engines, 'example-development-grouped', { from: 'review', given: { variationCount, selectedVariation } });
      assert.deepEqual([end, rests, trail.at(-1)], ['variation-selection', true, 'grouped-review/variation-selection'], `${name} waits for the operator`);
    }
    await pick(dir, chosen);
    const t = abc1(dir);
    assert.deepEqual(t.variations.filter(v => !v['is-deleted']).map(v => v.name), [chosen]);
    const { variationCount, selectedVariation } = facts(dir, chosen);
    assert.deepEqual([variationCount, selectedVariation.name], [1, chosen]);
    const { trail } = walk(engines, 'example-development-grouped', { from: 'review', given: { variationCount, selectedVariation } });
    assert.ok(trail.includes('grouped-review/variation-selection') && trail.indexOf('grouped-review/variation-selection') < trail.length - 1, `${chosen}: past Variation Selection: ${trail.join(' ')}`);
  }
});
