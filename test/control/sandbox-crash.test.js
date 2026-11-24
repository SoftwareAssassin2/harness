// ASS-568: a crashed Substrate sandbox (after a Docker Desktop or cluster node restart, or a lost snapshot) is replaced
// automatically instead of sending its ticket to Blocked — control's side (sandboxes.js). ctx.cli stands in for the
// substrate:sandbox-* commands (their own side, on a fake cluster with the fake command server, is
// test/agent-cli/substrate-crash.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxActor } from '../../src/control/machine-substrate.js';
import { sandboxWaits, sandboxUp, isCrash, lostWork } from '../../src/control/sandboxes.js';
import { ticketKey, BLOCK_AFTER } from '../../src/control/backoff.js';
import { runSteps } from '../../src/control/steps.js';
import { ticketLines } from '../../src/tui/ticket.js';
import { controlFixture } from './control-fixture.js';

const engine = { steps: [
  { id: 'build', sequence: 2, 'run-location': 'vm', action: { type: 'prompt', prompt: 'p' }, 'exit-events': [{ condition: { 'turn-complete': true }, 'move-to-state': 'done' }] },
  { id: 'done', sequence: 9, 'is-done': true, action: { type: 'none' } },
] };
const build = engine.steps[0];
const CRASH = 'agent.sh substrate:sandbox-up p ABC-3 A mac: substrate:sandbox-up: the sandbox abc-3-a on mac has crashed (crashed: worker restarted while hosting the actor): it cannot be resumed; control replaces it';
const crashError = (message = CRASH, code = 4) => Object.assign(new Error(message), { code });

// A fake control context: ctx.cli answers the substrate:sandbox-* commands as they would, keeping each variation's
// record; `crashed` the variations (`<KEY> <var>`) whose sandbox has crashed: sandbox-up exits 4 for them, as the
// real one does, until it is deleted. `fail(args)` throws for any command it gives an error for.
function fakeCtx({ fail = () => null, salvage = { salvaged: false, salvage: 'its files cannot be read: its command server does not answer' }, paths } = {}) {
  const calls = [], lines = [], records = new Map(), crashed = new Set(), appended = [];
  let now = Date.parse('2026-11-23T21:18:00Z');
  const ctx = {
    memory: { warned: new Set(), backoff: new Map() }, calls, lines, records, crashed, appended, paths,
    now: () => new Date(now), later: ms => { now += ms; },
    log: (phase, text) => lines.push(`${phase} ${text}`),
    cli: async args => {
      calls.push(args.join(' '));
      const why = fail(args);
      if (why) throw why instanceof Error ? why : new Error(why);
      const [command, project, key, variation, machine] = args, k = `${key} ${variation}`;
      const at = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z');
      if (command === 'substrate:sandbox-up') {
        if (crashed.has(k)) throw crashError();
        const was = records.get(k);
        const r = { ...(was ?? { name: sandboxActor(key, variation), project, machine, template: 'sandbox-dddddddddddd', 'created-at': at }), state: 'running', at };
        records.set(k, r);
        return `${JSON.stringify({ ...r, machine: `substrate:${project}:${machine}:${r.name}`, host: machine, created: !was, branches: [] })}\n`;
      }
      if (command === 'substrate:sandbox-delete') {
        records.delete(k); crashed.delete(k);
        return `${JSON.stringify({ deleted: true, name: sandboxActor(key, variation), branches: salvage.branches ?? [], ...(args[4] === '--salvage' ? salvage : {}) })}\n`;
      }
      if (command === 'work:append') { appended.push({ args, text: readFileSync(args[5], 'utf8') }); return ''; }
      if (command === 'substrate:stack-up') return '{"stack":false}\n';
      return '';
    },
  };
  return ctx;
}
const settle = () => new Promise(r => setTimeout(r, 0));
async function drain(ctx) { for (let i = 0; i < 20; i++) await settle(); for (const r of ctx.memory.sandboxes?.values() ?? []) if (r.job) await r.job; }
const hibernated = { name: 'abc-3-a', project: 'p', machine: 'mac', template: 'sandbox-dddddddddddd', state: 'stopped', 'created-at': '2026-11-23T10:00:00Z', at: '2026-11-23T20:00:00Z' };
function setup(ctx, sandbox = hibernated) {
  const v = { name: 'A', 'harness-status': { state: 'build', 'state-engine': 'e' }, 'state-changes': [{ to: 'build' }], sandbox: { ...sandbox } };
  ctx.records.set('ABC-3 A', { ...sandbox });
  const t = { key: 'ABC-3', variations: [v] };
  const project = { id: 'p', engine, tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  // The next tick's load: the variation's record as the commands left it.
  const reload = () => { const r = ctx.records.get('ABC-3 A'); if (r) v.sandbox = { ...r }; else delete v.sandbox; };
  return { v, t, project, reload, held: ticketKey('p', 'ABC-3', 'A', 'build') };
}

test('AC1: a resume refused because the actor is crashed is recognised as a crash, not counted as a failure; the sandbox is deleted (salvaged first) and a new one made at the next try', async () => {
  const ctx = fakeCtx();
  const { v, t, project, reload, held } = setup(ctx);
  ctx.crashed.add('ABC-3 A');
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), true, 'the step waits');
  await drain(ctx);
  assert.deepEqual(ctx.calls.filter(c => c.startsWith('substrate:')), ['substrate:sandbox-up p ABC-3 A mac', 'substrate:sandbox-delete p ABC-3 A --salvage']);
  assert.equal(ctx.memory.backoff.get(held), undefined, 'no failure of the step counted');
  assert.ok(!ctx.lines.some(l => /could not be (resumed|brought up)/.test(l)), ctx.lines.join('\n'));
  assert.ok(!ctx.records.has('ABC-3 A'), 'deleted');
  // The next tick: no sandbox recorded, so a new one is made at once (no backoff), and its stack brought up.
  reload();
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), true);
  await drain(ctx);
  assert.deepEqual(ctx.calls.filter(c => c.startsWith('substrate:')).slice(2), ['substrate:sandbox-up p ABC-3 A mac', 'substrate:stack-up p ABC-3 A --after created 0']);
  assert.ok(ctx.lines.some(l => /^sandbox ABC-3 A: its sandbox abc-3-a is up on the Mac \(made from sandbox-dddddddddddd\)/.test(l)), ctx.lines.join('\n'));
  reload();
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'ABC-3 A build', held), false, 'up: the step goes on');
  assert.equal(ctx.memory.backoff.get(held), undefined);
});

