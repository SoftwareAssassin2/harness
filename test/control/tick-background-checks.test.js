// ASS-497: the periodic checks that call out — reverts (reverts.js), the
// gcloud and glab logins (triggers.js), Claude usage (usage.js), API cost
// (api-cost.js) and push account (push-account.js) — run their outside calls
// as background jobs the tick does not await (background-checks.js), at most
// one in flight per check and project; reverts' forge calls a few at a time;
// stopped cleanly on shutdown. Every outside call here is a fake: gh a script
// on PATH, the rest the context's functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { detectReverts, FORGE_CALLS_AT_ONCE } from '../../src/control/reverts.js';
import { checkGlab } from '../../src/control/triggers.js';
import { checksRunning, settleChecks, stopChecks } from '../../src/control/background-checks.js';
import { stopStarted } from '../../src/control/stop.js';
import { until, within, LOADED_MS } from '../support/until.js';

const HOUR = 3600e3, MINUTE = 60e3;
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json, null, 4)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// A fake gh on PATH: each call logged (calls()), counted while it runs (peak(): the most at once), answering [] after
// `ms` (once `hold` is removed, while there is one); a repository under /bad/ fails.
function fakeGh(dir) {
  const bin = join(dir, 'bin'), running = join(dir, 'running');
  for (const d of [bin, running]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), dir = ${JSON.stringify(dir)}, args = process.argv.slice(2).join(' ');
fs.appendFileSync(path.join(dir, 'gh.log'), args + '\\n');
const me = path.join(dir, 'running', String(process.pid));
fs.writeFileSync(me, '');
fs.appendFileSync(path.join(dir, 'peaks'), fs.readdirSync(path.join(dir, 'running')).length + '\\n');
const ms = Number(fs.readFileSync(path.join(dir, 'ms'), 'utf8'));
const done = () => {
  fs.rmSync(me, { force: true });
  if (/\\/bad\\//.test(args)) { process.stderr.write('HTTP 502'); process.exit(1); }
  process.stdout.write('[]\\n');
  process.exit(0);
};
const wait = () => (fs.existsSync(path.join(dir, 'hold')) ? setTimeout(wait, 20) : setTimeout(done, ms));
wait();
`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(dir, 'ms'), '0');
  const lines = file => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n') : []);
  return {
    path: `${bin}:${process.env.PATH}`,
    calls: () => lines('gh.log'),
    peak: () => Math.max(0, ...lines('peaks').map(Number)),
    slow: ms => writeFileSync(join(dir, 'ms'), String(ms)),
    hold: on => (on ? writeFileSync(join(dir, 'hold'), '') : rmSync(join(dir, 'hold'), { force: true })),
  };
}

// The control fixture with every check on for p: its repositories `repositories` (GitHub, asked through the fake gh),
// check-memory-steps (so reverts are looked for), the gcloud and glab login checks, a push token declared; the
// clock an hour past control's start (reverts due). Each of ctx's outside calls answers once `gate` is opened.
function checking({ repositories = ['https://github.com/o/app'] } = {}) {
  const f = controlFixture();
  const dir = mkdtempSync(join(tmpdir(), 'checks-'));
  const gh = fakeGh(dir);
  writeFileSync(join(dir, 'vm-credentials.json'), JSON.stringify({ p: { github: { 'keychain-service': 'GitHub PAT' } } }));
  f.ctx.env = { ...f.env, PATH: gh.path, HARNESS_HOME: dir };
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => {
    e['check-memory-steps'] = [{ id: 'check-memory', sequence: 1, action: { type: 'state-engine', engine: 'investigate-gap' }, 'exit-events': [{ condition: { 'is-done': true } }] }];
  });
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => {
    p.repositories = repositories.map(url => ({ url }));
    p['check-for-expired-glab-auth'] = true;
    p['check-for-expired-gcloud-auth'] = true;
  });
  let clock = f.ctx.started.getTime() + HOUR;
  f.ctx.now = () => new Date(clock);
  const gate = deferred(), asked = [];
  const answer = (name, value) => async (...args) => { asked.push(name); await gate.promise; return typeof value === 'function' ? value(...args) : value; };
  f.ctx.glab = answer('glab', 'expired');
  f.ctx.gcloud = answer('gcloud', 'live');
  f.ctx.usage = answer('usage', { percent: 7, resetsAt: '2026-10-15T13:00:00Z', weekly: null });
  f.ctx.apiCost = answer('apiCost', { month: '2026-10', usd: 3 });
  f.ctx.pushAccount = answer('pushAccount', 'ada');
  const file = (...rest) => join(f.dir, 'projects', 'p', ...rest);
  const json = name => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : undefined);
  return { f, gh, gate, asked, file, json, later: ms => { clock += ms; } };
}
const ALL = ['checkApiCost/harness', 'checkGcloud/p', 'checkGlab/p', 'checkPushAccount/p', 'checkUsage/p', 'detectReverts/p'];

test('ASS-497 AC1, AC2, AC6: a tick starts every due check in the background and returns without waiting for any outside call; a check in flight is not started again; once they answer, each records what it did before', async () => {
  const { f, gh, gate, asked, file, json, later } = checking();
  gh.hold(true);
  await f.agent('assignments:pause', 'all', 'human');                 // nothing dispatched
  await tick(f.ctx);                                                     // returns while every outside call waits
  assert.deepEqual(checksRunning(f.ctx).sort(), ALL);
  assert.ok(await until(() => gh.calls().length === 1 && asked.length === 5), `${gh.calls()} ${asked}`);
  assert.equal(existsSync(file('glab-requires-reauthentication')), false);
  assert.equal(json('push-account.json'), undefined);
  assert.equal(json('revert-checks.json'), undefined);

  later(3 * MINUTE);                                                     // logins and usage due again; each still in flight
  await tick(f.ctx);
  later(HOUR);                                                           // every check due again
  await tick(f.ctx);
  assert.deepEqual(asked.sort(), ['apiCost', 'gcloud', 'glab', 'pushAccount', 'usage'], 'none asked twice');
  assert.equal(gh.calls().length, 1, 'the forge not asked twice');

  gate.resolve();
  gh.hold(false);
  await settleChecks(f.ctx);
  assert.deepEqual(checksRunning(f.ctx), []);
  assert.equal(readFileSync(file('glab-requires-reauthentication'), 'utf8'), 'true');
  assert.equal(json('push-account.json')?.account, 'ada');
  assert.equal(json('claude-usage.json')?.session?.percent, 7);
  assert.equal(JSON.parse(readFileSync(f.env.API_COST_FILE, 'utf8')).usd, 3);
  assert.deepEqual(Object.keys(json('revert-checks.json')), ['https://github.com/o/app']);
  assert.ok(f.lines.includes("glab p: the glab login has expired; run 'glab auth login'"), f.lines.join('\n'));

  later(HOUR);                                                           // finished: due again, so started again
  await tick(f.ctx);
  await settleChecks(f.ctx);
  assert.equal(asked.filter(a => a === 'glab').length, 2);
  assert.equal(gh.calls().length, 2);
});

test('ASS-497 AC1: detectReverts asks the forge FORGE_CALLS_AT_ONCE repositories at a time; each answer is marked checked, a failed one logged with its last check kept', async () => {
  assert.equal(FORGE_CALLS_AT_ONCE, 4);
  const repositories = [...Array.from({ length: 9 }, (_, i) => `https://github.com/o/app${i}`), 'https://github.com/bad/app'];
  const { f, gh, json } = checking({ repositories });
  const before = '2026-01-01T00:00:00Z';
  writeFileSync(join(f.dir, 'projects', 'p', 'revert-checks.json'), JSON.stringify({ 'https://github.com/bad/app': before }));
  // ASS-545: the calls held until FORGE_CALLS_AT_ONCE of them are under way at once, then let go — in place of each
  // answering after 300 ms, which on a loaded Mac could end one before the next had started.
  gh.hold(true);
  const asked = detectReverts(f.ctx, f.ctx.load());
  assert.ok(await until(() => gh.calls().length === FORGE_CALLS_AT_ONCE), 'the first calls under way together');
  gh.hold(false);
  await asked;
  assert.equal(gh.calls().length, 10);
  assert.ok(gh.peak() > 1, `in parallel (at most ${gh.peak()} at once)`);
  assert.ok(gh.peak() <= FORGE_CALLS_AT_ONCE, `never more than ${FORGE_CALLS_AT_ONCE} at once (${gh.peak()})`);
  const checked = json('revert-checks.json');
  assert.equal(checked['https://github.com/bad/app'], before);
  for (const url of repositories.slice(0, 9)) assert.equal(checked[url], f.ctx.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), url);
  assert.ok(f.lines.some(l => /^error reverts p https:\/\/github\.com\/bad\/app: gh api .*HTTP 502/.test(l)), f.lines.join('\n'));
});

