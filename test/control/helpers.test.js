// The pure helpers the tick's phases decide with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { turnComplete, costArgs, usageArgs, spentSoFar } from '../../src/control/finish.js';
import { scriptDue, agentNeedsWork } from '../../src/control/steps.js';
import { timerDue } from '../../src/control/triggers.js';
import { statusSeconds, nagDue } from '../../src/control/supervise.js';
import { outputSchema, agentFolder, containerPath } from '../../src/control/dispatch.js';
import { firstStepId, levelChanges, contextOf, isPaused, found } from '../../src/control/moves.js';
import { runValues, parseOutput, ticketFacts, problemOf, ticketOf, blockHistory, cameFrom } from '../../src/control/facts.js';
import { isHarnessProject } from '../../src/control/harness-project.js';

const memory = () => ({ lastRun: new Map(), ran: new Set(), timers: new Map(), nagged: new Map(), warned: new Set() });
const record = (name, rest = {}) => ({ 'agent-name': name, 'pen-holder': 'Daredevil', approvals: {}, ...rest });

test('turnComplete: the pen-holder\'s turn ended and every paired agent approved (decision 11)', () => {
  const pen = record('Daredevil', { approvals: { Spock: '2026-10-10T00:00:00Z' } });
  assert.equal(turnComplete([pen], pen), true);
  assert.equal(turnComplete([pen, record('Spock')], pen), true);
  assert.equal(turnComplete([pen, record('Spock'), record('Hulk')], pen), false);
  assert.equal(turnComplete([record('Daredevil', { approvals: {} }), record('Spock')], record('Daredevil', { approvals: {} })), false);
});

test('costArgs: the cost and tokens of a live agent\'s turns as assignments:remove takes them; none before a turn ended', () => {
  const live = { result: { type: 'result' }, cost: 0.1 + 0.2, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } };
  assert.deepEqual(costArgs(live), ['0.300000', '10', '20', '30', '40']);
  assert.deepEqual(costArgs({ ...live, cost: 1e-7 }), ['0.000000', '10', '20', '30', '40']);   // never 1e-7, which the command rejects
  assert.deepEqual(costArgs({ ...live, result: null }), []);
});

test('ASS-216 AC1: costArgs says what the dispatch was billed to, and a subscription\'s turns cost 0; a session that never said, its cost as today', () => {
  const live = { result: { type: 'result' }, cost: 0.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } };
  assert.deepEqual(costArgs({ ...live, agent: { billing: 'subscription' } }), ['0.000000', '10', '20', '30', '40', '--billing', 'subscription']);
  assert.deepEqual(costArgs({ ...live, agent: { billing: 'api' } }), ['0.500000', '10', '20', '30', '40', '--billing', 'api']);
  assert.deepEqual(costArgs({ ...live, agent: { billing: null } }), ['0.500000', '10', '20', '30', '40']);
  assert.deepEqual(costArgs({ ...live, result: null, agent: { billing: 'api' } }), ['--billing', 'api']);
});

// ASS-268: usage.json as session-usage.js writes it — after one finished turn ($0.50 exact), part way through a second (its estimate $0.20 more).
const usageJson = (rest = {}) => ({ model: 'm', tokens: { input: 20, output: 40, cacheRead: 60, cacheWrite: 80 }, costUsd: 0.7, costExact: false, billing: 'api', ...rest });

test('ASS-268 AC2: costArgs records the exact total when every turn ended — the live agent\'s figures, whatever usage.json estimated', () => {
  const live = { result: { type: 'result' }, cost: 0.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, agent: { billing: 'api' } };
  assert.deepEqual(costArgs(live, usageJson({ costUsd: 0.5, costExact: true })), ['0.500000', '10', '20', '30', '40', '--billing', 'api']);
  assert.deepEqual(costArgs(live, null), ['0.500000', '10', '20', '30', '40', '--billing', 'api']);   // no usage.json: as before
});

test('ASS-268 AC2/AC3: with a turn unfinished, costArgs records usage.json\'s estimate of every turn — one finished, one cut short — and its tokens, flagged --estimated', () => {
  const live = { result: { type: 'result' }, cost: 0.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, agent: { billing: 'api' } };
  assert.deepEqual(costArgs(live, usageJson()), ['0.700000', '20', '40', '60', '80', '--estimated', '--billing', 'api']);
  assert.deepEqual(costArgs({ ...live, result: null, cost: 0 }, usageJson({ costUsd: 0.2 })), ['0.200000', '20', '40', '60', '80', '--estimated', '--billing', 'api']);   // its first turn cut short
  // No price for its model: the finished turns' exact cost, flagged, as the most that is known.
  assert.deepEqual(costArgs(live, usageJson({ costUsd: null })), ['0.500000', '10', '20', '30', '40', '--estimated', '--billing', 'api']);
  // Nothing spent that anyone can price: billing alone, as before.
  assert.deepEqual(costArgs({ ...live, result: null, cost: 0 }, usageJson({ costUsd: null })), ['--billing', 'api']);
});