test('AC1: the machine layer\'s word for a crash (Substrate\'s ACTOR_STATE_CRASHED, on-machine "has crashed") is recognised too, at any exit code; other failures are not', () => {
  assert.equal(isCrash(crashError('x', 4)), true);
  assert.equal(isCrash(crashError('kubectl ate resume actor ass-562-a failed: Error: failed to resume actor: rpc error: code = FailedPrecondition desc = AssignWorker prerequisite not met for Actor: harness-harness/ass-562-a (got: ACTOR_STATE_CRASHED, want ACTOR_STATE_SUSPENDED)', 1)), true);
  assert.equal(isCrash(crashError('substrate: crashed: the sandbox abc-3-a has crashed (crashed)', 1)), true);
  assert.equal(isCrash(crashError('kubectl ate resume actor abc-3-a failed: no worker has room', 1)), false);
  assert.equal(isCrash(crashError('the stack failed', 3)), false);
});

test('AC1, AC5 (the rule): two failed resumes, then the crash — replaced without a third failure counted, so the ticket is not sent to Blocked', async () => {
  let refuse = 2;
  const ctx = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-up' && refuse-- > 0 ? 'could not be resumed: kubectl ate resume actor abc-3-a failed: timeout' : null) });
  const { v, t, project, reload, held } = setup(ctx);
  for (let n = 1; n <= 2; n++) {
    sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
    await drain(ctx);
    assert.equal(ctx.memory.backoff.get(held).failures, n);
    ctx.later(60 * 60e3);
  }
  ctx.crashed.add('ABC-3 A');
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.equal(ctx.memory.backoff.get(held).failures, 2, 'the crash is not the third');
  assert.ok(!ctx.memory.toBlock?.has(held), 'not queued for Blocked');
  reload();
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  reload();
  assert.equal(sandboxUp(ctx, project, t, v), true, 'its new sandbox is up');
});

test('AC1: a sandbox seen up that its cluster\'s check (after that) finds crashed is not taken as up: the next step brings it up, and so replaces it', async () => {
  const ctx = fakeCtx();
  const { v, t, project, reload, held } = setup(ctx, { ...hibernated, state: 'running' });
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  reload();
  assert.equal(sandboxUp(ctx, project, t, v), true);
  // A check taken before it was seen up says nothing new.
  project.substrate = { mac: { 'checked-at': '2026-11-23T21:00:00Z', usage: { 'sandbox-use': { 'abc-3-a': { state: 'crashed' } } } } };
  assert.equal(sandboxUp(ctx, project, t, v), true);
  // Docker restarted: the next check measures it crashed.
  ctx.later(5 * 60e3);
  ctx.crashed.add('ABC-3 A');
  project.substrate.mac['checked-at'] = ctx.now().toISOString();
  assert.equal(sandboxUp(ctx, project, t, v), false);
  assert.equal(sandboxWaits(ctx, {}, project, t, v, build, 'w', held), true);
  await drain(ctx);
  assert.ok(ctx.calls.includes('substrate:sandbox-delete p ABC-3 A --salvage'), ctx.calls.join('\n'));
  assert.equal(ctx.memory.backoff.get(held), undefined);
});

