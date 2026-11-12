// ASS-392 — the commands grouped-blocked's Repair Image path runs on the Mac:
// vm:golden-wait (Await the Golden Build: one golden rebuild at a time, read
// from the build lock and the started build the harness already uses),
// vm:golden-write (the one way the confined Repair Image agent edits the
// project's image definition, and nothing outside its golden-image folder),
// vm:recreate (the ticket's VM recreated from the current golden image,
// never losing work no remote has) and vm:image-recheck (Verify the
// Repaired Image: the image current, the VM its clone, the failing check
// passing there). Lima is test/support/fake-limactl.js (vm-fixture.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, AGENT } from './harness-fixture.js';
import { lima, git, edit } from './vm-fixture.js';

const outcome = promise => promise.then(r => ({ code: 0, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr }), e => ({ code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }));

// The lima() fixture with p's golden image defined (projects/p/golden-image: template.yaml, provision.sh),
// built from it now (its label's hash the inputs' — vm:golden-stale's — generation g2) unless current is false.
async function setup({ current = true } = {}) {
  const l = lima();
  l.mount();
  l.v.inVm('claude', 'exit 0');
  const at = (...rest) => join(l.f.dir, ...rest);
  const folder = at('projects', 'p', 'golden-image');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'template.yaml'), 'vmType: vz\n');
  writeFileSync(join(folder, 'provision.sh'), '#!/bin/bash\necho provision\n');
  chmodSync(join(folder, 'provision.sh'), 0o755);
  edit(at('projects', 'p', 'project.json'), p => { p['golden-image'] = { folder: 'projects/p/golden-image' }; });
  const agent = (...args) => run(AGENT, args, { env: l.env });
  const label = (name, fields) => writeFileSync(join(l.v.instances, name, 'golden-image.json'), JSON.stringify(fields));
  if (current) label('golden-p', { project: 'p', hash: JSON.parse((await agent('vm:golden-stale', 'p')).stdout).hash, 'built-at': '2026-11-12T08:00:00Z', generation: 'g2' });
  const log = () => (existsSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md')) ? readFileSync(at('projects', 'p', 'work', 'ABC-3', 'change-log-A.md'), 'utf8') : '');
  const building = () => writeFileSync(at('projects', 'p', 'golden-build-run.json'), JSON.stringify({ pid: process.pid, 'started-at': '2026-11-12T09:00:00Z' }));
  return { ...l, at, folder, agent, label, log, building };
}

// holdLock(file) — a process holding an exclusive flock on file, as vm:build-golden holds golden-build.lock; resolves once it is held.
function holdLock(file) {
  const child = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; $| = 1; sleep 60', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(resolve => child.stdout.once('data', () => resolve(child)));
}

test('ASS-392 AC3: vm:golden-wait exits 1 (wait) while golden-p is being built — golden-build.lock held, or golden-build-run.json\'s build still going — and 0 once none runs, printing the status and the image\'s label; 2 without a definition', async () => {
  const s = await setup();
  const idle = await outcome(s.agent('vm:golden-wait', 'p'));
  assert.equal(idle.code, 0, idle.stderr);
  assert.deepEqual([idle.out.status, idle.out['built-at'], idle.out.generation, idle.out.fix], ['current', '2026-11-12T08:00:00Z', 'g2', null]);
  const lock = await holdLock(s.at('projects', 'p', 'golden-build.lock'));
  try {
    const held = await outcome(s.agent('vm:golden-wait', 'p'));
    assert.deepEqual([held.code, held.out.status], [1, 'building'], 'the build lock vm:build-golden holds');
    assert.match(held.stderr, /golden-p is being built; waiting/);
  } finally { lock.kill(); }
  s.building();
  assert.deepEqual(await outcome(s.agent('vm:golden-wait', 'p')).then(r => [r.code, r.out.status]), [1, 'building'], 'the build vm:build-golden-start started, still going');
  writeFileSync(s.at('projects', 'p', 'golden-build-run.exit'), '1\n');
  assert.deepEqual(await outcome(s.agent('vm:golden-wait', 'p')).then(r => [r.code, r.out.status]), [0, 'current'], 'ended: no wait');
  edit(s.at('projects', 'q', 'project.json'), p => { delete p['golden-image']; });
  const none = await outcome(s.agent('vm:golden-wait', 'q'));
  assert.equal(none.code, 2);
  assert.equal(none.out['ai-feedback-short'], 'Repair Image: no golden image definition to repair');
  assert.match(none.out['ai-feedback-long'], /q has no golden-image in project\.json/);
});

