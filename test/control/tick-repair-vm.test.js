// ASS-427 AC8: Blocked's Repair the VM path through control's own tick, each
// way it goes. ABC-3 A is blocked at local-testing; its Blocked run starts at
// grouped-blocked's own repair-vm (Classify said vm), its agent the fake
// (FAKE_OUTPUT its structured output), and the steps after it are the
// engine's own: rebuild-source (vm:golden-followup), verify-image
// (vm:image-recheck) and, not fixable in place, await-golden-build
// (vm:golden-wait) — their scripts' answers faked, their calls recorded.
//   - fixed in place, the golden image's definition fixed and a rebuild
//     started: the ticket resumes as soon as the check passes on its VM,
//     never waiting on the build (no vm:golden-wait);
//   - a build already running: the definition change queued, the ticket
//     resumes all the same; control's golden follow-up phase then carries the
//     queue into the rebuild once that build ends (vm:golden-followup <p>);
//   - not fixable in place: today's path, the ticket waiting at Await the
//     Golden Build while a build runs;
//   - the VM-setup case (a registry declaration, no rebuild): resumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { controlFixture } from './control-fixture.js';
import { tick } from '../../src/control/tick.js';
import { hs } from '../agent-cli/harness-fixture.js';
import { engineDir } from '../support/engine-walk.js';
import { until } from '../support/until.js';
import { readEngine } from '../../src/workflow/engine-file.js';

const ROOT = join(import.meta.dirname, '..', '..');
const edit = (file, change) => { const json = JSON.parse(readFileSync(file, 'utf8')); change(json); writeFileSync(file, JSON.stringify(json)); };
const sprint = f => join(f.dir, 'projects', 'p', 'sprints', 'sprint-10', 'sprint.json');
const grouped = readEngine(join(engineDir('grouped-blocked'), 'workflow.yaml'));
const KEPT = ['repair-vm', 'rebuild-source', 'verify-image', 'await-golden-build', 'repair-image', 'done', 'retry', 'blocked-for-human'];
const SCRIPTS = ['vm:golden-followup', 'vm:image-recheck', 'vm:golden-wait'];
const VERIFIED = { exitCode: 0, stdout: JSON.stringify({ 'needs-fix': false, rechecked: true, 'recheck-passed': true, summary: 'Passed on re-check; nothing to fix', recheck: { at: 'local-testing', command: 'c', exit: 0 }, 'image-verified': true }) };
const fixed = (source, change, queued = false) => ({ 'in-place': true, fixed: true, source, 'source-change': change, 'golden-queued': queued, evidence: ['vm:run p ABC-3 A fix.sh → exit 0'], 'ai-feedback-short': `Fixed in the VM; ${change}`, 'ai-feedback-long': 'L' });

