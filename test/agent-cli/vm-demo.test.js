// The Demo action at human review (ASS-76 AC2, AC3): vm:demo makes sure the
// variation's VM runs with a display (video.display vz, a window onto its
// desktop on the Mac), runs the demo plan's setup in /repos/, polls its
// ready-check, then starts the desktop (lightdm) and the plan's tool in it.
// vm:start starts every other VM without one. limactl is
// test/support/fake-limactl.js; the VM's root a folder (vm-fixture.js lima()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, AGENT } from './harness-fixture.js';
import { lima, edit } from './vm-fixture.js';

const display = l => readFileSync(join(l.v.instances, 'abc-3-a', 'display'), 'utf8');

test('vm:start starts a VM without a display — whatever a demo left it with — and with one given --display; a running VM it takes as it is', async () => {
  const l = lima();
  l.mount();
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  await l.cli('vm:stop', 'p', 'abc-3-a');
  await l.cli('vm:start', 'p', 'ABC-3', 'A', '--display');
  assert.equal(display(l), 'vz');
  await l.cli('vm:stop', 'p', 'abc-3-a');
  await l.cli('vm:start', 'p', 'ABC-3', 'A');
  assert.equal(display(l), 'none');
  const before = l.v.calls().length;
  await l.cli('vm:start', 'p', 'ABC-3', 'A', '--display');   // running: taken as it is
  assert.ok(!l.v.calls().slice(before).some(c => ['edit', 'start', 'stop'].includes(c.argv?.[0])));
  assert.equal(display(l), 'none');
});

// lima() with ABC-3 A's VM made (vm:create, running, no display) and, in its
// VM, the desktop as desktop.sh leaves it: systemctl and setsid log what they
// are asked (in the VM's root, desktop.log); pgrep finds the autologin
// session's xfce4-session (4242), whose environment /proc holds. Its engine's
// blocked state is Stuck for Human. plan(p) writes the variation's demo plan.
async function demo() {
  const l = lima();
  l.mount();
  edit(join(l.f.dir, 'engines', 'example-development', 'state-engine.json'), e => { e.steps.push({ id: 'stuck', sequence: 0, area: 'quarantine', 'is-blocked-state': true, action: { type: 'human' } }); });
  await l.cli('vm:create', 'p', 'ABC-3', 'A');
  const log = l.vmFile('desktop.log');
  l.v.inVm('systemctl', `echo "systemctl $*" >> "${log}"`);
  l.v.inVm('setsid', `echo "setsid $*" >> "${log}"`);
  l.v.inVm('pgrep', '[[ "$*" == *xfce4-session* ]] && echo 4242');
  mkdirSync(l.vmFile('proc', '4242'), { recursive: true });
  writeFileSync(l.vmFile('proc', '4242', 'environ'), 'HOME=/home/u\0DISPLAY=:0\0XAUTHORITY=/home/u/.Xauthority\0DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/501/bus\0');
  const plan = p => writeFileSync(join(l.folder, 'demo-plan-A.json'), JSON.stringify(p));
  const desktop = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  // A ready-check that passes may take its tries a while on a busy machine (each is a limactl shell): its limit is
  // generous (ASS-109); demo(env) runs vm:demo with env added, a short DEMO_READY_TIMEOUT for one that never passes.
  const env = { ...l.env, DEMO_READY_INTERVAL: '0.1', DEMO_READY_TIMEOUT: '600' };
  return { ...l, plan, desktop, demo: (extra = {}) => run(AGENT, ['vm:demo', 'p', 'ABC-3', 'A'], { env: { ...env, ...extra } }) };
}

const TERMINAL = {
  demo: true, setup: ['echo built > built.txt', 'echo up >> built.txt'],
  'ready-check': 'n=$(cat tries 2>/dev/null || echo 0); echo $((n + 1)) > tries; echo "try $n"; [ "$n" -ge 2 ]',
  view: { with: 'terminal', commands: ['corpus ingest --dry-run', "grep -c 'a b' out.txt"] }, 'look-at': ['the dry run lists 3 files'],
};

test('vm:demo restarts the running VM with a display, runs the plan\'s setup in /repos/, polls the ready-check until it passes, then starts the desktop and opens a terminal at /repos/ with the commands', async () => {
  const d = await demo();
  d.plan(TERMINAL);
  const before = d.v.calls().length;
  const out = JSON.parse((await d.demo()).stdout);
  assert.deepEqual(out, { name: 'abc-3-a', ip: '192.168.64.15', view: TERMINAL.view, 'look-at': TERMINAL['look-at'] });
  const calls = d.v.calls().slice(before).map(c => c.argv[0]);
  assert.ok(calls.indexOf('stop') < calls.indexOf('edit') && calls.indexOf('edit') < calls.indexOf('start') && calls.includes('stop'), calls.join(' '));
  assert.equal(display(d), 'vz');
  assert.equal(readFileSync(d.vmFile('repos', 'built.txt'), 'utf8'), 'built\nup\n');
  assert.equal(readFileSync(d.vmFile('repos', 'tries'), 'utf8'), '3\n');   // failed twice, then passed
  const [lightdm, terminal] = d.desktop();
  assert.equal(lightdm, 'systemctl start lightdm');
  assert.match(terminal, /^setsid -f xfce4-terminal --working-directory=\/repos -x bash --rcfile (\S+) -i$/);
  const rc = readFileSync(d.vmFile(/--rcfile (\S+)/.exec(terminal)[1]), 'utf8');
  const shown = execFileSync('bash', ['-c', `set -o history\n${rc.replace(/.*bashrc.*\n/, '')}\nhistory`], { encoding: 'utf8' });
  assert.match(shown, /corpus ingest --dry-run\n.*grep -c 'a b' out\.txt\n/);
  for (const c of TERMINAL.view.commands) assert.ok(shown.includes(`  ${c}`), shown);
});

