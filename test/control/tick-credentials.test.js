// The credentials check (ASS-395): at control's first tick and every few
// minutes per project, project:check-credentials checks every credential the
// project is declared to need; while one is missing or failing the hold
// (credentials-hold.json) keeps the project's new work — agents and VM
// setups — from starting, running agents finishing their turns, and lifts by
// itself once a check passes. The check runs the real command against a
// HOME of the test's and a fake `security` on PATH: never the real keychain.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { controlFixture } from './control-fixture.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { tick } from '../../src/control/tick.js';
import { until } from '../support/until.js';

const MINUTE = 60e3;
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const ITEM = 'Claude Token (Test)';

// The control fixture with the credentials check on: p declares one keychain
// item, ITEM, in a HOME of its own; `security` answers from a keychain folder
// (a file per item present). store(present) adds or removes ITEM; later(ms)
// moves the clock; every cli call recorded.
function checking() {
  const f = controlFixture();
  process.env.FAKE_HOLD = join(f.dir, 'hold');   // hold every dispatched agent's turn open
  writeFileSync(process.env.FAKE_HOLD, '');
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));
  const home = join(dir, 'home'), kc = join(dir, 'keychain'), bin = join(dir, 'bin');
  for (const d of [join(home, '.harness'), kc, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.harness', 'vm-credentials.json'), JSON.stringify({ p: { claude: { 'keychain-service': ITEM } } }));
  writeFileSync(join(bin, 'security'), `#!/usr/bin/env bash\n[[ -e "${kc}/$3" ]] || exit 44\n`);
  chmodSync(join(bin, 'security'), 0o755);
  const store = present => (present ? writeFileSync(join(kc, ITEM), 'x') : rmSync(join(kc, ITEM), { force: true }));
  f.ctx.env = { ...f.env, CREDENTIALS_CHECK_DISABLED: '0' };
  let now = Date.parse('2026-11-12T12:00:00Z');
  f.ctx.now = () => new Date(now);
  const cli = f.ctx.cli, calls = [];
  f.ctx.cli = (args, env) => {
    calls.push(args.join(' '));
    return args[0] === 'project:check-credentials' ? cli(args, { ...env, HOME: home, PATH: `${bin}:${process.env.PATH}` }) : cli(args, env);
  };
  const record = join(f.dir, 'projects', 'p', 'credentials-hold.json');
  return { f, store, calls, record, later: ms => { now += ms; } };
}
const checks = calls => calls.filter(c => c === 'project:check-credentials p').length;
const dispatched = f => f.assignments().assignments.filter(a => a['work-item'] === 'ABC-3');
const FIX = `security add-generic-password -U -s "${ITEM}" -a "$USER" -T /usr/bin/security -w "$(pbpaste)" (with the claude token copied)`;
const HOLD = `hold p blocked by credentials: none of its agents or VM setups start until they pass; running agents finish their turns — keychain item "${ITEM}" (claude): missing from the keychain — fix: ${FIX}`;
afterEach(() => { delete process.env.FAKE_HOLD; });

test('ASS-395 AC1: control checks the credentials at its first tick, then every 3 minutes per project; all present, nothing held and nothing said', async () => {
  const c = checking();
  c.store(true);
  await tick(c.f.ctx);
  assert.equal(checks(c.calls), 1);
  c.later(3 * MINUTE - 1000);
  await tick(c.f.ctx);
  assert.equal(checks(c.calls), 1);
  c.later(1000);
  await tick(c.f.ctx);
  assert.equal(checks(c.calls), 2);
  assert.equal(existsSync(c.record), false);
  assert.ok(!c.f.lines.some(l => l.startsWith('hold ')), c.f.lines.join('\n'));
  assert.equal(dispatched(c.f).length, 1, 'its work starts');
});

test('ASS-395 AC2/AC4/AC6: a missing credential holds the project — one problem recorded with its fix, logged once; no agent starts, a running one finishes its turn — and the hold lifts by itself once the check passes', async () => {
  const c = checking();
  c.store(true);
  await tick(c.f.ctx);                                          // the plan agent is dispatched
  assert.equal(dispatched(c.f).length, 1);
  const running = [...c.f.ctx.agents.keys()];
  c.store(false);
  c.later(3 * MINUTE);
  await tick(c.f.ctx);
  const hold = JSON.parse(readFileSync(c.record, 'utf8'));
  assert.deepEqual(hold.problems, [{ credential: `keychain item "${ITEM}" (claude)`, problem: 'missing from the keychain', fix: FIX }]);
  assert.ok(c.f.lines.includes(HOLD), c.f.lines.join('\n'));
  assert.deepEqual([...c.f.ctx.agents.keys()], running, 'the running agent is not stopped');
  rmSync(process.env.FAKE_HOLD);
  assert.ok(await until(() => [...c.f.ctx.agents.values()].every(a => a.result)), 'its turn ends');
  for (let i = 0; i < 3; i++) { c.later(MINUTE); await tick(c.f.ctx); }
  assert.deepEqual(dispatched(c.f), [], `no new agent while held\n${c.f.lines.join('\n')}`);
  assert.equal(c.f.lines.filter(l => l === HOLD).length, 1, 'logged once');
  assert.equal(JSON.parse(readFileSync(c.record, 'utf8')).since, hold.since, 'since kept');

  c.store(true);
  c.later(3 * MINUTE);
  await tick(c.f.ctx);
  assert.equal(existsSync(c.record), false);
  assert.ok(c.f.lines.includes("hold p's credentials pass again: the hold is lifted, its work resumes"), c.f.lines.join('\n'));
  assert.equal(dispatched(c.f).length, 1, 'its work resumes');
});

test('ASS-395 AC2: while held, a step that sets up a VM waits, never run, said once', async () => {
  const c = checking();
  c.f.ctx.env.CREDENTIALS_CHECK_DISABLED = '1';                  // the record as written stands
  writeFileSync(c.record, JSON.stringify({ since: '2026-11-12T11:00:00Z', problems: [{ credential: 'the gh login (github.com)', problem: 'gh is not authenticated on github.com', fix: 'gh auth login --hostname github.com' }] }));
  edit(join(c.f.dir, 'engines', 'example-development', 'state-engine.json'), e => {
    e.steps.find(s => s.id === 'build').action.command = './agent.sh vm:create {project} {ticket} {variation}';
  });
  edit(join(c.f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), s => {
    s.features[0].variations[0]['harness-status'] = hs('build');
    s.features[0]['ticket-system-status'] = 'In Progress';
  });
  for (let i = 0; i < 2; i++) await tick(c.f.ctx);
  assert.ok(!c.f.lines.some(l => /^script .*vm:create/.test(l)), c.f.lines.join('\n'));
  assert.equal(c.f.lines.filter(l => l === 'steps ABC-3 A build: waits: p is blocked by credentials').length, 1, c.f.lines.join('\n'));
  assert.equal(c.f.variation()['harness-status'].state, 'build');
});

test('ASS-395 AC1: a check that cannot be run is logged once per failure streak; the record stands', async () => {
  const c = checking();
  const cli = c.f.ctx.cli;
  c.f.ctx.cli = (args, env) => (args[0] === 'project:check-credentials' ? Promise.reject(new Error('agent.sh project:check-credentials p: boom')) : cli(args, env));
  for (let i = 0; i < 3; i++) { await tick(c.f.ctx); c.later(3 * MINUTE); }
  assert.equal(c.f.lines.filter(l => l.startsWith('error credentials p: ')).length, 1, c.f.lines.join('\n'));
});
