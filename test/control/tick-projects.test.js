// A control per project (ASS-9): a control started for one project ticks only
// it — its tickets, runs, agents, rate limit — while harness.json's limits
// still count every project's agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { createContext, tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { until } from '../support/until.js';

const FAKE = join(import.meta.dirname, '..', 'support', 'fake-agent.js');
const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, JSON.stringify(data, null, 4)); };

// The control fixture plus a second project, x, on the same engine, its X-1 at backlog; controls for each.
function twoProjects() {
  const f = controlFixture();
  const at = (...rest) => join(f.dir, 'projects', 'x', ...rest);
  mkdirSync(at('sprints', 'sprint-1'), { recursive: true });
  writeFileSync(at('project.json'), JSON.stringify({ name: 'X', 'execution-state-engine': 'example-development', 'work-sources': [], 'local-environments': [{ name: 'local-pc', type: 'local-pc', folder: join(f.dir, 'workspace'), 'active-branch': null }] }));
  writeFileSync(at('sprints.json'), JSON.stringify({ list: [{ number: 1, 'is-active': true }] }));
  writeFileSync(at('sprints', 'sprint-1', 'sprint.json'), JSON.stringify({ number: 1, features: [{ key: 'X-1', 'ticket-system-status': 'Backlog', variations: [{ name: 'A', 'harness-status': hs('backlog'), 'state-changes': [] }] }], bugs: [], spikes: [] }));
  const lines = [];
  const control = project => createContext({ root: ROOT, env: f.env, command: ['node', FAKE], project, log: (phase, text) => lines.push(`${phase} ${text}`) });
  const xTicket = () => JSON.parse(readFileSync(at('sprints', 'sprint-1', 'sprint.json'), 'utf8')).features[0];
  return { ...f, control, xTicket, lines };
}

test('a control for one project moves and dispatches only its tickets', async () => {
  const f = twoProjects();
  const p = f.control('p');
  try {
    await tick(p);
    assert.equal(f.variation()['harness-status'].state, 'plan');                           // p's ticket moved, an agent on it
    assert.equal(f.xTicket().variations[0]['harness-status'].state, 'backlog');             // x's left alone
    assert.deepEqual(f.assignments().assignments.map(a => a.project), ['p']);
  } finally {
    p.stopAgents();
  }
});

test('harness.json\'s max-agents counts every project\'s agents, whichever control dispatches', async () => {
  const f = twoProjects();
  edit(join(f.dir, 'harness.json'), h => { h['max-agents'] = 1; });
  const p = f.control('p'), x = f.control('x');
  try {
    await tick(p);
    assert.equal(f.assignments().assignments.length, 1);
    await tick(x);                                                                         // x's ticket is ready for an agent, but the harness is full
    assert.equal(f.xTicket().variations[0]['harness-status'].state, 'plan');
    assert.deepEqual(f.assignments().assignments.map(a => a.project), ['p']);
  } finally {
    p.stopAgents();
    x.stopAgents();
  }
});

test('a rate limit is recorded on, and holds, only the project whose agent hit it', async () => {
  const f = twoProjects();
  const p = f.control('p');
  process.env.FAKE_RATE_LIMIT = String(Math.floor(Date.now() / 1000) + 3600);
  try {
    await tick(p);
    assert.ok(await until(() => p.agents.size > 0 && [...p.agents.values()].every(a => a.result)));   // its turn ended, rate-limited
    await tick(p);
    const limit = id => existsSync(join(f.dir, 'projects', id, 'rate-limit.json')) ? JSON.parse(readFileSync(join(f.dir, 'projects', id, 'rate-limit.json'), 'utf8')) : null;
    assert.ok(limit('p'), 'p is held');
    assert.equal(limit('x'), null);                                                         // x is not
  } finally {
    delete process.env.FAKE_RATE_LIMIT;
    p.stopAgents();
  }
});
