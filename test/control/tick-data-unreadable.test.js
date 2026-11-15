// ASS-460, ASS-457, ASS-458: control survives a bad read of its data or an
// engine. A read caught empty or half-written is tried again (read.js
// readJson); an engine that still fails is its last good copy (state.js
// readEngines); the data failing to read skips the rest of the tick, logged
// once, until it reads again, and past data-unreadable-exit-seconds control is
// told to exit (tick.js waitForData); checkRateLimits and the drain's loads
// are guarded as every phase is; running agents are left be meanwhile; and
// stop.js stops what control started, SIGKILLing what ignores SIGTERM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { tick, startDrain, drained } from '../../src/control/tick.js';
import { readJson, troubleOf } from '../../src/control/read.js';
import { readEngines } from '../../src/control/state.js';
import { stopStarted } from '../../src/control/stop.js';
import { until } from '../support/until.js';

const step = f => f.variation()['harness-status'].state;
const working = f => f.assignments().assignments.map(a => a['work-item']).toSorted();
const engineFile = f => join(f.dir, 'engines', 'example-development', 'state-engine.json');
// The fixture with its agents held at work (FAKE_HOLD) while fn runs (as tick-drain.test.js).
async function held(fn) {
  const f = controlFixture();
  process.env.FAKE_OUTPUT = '{"is-approved":true}';
  process.env.FAKE_HOLD = join(f.dir, 'hold');
  writeFileSync(process.env.FAKE_HOLD, '');
  try { return await fn(f); } finally { delete process.env.FAKE_HOLD; delete process.env.FAKE_OUTPUT; f.ctx.stopAgents(); }
}

test('ASS-460 AC3, ASS-458 AC1: readJson reads again a file caught empty, half-written or gone with its folder, and fails as before once it stays bad; a file that parses is read once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-json-'));
  const file = join(dir, 'a.json');
  const reads = texts => { const seen = []; return [seen, f => { seen.push(f); const next = texts.shift(); if (next instanceof Error) throw next; return next; }]; };
  let [seen, read] = reads(['', '{"a":', '{"a":1}']);
  assert.deepEqual(readJson(file, [1, 1], read), { a: 1 });             // empty, then truncated, then whole
  assert.equal(seen.length, 3);
  [seen, read] = reads(['{"a":2}']);
  assert.deepEqual(readJson(file, [1, 1], read), { a: 2 });
  assert.equal(seen.length, 1);                                          // parses: read once
  [seen, read] = reads(['', '', '']);
  assert.throws(() => readJson(file, [1, 1], read), error => error instanceof SyntaxError && error.file === file);
  assert.equal(seen.length, 3);                                          // twice again, then it fails as it did
  // ENOENT: read again while its folder is gone (the drive), not when only the file is missing (data is written atomically).
  const gone = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  [seen, read] = reads([gone(), gone(), gone()]);
  assert.throws(() => readJson(join(dir, 'away', 'b.json'), [1, 1], read), { code: 'ENOENT' });
  assert.equal(seen.length, 3);
  [seen, read] = reads([gone(), gone()]);
  assert.throws(() => readJson(file, [1, 1], read), { code: 'ENOENT' });
  assert.equal(seen.length, 1);
  // Real files: the default delays add up to 200 ms at most.
  writeFileSync(file, '');
  const began = Date.now();
  assert.throws(() => readJson(file), SyntaxError);
  assert.ok(Date.now() - began < 1000);
});

test('ASS-460 AC3, ASS-458 AC4: an engine that fails to read is its last good copy, marked stale; one never read well throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engines-'));
  mkdirSync(join(dir, 'e'));
  const file = join(dir, 'e', 'state-engine.json');
  writeFileSync(file, JSON.stringify({ steps: [{ id: 'one' }] }));
  assert.deepEqual(readEngines(dir), { e: { steps: [{ id: 'one' }] } });
  writeFileSync(file, '');                                               // a merge rewriting it in place
  const stale = [];
  assert.deepEqual(readEngines(dir, [], stale), { e: { steps: [{ id: 'one' }] } });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].file, file);
  writeFileSync(file, JSON.stringify({ steps: [{ id: 'two' }] }));        // only a change that parses replaces it
  assert.deepEqual(readEngines(dir, [], []), { e: { steps: [{ id: 'two' }] } });
  mkdirSync(join(dir, 'new'));
  writeFileSync(join(dir, 'new', 'state-engine.json'), '{"steps": [');
  assert.throws(() => readEngines(dir), SyntaxError);
});