test('AC2: --salvage is asked for before the delete; whether its branches were pushed or not, the replacement goes ahead and says what was saved', async () => {
  // Its files could be read: --salvage pushed its branches through the Mac.
  const saved = fakeCtx({ salvage: { salvaged: true, salvage: null, branches: [{ repo: 'harness', branch: 'change/ABC-3-1' }] } });
  let s = setup(saved);
  saved.crashed.add('ABC-3 A');
  sandboxWaits(saved, {}, s.project, s.t, s.v, build, 'w', s.held);
  await drain(saved);
  assert.ok(saved.lines.some(l => l === 'sandbox ABC-3 A: its sandbox on the Mac had crashed (crashed: worker restarted while hosting the actor); replaced. Lost: nothing: its branches were pushed through the Mac first (harness on change/ABC-3-1)'), saved.lines.join('\n'));
  // They could not: deleted all the same.
  const lost = fakeCtx();
  s = setup(lost);
  lost.crashed.add('ABC-3 A');
  sandboxWaits(lost, {}, s.project, s.t, s.v, build, 'w', s.held);
  await drain(lost);
  assert.ok(lost.calls.includes('substrate:sandbox-delete p ABC-3 A --salvage'));
  assert.ok(!lost.records.has('ABC-3 A'), 'replaced anyway');
  assert.match(lost.lines.find(l => /had crashed/.test(l)), /— its files cannot be read: its command server does not answer$/);
  // A delete that fails is a failure of the step (the usual rule), the crash said in it.
  const stuck = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-delete' ? 'mac is not connected' : null) });
  s = setup(stuck);
  stuck.crashed.add('ABC-3 A');
  sandboxWaits(stuck, {}, s.project, s.t, s.v, build, 'w', s.held);
  await drain(stuck);
  assert.equal(stuck.memory.backoff.get(s.held).failures, 1);
  assert.match(stuck.lines.at(-1), /could not be resumed \(1 in a row; .*had crashed \(crashed: worker restarted while hosting the actor\) and could not be deleted to be replaced/);
});

test('AC3: lostWork judges what was lost from the commits record (ASS-558) and the step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lost-'));
  const ctx = { paths: { projects: dir } };
  const project = { id: 'p' }, ticket = { key: 'ABC-3' }, v = { name: 'A', 'harness-status': { state: 'generate-solution' } };
  assert.match(lostWork(ctx, project, ticket, v, { salvaged: false }), /^not known \(no commits record yet\): whatever it had committed and not pushed, or left uncommitted in generate-solution$/);
  mkdirSync(join(dir, 'p', 'work', 'ABC-3'), { recursive: true });
  writeFileSync(join(dir, 'p', 'work', 'ABC-3', 'commits-A.json'), JSON.stringify({ commits: [
    { sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-11-23T10:00:00Z', subject: 'ABC-3: first', state: 'pushed' },
    { sha: 'b'.repeat(40), short: 'bbbbbbb', date: '2026-11-23T11:00:00Z', subject: 'ABC-3: the plan step', state: 'open-mr' },
    { sha: 'c'.repeat(40), short: 'ccccccc', date: '2026-11-23T12:00:00Z', subject: 'ABC-3: wip', state: 'local' },
  ] }));
  assert.equal(lostWork(ctx, project, ticket, v, { salvaged: false, salvage: 'its files cannot be read' }),
    '1 commit not on the forge (ccccccc ABC-3: wip); whatever it had committed after bbbbbbb "ABC-3: the plan step" (2026-11-23 11:00 UTC), the variation\'s last commit on the forge, or left uncommitted in generate-solution — its files cannot be read');
  writeFileSync(join(dir, 'p', 'work', 'ABC-3', 'commits-A.json'), JSON.stringify({ commits: [] }));
  assert.match(lostWork(ctx, project, ticket, v, null), /none of the variation's commits is on the forge yet/);
});