test('ASS-268 AC2: costArgs records 0 on a subscription, estimate or not; the billing usage.json recorded when the live agent never said', () => {
  const live = { result: null, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, agent: { billing: null } };
  assert.deepEqual(costArgs(live, usageJson({ billing: 'subscription' })), ['0.000000', '20', '40', '60', '80', '--estimated', '--billing', 'subscription']);
  assert.deepEqual(costArgs(live, usageJson()), ['0.700000', '20', '40', '60', '80', '--estimated', '--billing', 'api']);
  assert.deepEqual(costArgs({ ...live, agent: { billing: 'subscription' } }, usageJson()), ['0.000000', '20', '40', '60', '80', '--estimated', '--billing', 'subscription']);
});

test('ASS-268 AC2: usageArgs — what a session cost from its usage.json alone, for an agent no live process speaks for (control\'s startup clean-up)', () => {
  assert.deepEqual(usageArgs(usageJson()), ['0.700000', '20', '40', '60', '80', '--estimated', '--billing', 'api']);
  assert.deepEqual(usageArgs(usageJson({ costExact: true })), ['0.700000', '20', '40', '60', '80', '--billing', 'api']);   // every turn ended: exact
  assert.deepEqual(usageArgs(usageJson({ billing: 'subscription' })), ['0.000000', '20', '40', '60', '80', '--estimated', '--billing', 'subscription']);
  assert.deepEqual(usageArgs(usageJson({ billing: null, costUsd: null })), []);
  assert.deepEqual(usageArgs(null), []);                                        // no usage.json
});

test('ASS-270 AC1/AC2/AC4: spentSoFar — what a live agent has cost so far, in dollars, as costArgs prices it: its finished turns exact and the unfinished one estimated; 0 on a subscription or with nothing known', () => {
  const live = { result: { type: 'result' }, cost: 0.5, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, agent: { billing: 'api' } };
  assert.equal(spentSoFar(live, usageJson()), 0.7);                                          // one turn finished, one under way
  assert.equal(spentSoFar({ ...live, result: null, cost: 0 }, usageJson({ costUsd: 0.2 })), 0.2);   // a single turn, mid-way
  assert.equal(spentSoFar(live, usageJson({ costUsd: 0.5, costExact: true })), 0.5);
  assert.equal(spentSoFar(live, usageJson({ costUsd: null })), 0.5);                        // no price: the finished turns
  assert.equal(spentSoFar({ ...live, agent: { billing: 'subscription' } }, usageJson()), 0);
  assert.equal(spentSoFar({ ...live, result: null, cost: 0 }, null), 0);                    // nothing yet
});

test('scriptDue: a timer script runs when its minutes have passed since it last ran; any other once per visit (a failing one is held between tries by the backoff, backoff.js)', () => {
  const lines = [], ctx = { memory: memory(), log: (_, text) => lines.push(text) };
  const timer = { action: { type: 'script', mode: 'timer', 'timer-minutes': 5 } }, once = { action: { type: 'script' } };
  assert.equal(scriptDue(ctx, 't', 'k', 'k/1', timer, 1_000_000), true);
  assert.equal(scriptDue(ctx, 't', 'k', 'k/1', timer, 1_000_000 + 4 * 60_000), false);
  assert.equal(scriptDue(ctx, 't', 'k', 'k/1', timer, 1_000_000 + 5 * 60_000), true);
  assert.deepEqual(lines, []);                                                                // a timer's skip is never logged
  assert.equal(scriptDue(ctx, 's', 'o', 'o/1', once, 0), true);
  assert.equal(scriptDue(ctx, 's', 'o', 'o/1', once, 10 ** 9), false);
  assert.equal(scriptDue(ctx, 's', 'o', 'o/1', once, 10 ** 9 + 1), false);
  assert.deepEqual(lines, ['s: its script already ran this visit; not run again']);          // said once a visit
  assert.equal(scriptDue(ctx, 's', 'o', 'o/2', once, 30_000), true);                          // the next visit
  assert.equal(scriptDue(ctx, 's', 'o', 'o/2', once, 60_000), false);
  assert.equal(lines.length, 2);
});