test('ASS-460 AC1: a checkRateLimits load that throws is logged under its phase, and the tick goes on', async () => {
  const f = controlFixture();
  const load = f.ctx.load;
  f.ctx.load = () => { if (new Error().stack.includes('checkRateLimits')) throw new Error('boom'); return load(); };
  await tick(f.ctx);
  assert.ok(f.lines.includes('error hold check: boom'), f.lines.join('\n'));
  assert.equal(step(f), 'plan');                                         // the steps phase, after it, ran
});

test('ASS-460 AC1: the drain\'s loads are guarded: a restart asked for while the data cannot be read still drains, logging it', () => {
  const f = controlFixture();
  f.ctx.load = () => { throw new Error('boom'); };
  startDrain(f.ctx);
  assert.equal(f.ctx.drain.seconds, 300);
  assert.equal(drained(f.ctx), false);                                   // others unknown: it waits, up to the limit
  assert.ok(f.lines.includes('error restart drain: boom; draining for up to 300s'), f.lines.join('\n'));
  f.ctx.drain.until = 0;
  assert.equal(drained(f.ctx), true);
});

test('ASS-457 AC1, AC3: with assignments.json, then the whole data folder, missing a tick does nothing but say so once; once it reads the tick runs and says it recovered', async () => {
  const f = controlFixture();
  const file = join(f.dir, 'assignments.json');
  renameSync(file, `${file}.away`);
  await tick(f.ctx);
  await tick(f.ctx);
  const waiting = f.lines.filter(l => l.startsWith('data '));
  assert.equal(waiting.length, 1, f.lines.join('\n'));                   // once, not every tick
  assert.match(waiting[0], new RegExp(`^data waiting: cannot read ${file} \\(ENOENT: .*\\); control skips its ticks until it reads, and exits if it cannot for 300s$`));
  assert.equal(step(f), 'backlog');                                      // no phase ran on what it could read
  assert.ok(!f.lines.some(l => l.startsWith('error ')), f.lines.join('\n'));
  renameSync(`${file}.away`, file);
  renameSync(f.dir, `${f.dir}.away`);                                    // the drive gone: every file of it
  try { await tick(f.ctx); } finally { renameSync(`${f.dir}.away`, f.dir); }
  assert.equal(f.ctx.dataExit, undefined);
  await tick(f.ctx);
  assert.match(f.lines.findLast(l => l.startsWith('data ')), /^data recovered: it reads again after \d+s \(.*\); control carries on with its agents, VMs and workstations$/);
  assert.equal(step(f), 'plan');
});

test('ASS-457 AC2, ASS-458 AC3: data that stays unreadable past data-unreadable-exit-seconds tells control to exit, naming the file and why', async () => {
  const f = controlFixture();
  writeFileSync(join(f.dir, 'harness.json'), JSON.stringify({ ...f.harness(), 'data-unreadable-exit-seconds': 60 }));
  let clock = Date.now();
  f.ctx.now = () => new Date(clock);
  await tick(f.ctx);                                                     // a good load: the limit read
  const project = join(f.dir, 'projects', 'p', 'project.json'), good = readFileSync(project, 'utf8');
  writeFileSync(project, good.slice(0, 20));                             // a corrupt file: still reported, naming it
  await tick(f.ctx);
  assert.match(f.lines.findLast(l => l.startsWith('data ')), new RegExp(`^data waiting: cannot read ${project} \\(.*JSON.*\\); .* for 60s$`));
  clock += 59_000;
  await tick(f.ctx);
  assert.equal(f.ctx.dataExit, undefined);
  clock += 2_000;
  await tick(f.ctx);
  assert.match(f.ctx.dataExit, new RegExp(`^its data has not read for 61s, over data-unreadable-exit-seconds \\(60s\\): ${project} \\(`));
});