// ABC-3 A blocked at local-testing; its Blocked a run of grouped-blocked's repair-vm and the steps after it;
// `answers` the faked scripts' { exitCode, stdout } by command.
function fixture(answers) {
  const f = controlFixture();
  edit(join(f.dir, 'engines', 'example-development', 'workflow.yaml'), e => {
    e['check-health-interval-seconds'] = 1e9;
    e.steps.unshift({ id: 'blocked-for-human', sequence: -1, 'is-blocked-state': true, action: { type: 'human' } });
    Object.assign(e.steps.find(s => s.id === 'blocked'), {
      action: { type: 'state-engine', engine: 'own' }, 'follow-return-to-state': true,
      'exit-events': [
        { condition: { all: [{ 'is-done': true }, { 'sub-engine-ended-at': 'blocked-for-human' }] }, 'move-to-state': 'blocked-for-human' },
        { condition: { 'is-done': true }, 'follow-return-to-state': true },
      ],
    });
  });
  mkdirSync(join(f.dir, 'engines', 'own'), { recursive: true });
  writeFileSync(join(f.dir, 'engines', 'own', 'workflow.yaml'), JSON.stringify({ steps: grouped.steps.filter(s => KEPT.includes(s.id)).map(({ vm, ...s }) => s) }));
  for (const p of ['repair-vm-on-host-grouped', 'repair-image-on-host-grouped']) {
    mkdirSync(join(f.dir, 'prompts', p), { recursive: true });
    writeFileSync(join(f.dir, 'prompts', p, 'prompt.txt'), 'Repair {ticket} {variation}.\n');
    writeFileSync(join(f.dir, 'prompts', p, 'prompt.json'), JSON.stringify({ output: JSON.parse(readFileSync(join(ROOT, 'prompts', p, 'prompt.json'), 'utf8')).output }));
  }
  const was = (from, to) => ({ 'state-engine': 'example-development', 'from-state': from, 'to-state': to, timestamp: '2026-11-14T18:00:00Z', 'agent-dispatch-log': [], 'work-is-done': true });
  edit(sprint(f), s => {
    s.features[0]['ticket-system-status'] = 'Blocked';
    Object.assign(s.features[0].variations[0], { 'harness-status': hs('blocked'), 'state-changes': [was('plan', 'build'), was('build', 'local-testing'), was('local-testing', 'blocked')] });
  });
  f.now = Date.parse('2026-11-14T18:10:00Z');
  f.ctx.now = () => new Date(f.now);
  const script = f.ctx.script;
  f.calls = [];
  f.ctx.script = (argv, vm) => {
    const command = SCRIPTS.find(c => argv.includes(c));
    if (!command) return script(argv, vm);
    f.calls.push(argv.slice(1).join(' '));
    return Promise.resolve(answers[command] ?? { exitCode: 1, stdout: '' });
  };
  return f;
}
const state = f => f.variation()['harness-status'].state;
const topTrail = f => f.variation()['state-changes'].filter(c => !c['sub-state-change']).map(c => `${c['from-state']}→${c['to-state']}`);
const sub = f => f.variation()['harness-status']['sub-status']?.state;
const turnsEnd = ctx => until(() => [...ctx.agents.values()].every(a => a.result));
// Ticks — each agent's turn awaited — until ABC-3 A leaves Blocked, or `ticks` have passed.
async function settle(f, output, ticks = 8) {
  process.env.FAKE_OUTPUT = JSON.stringify(output);
  try {
    for (let i = 0; i < ticks && state(f) === 'blocked'; i++) { await tick(f.ctx); assert.ok(await turnsEnd(f.ctx)); f.now += 60e3; }
  } finally {
    delete process.env.FAKE_OUTPUT;
    f.ctx.stopAgents();
  }
}

test('ASS-427 AC1/AC2/AC8: fixed in the ticket\'s VM, the same fix in the golden image definition and a rebuild started — the source rebuilt in the background, verified on its fixed VM, and the ticket resumes at once, never waiting on the build', async () => {
  const f = fixture({ 'vm:golden-followup': { exitCode: 0, stdout: JSON.stringify({ project: 'p', status: 'building', applied: [], started: true, reported: [], waiting: 1, queued: 0 }) }, 'vm:image-recheck': VERIFIED });
  await settle(f, fixed('golden-image', 'provision.sh installs bats; bats in golden-image tools'));
  assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  assert.deepEqual(f.calls, ['vm:golden-followup p ABC-3 A', 'vm:image-recheck p ABC-3 A'], 'the rebuild started, then verified on its VM — no vm:golden-wait');
  assert.ok(!topTrail(f).some(t => t.includes('blocked-for-human')), 'not handed to the operator');
  const changes = f.variation()['state-changes'].filter(c => c['sub-state-change']).map(c => c['sub-state-change']['to-state']);
  assert.deepEqual(changes.filter(s => KEPT.includes(s)), ['repair-vm', 'rebuild-source', 'verify-image', 'done'], f.lines.join('\n'));
});