test('timerDue: an interval counted from control\'s start, then from the last firing; no interval, never', () => {
  const m = memory();
  assert.equal(timerDue(m, 't', 300, 1_000_000 + 299_000, 1_000_000), false);
  assert.equal(timerDue(m, 't', 300, 1_000_000 + 300_000, 1_000_000), true);
  assert.equal(timerDue(m, 't', 300, 1_000_000 + 400_000, 1_000_000), false);
  assert.equal(timerDue(m, 't', 300, 1_000_000 + 600_000, 1_000_000), true);
  assert.equal(timerDue(m, 'u', null, 10 ** 12, 0), false);
  assert.equal(timerDue(m, 'u', 0, 10 ** 12, 0), false);
});

test('nagDue and statusSeconds: quiet since the last update (or the start) for the engine\'s seconds, asked once per silence', () => {
  const m = memory();
  const r = record('Hulk', { 'start-time': '2026-10-10T00:00:00Z', 'last-ai-status-update': null });
  const t = s => Date.parse('2026-10-10T00:00:00Z') + s * 1000;
  assert.equal(nagDue(m, r, 480, t(479)), false);
  assert.equal(nagDue(m, r, 480, t(480)), true);
  assert.equal(nagDue(m, r, 480, t(1000)), false);                                              // asked already for this silence
  assert.equal(nagDue(m, { ...r, 'last-ai-status-update': '2026-10-10T00:10:00Z' }, 480, t(600 + 479)), false);
  assert.equal(nagDue(m, { ...r, 'last-ai-status-update': '2026-10-10T00:10:00Z' }, 480, t(600 + 480)), true);
  assert.equal(nagDue(m, r, undefined, t(10 ** 6)), false);
  const key = 'ask-for-status-update-given-none-was-provided-for-seconds';
  const state = { engines: { e: { [key]: 60 }, 'no-key': {} }, projects: [{ id: 'p', engine: { [key]: 90 } }] };
  assert.equal(statusSeconds(state, { 'state-engine': 'e', project: 'p' }), 60);
  assert.equal(statusSeconds(state, { 'state-engine': 'e/check-health-steps', project: 'p' }), 60);
  assert.equal(statusSeconds(state, { 'state-engine': 'no-key', project: 'p' }), 90);
  assert.equal(statusSeconds(state, { 'state-engine': 'no-key', project: 'q' }), undefined);
});

test('agentNeedsWork: a planning step (the queue) while a planning slot is free; another step while the variation holds an in-progress slot', () => {
  const engine = { steps: [{ id: 'committed', 'is-planning-stage': true }, { id: 'wait' }] };
  const ticket = { key: 'T-1' }, variation = { name: 'A' };
  const planned = free => ({ reserved: [{ key: 'T-1', variation: 'A' }], free: { planning: free, progress: false } });
  assert.equal(agentNeedsWork(planned(true), engine.steps[0], ticket, variation), true);
  assert.equal(agentNeedsWork(planned(false), engine.steps[0], ticket, variation), false);
  assert.equal(agentNeedsWork(planned(false), engine.steps[1], ticket, variation), true);
  assert.equal(agentNeedsWork({ reserved: [], free: { planning: true, progress: true } }, engine.steps[1], ticket, variation), false);
});

test('outputSchema: the prompt\'s output when it is an object with keys (decision 15); agentFolder: the worktree, else the local-pc folder, on disk, and where the container sees it (containerFolder, null without a container)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'));
  mkdirSync(join(dir, 'schema'));
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(dir, 'none'));
  writeFileSync(join(dir, 'schema', 'prompt.json'), JSON.stringify({ output: { type: 'object' } }));
  writeFileSync(join(dir, 'empty', 'prompt.json'), JSON.stringify({ output: '' }));
  assert.deepEqual(outputSchema(dir, 'schema'), { type: 'object' });
  assert.equal(outputSchema(dir, 'empty'), undefined);
  assert.equal(outputSchema(dir, 'none'), undefined);
  assert.equal(outputSchema(dir, 'missing'), undefined);
  const mounts = [{ Source: dir, Destination: '/workspace' }, { Source: `${dir}/schema`, Destination: '/deep' }, { Source: '/elsewhere', Destination: '/x' }];
  const ctx = { mounts: container => (container === 'devc' ? mounts : []) };
  const project = { id: 'p', json: { 'local-environments': [{ type: 'dev-container' }, { type: 'local-pc', folder: dir }] } };
  assert.deepEqual(agentFolder(ctx, project, { build: { 'worktree-folder': join(dir, 'schema') } }), { folder: join(dir, 'schema'), containerFolder: null });
  assert.deepEqual(agentFolder(ctx, project, { build: { 'worktree-folder': null } }), { folder: dir, containerFolder: null });
  assert.deepEqual(agentFolder(ctx, project, undefined), { folder: dir, containerFolder: null });
  assert.throws(() => agentFolder(ctx, { id: 'q', json: {} }, undefined), /no worktree for the variation and no local-pc folder/);
  assert.throws(() => agentFolder(ctx, project, { build: { 'worktree-folder': '/no/such/folder' } }), /\/no\/such\/folder does not exist/);
  // Inside a container: the same folder as the container mounts it, the longest mount winning.
  assert.deepEqual(agentFolder(ctx, project, { build: { 'worktree-folder': join(dir, 'empty') } }, 'devc'), { folder: join(dir, 'empty'), containerFolder: '/workspace/empty' });
  assert.deepEqual(agentFolder(ctx, project, { build: { 'worktree-folder': join(dir, 'schema') } }, 'devc'), { folder: join(dir, 'schema'), containerFolder: '/deep' });
  assert.deepEqual(agentFolder(ctx, project, undefined, 'devc'), { folder: dir, containerFolder: '/workspace' });
  assert.throws(() => agentFolder(ctx, project, undefined, 'other'), /does not mount/);
  assert.equal(containerPath(mounts, '/elsewhere/a/b'), '/x/a/b');
  assert.equal(containerPath(mounts, '/elsewhere-not'), null);
  assert.equal(containerPath([{ Source: '/a/', Destination: '/m/' }], '/a/b'), '/m/b');
});