test('ASS-392 AC2: vm:golden-write replaces one file of the golden-image folder from stdin, its mode kept — and refuses, writing nothing, a path outside it (absolute, .., a dot-file, through a symlink), an empty stdin, or any write while a golden build runs', async () => {
  const s = await setup();
  const write = (path, content) => outcome(run('bash', ['-c', `printf '%s' "$1" | "$2" vm:golden-write p "$3"`, '-', content, AGENT, path], { env: s.env }));
  const ok = await write('provision.sh', '#!/bin/bash\nsudo apt-get install -y jq\n');
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.out, { project: 'p', file: 'provision.sh', bytes: 39 });
  assert.equal(readFileSync(join(s.folder, 'provision.sh'), 'utf8'), '#!/bin/bash\nsudo apt-get install -y jq\n');
  assert.equal(statSync(join(s.folder, 'provision.sh')).mode & 0o777, 0o755, 'its mode kept');
  assert.equal((await write('images.txt', 'registry.example.com/app:1@sha256:abc\n')).code, 0, 'a new file of the definition');
  assert.equal((await write('tests/smoke.sh', 'true\n')).code, 0, 'in a subfolder too');
  const other = s.at('projects', 'q', 'golden-image');
  mkdirSync(other, { recursive: true });
  symlinkSync(other, join(s.folder, 'linked'));
  for (const [path, why] of [['/etc/hosts', /not a path relative/], ['../../q/project.json', /'\.\.', '\.', dot-file/], ['.env', /dot-file/], ['sub/../../x', /'\.\.'/], ['linked/provision.sh', /symlink/], ['', /not a path relative/]]) {
    const refused = await write(path, 'x\n');
    assert.equal(refused.code, 1, path);
    assert.match(refused.stderr, why, path);
  }
  assert.ok(!existsSync(join(other, 'provision.sh')), 'nothing written through the symlink');
  assert.match((await write('warm.sh', '')).stderr, /nothing on stdin/);
  assert.ok(!existsSync(join(s.folder, 'warm.sh')));
  s.building();
  const during = await write('provision.sh', 'echo changed\n');
  assert.equal(during.code, 1);
  assert.match(during.stderr, /golden-p is being built now/);
  assert.match(readFileSync(join(s.folder, 'provision.sh'), 'utf8'), /apt-get install -y jq/, 'unchanged while it builds');
});

