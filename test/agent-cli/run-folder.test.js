// A run's folder, projects/<project>/work/run-<root run id>: where a health
// check's reports wait for the ticket they lead to. ticket:adopt-run-folder
// moves them into the ticket's folder; transient-state-engine:remove of the
// root run deletes what is left, so nothing stray stays behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fixture, SELF_HEALING_ENGINE } from './harness-fixture.js';

const fails = (promise, message) => assert.rejects(promise, e => message.test(e.stderr));
const CHILD = 'cccccccc-0000-4000-8000-000000000004';

// The fixture with a child run under the self-healing run, and the root's folder holding two reports.
function withReports() {
  const f = fixture();
  const file = join(f.dir, 'assignments.json');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data['transient-state-engines'].push({ ...data['transient-state-engines'][0], id: CHILD, parent: { 'transient-state-engine': SELF_HEALING_ENGINE } });
  writeFileSync(file, JSON.stringify(data, null, 4));
  const work = (...rest) => join(f.dir, 'projects', 'p', 'work', ...rest);
  mkdirSync(work(`run-${SELF_HEALING_ENGINE}`), { recursive: true });
  writeFileSync(work(`run-${SELF_HEALING_ENGINE}`, 'harness.md'), 'H');
  writeFileSync(work(`run-${SELF_HEALING_ENGINE}`, 'project.md'), 'P');
  return { ...f, work };
}

test('ticket:adopt-run-folder moves a run\'s root folder into the ticket\'s, beside what is there, and removes it; a run without one moves nothing', async () => {
  const f = withReports();
  mkdirSync(f.work('ABC-9'));
  writeFileSync(f.work('ABC-9', 'ticket.json'), '{}');
  const { stdout } = await f.agent('ticket:adopt-run-folder', 'p', 'abc-9', CHILD);           // any run of the chain finds the root's folder
  assert.deepEqual(JSON.parse(stdout), { moved: ['harness.md', 'project.md'] });
  assert.deepEqual(readdirSync(f.work('ABC-9')).toSorted(), ['harness.md', 'project.md', 'ticket.json']);
  assert.equal(readFileSync(f.work('ABC-9', 'harness.md'), 'utf8'), 'H');
  assert.ok(!existsSync(f.work(`run-${SELF_HEALING_ENGINE}`)));
  assert.deepEqual(JSON.parse((await f.agent('ticket:adopt-run-folder', 'p', 'ABC-9', CHILD)).stdout), { moved: [] });
});

test('ticket:adopt-run-folder fails, moving nothing, when a file would overwrite one in the ticket\'s folder, or on bad arguments', async () => {
  const f = withReports();
  mkdirSync(f.work('ABC-9'));
  writeFileSync(f.work('ABC-9', 'project.md'), 'mine');
  await fails(f.agent('ticket:adopt-run-folder', 'p', 'ABC-9', CHILD), /ABC-9 already has project\.md/);
  assert.deepEqual(readdirSync(f.work(`run-${SELF_HEALING_ENGINE}`)).toSorted(), ['harness.md', 'project.md']);
  assert.equal(readFileSync(f.work('ABC-9', 'project.md'), 'utf8'), 'mine');
  await fails(f.agent('ticket:adopt-run-folder', 'p', 'ABC-9'), /usage/);
  await fails(f.agent('ticket:adopt-run-folder', 'p', '../x', CHILD), /invalid ticket/);
});

test('transient-state-engine:remove of a root run deletes its folder; removing a run under it leaves the folder', async () => {
  const f = withReports();
  await f.agent('transient-state-engine:remove', CHILD);
  assert.ok(existsSync(f.work(`run-${SELF_HEALING_ENGINE}`)));
  await f.agent('transient-state-engine:remove', SELF_HEALING_ENGINE);
  assert.ok(!existsSync(f.work(`run-${SELF_HEALING_ENGINE}`)));
});

test('a run folder\'s move (ticket:adopt-run-folder) and delete (transient-state-engine:remove of its root) take its run lock, work/run-<id>.lock: held, each waits, then goes on (ASS-179 AC3)', async t => {
  const f = withReports();
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${f.work(`run-${SELF_HEALING_ENGINE}`)}.lock`]);
  t.after(() => holder.kill('SIGKILL'));
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const done = [];
  const adopting = f.agent('ticket:adopt-run-folder', 'p', 'ABC-9', CHILD).then(r => { done.push('adopt'); return r; });
  await new Promise(r => setTimeout(r, 1000));
  assert.ok(existsSync(f.work(`run-${SELF_HEALING_ENGINE}`, 'harness.md')), 'nothing moved while the lock is held');
  assert.deepEqual(done, []);
  holder.kill('SIGKILL');
  assert.deepEqual(JSON.parse((await adopting).stdout), { moved: ['harness.md', 'project.md'] });

  mkdirSync(f.work(`run-${SELF_HEALING_ENGINE}`));
  const again = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "locked\\n"; $| = 1; sleep 600;', `${f.work(`run-${SELF_HEALING_ENGINE}`)}.lock`]);
  t.after(() => again.kill('SIGKILL'));
  await new Promise(resolve => again.stdout.once('data', resolve));
  const removing = f.agent('transient-state-engine:remove', SELF_HEALING_ENGINE);
  await new Promise(r => setTimeout(r, 1000));
  assert.ok(existsSync(f.work(`run-${SELF_HEALING_ENGINE}`)), 'not deleted while the lock is held');
  again.kill('SIGKILL');
  await removing;
  assert.ok(!existsSync(f.work(`run-${SELF_HEALING_ENGINE}`)));
});