test('ASS-427 AC3/AC8: a golden build already running — the definition change queued, the ticket resumes all the same; control\'s golden follow-up carries the queue into the rebuild once that build ends', async () => {
  const f = fixture({ 'vm:golden-followup': { exitCode: 0, stdout: JSON.stringify({ project: 'p', status: 'building', applied: [], started: false, reported: [], waiting: 1, queued: 1 }) }, 'vm:image-recheck': VERIFIED });
  await settle(f, fixed('golden-image', 'provision.sh installs bats (queued behind the running build)', true));
  assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  assert.deepEqual(f.calls, ['vm:golden-followup p ABC-3 A', 'vm:image-recheck p ABC-3 A']);
  // Control's phase: a file queued, so vm:golden-followup p runs (once a minute), and what it did is logged.
  edit(join(f.dir, 'projects', 'p', 'project.json'), p => { p['golden-image'] = { folder: 'projects/p/golden-image' }; });
  mkdirSync(join(f.dir, 'projects', 'p', 'golden-queue'), { recursive: true });
  writeFileSync(join(f.dir, 'projects', 'p', 'golden-queue', 'provision.sh'), 'apt install bats\n');
  const cli = f.ctx.cli, followups = [];
  f.ctx.cli = (args, env) => (args[0] === 'vm:golden-followup'
    ? (followups.push(args.join(' ')), Promise.resolve(JSON.stringify({ project: 'p', status: 'building', applied: ['provision.sh'], started: true, reported: [{ ticket: 'ABC-2', variation: 'A', result: 'rebuilt' }], waiting: 1, queued: 0 })))
    : cli(args, env));
  await tick(f.ctx);
  await f.ctx.memory.golden.get('p').job;
  assert.deepEqual(followups, ['vm:golden-followup p']);
  assert.ok(f.lines.includes('golden p: queued provision.sh written into golden-p\'s definition; golden-p\'s rebuild started; ABC-2 A: its fix\'s rebuild rebuilt'), f.lines.join('\n'));
  await tick(f.ctx);
  assert.equal(followups.length, 1, 'not again within the minute');
  f.now += 61e3;
  await tick(f.ctx);
  await f.ctx.memory.golden.get('p').job;
  assert.equal(followups.length, 2, 'again a minute later, while it is queued');
});

test('ASS-427 AC4/AC8: not fixable in place (the Lima template) — today\'s path: Await the Golden Build, the ticket waiting while a build runs, nothing verified or resumed', async () => {
  const f = fixture({ 'vm:golden-wait': { exitCode: 1, stdout: JSON.stringify({ project: 'p', image: 'golden-p', status: 'building' }) } });
  await settle(f, { 'in-place': false, fixed: false, evidence: ['template.yaml: memory 4GiB, the suite needs 8'], 'ai-feedback-short': 'Needs more memory: the Lima template', 'ai-feedback-long': 'L' }, 5);
  assert.equal(state(f), 'blocked', f.lines.join('\n'));
  assert.equal(sub(f), 'await-golden-build', f.lines.join('\n'));
  assert.ok(f.calls.length >= 1 && f.calls.every(c => c === 'vm:golden-wait p'), f.calls.join('\n'));
  assert.ok(!f.lines.some(l => /^error /.test(l) && /golden-wait/.test(l)), 'waiting is no failure');
});

test('ASS-427 AC5/AC8: the VM-setup case — an undeclared npm registry declared and applied in the VM, no rebuild needed — verified on the VM, the ticket resumes', async () => {
  const f = fixture({ 'vm:golden-followup': { exitCode: 0, stdout: JSON.stringify({ project: 'p', status: 'current', applied: [], started: false, reported: [], waiting: 0, queued: 0 }) }, 'vm:image-recheck': VERIFIED });
  await settle(f, fixed('vm-setup', '@example → GitLab project 11223344 in ~/.harness/vm-credentials.json'));
  assert.equal(state(f), 'local-testing', f.lines.join('\n'));
  assert.deepEqual(f.calls, ['vm:golden-followup p ABC-3 A', 'vm:image-recheck p ABC-3 A']);
  assert.ok(!topTrail(f).some(t => t.includes('blocked-for-human')), 'not handed to the operator');
});