test('firstStepId, levelChanges, contextOf, isPaused, found: the small readings the phases share', () => {
  assert.equal(firstStepId({ steps: [{ id: 'b', sequence: 2 }, { id: 'a', sequence: 1 }] }), 'a');
  assert.equal(firstStepId(undefined), undefined);
  const sub = { 'from-state': 'x', 'to-state': 'x', 'sub-state-change': { 'to-state': 't' } };
  assert.deepEqual(levelChanges({ 'state-changes': [{ 'from-state': 'a', 'to-state': 'x' }, sub] }), [{ 'from-state': 'a', 'to-state': 'x' }]);
  assert.deepEqual(levelChanges({}), []);
  const transient = [
    { id: 'top', parent: { trigger: 'check-ticket-health', 'work-item': 'T-1', variation: 'A' } },
    { id: 'child', parent: { 'transient-state-engine': 'top', 'state-engine': 'e', state: 's' } },
    { id: 'alone', parent: { trigger: 'self-healing' } },
    { id: 'loop', parent: { 'transient-state-engine': 'loop' } },
  ];
  assert.deepEqual(contextOf(transient[0], transient), { workItem: 'T-1', variation: 'A' });
  assert.deepEqual(contextOf(transient[1], transient), { workItem: 'T-1', variation: 'A' });
  assert.deepEqual(contextOf(transient[2], transient), {});
  assert.deepEqual(contextOf(transient[3], transient), {});
  const state = { pauses: {}, projects: [{ id: 'p', tickets: [{ key: 'T-1', variations: [{ name: 'A', 'is-paused': true }, { name: 'B' }, { name: 'C', 'is-deleted': true }] }, { key: 'T-2', 'is-paused': true, variations: [{ name: 'A' }] }] }] };
  assert.equal(isPaused(state, 'p', 'T-1', 'A'), true);
  assert.equal(isPaused(state, 'p', 'T-1', 'B'), false);
  assert.equal(isPaused(state, 'p', 'T-2', 'A'), true);
  assert.equal(isPaused(state, 'p', undefined, undefined), false);
  // Scoped: all agents, or one project's; a project is held by its own pauses and all's.
  assert.equal(isPaused({ ...state, pauses: { all: { human: {} } } }, 'p', 'T-1', 'B'), true);
  assert.equal(isPaused({ ...state, pauses: { p: { human: {} } } }, 'p', 'T-1', 'B'), true);
  assert.equal(isPaused({ ...state, pauses: { q: { human: {} } } }, 'p', 'T-1', 'B'), false);
  // An AI pause leaves its own health check's work going: the run that took it and the runs under it.
  const health = [{ id: 'hc', project: 'q', parent: { trigger: 'check-health' } }, { id: 'heal', project: 'q', parent: { 'transient-state-engine': 'hc' } }, { id: 'other', project: 'q', parent: { trigger: 'gap-resolution' } }];
  const ai = { ...state, transient: health, pauses: { all: { ai: { agent: 'Ripley', project: 'q', run: 'hc' } } } };
  assert.equal(isPaused(ai, 'p', 'T-1', 'B'), true);
  assert.equal(isPaused(ai, 'q', undefined, undefined, 'heal'), false);
  assert.equal(isPaused(ai, 'q', undefined, undefined, 'hc'), false);
  assert.equal(isPaused(ai, 'q', undefined, undefined, 'other'), true);
  // ASS-127: a project's background work off holds its background runs and the runs under them — a ticket
  // health check by the project it runs on, not the ticket's — and nothing else.
  const runs = [{ id: 'hc', project: 'h', parent: { trigger: 'check-health' } }, { id: 'sub', project: 'h', parent: { 'transient-state-engine': 'hc' } },
    { id: 'th', project: 'h', parent: { trigger: 'check-ticket-health', 'work-item': 'T-1', variation: 'B', 'ticket-project': 'p' } },
    { id: 'gap', project: 'h', parent: { trigger: 'gap-resolution', 'work-item': 'T-1', variation: 'B' } }, { id: 'step', project: 'h', parent: { 'work-item': 'T-1', variation: 'B', state: 'blocked' } }];
  const off = id => ({ ...state, transient: runs, projects: [...state.projects, { id: 'h', json: { 'background-work': false }, tickets: [] }].map(p => p.id === id ? p : { ...p, json: {} }) });
  for (const id of ['hc', 'sub', 'th']) assert.equal(isPaused(off('h'), 'h', undefined, undefined, id), true, id);
  for (const id of ['gap', 'step']) assert.equal(isPaused(off('h'), 'h', undefined, undefined, id), false, id);
  assert.equal(isPaused(off('p'), 'h', undefined, undefined, 'th'), false, 'the ticket\'s project\'s switch is not the one');
  assert.equal(isPaused({ ...off('h'), allProjects: [{ id: 'h', json: {} }] }, 'h', undefined, undefined, 'hc'), false, 'read from every project, a control for one');
  assert.equal(found(state, { project: 'p', 'work-item': 'T-1', variation: 'C' }).variation, undefined);   // deleted is as good as missing
  assert.equal(found(state, { project: 'x', 'work-item': 'T-1', variation: 'A' }).project, undefined);
});