test('ASS-497 AC5: a background check over the slow limit logs a timers line with how long it took; a quick one none', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['check-for-expired-glab-auth'] = true; });
  let clock = Date.parse('2026-10-14T12:00:00Z');
  f.ctx.now = () => new Date(clock);
  f.ctx.glab = async () => 'live';
  await checkGlab(f.ctx, f.ctx.load());
  assert.ok(!f.lines.some(l => l.startsWith('timers ')), f.lines.join('\n'));
  f.ctx.slowCheckMs = 50;
  f.ctx.glab = () => new Promise(resolve => setTimeout(() => resolve('live'), 120));
  clock += 3 * MINUTE;
  await checkGlab(f.ctx, f.ctx.load());
  assert.ok(f.lines.some(l => /^timers checkGlab\/p took \d+\.\ds in the background$/.test(l)), f.lines.join('\n'));
});

test('ASS-497 AC4, AC6: shutdown stops the background checks: the forge call in flight is ended, nothing is written after, no check is left running or started again', async () => {
  const { f, gh, gate, file, json, later } = checking();
  gh.hold(true);                                                        // ASS-545: a call that never answers until let go
  const say = (phase, detail) => f.ctx.log(phase, detail);
  const started = detectReverts(f.ctx, f.ctx.load());
  checkGlab(f.ctx, f.ctx.load());
  assert.ok(await until(() => gh.calls().length === 1), 'the forge is asked');
  setTimeout(() => gate.resolve(), 200);                                // the glab answer lands while control stops
  // ASS-545: the forge call never answers while held, so a shutdown that waited for it would never end; within() is a
  // hang guard only (LOADED_MS), in place of a 5 s limit.
  assert.notEqual(await within((async () => { await stopStarted(f.ctx, say); await started; })()), `still running after ${LOADED_MS}ms`, 'the forge call in flight was ended');
  gh.hold(false);
  assert.deepEqual(checksRunning(f.ctx), []);
  assert.equal(json('revert-checks.json'), undefined, 'nothing marked checked');
  assert.equal(existsSync(file('glab-requires-reauthentication')), false, 'the login flag not written after');
  assert.ok(f.lines.some(l => /^shutdown stopping 2 background checks \(detectReverts\/p, checkGlab\/p\)$/.test(l)), f.lines.join('\n'));
  assert.ok(!f.lines.some(l => l.startsWith('error ')), f.lines.join('\n'));
  later(HOUR);
  detectReverts(f.ctx, f.ctx.load());
  checkGlab(f.ctx, f.ctx.load());
  assert.deepEqual(checksRunning(f.ctx), [], 'none starts once stopping');
});

test('ASS-497 AC4: a check still running when the wait ends is logged and left, and starts no write after', async () => {
  const f = controlFixture();
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['check-for-expired-glab-auth'] = true; });
  const gate = deferred(), calls = [];
  f.ctx.glab = () => gate.promise;
  const cli = f.ctx.cli;
  f.ctx.cli = args => { calls.push(args.join(' ')); return cli(args); };
  const job = checkGlab(f.ctx, f.ctx.load());
  await stopChecks(f.ctx, f.ctx.log, 100);
  assert.ok(f.lines.includes('shutdown checkGlab/p still running after 0.1s: left, starting no write from now'), f.lines.join('\n'));
  gate.resolve('expired');
  await job;
  assert.deepEqual(calls, []);
});
