// The control fixture: the agent-cli fixture (test/agent-cli/harness-fixture.js)
// with an execution engine of every action type, a fake agent, and a context
// whose log the tests read.
import { afterEach } from 'node:test';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fixture, hs } from '../agent-cli/harness-fixture.js';
import { createContext } from '../../src/control/tick.js';
import { readEngine } from '../../src/workflow/engine-file.js';

// Every fixture's agents are ended when its test ends, passed or failed: a
// test that fails part way leaves no fake agent holding the run open (ASS-109).
// stopAgents ends one in a VM too; SIGKILL one a test has SIGSTOPped.
const contexts = [];
afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.stopAgents();
    for (const { agent } of ctx.agents.values()) try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* ended */ }
  }
});
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const FAKE = join(import.meta.dirname, '..', 'support', 'fake-agent.js');
const write = (file, content) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 4)); };
export const complete = { 'turn-complete': true };

// ASS-528: seats come from the Mac's memory and CPU budget (src/control/seat-budget.js), no longer from
// max-tickets-in-progress / max-tickets-in-planning. The fixture's control reads a fake Mac (ctx.hostMemory) sized so
// the default budget (90% of its memory) carries exactly `seats` tickets of the floor need (4 GiB: no VM of the
// project measured), with nothing else using memory; no CPU reading (ctx.hostCpu null). SEATS is every fixture's.
export const SEATS = 1;
const GIB = 2 ** 30;
export function macSeats(ctx, seats) {
  delete ctx.memory.hostMemory;   // the last reading forgotten, so the next tick reads this Mac
  if (seats == null || seats === Infinity) { ctx.hostMemory = null; ctx.hostCpu = null; return; }
  const totalBytes = Math.round(((seats + 0.5) * 4 * GIB) / 0.9);
  ctx.hostMemory = async () => ({ freePercent: 100, pressure: 'normal', totalBytes, freeBytes: totalBytes, reclaimableBytes: totalBytes, swapouts: 0, swapUsedBytes: 0, vms: new Map(), measure: 'footprint' });
  ctx.hostCpu = null;
}
const approved = ok => ({ all: [complete, { 'structured-output': { 'is-approved': ok } }] });

