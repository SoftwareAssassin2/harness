// Every agent's memory (ASS-62): each project's own Hindsight server — here
// test/support/fake-hindsight.js — its bank's MCP endpoint handed to every
// agent control starts as --mcp-config; the fake agent prints its arguments
// and, with FAKE_MEMORY, makes the MCP calls it lists on that endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { fakeHindsight } from '../support/fake-hindsight.js';
import { until } from '../support/until.js';
import { fakeVm } from '../support/fake-vm.js';

const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const session = live => readFileSync(join(live.agent.dir, 'session.txt'), 'utf8');
const mcp = (port, bank, host = '127.0.0.1') => JSON.stringify({ mcpServers: { hindsight: { type: 'http', url: `http://${host}:${port}/mcp/${bank}/` } } });

// The fake agent's settings for test t: host agents run on control's own environment.
const withEnv = (t, vars) => { Object.assign(process.env, vars); t.after(() => { for (const k of Object.keys(vars)) delete process.env[k]; }); };
// The control fixture with p's project.json naming a Hindsight on `port`.
function memoryFixture(port) {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p.hindsight = { port, 'llm-api-key': null }; });
  return f;
}
// The one agent the first tick starts, once it has printed its arguments.
async function firstAgent(f) {
  await tick(f.ctx);
  const [record] = f.assignments().assignments;
  const live = f.ctx.agents.get(record['agent-name']);
  assert.ok(await until(() => session(live).includes('config ')));
  return live;
}

test('AC2: every agent of a project with a Hindsight gets its bank\'s MCP endpoint as --mcp-config — with the project\'s own .claude and with the shared ~/.claude alike', async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  for (const own of [true, false]) {
    const f = memoryFixture(h.port);
    if (own) mkdirSync(join(f.dir, 'projects', 'p', '.claude'));
    try {
      const log = session(await firstAgent(f));
      assert.ok(log.includes(`--mcp-config ${mcp(h.port, 'p')}`), log);
      assert.match(log, own ? /config \/.*\/projects\/p\/\.claude\n/ : /config -\n/);
    } finally {
      f.ctx.stopAgents();
    }
  }
});