test('vm:demo whose ready-check never passes blocks the ticket with its last output, and opens nothing', async () => {
  const d = await demo();
  d.plan({ ...TERMINAL, 'ready-check': 'echo "connection refused on 8080"; exit 7' });
  await assert.rejects(d.demo({ DEMO_READY_TIMEOUT: '2' }), e => /did not pass within 2s/.test(e.stderr) && /connection refused on 8080/.test(e.stderr));
  const v = d.f.variation('A');
  assert.equal(v['harness-status'].state, 'stuck');
  assert.equal(v['ai-feedback-short'], 'Demo not ready');
  assert.match(v['ai-feedback-long'], /ready-check `echo "connection refused on 8080"; exit 7` did not pass within 2s of its setup in abc-3-a; its last output: connection refused on 8080$/);
  assert.deepEqual(d.desktop(), []);
});

test('vm:demo whose setup command fails blocks the ticket with its output, running neither the rest nor the ready-check', async () => {
  const d = await demo();
  d.plan({ ...TERMINAL, setup: ['echo "no such service: api" >&2; exit 3', 'touch after'] });
  await assert.rejects(d.demo(), e => /setup command .* failed in abc-3-a's \/repos\/: no such service: api/.test(e.stderr));
  const v = d.f.variation('A');
  assert.equal(v['harness-status'].state, 'stuck');
  assert.equal(v['ai-feedback-short'], 'Demo setup failed');
  assert.ok(!existsSync(d.vmFile('repos', 'after')) && !existsSync(d.vmFile('repos', 'tries')));
  assert.deepEqual(d.desktop(), []);
});

test('vm:demo again, the VM running with its display, takes it as it runs — no restart — records the access, and opens the browser at the address', async () => {
  const d = await demo();
  const view = { with: 'browser', address: 'http://localhost:3000/opinions' };
  d.plan({ ...TERMINAL, view });
  await d.demo();
  const vms = () => JSON.parse(readFileSync(join(d.f.dir, 'projects', 'p', 'vms.json'), 'utf8'))['abc-3-a'];
  edit(join(d.f.dir, 'projects', 'p', 'vms.json'), v => { v['abc-3-a']['last-accessed'] = '2026-10-01T00:00:00Z'; });
  const before = d.v.calls().length;
  assert.deepEqual(JSON.parse((await d.demo()).stdout).view, view);
  assert.ok(!d.v.calls().slice(before).some(c => ['edit', 'start', 'stop'].includes(c.argv?.[0])));
  assert.notEqual(vms()['last-accessed'], '2026-10-01T00:00:00Z');
  assert.equal(d.desktop().at(-1), 'setsid -f firefox-esr http://localhost:3000/opinions');
});

test('vm:demo for a plan with no demo fails saying why, touching no VM', async () => {
  const d = await demo();
  d.plan({ demo: false, why: 'a refactor: nothing to see' });
  const before = d.v.calls().length;
  await assert.rejects(d.demo(), e => /ABC-3 A has no demo: a refactor: nothing to see/.test(e.stderr));
  assert.equal(d.v.calls().length, before);
});

test('control starting the VM while vm:demo restarts it (vm:start, under the same lock) leaves it running with the display', async () => {
  const d = await demo();
  d.plan(TERMINAL);
  await Promise.all([d.demo(), d.cli('vm:start', 'p', 'ABC-3', 'A')]);
  assert.equal(display(d), 'vz');
  assert.equal(readFileSync(join(d.v.instances, 'abc-3-a', 'status'), 'utf8'), 'Running');
});

test('vm:demo whose VM stops part way — its window closed on the Mac, which stops it — fails saying so, without blocking the ticket', async () => {
  const d = await demo();
  d.plan({ ...TERMINAL, setup: [`echo Stopped > "${join(d.v.instances, 'abc-3-a', 'status')}"; exit 255`] });
  await assert.rejects(d.demo(), e => /abc-3-a stopped during the demo \(its window closed\?\); nothing is blocked/.test(e.stderr));
  assert.equal(d.f.variation('A')['harness-status'].state, 'generate-solution');
  assert.deepEqual(d.desktop(), []);
});