test('ASS-392 AC2: vm:recreate puts a set-up VM on the current golden image — its pushed branch checked out again, Setup marked complete again, logged — but refuses, deleting nothing, while a golden build runs or while the VM holds work no remote has', async () => {
  const s = await setup();
  await s.agent('vm:create', 'p', 'ABC-3', 'A');
  writeFileSync(s.vmFile('repos', '.setup-complete'), '');
  const repo = s.vmFile('repos', 'harness');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  const deletes = () => s.v.calls().filter(c => c.argv?.[0] === 'delete' && c.argv.includes('abc-3-a')).length;

  writeFileSync(join(repo, 'wip.txt'), 'in progress\n');
  const dirty = await outcome(s.agent('vm:recreate', 'p', 'ABC-3', 'A'));
  assert.equal(dirty.code, 3);
  assert.match(dirty.stderr, /abc-3-a holds the ticket's work not on any remote — harness: changes not committed/);
  git(repo, 'checkout', '-q', '-b', 'change/ABC-3'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'work');
  const unpushed = await outcome(s.agent('vm:recreate', 'p', 'ABC-3', 'A'));
  assert.equal(unpushed.code, 3);
  assert.match(unpushed.stderr, /harness: commits no remote has/);
  assert.equal(deletes(), 0, 'nothing deleted');
  assert.match(s.log(), /Blocked, Repair Image\nvm:recreate refused: abc-3-a holds the ticket's work not on any remote/);

  git(repo, 'push', '-q', 'origin', 'change/ABC-3');
  const commit = git(repo, 'rev-parse', 'HEAD');
  s.building();
  const during = await outcome(s.agent('vm:recreate', 'p', 'ABC-3', 'A'));
  assert.equal(during.code, 3);
  assert.match(during.stderr, /golden-p is being built now; wait for it to finish/);
  rmSync(s.at('projects', 'p', 'golden-build-run.json'));

  const done = await outcome(s.agent('vm:recreate', 'p', 'ABC-3', 'A'));
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual([done.out.name, done.out.created], ['abc-3-a', true]);
  assert.equal(deletes(), 1);
  assert.equal(s.v.calls().filter(c => c.argv?.[0] === 'clone').length, 2, 'cloned again from golden-p');
  assert.match(done.stderr, /abc-3-a was deleted; it is recreated from golden-p/);
  assert.deepEqual([git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), git(repo, 'rev-parse', 'HEAD')], ['change/ABC-3', commit], 'its branch put back');
  assert.ok(existsSync(s.vmFile('repos', '.setup-complete')), 'Setup marked complete again');
  assert.ok(s.v.calls().some(c => c.vm === 'abc-3-a' && c.argv.join(' ').includes('command -v claude')), 'through vm:mark-setup-complete, which checks the VM can run an agent');
  assert.equal(JSON.parse(readFileSync(join(s.v.instances, 'abc-3-a', 'golden-image.json'), 'utf8')).generation, 'g2', 'a clone of the current image');
  assert.match(s.log(), /vm:recreate: abc-3-a recreated from golden-p \(generation g2\), its repositories put back on their branches and its Setup marked complete again\./);
});

test('ASS-392 AC4: vm:image-recheck — not verified (exit 3, ai-feedback for the operator) while golden-p builds, when it is not built from its current definition, or when the ticket\'s VM is an older clone; image current and VM its clone, the harness has no check to re-run: exit 2, Repair Image\'s run stands', async () => {
  const s = await setup();
  await s.agent('vm:create', 'p', 'ABC-3', 'A');
  const recheck = () => outcome(s.agent('vm:image-recheck', 'p', 'ABC-3', 'A'));
  const ok = await recheck();
  assert.equal(ok.code, 2, ok.stderr);
  assert.deepEqual([ok.out['image-verified'], ok.out.rechecked], [true, false]);
  assert.match(s.log(), /Blocked, Verify the Repaired Image\nNot re-checked: its state changes do not say which step it was blocked at\. Repair Image's run of the failing check stands\./);
  assert.match(s.log(), /the harness has no check of its own to re-run/);
  s.label('abc-3-a', { project: 'p', hash: 'x', 'built-at': '2026-11-01T08:00:00Z', generation: 'g1' });
  const old = await recheck();
  assert.equal(old.code, 3);
  assert.match(old.out['ai-feedback-short'], /abc-3-a is not a clone of the repaired golden-p/);
  assert.match(old.out['ai-feedback-long'], /vm:recreate p ABC-3 A/);
  writeFileSync(join(s.folder, 'provision.sh'), '#!/bin/bash\necho changed\n');
  const stale = await recheck();
  assert.equal(stale.code, 3);
  assert.match(stale.out['ai-feedback-short'], /golden-p is not built from its current definition/);
  s.building();
  assert.match((await recheck()).out['ai-feedback-short'], /golden-p is still being built/);
  assert.match(s.log(), /Not verified: golden-p is still being built/);
});

test('ASS-392 AC4: vm:image-recheck re-runs the blocked step\'s check on the VM from the repaired image — passing, exit 0 and verified; still failing, exit 3 for the operator with its last lines', async () => {
  for (const [variation, code] of [['A', 0], ['Z', 3]]) {
    const s = await setup();
    await s.agent('vm:create', 'p', 'ABC-3', 'A');
    const engine = (name, steps) => { mkdirSync(s.at('engines', name), { recursive: true }); writeFileSync(s.at('engines', name, 'state-engine.json'), JSON.stringify({ steps })); };
    engine('dev', [
      { id: 'blocked', sequence: 0, 'follow-return-to-state': true, action: { type: 'state-engine', engine: 'grouped-blocked' }, 'exit-events': [{ condition: { 'is-done': true }, 'follow-return-to-state': true }] },
      { id: 'committed', sequence: 1, action: { type: 'none' } },
      { id: 'build', sequence: 2, 'return-to-state': 'build', action: { type: 'state-engine', engine: 'sub-build' }, 'exit-events': [{ condition: { 'is-done': true }, 'move-to-state': 'done' }] },
      { id: 'done', sequence: 3, 'is-done': true, action: { type: 'none' } },
    ]);
    engine('sub-build', [
      { id: 'check', sequence: 1, action: { type: 'script', command: `./agent.sh ticket:set-paused {project} {ticket} ${variation} false` } },
      { id: 'done', sequence: 2, 'is-done': true, action: { type: 'none' } },
    ]);
    edit(s.at('projects', 'p', 'project.json'), p => { p['execution-state-engine'] = 'dev'; });
    const c = (from, to, sub) => ({ 'state-engine': 'dev', 'from-state': from, 'to-state': to, timestamp: '2026-11-12T09:00:00Z', 'agent-dispatch-log': [], ...(sub ? { 'sub-state-change': sub } : {}) });
    edit(s.at('projects', 'p', 'sprints', 'sprint-10', 'sprint.json'), sprint => {
      sprint.features[0].variations[0]['state-changes'] = [c('committed', 'build'), c('build', 'build', { 'state-engine': 'sub-build', 'from-state': null, 'to-state': 'check' }), c('build', 'blocked')];
    });
    const r = await outcome(s.agent('vm:image-recheck', 'p', 'ABC-3', 'A'));
    assert.equal(r.code, code, r.stderr);
    if (code === 0) {
      assert.deepEqual([r.out['image-verified'], r.out['recheck-passed'], r.out.recheck.at], [true, true, 'build/check']);
      assert.match(s.log(), /Blocked, Verify the Repaired Image\nPassed on re-check; nothing to fix\. Re-ran `\.\/agent\.sh ticket:set-paused p ABC-3 A false` \(the step build\/check, where it was blocked\): exit 0\. The ticket resumes\./);
      assert.match(s.log(), /Verified: the failing check passes on a VM from the repaired image \(abc-3-a, golden-p generation g2\)\./);
    } else {
      assert.equal(r.out['image-verified'], false);
      assert.match(r.out['ai-feedback-short'], /the failing check still fails on a VM from the repaired image/);
      assert.match(r.out['ai-feedback-long'], /`\.\/agent\.sh ticket:set-paused p ABC-3 Z false` exit 1/);
      assert.match(s.log(), /still fails \(exit 1\)\. Blocked for Human\./);
    }
  }
});