// The fixture with: no assignments or runs; one project, p, whose execution
// engine's steps chain backlog → committed (always) → plan (agent-needs-work;
// a prompt with a schema) → build (a script) → local-testing (the test
// engine) → done; a test engine of two prompts; one ticket, ABC-3 A, at
// backlog; a workspace folder as p's local-pc environment. Returns the
// fixture's helpers plus ctx (the control context on a fake agent), lines
// (its log), variation() and ticket().
export function controlFixture() {
  const f = fixture();
  const at = (...rest) => join(f.dir, ...rest);
  write(at('assignments.json'), { status: 'Running', assignments: [], 'transient-state-engines': [], 'self-healing': null, pauses: {} });
  write(at('harness.json'), { ...f.harness(), 'max-agents': null, 'agent-graceful-shut-down-delay-in-seconds': 1 });
  const engine = readEngine(at('engines', 'example-development', 'workflow.yaml'));
  write(at('engines', 'example-development', 'workflow.yaml'), {
    ...engine, 'ask-for-status-update-given-none-was-provided-for-seconds': 600,
    // As the real engine shapes it: one step, finished by its is-done exit. Step ids are unique across an engine's lists.
    'check-health-steps': [{ id: 'check-health', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }], 'check-health-interval-seconds': 3600, 'check-variation-appeal-interval-seconds': 3600,
    'gap-resolution-steps': [{ id: 'gap-resolution', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }],
    steps: [
      { id: 'blocked', sequence: 0, 'is-blocked-state': true, 'paired-ticket-system-status': 'Blocked', action: { type: 'human' } },
      { id: 'backlog', sequence: 1, 'is-planning-stage': true, 'paired-ticket-system-status': 'Backlog', action: { type: 'none' }, 'exit-events': [{ condition: { always: true }, 'move-to-state': 'committed' }] },
      { id: 'committed', sequence: 2, 'is-planning-stage': true, 'paired-ticket-system-status': 'To Do', action: { type: 'none' }, 'exit-events': [{ condition: { 'agent-needs-work': true }, 'move-to-state': 'plan' }] },
      { id: 'plan', sequence: 3, 'is-planning-stage': true, 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'plan',
        action: { type: 'prompt', prompt: 'review-plan', 'agent-count': 1, 'run-in-dev-container': false },
        'exit-events': [{ condition: approved(true), 'move-to-state': 'build' }, { condition: approved(false), 'move-to-state': 'plan' }] },
      { id: 'build', sequence: 4, 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'build',
        action: { type: 'script', command: './agent.sh ticket:set-paused {project} {ticket} {variation} false' },
        'exit-events': [{ condition: { 'exit-code': 0 }, 'move-to-state': 'local-testing' }, { condition: { not: { 'exit-code': 0 } }, 'move-to-state': 'build' }] },
      { id: 'local-testing', sequence: 5, 'paired-ticket-system-status': 'In Progress', 'max-visits': 3, 'on-max-visits': 'blocked', 'return-to-state': 'local-testing',
        action: { type: 'state-engine', engine: 'test' },
        'exit-events': [{ condition: { all: [{ 'is-done': true }, { 'structured-output': { 'is-approved': true } }] }, 'move-to-state': 'done' }, { condition: { all: [{ 'is-done': true }, { 'structured-output': { 'is-approved': false } }] }, 'move-to-state': 'plan' }] },
      { id: 'done', sequence: 6, 'is-done': true, 'paired-ticket-system-status': 'Done', action: { type: 'none' } },
    ],
  });
  write(at('engines', 'test', 'workflow.yaml'), { steps: [
    { id: 'test', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'take-screenshots' }] },
    { id: 'take-screenshots', sequence: 2, action: { type: 'prompt', prompt: 'take-screenshots', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('engines', 'investigate-gap', 'workflow.yaml'), { steps: [
    { id: 'investigate', sequence: 1, action: { type: 'prompt', prompt: 'test', 'agent-count': 1 }, 'exit-events': [{ condition: complete, 'move-to-state': 'done' }] },
    { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
  ] });
  write(at('prompts', 'review-plan', 'prompt.txt'), 'Review the plan of {ticket}.\n');
  write(at('prompts', 'review-plan', 'prompt.json'), { output: { type: 'object', properties: { 'is-approved': { type: 'boolean' } }, required: ['is-approved'] } });
  write(at('prompts', 'test', 'prompt.txt'), 'Test {ticket} {variation}.\n');
  write(at('prompts', 'take-screenshots', 'prompt.txt'), 'Screenshots of {ticket}.\n');
  write(at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), {
    number: 10, bugs: [], spikes: [],
    features: [{ key: 'ABC-3', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] }],
  });
  rmSync(at('projects', 'q'), { recursive: true });                                            // one project under test
  // A workspace folder for p, where its agents are started (dispatch.js agentFolder).
  mkdirSync(at('workspace'), { recursive: true });
  write(at('projects', 'p', 'project.json'), { ...JSON.parse(readFileSync(at('projects', 'p', 'project.json'), 'utf8')), 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: at('workspace'), 'active-branch': null }] });
  const lines = [];
  const ctx = createContext({ root: ROOT, env: f.env, command: ['node', FAKE], log: (phase, text) => lines.push(`${phase} ${text}`) });
  contexts.push(ctx);
  macSeats(ctx, SEATS);
  // seats(n) — ASS-528: n seats on this Mac (Infinity: not limited), both for the ticks (macSeats: the budget phase
  // reads that Mac) and for a test running the later phases alone (seat-budget.json, as the budget phase records it).
  const seats = n => {
    macSeats(ctx, n);
    const file = at('projects', 'p', 'seat-budget.json');
    if (n == null || n === Infinity) rmSync(file, { force: true });
    else write(file, { seats: n });
  };
  return { ...f, ctx, lines, seats, variation: () => f.sprint().features[0].variations[0], ticket: () => f.sprint().features[0] };
}