test('ASS-458 AC2, AC4, AC6: an engine caught truncated across ticks is its last good copy and the tick goes on, said once; one never read well skips the tick until it parses', async () => {
  const f = controlFixture();
  await tick(f.ctx);                                                     // read well once
  const file = engineFile(f), good = readFileSync(file, 'utf8');
  writeFileSync(file, good.slice(0, 100));
  const at = f.lines.length;
  await tick(f.ctx);
  await tick(f.ctx);
  const said = f.lines.slice(at).filter(l => l.startsWith('engines '));
  assert.equal(said.length, 1, f.lines.join('\n'));
  assert.match(said[0], new RegExp(`^engines ${file} could not be read \\(.*\\): its last good copy is used until it reads again$`));
  assert.ok(!f.lines.slice(at).some(l => l.startsWith('data ')));
  writeFileSync(file, good);
  await tick(f.ctx);
  assert.equal(f.lines.findLast(l => l.startsWith('engines ')), `engines ${file} reads again`);
  // A fresh control's first read of a truncated engine: no last good copy, the tick skipped, no exit.
  const g = controlFixture();
  writeFileSync(engineFile(g), good.slice(0, 100));
  await tick(g.ctx);
  assert.match(g.lines.find(l => l.startsWith('data ')), new RegExp(`^data waiting: cannot read ${engineFile(g)} \\(`));
  assert.equal(step(g), 'backlog');
  writeFileSync(engineFile(g), good);
  await tick(g.ctx);
  assert.equal(step(g), 'plan');
  assert.match(g.lines.findLast(l => l.startsWith('data ')), /^data recovered: /);
});

test('ASS-457 AC3, ASS-458 AC5: a running agent is neither stopped, nor dispatched again, nor taken as stale while the data cannot be read', async () => {
  await held(async f => {
    await tick(f.ctx);
    assert.deepEqual(working(f), ['ABC-3']);
    const [live] = f.ctx.agents.values();
    const file = join(f.dir, 'assignments.json');
    renameSync(file, `${file}.away`);
    await tick(f.ctx);
    await tick(f.ctx);
    renameSync(`${file}.away`, file);
    assert.equal(live.exited, null);
    process.kill(live.agent.pid, 0);                                      // still running
    await tick(f.ctx);
    assert.deepEqual(working(f), ['ABC-3']);                              // one assignment, not two
    assert.equal(f.ctx.agents.size, 1);
    assert.ok(!f.lines.some(l => /stale|shut down|killed/.test(l)), f.lines.join('\n'));
  });
});

test('ASS-457 AC4: a write failing for the data folder being gone is the data\'s trouble; one failing with the folder there is the phase\'s own error', () => {
  const f = controlFixture();
  const failed = new Error(`agent.sh ticket:move p ABC-3: Error: ENOENT: no such file or directory, open '${join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json.tmp')}'`);
  assert.equal(troubleOf(f.ctx, failed), null);                          // the folder answers: not the drive
  renameSync(f.dir, `${f.dir}.away`);
  try {
    assert.deepEqual(troubleOf(f.ctx, failed), { file: join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json.tmp'), reason: failed.message });
    assert.equal(troubleOf(f.ctx, new Error('ENOENT: no such file or directory, open \'/elsewhere/x\'')), null);   // not under the data
  } finally { renameSync(`${f.dir}.away`, f.dir); }
});

test('ASS-460 AC5: stopStarted SIGTERMs every agent\'s group and SIGKILLs one still running after the grace', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise(resolve => child.stdout.once('data', resolve));
  const live = { name: 'Stubborn', exited: false, agent: { pid: child.pid, stop: () => process.kill(-child.pid, 'SIGTERM') } };
  child.once('exit', () => { live.exited = true; });
  const said = [];
  const ctx = { agents: new Map([['Stubborn', live]]), scripts: new Set(), stopAgents: () => live.agent.stop(), stopScripts: () => {} };
  try {
    await ready;                                                           // its SIGTERM handler set
    await stopStarted(ctx, (phase, text) => said.push(`${phase} ${text}`), 300);
    assert.deepEqual(said, ['shutdown stopping 1 agent', 'shutdown Stubborn killed']);
    assert.ok(await until(() => live.exited));
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ended */ } }
});