test('runValues and parseOutput: a run\'s placeholders from its context and output (the tickets to pause comma-separated, - for none, no operator action or no missing repository); a script\'s stdout as JSON when it is', () => {
  const run = { id: 'r', project: 'p', 'structured-output': { key: 'ABC-9', summary: 'the build is red', url: 'https://x/ABC-9', 'pause-tickets': ['ABC-3', 'ABC-4'], 'human-action': 'Re-authenticate glab', 'missing-repository': 'https://gitlab.com/g/legal-search' } };
  assert.deepEqual(runValues(run, { workItem: 'ABC-3', variation: 'A' }), { ticket: 'ABC-9', 'work-item': 'ABC-3', variation: 'A', summary: 'the build is red', 'ticket-url': 'https://x/ABC-9', project: 'p', 'pause-tickets': 'ABC-3,ABC-4', 'human-action': 'Re-authenticate glab', 'missing-repository': 'https://gitlab.com/g/legal-search', 'failing-repository': '-', 'failing-job': '-', run: 'r' });
  assert.deepEqual(runValues({ ...run, 'structured-output': { key: 'ABC-9', 'pause-tickets': [] } }, {}), { ticket: 'ABC-9', 'work-item': undefined, variation: undefined, summary: undefined, 'ticket-url': '-', project: 'p', 'pause-tickets': '-', 'human-action': '-', 'missing-repository': '-', 'failing-repository': '-', 'failing-job': '-', run: 'r' });
  assert.deepEqual(runValues({ project: 'p', 'structured-output': null }, {}), { ticket: undefined, 'work-item': undefined, variation: undefined, summary: undefined, 'ticket-url': '-', project: 'p', 'pause-tickets': '-', 'human-action': '-', 'missing-repository': '-', 'failing-repository': '-', 'failing-job': '-', run: undefined });
  assert.deepEqual(parseOutput('{"needs-attention":true}\n'), { 'needs-attention': true });
  assert.equal(parseOutput('ok\n'), undefined);
});