test('AC3: the replacement is logged once per sandbox with what was lost, written to the change log, and shown on the ticket screen (control on the fixture, the real work:append and ticket:add-ai-notice)', async () => {
  const f = controlFixture();
  const real = f.ctx.cli;
  const fake = fakeCtx({ paths: f.ctx.paths });
  const ctx = { ...fake, paths: f.ctx.paths, cli: args => (/^(work:append|ticket:add-ai-notice)$/.test(args[0]) ? real(args) : fake.cli(args)) };
  const { v, t, project, held } = setup(fake);
  mkdirSync(join(f.ctx.paths.projects, 'p', 'work', 'ABC-3'), { recursive: true });   // a ticket in progress has its work folder
  fake.crashed.add('ABC-3 A');
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  const said = fake.lines.filter(l => /had crashed/.test(l));
  assert.equal(said.length, 1);
  assert.match(said[0], /^sandbox ABC-3 A: its sandbox on the Mac had crashed \(crashed: worker restarted while hosting the actor\); replaced\. Lost: not known \(no commits record yet\)/);
  // Its change log.
  const log = readFileSync(join(f.ctx.paths.projects, 'p', 'work', 'ABC-3', 'change-log-A.md'), 'utf8');
  assert.match(log, /^### 2026-11-23T21:18:00Z Sandbox replaced\nIts Substrate sandbox abc-3-a on the Mac had crashed \(crashed: worker restarted while hosting the actor\).*Lost: not known/m);
  // Its notice, on the ticket screen's Health.
  const notices = f.variation()['ai-notices'];
  assert.equal(notices.length, 1);
  assert.equal(notices[0].source, 'sandbox');
  const details = ticketLines({ key: 'ABC-3', title: 'T', variation: f.variation() }, { status: 'Build', stepName: id => id, prompted: () => false, agents: [], columns: 400 }).details.join('\n');
  assert.match(details, /Health.*Notice \(.* UTC, sandbox\): Its Substrate sandbox abc-3-a on the Mac had crashed/);
  // The same sandbox's replacement said again (its delete retried): not logged twice.
  fake.records.set('ABC-3 A', { ...hibernated }); fake.crashed.add('ABC-3 A');
  const r = ctx.memory.sandboxes.values().next().value;
  r.replaced = false;
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.equal(fake.lines.filter(l => /had crashed/.test(l)).length, 1, 'once per sandbox');
});

test('AC4: if the new sandbox cannot be made, the usual 3-in-a-row rule sends the ticket to Blocked', async () => {
  const f = controlFixture();
  const at = f.variation()['harness-status'].state;
  const key = ticketKey('p', 'ABC-3', 'A', at);
  const fake = fakeCtx({ fail: a => (a[0] === 'substrate:sandbox-up' && !fake.crashed.size ? 'substrate:sandbox-up: kubectl ate create actor abc-3-a failed: no template' : null) });
  const ctx = { ...fake, memory: f.ctx.memory };
  ctx.memory.backoff ??= new Map();
  const v = { ...f.variation(), sandbox: { ...hibernated } };
  const t = { key: 'ABC-3', variations: [v] };
  const project = { id: 'p', engine, tickets: [t], seats: [{ key: 'ABC-3', variation: 'A', kind: 'vm', target: 'local-substrate' }] };
  fake.crashed.add('ABC-3 A');
  sandboxWaits(ctx, {}, project, t, v, build, 'w', key);
  await drain(ctx);
  assert.equal(ctx.memory.backoff.get(key), undefined, 'the crash: replaced, not counted');
  delete v.sandbox;
  for (let n = 1; n <= BLOCK_AFTER; n++) {
    fake.later(60 * 60e3);
    sandboxWaits(ctx, {}, project, t, v, build, 'w', key);
    await drain(ctx);
    assert.equal(ctx.memory.backoff.get(key).failures, n);
  }
  assert.match(fake.lines.at(-1), new RegExp(`could not be brought up \\(${BLOCK_AFTER} in a row; to Blocked`));
  await runSteps(f.ctx, f.ctx.load());
  assert.equal(f.variation()['harness-status'].state, 'blocked');
});

test('AC4: a sandbox that crashes again before any bring-up worked since its replacement is replaced again, and that time counted (no endless loop)', async () => {
  const ctx = fakeCtx();
  const { v, t, project, reload, held } = setup(ctx);
  ctx.crashed.add('ABC-3 A');
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.equal(ctx.memory.backoff.get(held), undefined);
  // Made again, but crashed before it answered (sandbox-up exits 4 for the new one too).
  reload();
  ctx.records.set('ABC-3 A', { ...hibernated, 'created-at': '2026-11-23T21:19:00Z' }); ctx.crashed.add('ABC-3 A'); reload();
  sandboxWaits(ctx, {}, project, t, v, build, 'w', held);
  await drain(ctx);
  assert.equal(ctx.memory.backoff.get(held).failures, 1, 'counted');
  assert.equal(ctx.lines.filter(l => /had crashed/.test(l)).length, 2, 'each sandbox said once');
  assert.match(ctx.lines.at(-1), /crashed again before any bring-up worked/);
});