test('a project with no hindsight in its project.json starts its agents with no MCP configuration, as before', async () => {
  const f = controlFixture();
  try {
    const log = session(await firstAgent(f));
    assert.ok(!log.includes('--mcp-config'), log);
    assert.ok(!log.includes('memory unavailable'), log);
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC5: with the project\'s Hindsight unreachable, its agent starts without memory, its step still completes, and its session log says memory was unavailable', async t => {
  const h = await fakeHindsight();
  const { port } = h;
  await h.close();                                                     // nothing answers on its port now
  const f = memoryFixture(port);
  withEnv(t, { FAKE_OUTPUT: JSON.stringify({ 'is-approved': true }) });
  try {
    const live = await firstAgent(f);
    assert.ok(await until(() => live.result), 'the turn ends');
    const log = session(live);
    assert.match(log, new RegExp(`^\\[memory unavailable: p's Hindsight is not answering on 127\\.0\\.0\\.1:${port}; this step runs without memory\\]`));
    assert.ok(!log.includes('--mcp-config'), log);
    assert.ok(f.lines.some(l => l.startsWith(`dispatch memory unavailable: p's Hindsight`)), f.lines.join('\n'));
    await tick(f.ctx);                                                 // finished, approved: on past plan
    assert.ok(f.variation()['state-changes'].some(c => c['from-state'] === 'plan' && c['to-state'] === 'build'), JSON.stringify(f.variation()['state-changes']));
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC2: an agent in its ticket\'s VM gets its project\'s bank at host.lima.internal:<port>, Lima\'s address for the Mac\'s loopback', async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  const f = memoryFixture(h.port);
  edit(join(f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps = e.steps.map(s => (s.id === 'plan' ? { ...s, 'run-location': 'vm' } : s)); });
  edit(join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => { s.features[0].variations[0].vm = { name: 'abc-3-a', ip: '192.168.64.9' }; });
  const lima = fakeVm(f.env);
  f.ctx.env = lima.env;
  try {
    const log = session(await firstAgent(f));
    assert.ok(log.includes(`--mcp-config ${mcp(h.port, 'p', 'host.lima.internal')}`), log);
    assert.ok(lima.calls().some(c => c.vm === 'abc-3-a'), 'it ran in the VM');
  } finally {
    f.ctx.stopAgents();
  }
});
// session log, once its turn has ended.
async function planPasses(t, f, ...calls) {
  withEnv(t, { FAKE_OUTPUT: JSON.stringify({ 'is-approved': false }) });
  const logs = [];
  for (const memory of calls) {
    process.env.FAKE_MEMORY = JSON.stringify(memory);
    await tick(f.ctx);
    const [record] = f.assignments().assignments;
    const live = f.ctx.agents.get(record['agent-name']);
    assert.ok(await until(() => live.result), `pass ${logs.length + 1} ends its turn`);
    logs.push(session(live));
  }
  delete process.env.FAKE_MEMORY;
  return logs;
}
const source = { ticket: 'ABC-3', step: 'plan', model: 'claude-opus-5-5', date: '2026-10-25' };
const retain = (content, doc) => ({ tool: 'retain', arguments: { content, context: 'toolchain', document_id: doc, metadata: source } });
const recall = query => ({ tool: 'recall', arguments: { query } });
const recalled = log => JSON.parse(log.split('\n').find(l => l.startsWith('memory recall ')).slice('memory recall '.length)).results;

test('AC3, AC7: a fact one agent retains is recalled by the agent on a later dispatch for the same project, with its source — ticket, step, model and date', async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  const f = memoryFixture(h.port);
  try {
    const [first, second] = await planPasses(t, f,
      [recall('pnpm toolchain'), retain('The workspace toolchain needs pnpm 9; npm install breaks the lockfile', 'toolchain-pnpm')],
      [recall('which pnpm does the toolchain need')]);
    assert.deepEqual(recalled(first), []);
    assert.deepEqual(recalled(second).map(m => [m.text, m.metadata]), [['The workspace toolchain needs pnpm 9; npm install breaks the lockfile', source]]);
    assert.ok(h.requests.filter(r => r.path.startsWith('/mcp/')).every(r => r.path === '/mcp/p/'), 'every call went to the project\'s own bank');
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC4: an agent of one project cannot recall another project\'s bank — each project has its own Hindsight, and its agents are pointed at it alone', async t => {
  const mine = await fakeHindsight(), theirs = await fakeHindsight();
  t.after(mine.close); t.after(theirs.close);
  const other = memoryFixture(theirs.port);
  try {
    await planPasses(t, other, [retain('The other project deploys with helm', 'deploy')]);
  } finally {
    other.ctx.stopAgents();
  }
  const f = memoryFixture(mine.port);
  try {
    const [log] = await planPasses(t, f, [recall('how does the project deploy with helm')]);
    assert.deepEqual(recalled(log), []);
    assert.equal(theirs.requests.filter(r => r.path.startsWith('/mcp/')).length, 1, 'only the other project\'s own agent reached its server');
  } finally {
    f.ctx.stopAgents();
  }
});

test('AC6: an agent that finds a recalled memory no longer true supersedes it — retained again under its document_id — and the old one is never recalled again', async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  const f = memoryFixture(h.port);
  try {
    const [, second, third] = await planPasses(t, f,
      [retain('The workspace toolchain needs pnpm 9', 'toolchain-pnpm')],
      [recall('pnpm toolchain'), retain('The workspace toolchain needs pnpm 10 since the upgrade', 'toolchain-pnpm')],
      [recall('pnpm toolchain')]);
    assert.deepEqual(recalled(second).map(m => m.text), ['The workspace toolchain needs pnpm 9']);
    assert.deepEqual(recalled(third).map(m => m.text), ['The workspace toolchain needs pnpm 10 since the upgrade']);
  } finally {
    f.ctx.stopAgents();
  }
});

test('ASS-147 AC1: when an agent\'s session ends, its dispatch records how it used memory, counted from its session log — recalls, memories returned, saves, deletes; one without memory zeros', async t => {
  const h = await fakeHindsight();
  t.after(h.close);
  const f = memoryFixture(h.port);
  try {
    await planPasses(t, f,
      [retain('The workspace toolchain needs pnpm 9', 'toolchain-pnpm'), retain('zot listens on loopback', 'zot')],
      [recall('pnpm toolchain'), recall('zot loopback'), { tool: 'delete_document', arguments: { document_id: 'zot' } }],
      []);
    await tick(f.ctx);                                                 // the last agent's session ends too
    const done = f.variation()['state-changes'].flatMap(c => c['agent-dispatch-log'] ?? []).filter(d => d['completed-timestamp']);
    assert.deepEqual(done.map(d => d.memory), [
      { recalls: 0, returned: 0, saves: 2, deletes: 0 },
      { recalls: 2, returned: 2, saves: 0, deletes: 1 },
      { recalls: 0, returned: 0, saves: 0, deletes: 0 },
    ]);
  } finally {
    f.ctx.stopAgents();
  }
});