test('ticketFacts: the variation\'s facts, whether a work file was written since the turn began, and whether a filled script succeeds', () => {
  const root = mkdtempSync(join(tmpdir(), 'facts-'));
  mkdirSync(join(root, 'p', 'work', 'T-1'), { recursive: true });
  writeFileSync(join(root, 'p', 'work', 'T-1', 'plan.md'), 'x');
  utimesSync(join(root, 'p', 'work', 'T-1', 'plan.md'), new Date(2_000_000), new Date(2_000_000));
  const lines = [];
  const ctx = { paths: { projects: root }, log: (p, t) => lines.push(`${p} ${t}`), succeeds: argv => argv.join(' ') === 'true T-1' };
  const ticket = { key: 'T-1', 'ticket-system-status': 'In Progress', 'selected-variation': { name: 'A', state: 's' }, variations: [{ name: 'A' }, { name: 'B', 'is-deleted': true }] };
  const variation = { name: 'A', 'human-review': { state: 's', decision: 'Approved' } };
  const facts = ticketFacts(ctx, { id: 'p' }, ticket, variation, 1_000_000);
  assert.equal(facts.ticketSystemStatus, 'In Progress');
  assert.deepEqual([facts.humanReview.decision, facts.selectedVariation.name, facts.variationCount, facts.variation], ['Approved', 'A', 1, variation]);
  assert.equal(facts.fileUpdated('plan.md'), false, 'ASS-181: the unsuffixed file is no variation\'s: no fallback');
  writeFileSync(join(root, 'p', 'work', 'T-1', 'plan-A.md'), 'x');
  utimesSync(join(root, 'p', 'work', 'T-1', 'plan-A.md'), new Date(2_000_000), new Date(2_000_000));
  assert.equal(facts.fileUpdated('plan.md'), true, 'ASS-181: the variation\'s own, plan-A.md');
  assert.equal(facts.fileUpdated('plan-{variation}.md'), true, 'a name naming {variation} already is that one');
  assert.equal(ticketFacts(ctx, { id: 'p' }, ticket, { name: 'B' }, 1_000_000).fileUpdated('plan.md'), false, 'B\'s is plan-B.md');
  assert.equal(ticketFacts(ctx, { id: 'p' }, ticket, variation, 3_000_000).fileUpdated('plan.md'), false);
  assert.equal(facts.fileUpdated('missing.md'), false);
  // ASS-118: a file named per variation — {variation} (and {ticket}, {project}) filled from the variation's.
  writeFileSync(join(root, 'p', 'work', 'T-1', 'explanation-A.md'), 'x');
  assert.equal(facts.fileUpdated('explanation-{variation}.md'), true);
  assert.equal(ticketFacts(ctx, { id: 'p' }, ticket, { name: 'B' }, 1_000_000).fileUpdated('explanation-{variation}.md'), false);
  assert.equal(facts.scriptSucceeds('true {ticket}'), true);
  assert.equal(facts.scriptSucceeds('false {ticket}'), false);
  assert.equal(facts.scriptSucceeds('true {summary}'), false);
  assert.match(lines[0], /unfilled placeholder \{summary\}/);
});

test('problemOf: the problem a run\'s ticket prompts get — the nearest analysis up its parents (a create-ticket run has none of its own), every field spelled out; - when there is none', () => {
  const analysis = {
    'needs-fix': true, summary: 'pnpm nx will not run', 'root-cause': 'node_modules predates the lockfile; install needs the @example token',
    'cause-in': 'operator', evidence: ['pnpm exec nx --version → ERR_PNPM_VERIFY_DEPS_BEFORE_RUN', 'no _authToken in .npmrc'],
    'blocks-tickets': [], 'needs-human': true, 'human-action': 'Add the @example npm token; pnpm install', 'pause-tickets': [],
  };
  const healing = { id: 'h', parent: { trigger: 'self-healing' }, 'structured-output': analysis };
  const child = { id: 'c', parent: { 'transient-state-engine': 'h' }, 'structured-output': null };
  assert.equal(problemOf(child, [healing, child]), [
    'Summary: pnpm nx will not run',
    'Root cause: node_modules predates the lockfile; install needs the @example token',
    'Cause is in: the operator\'s own machine (not the harness, not the project)',
    'Evidence:',
    '- pnpm exec nx --version → ERR_PNPM_VERIFY_DEPS_BEFORE_RUN',
    '- no _authToken in .npmrc',
    'Blocks: no ticket shown to be blocked',
    'Needs the operator: yes — Add the @example npm token; pnpm install',
    'Fixing it interrupts agent work: no',
    'The top ticket can go on without the fix: no',
    'Tickets to pause for the fix: none',
  ].join('\n'));
  const harness = { ...analysis, 'cause-in': 'harness', 'blocks-tickets': ['EX-1'], 'needs-human': false, evidence: [], 'must-interrupt-work': true, 'can-continue-without-fix': true, 'pause-tickets': ['EX-1', 'EX-2'] };
  assert.equal(problemOf({ ...healing, 'structured-output': harness }, []).split('\n').slice(2).join('\n'), [
    'Cause is in: the harness',
    'Evidence: none recorded',
    'Blocks: EX-1',
    'Needs the operator: no',
    'Fixing it interrupts agent work: yes',
    'The top ticket can go on without the fix: yes',
    'Tickets to pause for the fix: EX-1, EX-2',
  ].join('\n'));
  assert.equal(problemOf({ ...child, parent: {} }, []), '-');
});

test('ticketOf: the ticket a run works for — the key a create-ticket step returned, nearest up its parents, else its context\'s work item; none when neither', () => {
  const healing = { id: 'h', parent: { trigger: 'self-healing' }, 'structured-output': { summary: 'S', key: 'HD-1' } };
  const child = { id: 'c', parent: { 'transient-state-engine': 'h' }, 'structured-output': null };
  assert.equal(ticketOf(child, [healing, child]), 'HD-1');
  assert.equal(ticketOf({ id: 't', parent: { 'work-item': 'ABC-3', variation: 'B' }, 'structured-output': { key: 'HD-9' } }, []), 'HD-9');   // the fix ticket over the one sampled
  assert.equal(ticketOf({ id: 't', parent: { 'work-item': 'ABC-3', variation: 'B' }, 'structured-output': null }, []), 'ABC-3');
  assert.equal(ticketOf({ ...healing, 'structured-output': { summary: 'S', key: '' } }, []), undefined);
  assert.equal(ticketOf({ id: 'x', parent: {} }, []), undefined);
});

test('problemOf: blocks-tickets is a boolean from an assess-health analysis (prompts/assess-health/prompt.json), not the analysis prompt\'s ticket keys', () => {
  const assess = { 'needs-fix': true, summary: 'pnpm nx will not run', 'blocks-tickets': true, 'must-interrupt-work': true, 'can-continue-without-fix': false };
  const healing = { id: 'h', parent: { 'transient-state-engine': 'a' }, 'structured-output': assess };
  assert.equal(problemOf(healing, [healing]), [
    'Summary: pnpm nx will not run',
    'Evidence: none recorded',
    'Blocks: sprint tickets',
    'Needs the operator: no',
    'Fixing it interrupts agent work: yes',
    'The top ticket can go on without the fix: no',
    'Tickets to pause for the fix: none',
  ].join('\n'));
  assert.match(problemOf({ ...healing, 'structured-output': { ...assess, 'blocks-tickets': false } }, []), /^Blocks: no ticket shown to be blocked$/m);
});

test('problemOf: a block Troubleshoot found needs a repository the project lacks names it (ASS-121 AC1), so Classify routes it to Repair Environment; none named, no line', () => {
  const found = { 'needs-fix': true, summary: 'Work lands in legal-search, which p does not list', 'root-cause': 'The plan\'s merge request is in legal-search', evidence: ['execution-plan.md:12'], 'missing-repository': 'https://gitlab.com/g/legal-search' };
  const run = { id: 'b', parent: { 'work-item': 'ABC-3', variation: 'A' }, 'structured-output': found };
  assert.match(problemOf(run, [run]), /^Root cause: The plan's merge request is in legal-search\nMissing repository: https:\/\/gitlab\.com\/g\/legal-search — the project does not list it: an environment issue, which Repair Environment adds when the harness can access it\nEvidence:/m);
  assert.doesNotMatch(problemOf({ ...run, 'structured-output': { ...found, 'missing-repository': undefined } }, []), /Missing repository/);
});

test('isHarnessProject: only the project harness.json\'s harness-project names is the harness (ASS-106); with none named, none is', () => {
  assert.equal(isHarnessProject({ 'harness-project': 'harness' }, 'harness'), true);
  assert.equal(isHarnessProject({ 'harness-project': 'harness' }, 'example'), false);
  assert.equal(isHarnessProject({}, 'harness'), false);
  assert.equal(isHarnessProject({}, undefined), false);
});

// ASS-107 AC2/AC3: where a classified issue's fix ticket goes is decided here, not in a prompt's wording — and told to the ticket prompts.
test('problemOf: a classified issue says where its fix ticket goes — a harness (or environment) issue the harness project\'s backlog, a project issue the blocked ticket\'s own project\'s ticket system; on the harness project both are its backlog', () => {
  const harness = { 'harness-project': 'harness' };
  const blocked = (project, issue) => ({ id: 'b', project, parent: { 'work-item': 'ABC-3', variation: 'A' }, 'structured-output': { summary: 'S', issue, reasoning: 'R' } });
  const said = (project, issue) => problemOf(blocked(project, issue), [], { harness }).split('\n').filter(l => /^(Classified|Raise the fix ticket in):/.test(l));
  assert.deepEqual(said('example', 'harness'), ['Classified: a harness issue — R', 'Raise the fix ticket in: project harness — the harness project\'s backlog']);
  assert.deepEqual(said('example', 'project'), ['Classified: a project issue — R', 'Raise the fix ticket in: project example — its own ticket system']);
  assert.deepEqual(said('example', 'environment'), ['Classified: an environment issue — R', 'Raise the fix ticket in: project harness — the harness project\'s backlog']);
  for (const issue of ['harness', 'project']) assert.deepEqual(said('harness', issue)[1], 'Raise the fix ticket in: project harness — the harness project\'s backlog', issue);
  // Unclassified (an older analysis, a ticket-health check), or no harness project named: the prompt goes by cause-in, as before.
  assert.deepEqual(said('example', undefined), []);
  assert.deepEqual(problemOf(blocked('example', 'harness'), [], { harness: {} }).split('\n').filter(l => /^Raise/.test(l)), []);
});

// ASS-107 (operator, 2026-10-24): Blocked learns — its prompts see every earlier block of the ticket, repeats at one step above all, what was tried and how it ended.
const top = (from, to) => ({ 'from-state': from, 'to-state': to });
const within = (state, step) => ({ 'from-state': state, 'to-state': state, 'sub-state-change': { 'state-engine': 'grouped-build', 'from-state': null, 'to-state': step } });

test('cameFrom: the step the variation entered a state from, with the detailed step it was at there', () => {
  const v = { 'state-changes': [top('plan', 'build'), within('build', 'generate-solution'), within('build', 'automated-testing'), top('build', 'blocked'), top('blocked', 'blocked')] };
  assert.equal(cameFrom(v, 'blocked'), 'build/automated-testing');
  assert.equal(cameFrom({ 'state-changes': [top('generate-solution', 'blocked')] }, 'blocked'), 'generate-solution');
  assert.equal(cameFrom({ 'state-changes': [] }, 'blocked'), undefined);
});

test('blockHistory: every stay in Blocked from the history, repeats at one step called out, and each kept run — what was found, the issue, what was tried, how it ended; nothing for a ticket never blocked', () => {
  const v = {
    'state-changes': [top('plan', 'build'), within('build', 'automated-testing'), top('build', 'blocked'), top('blocked', 'build'), within('build', 'automated-testing'), top('build', 'blocked'), top('blocked', 'blocked'), top('blocked', 'build'), within('build', 'automated-testing'), top('build', 'blocked')],
    blocks: [
      { timestamp: '2026-10-20T01:00:00Z', 'came-from': 'build/automated-testing', summary: 'nx will not run', 'root-cause': 'stale node_modules', issue: 'environment', reasoning: 'deps', remediated: true, 'ai-feedback-short': 'pnpm install', 'ended-at': 'done' },
      { timestamp: '2026-10-20T02:00:00Z', 'came-from': 'build/automated-testing', summary: 'nx will not run', 'root-cause': 'lockfile drift', issue: 'harness', reasoning: 'setup', key: 'ASS-9', 'ended-at': 'retry' },
      { timestamp: '2026-10-20T03:00:00Z', 'came-from': 'build/automated-testing', summary: 'nx will not run', issue: 'harness', key: 'ASS-10', 'ended-at': 'done' },
    ],
  };
  const text = blockHistory(v);
  assert.match(text, /^Earlier blocks of this ticket/);
  assert.match(text, /Entered Blocked 3 times \(this stay included\): 3 at build\/automated-testing — the same step again and again/);
  assert.match(text, /2026-10-20T01:00:00Z, from build\/automated-testing: nx will not run\. Cause: stale node_modules\. Issue: environment — deps\. Ended: repaired in place \(pnpm install\), resumed — blocked again/);
  assert.match(text, /Issue: harness — setup\. Ended: fix ticket ASS-9 closed unmerged/);
  assert.match(text, /Ended: fix ticket ASS-10 landed, resumed — blocked again/);
  assert.equal(blockHistory({ 'state-changes': [top('plan', 'build')] }), '');
  assert.equal(blockHistory({ 'state-changes': v['state-changes'] }), '', 'no run kept: an engine that keeps none (the current engines)');
  assert.equal(blockHistory(undefined), '');
});

test('problemOf: a Blocked run\'s prompts get the ticket\'s block history after the analysis — alone before there is one', () => {
  const run = { id: 'b', project: 'p', parent: { 'work-item': 'ABC-3', variation: 'A' }, 'structured-output': { summary: 'S' } };
  assert.match(problemOf(run, [], { history: 'Earlier blocks of this ticket: H' }), /^Summary: S\n[\s\S]*\n\nEarlier blocks of this ticket: H$/);
  assert.equal(problemOf({ ...run, 'structured-output': null }, [], { history: 'Earlier blocks of this ticket: H' }), 'Earlier blocks of this ticket: H');
  assert.equal(problemOf({ ...run, 'structured-output': null }, [], { history: '' }), '-');
});

test('problemOf: a project issue found by a harness run about another project\'s ticket (a ticket health check) goes to that ticket\'s project', () => {
  const run = { id: 'h', project: 'harness', parent: { trigger: 'check-ticket-health', 'work-item': 'EX-1' }, 'structured-output': { summary: 'S', issue: 'project', reasoning: 'R' } };
  assert.match(problemOf(run, [], { harness: { 'harness-project': 'harness' }, project: 'example' }), /^Raise the fix ticket in: project example — its own ticket system$/m);
});
